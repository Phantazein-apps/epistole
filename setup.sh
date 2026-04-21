#!/bin/bash
set -e

echo "=== Epistole Setup ==="
echo ""

# Check wrangler is available
if ! command -v npx &> /dev/null; then
  echo "Error: npx not found. Install Node.js first."
  exit 1
fi

echo "Creating Cloudflare resources..."
echo ""

# 1. D1 Database
echo "→ Creating D1 database 'email-mcp'..."
D1_OUTPUT=$(npx wrangler d1 create email-mcp 2>&1) || true
D1_ID=$(echo "$D1_OUTPUT" | grep -o 'database_id = "[^"]*"' | head -1 | cut -d'"' -f2)

if [ -z "$D1_ID" ]; then
  echo "  D1 database may already exist. Checking..."
  D1_ID=$(npx wrangler d1 list 2>&1 | grep email-mcp | grep -o '[0-9a-f-]\{36\}' | head -1)
fi

if [ -n "$D1_ID" ]; then
  echo "  D1 ID: $D1_ID"
  # Update wrangler.toml with the database ID
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/database_id = \"\"/database_id = \"$D1_ID\"/" wrangler.toml
  else
    sed -i "s/database_id = \"\"/database_id = \"$D1_ID\"/" wrangler.toml
  fi
else
  echo "  Warning: Could not determine D1 database ID. Update wrangler.toml manually."
fi

# 2. Initialize D1 schema
echo "→ Initializing D1 schema..."
npx wrangler d1 execute email-mcp --remote --file=schema.sql 2>&1 || echo "  Schema may already exist."

# 3. R2 Bucket
echo "→ Creating R2 bucket 'email-attachments'..."
npx wrangler r2 bucket create email-attachments 2>&1 || echo "  Bucket may already exist."

# 4. Vectorize Index
echo "→ Creating Vectorize index 'email-embeddings'..."
npx wrangler vectorize create email-embeddings --dimensions=768 --metric=cosine 2>&1 || echo "  Index may already exist."

echo ""
echo "=== Resources created ==="
echo ""
echo "Now set your secrets:"
echo ""
echo "  npx wrangler secret put IMAP_HOST"
echo "  npx wrangler secret put IMAP_PORT"
echo "  npx wrangler secret put IMAP_USER"
echo "  npx wrangler secret put IMAP_PASS"
echo "  npx wrangler secret put SMTP_HOST"
echo "  npx wrangler secret put SMTP_PORT"
echo "  npx wrangler secret put SMTP_USER"
echo "  npx wrangler secret put SMTP_PASS"
echo "  npx wrangler secret put EMAIL_ADDRESS"
echo "  npx wrangler secret put FULL_NAME"
echo "  npx wrangler secret put MCP_TOKEN"
echo ""
echo "Optional — set only if you want the WhatsApp bridge endpoint"
echo "(see README → WhatsApp bridge):"
echo ""
echo "  npx wrangler secret put WA_BRIDGE_TOKEN"
echo ""
echo "Then deploy:"
echo ""
echo "  npx wrangler deploy"
echo ""
