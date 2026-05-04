# Deprecated — WhatsApp bridge (BETA)

This directory holds the WhatsApp mirror that Epistole used to expose alongside
its email tools. It accepted one-way pushes from
[Hermeneia](https://github.com/Phantazein-apps/hermeneia) (a desktop-only
WhatsApp MCP) and made the mirrored history searchable via `semantic_search`
and the `wa_*` MCP tools.

It is **not** registered with the Worker anymore. The code is preserved in case
we revive it. If you don't plan to revive it, delete this directory.

## What's here

```
deprecated/
├── src/
│   ├── tools/whatsapp.ts   # 8 wa_* MCP tools
│   └── wa/
│       ├── handler.ts      # POST /api/wa/push, /api/wa/heartbeat
│       ├── ingest.ts       # D1 upserts for accounts/chats/messages/contacts
│       └── embed.ts        # Vectorize embedding for WA messages
└── migrations/
    └── 0001_whatsapp.sql   # wa_accounts, wa_chats, wa_messages, wa_contacts
```

## What was removed from the live code

- `registerWhatsAppTools(...)` calls in `src/index.ts` and `src/mcp.ts`.
- The `/api/wa` route mount + `waHandler` import in `src/auth-handler.ts`.
- The `WA_BRIDGE_TOKEN` field on `Env` in `src/types.ts`.
- The `wa_*` table block in `schema.sql`.
- WhatsApp branches in `src/tools/search.ts` (`semantic_search` no longer
  accepts `channel`, `wa_account`, `wa_chat_jid`; it only ranks email vectors
  and skips any leftover `wa:*` ids).
- WhatsApp prompts in `install.sh` and `setup.sh`.
- The WhatsApp bridge section of `README.md`.

## To revive

1. Move files back:
   ```bash
   git mv deprecated/src/wa src/wa
   git mv deprecated/src/tools/whatsapp.ts src/tools/whatsapp.ts
   git mv deprecated/migrations/0001_whatsapp.sql migrations/0001_whatsapp.sql
   ```
2. Restore the changes listed above (the commit that introduced this directory
   contains the full diff — revert it as a starting point).
3. Apply the migration on existing deployments:
   ```bash
   npx wrangler d1 execute email-mcp --remote --file=migrations/0001_whatsapp.sql
   npx wrangler secret put WA_BRIDGE_TOKEN
   npx wrangler deploy
   ```

## Existing deployments

This change does **not** drop the `wa_*` tables on already-deployed Workers.
They become orphaned (no code reads or writes to them). Drop them manually if
you want to reclaim space:

```bash
npx wrangler d1 execute email-mcp --remote --command="DROP TABLE IF EXISTS wa_messages; DROP TABLE IF EXISTS wa_chats; DROP TABLE IF EXISTS wa_contacts; DROP TABLE IF EXISTS wa_accounts;"
```

Vectorize entries with `wa:*` ids likewise remain until manually deleted; they
are skipped at query time by `semantic_search`.
