"""ChromaDB vector store wrapper.

One collection per account.  Document IDs follow the format:
``<account>:<folder>:<uidvalidity>:<uid>``

Embeddings are produced by model2vec (lightweight, no torch/onnxruntime).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import chromadb
import numpy as np
from model2vec import StaticModel

from .config import Config

log = logging.getLogger("epistole.index")


class _Model2VecEmbeddingFunction(chromadb.EmbeddingFunction):
    """ChromaDB-compatible embedding function backed by model2vec."""

    def __init__(self, model_name: str, cache_dir: str) -> None:
        self._model: StaticModel | None = None
        self._model_name = model_name
        self._cache_dir = cache_dir

    def _load(self) -> StaticModel:
        if self._model is None:
            import os
            # Direct HuggingFace Hub cache to our data dir
            os.environ.setdefault("HF_HOME", self._cache_dir)
            log.info("Loading embedding model %s …", self._model_name)
            self._model = StaticModel.from_pretrained(self._model_name)
            log.info("Embedding model loaded (dim=%d)", self._model.dim)
        return self._model

    def name(self) -> str:
        return f"model2vec:{self._model_name}"

    def __call__(self, input: list[str]) -> list[list[float]]:  # noqa: A002
        model = self._load()
        embeddings: np.ndarray = model.encode(input)
        return embeddings.tolist()


class VectorIndex:
    """Thin wrapper around a ChromaDB persistent collection."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        cfg.chroma_dir.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(cfg.chroma_dir))
        self._ef = _Model2VecEmbeddingFunction(
            model_name=cfg.embedding_model,
            cache_dir=str(cfg.models_dir),
        )
        self._collection = self._client.get_or_create_collection(
            name=cfg.account_id,
            embedding_function=self._ef,
            metadata={"hnsw:space": "cosine"},
        )

    # ── document ID ─────────────────────────────────────────────────────

    def doc_id(self, folder: str, uidvalidity: int, uid: int) -> str:
        return f"{self._cfg.account_id}:{folder}:{uidvalidity}:{uid}"

    # ── write ───────────────────────────────────────────────────────────

    def upsert(
        self,
        uid: int,
        folder: str,
        uidvalidity: int,
        *,
        subject: str,
        from_: str,
        to: str,
        date_iso: str,
        body: str,
        pdf_text: str = "",
        has_attachments: bool = False,
        attachment_filenames: list[str] | None = None,
        message_id: str = "",
        in_reply_to: str = "",
    ) -> None:
        doc_text = "\n".join(filter(None, [subject, from_, to, body, pdf_text]))
        doc_text = doc_text[: self._cfg.max_body_chars]

        meta: dict[str, Any] = {
            "uid": uid,
            "folder": folder,
            "account": self._cfg.account_id,
            "date_iso": date_iso or "",
            "from": from_,
            "to": to,
            "subject": subject,
            "has_attachments": has_attachments,
            "attachment_filenames": json.dumps(attachment_filenames or []),
            "uidvalidity": uidvalidity,
            "message_id": message_id,
            "in_reply_to": in_reply_to,
        }

        self._collection.upsert(
            ids=[self.doc_id(folder, uidvalidity, uid)],
            documents=[doc_text],
            metadatas=[meta],
        )

    def delete_by_folder(self, folder: str) -> None:
        """Drop all documents for a folder (used on UIDVALIDITY change)."""
        self._collection.delete(where={"folder": folder})

    # ── read ────────────────────────────────────────────────────────────

    def query(
        self,
        text: str,
        *,
        n_results: int = 10,
        where: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Semantic search.  Returns list of metadata dicts with ``score``."""
        kwargs: dict[str, Any] = {
            "query_texts": [text],
            "n_results": n_results,
        }
        if where:
            kwargs["where"] = where
        try:
            results = self._collection.query(**kwargs)
        except Exception as exc:
            log.warning("Chroma query failed: %s", exc)
            return []

        out: list[dict[str, Any]] = []
        ids = results.get("ids", [[]])[0]
        metas = results.get("metadatas", [[]])[0]
        distances = results.get("distances", [[]])[0]
        documents = results.get("documents", [[]])[0]

        for i, doc_id in enumerate(ids):
            meta = dict(metas[i]) if i < len(metas) else {}
            meta["score"] = round(1 - distances[i], 4) if i < len(distances) else 0
            meta["snippet"] = (documents[i] or "")[:300] if i < len(documents) else ""
            af = meta.get("attachment_filenames", "[]")
            try:
                meta["attachment_filenames"] = json.loads(af)
            except (json.JSONDecodeError, TypeError):
                meta["attachment_filenames"] = []
            meta["attachment_count"] = len(meta["attachment_filenames"])
            out.append(meta)

        return out

    def get_by_metadata(
        self,
        where: dict[str, Any],
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Fetch documents by metadata filter (no semantic query)."""
        try:
            results = self._collection.get(where=where, limit=limit)
        except Exception:
            return []

        out = []
        for meta in results.get("metadatas", []):
            entry = dict(meta)
            af = entry.get("attachment_filenames", "[]")
            try:
                entry["attachment_filenames"] = json.loads(af)
            except (json.JSONDecodeError, TypeError):
                entry["attachment_filenames"] = []
            out.append(entry)
        return out

    @property
    def count(self) -> int:
        return self._collection.count()
