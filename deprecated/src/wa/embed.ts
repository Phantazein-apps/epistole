/**
 * Vectorize embedding for WhatsApp messages.
 *
 * Uses the same model + index as email (bge-base-en-v1.5 / email-embeddings),
 * tagging each vector with channel:"whatsapp" so the unified semantic_search
 * tool can filter by channel.
 */

import type { Env } from "../types.js";

const MAX_CHARS = 2000;
const BATCH = 20;

export interface WaEmbedInput {
  id: string;          // `${account_id}:${chat_jid}:${message_id}`
  text: string;        // content (plus chat name / sender for ranking)
  metadata: {
    channel: "whatsapp";
    account_id: string;
    chat_jid: string;
    sender: string;
    timestamp: number; // unix seconds
    is_from_me: 0 | 1;
    media_type?: string;
  };
}

export function makeVectorId(accountId: string, chatJid: string, messageId: string): string {
  return `wa:${accountId}:${chatJid}:${messageId}`;
}

export async function embedWaMessages(env: Env, inputs: WaEmbedInput[]): Promise<void> {
  if (inputs.length === 0) return;

  for (let i = 0; i < inputs.length; i += BATCH) {
    const chunk = inputs.slice(i, i + BATCH);
    try {
      const texts = chunk.map((x) => x.text.slice(0, MAX_CHARS) || " ");
      const resp = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: texts });
      const vectors = (resp as any).data as number[][];
      if (!vectors || vectors.length !== chunk.length) {
        console.error(`WA embed mismatch: ${vectors?.length} vs ${chunk.length}`);
        continue;
      }
      await env.VECTORIZE.upsert(
        chunk.map((x, idx) => ({ id: x.id, values: vectors[idx], metadata: x.metadata }))
      );
    } catch (err: any) {
      console.error("embedWaMessages failed:", err?.message || err);
    }
  }
}
