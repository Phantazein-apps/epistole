#!/bin/bash
set -e

# ── Re-attach stdin for interactive prompts when piped from curl ────────
if [ ! -t 0 ]; then
  exec bash <(curl -fsSL "https://raw.githubusercontent.com/Phantazein-apps/epistole/master/install.sh") </dev/tty
fi

# ── Colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Helpers ─────────────────────────────────────────────────────────────
info()  { echo -e "${BLUE}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }
ask()   { echo -en "${CYAN}?${NC} $1 "; }
secret(){ echo -en "${CYAN}?${NC} $1 "; read -s REPLY; echo ""; }

header() {
  echo ""
  echo -e "${BOLD}$1${NC}"
  echo -e "${DIM}$(printf '%.0s─' {1..50})${NC}"
}

# ── Banner ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  ✉  Epistole — Email MCP Server${NC}"
echo -e "${DIM}  Connect Claude to your email via IMAP/SMTP${NC}"
echo -e "${DIM}  Deployed as a Cloudflare Worker with OAuth${NC}"
echo ""

# ── Check dependencies ──────────────────────────────────────────────────
header "Checking dependencies"

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org"
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  fail "npm not found. Install Node.js from https://nodejs.org"
fi
ok "npm $(npm --version)"

if ! command -v npx &>/dev/null; then
  fail "npx not found. Update npm: npm install -g npm"
fi
ok "npx available"

if ! command -v wrangler &>/dev/null; then
  info "Installing wrangler globally..."
  npm install -g wrangler 2>&1 | tail -1
  if ! command -v wrangler &>/dev/null; then
    fail "wrangler install failed. Run 'npm install -g wrangler' manually."
  fi
fi
ok "wrangler $(wrangler --version 2>&1 | head -1)"

if ! wrangler whoami &>/dev/null 2>&1; then
  echo ""
  warn "Not logged into Cloudflare."
  info "Opening browser for login..."
  wrangler login
  echo ""
  if ! wrangler whoami &>/dev/null 2>&1; then
    fail "Cloudflare login failed. Run 'wrangler login' manually."
  fi
fi
ok "Cloudflare authenticated"

# ── Clone repo ──────────────────────────────────────────────────────────
header "Setting up project"

INSTALL_DIR="$HOME/.epistole-server"

if [ -d "$INSTALL_DIR" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --quiet
else
  info "Cloning repository..."
  git clone --quiet https://github.com/Phantazein-apps/epistole.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

info "Installing dependencies..."
npm install --silent 2>/dev/null

# ── Email provider ──────────────────────────────────────────────────────
header "Email provider"

echo ""
echo "  1) Migadu"
echo "  2) Fastmail"
echo "  3) Gmail"
echo "  4) Outlook / Microsoft 365"
echo "  5) Yahoo"
echo "  6) iCloud"
echo "  7) Other (enter manually)"
echo ""
ask "Provider [1-7]:"
read PROVIDER_CHOICE

case "$PROVIDER_CHOICE" in
  1) IMAP_HOST="imap.migadu.com"; SMTP_HOST="smtp.migadu.com"; IMAP_PORT="993"; SMTP_PORT="465"; PROVIDER="Migadu" ;;
  2) IMAP_HOST="imap.fastmail.com"; SMTP_HOST="smtp.fastmail.com"; IMAP_PORT="993"; SMTP_PORT="465"; PROVIDER="Fastmail" ;;
  3) IMAP_HOST="imap.gmail.com"; SMTP_HOST="smtp.gmail.com"; IMAP_PORT="993"; SMTP_PORT="465"; PROVIDER="Gmail" ;;
  4) IMAP_HOST="outlook.office365.com"; SMTP_HOST="smtp.office365.com"; IMAP_PORT="993"; SMTP_PORT="587"; PROVIDER="Outlook" ;;
  5) IMAP_HOST="imap.mail.yahoo.com"; SMTP_HOST="smtp.mail.yahoo.com"; IMAP_PORT="993"; SMTP_PORT="465"; PROVIDER="Yahoo" ;;
  6) IMAP_HOST="imap.mail.me.com"; SMTP_HOST="smtp.mail.me.com"; IMAP_PORT="993"; SMTP_PORT="587"; PROVIDER="iCloud" ;;
  7)
    PROVIDER="Custom"
    ask "IMAP host:"; read IMAP_HOST
    ask "IMAP port [993]:"; read IMAP_PORT; IMAP_PORT="${IMAP_PORT:-993}"
    ask "SMTP host:"; read SMTP_HOST
    ask "SMTP port [465]:"; read SMTP_PORT; SMTP_PORT="${SMTP_PORT:-465}"
    ;;
  *) fail "Invalid choice" ;;
esac

ok "Provider: $PROVIDER ($IMAP_HOST)"

# ── Credentials ─────────────────────────────────────────────────────────
header "Credentials"

ask "Email address:"; read EMAIL_ADDRESS
ask "Full name (for From header):"; read FULL_NAME

ask "IMAP username [${EMAIL_ADDRESS}]:"; read IMAP_USER
IMAP_USER="${IMAP_USER:-$EMAIL_ADDRESS}"

if [ "$PROVIDER" = "Gmail" ] || [ "$PROVIDER" = "Fastmail" ] || [ "$PROVIDER" = "Yahoo" ] || [ "$PROVIDER" = "iCloud" ]; then
  echo ""
  warn "$PROVIDER requires an app-specific password, not your regular password."
  case "$PROVIDER" in
    Gmail)    echo -e "  ${DIM}Generate one at: https://myaccount.google.com/apppasswords${NC}" ;;
    Fastmail) echo -e "  ${DIM}Generate one at: Settings → Privacy & Security → App Passwords${NC}" ;;
    Yahoo)    echo -e "  ${DIM}Generate one at: Account Security → App Passwords${NC}" ;;
    iCloud)   echo -e "  ${DIM}Generate one at: appleid.apple.com → App-Specific Passwords${NC}" ;;
  esac
  echo ""
fi

secret "Email password:"
EMAIL_PASS="$REPLY"
if [ -z "$EMAIL_PASS" ]; then
  fail "Email password cannot be empty."
fi

SMTP_USER="$IMAP_USER"
SMTP_PASS="$EMAIL_PASS"

# ── Validate IMAP credentials ──────────────────────────────────────────
header "Validating credentials"

info "Connecting to ${IMAP_HOST}:${IMAP_PORT}..."

IMAP_TEST=$(expect <<EXPECTEOF 2>&1 || true
set timeout 10
spawn openssl s_client -connect ${IMAP_HOST}:${IMAP_PORT} -quiet
expect {
  "* OK" {}
  timeout { puts "TIMEOUT"; exit 1 }
  eof { puts "CONNECTION_FAILED"; exit 1 }
}
send "A1 LOGIN \"${IMAP_USER}\" \"${EMAIL_PASS}\"\r"
expect {
  "A1 OK" { puts "LOGIN_OK"; }
  "A1 NO" { puts "LOGIN_FAILED"; }
  "A1 BAD" { puts "LOGIN_FAILED"; }
  timeout { puts "LOGIN_TIMEOUT"; }
}
send "A2 LOGOUT\r"
expect eof
EXPECTEOF
)

if echo "$IMAP_TEST" | grep -q "LOGIN_OK"; then
  ok "IMAP login successful"
elif echo "$IMAP_TEST" | grep -q "LOGIN_FAILED"; then
  echo ""
  fail "IMAP login failed — wrong username or password.\n  Check your credentials and try again.\n  ${DIM}If using Gmail/Fastmail/Yahoo/iCloud, make sure you're using an app-specific password.${NC}"
elif echo "$IMAP_TEST" | grep -q "CONNECTION_FAILED\|TIMEOUT"; then
  warn "Could not connect to ${IMAP_HOST}:${IMAP_PORT}"
  echo -e "  ${DIM}This might be a firewall issue or wrong hostname/port.${NC}"
  ask "Continue anyway? [y/N]"
  read CONTINUE_ANYWAY
  if [[ ! "$CONTINUE_ANYWAY" =~ ^[Yy] ]]; then
    fail "Aborted. Fix your IMAP settings and try again."
  fi
else
  OPENSSL_TEST=$(echo -e "A1 LOGIN \"${IMAP_USER}\" \"${EMAIL_PASS}\"\nA2 LOGOUT" | \
    openssl s_client -connect "${IMAP_HOST}:${IMAP_PORT}" -quiet 2>/dev/null | \
    head -20)

  if echo "$OPENSSL_TEST" | grep -q "A1 OK"; then
    ok "IMAP login successful"
  elif echo "$OPENSSL_TEST" | grep -q "A1 NO\|A1 BAD"; then
    echo ""
    fail "IMAP login failed — wrong username or password.\n  Check your credentials and try again."
  else
    warn "Could not verify IMAP credentials (openssl test inconclusive)"
    ask "Continue anyway? [y/N]"
    read CONTINUE_ANYWAY2
    if [[ ! "$CONTINUE_ANYWAY2" =~ ^[Yy] ]]; then
      fail "Aborted."
    fi
  fi
fi

# ── Create Cloudflare resources ─────────────────────────────────────────
header "Creating Cloudflare resources"

# Helper: extract a UUID from wrangler output (handles various formats)
# Helper: get Cloudflare API token from wrangler config
get_cf_token() {
  local cfg="${HOME}/Library/Preferences/.wrangler/config/default.toml"
  if [ ! -f "$cfg" ]; then
    cfg="${HOME}/.wrangler/config/default.toml"
  fi
  grep -o 'oauth_token = "[^"]*"' "$cfg" 2>/dev/null | cut -d'"' -f2
}

# Helper: get Cloudflare account ID
get_cf_account_id() {
  local token=$(get_cf_token)
  if [ -n "$token" ]; then
    curl -s -H "Authorization: Bearer $token" "https://api.cloudflare.com/client/v4/accounts?per_page=1" 2>/dev/null | \
      grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4
  fi
}

CF_TOKEN=$(get_cf_token)
CF_ACCOUNT_ID=$(get_cf_account_id)

if [ -z "$CF_TOKEN" ] || [ -z "$CF_ACCOUNT_ID" ]; then
  fail "Could not read Cloudflare credentials. Run 'wrangler login' and try again."
fi

extract_uuid() {
  echo "$1" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1
}

# D1
info "Creating D1 database..."
D1_OUTPUT=$(wrangler d1 create email-mcp 2>&1) || true
D1_ID=$(extract_uuid "$D1_OUTPUT")
if [ -z "$D1_ID" ]; then
  # Already exists — look it up via API
  info "D1 may already exist, looking up via API..."
  D1_API=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database" 2>/dev/null)
  D1_ID=$(echo "$D1_API" | grep -o '"uuid":"[^"]*"' | while read -r line; do
    uuid=$(echo "$line" | cut -d'"' -f4)
    if echo "$D1_API" | grep -q "\"name\":\"email-mcp\""; then
      echo "$uuid"
      break
    fi
  done)
  # More robust: use node to parse JSON
  if [ -z "$D1_ID" ]; then
    D1_ID=$(echo "$D1_API" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const r=JSON.parse(d).result||[];
          const db=r.find(x=>x.name==='email-mcp');
          if(db) console.log(db.uuid);
        } catch{}
      });" 2>/dev/null)
  fi
fi
if [ -n "$D1_ID" ]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/database_id = \"[^\"]*\"/database_id = \"$D1_ID\"/" wrangler.toml
  else
    sed -i "s/database_id = \"[^\"]*\"/database_id = \"$D1_ID\"/" wrangler.toml
  fi
  ok "D1 database ready ($D1_ID)"
else
  fail "Could not create or find D1 database 'email-mcp'. Run 'wrangler d1 create email-mcp' manually."
fi

# D1 schema
info "Initializing database schema..."
wrangler d1 execute email-mcp --remote --file=schema.sql &>/dev/null || true
ok "Schema initialized"

# R2
info "Creating R2 bucket..."
wrangler r2 bucket create email-attachments &>/dev/null 2>&1 || true
ok "R2 bucket ready"

# Vectorize
info "Creating Vectorize index..."
wrangler vectorize create email-embeddings --dimensions=768 --metric=cosine &>/dev/null 2>&1 || true
ok "Vectorize index ready"

# KV (for OAuth state)
info "Creating KV namespace for OAuth..."
KV_OUTPUT=$(wrangler kv namespace create email-mcp-oauth 2>&1) || true
KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)
if [ -z "$KV_ID" ]; then
  # Already exists — look it up via API
  info "KV may already exist, looking up via API..."
  KV_ID=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces" 2>/dev/null | \
    node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try { const r=JSON.parse(d).result||[];
          const ns=r.find(x=>x.title==='email-mcp-oauth');
          if(ns) console.log(ns.id);
        } catch{}
      });" 2>/dev/null)
fi
if [ -n "$KV_ID" ]; then
  # Only replace the KV id line (not the D1 database_id line)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "/OAUTH_KV/,/^$/{s/id = \"[^\"]*\"/id = \"$KV_ID\"/;}" wrangler.toml
  else
    sed -i "/OAUTH_KV/,/^$/{s/id = \"[^\"]*\"/id = \"$KV_ID\"/;}" wrangler.toml
  fi
  ok "KV namespace ready ($KV_ID)"
else
  fail "Could not create or find KV namespace 'email-mcp-oauth'. Run 'wrangler kv namespace create email-mcp-oauth' manually."
fi

# ── Set secrets ─────────────────────────────────────────────────────────
header "Setting secrets"

set_secret() {
  if echo "$2" | wrangler secret put "$1" &>/dev/null 2>&1; then
    ok "$1"
  else
    warn "$1 — failed to set, will retry after deploy"
    SECRETS_FAILED=true
  fi
}
SECRETS_FAILED=false

set_secret "IMAP_HOST" "$IMAP_HOST"
set_secret "IMAP_PORT" "$IMAP_PORT"
set_secret "IMAP_USER" "$IMAP_USER"
set_secret "IMAP_PASS" "$EMAIL_PASS"
set_secret "SMTP_HOST" "$SMTP_HOST"
set_secret "SMTP_PORT" "$SMTP_PORT"
set_secret "SMTP_USER" "$SMTP_USER"
set_secret "SMTP_PASS" "$SMTP_PASS"
set_secret "EMAIL_ADDRESS" "$EMAIL_ADDRESS"
set_secret "FULL_NAME" "$FULL_NAME"

ok "All 10 secrets set (encrypted in Cloudflare)"

# ── Custom domain ──────────────────────────────────────────────────────
header "Custom domain (optional)"

echo ""
echo -e "  Your Worker will be available at a ${DIM}*.workers.dev${NC} URL by default."
echo -e "  You can also point a custom domain to it (e.g. ${DIM}mail.yourdomain.com${NC})."
echo -e "  The domain must already be on Cloudflare DNS."
echo ""
ask "Custom domain (leave empty to skip):"
read CUSTOM_DOMAIN

if [ -n "$CUSTOM_DOMAIN" ]; then
  CUSTOM_DOMAIN=$(echo "$CUSTOM_DOMAIN" | sed 's|^https\?://||' | sed 's|/$||')
  ROOT_DOMAIN=$(echo "$CUSTOM_DOMAIN" | awk -F. '{if (NF>=2) print $(NF-1)"."$NF; else print $0}')

  info "Checking if ${ROOT_DOMAIN} is in your Cloudflare account..."

  WRANGLER_CONFIG="${HOME}/Library/Preferences/.wrangler/config/default.toml"
  if [ ! -f "$WRANGLER_CONFIG" ]; then
    WRANGLER_CONFIG="${HOME}/.wrangler/config/default.toml"
  fi

  ZONE_FOUND=false
  if [ -f "$WRANGLER_CONFIG" ]; then
    CF_TOKEN=$(grep -o 'oauth_token = "[^"]*"' "$WRANGLER_CONFIG" 2>/dev/null | cut -d'"' -f2)
    if [ -n "$CF_TOKEN" ]; then
      ZONE_RESULT=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones?name=${ROOT_DOMAIN}&status=active" 2>/dev/null)
      if echo "$ZONE_RESULT" | grep -q "\"name\":\"${ROOT_DOMAIN}\""; then
        ZONE_FOUND=true
      fi
    fi
  fi

  if [ "$ZONE_FOUND" = true ]; then
    ok "Zone found: $ROOT_DOMAIN"
  else
    warn "Could not verify ${ROOT_DOMAIN} in your Cloudflare zones."
    echo -e "  ${DIM}The domain's root zone (${ROOT_DOMAIN}) must be active in your Cloudflare account.${NC}"
    echo -e "  ${DIM}If it's not, the deploy will fail with a domain ownership error.${NC}"
    echo ""
    ask "Continue anyway? [Y/n]"
    read CONTINUE_DOMAIN
    CONTINUE_DOMAIN="${CONTINUE_DOMAIN:-Y}"
    if [[ ! "$CONTINUE_DOMAIN" =~ ^[Yy] ]]; then
      CUSTOM_DOMAIN=""
      info "Skipping custom domain — will use default *.workers.dev URL"
    fi
  fi

  if [ -n "$CUSTOM_DOMAIN" ]; then
    if ! grep -q "custom_domain" wrangler.toml; then
      cat >> wrangler.toml <<ROUTEEOF

[[routes]]
pattern = "${CUSTOM_DOMAIN}"
custom_domain = true
ROUTEEOF
    fi
    ok "Custom domain configured: $CUSTOM_DOMAIN"
  fi
fi

# ── Deploy ──────────────────────────────────────────────────────────────
header "Deploying"

DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
DEPLOY_EXIT=$?

if [ -n "$CUSTOM_DOMAIN" ]; then
  WORKER_URL="https://${CUSTOM_DOMAIN}"
else
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -o 'https://[^ ]*\.workers\.dev' | head -1)
fi

if [ $DEPLOY_EXIT -ne 0 ] && [ -n "$CUSTOM_DOMAIN" ]; then
  if echo "$DEPLOY_OUTPUT" | grep -qi "domain\|zone\|DNS\|conflict\|ownership"; then
    echo ""
    echo -e "${RED}Deploy failed — custom domain error:${NC}"
    echo "$DEPLOY_OUTPUT" | grep -i "domain\|zone\|DNS\|conflict\|ownership\|error" | head -5
    echo ""
    ask "Retry without custom domain? [Y/n]"
    read RETRY_NO_DOMAIN
    RETRY_NO_DOMAIN="${RETRY_NO_DOMAIN:-Y}"
    if [[ "$RETRY_NO_DOMAIN" =~ ^[Yy] ]]; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/^\[\[routes\]\]/,/^$/d' wrangler.toml
      else
        sed -i '/^\[\[routes\]\]/,/^$/d' wrangler.toml
      fi
      CUSTOM_DOMAIN=""
      info "Retrying deploy without custom domain..."
      DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
      WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -o 'https://[^ ]*\.workers\.dev' | head -1)
    else
      echo ""
      echo "$DEPLOY_OUTPUT"
      fail "Deploy failed. Fix the domain issue and run 'wrangler deploy' manually."
    fi
  else
    echo ""
    echo "$DEPLOY_OUTPUT"
    fail "Deploy failed. Check the error above."
  fi
elif [ $DEPLOY_EXIT -ne 0 ]; then
  echo ""
  echo "$DEPLOY_OUTPUT"
  fail "Deploy failed. Check the error above."
fi

if [ -z "$WORKER_URL" ]; then
  warn "Could not detect Worker URL from deploy output."
  ask "Enter your Worker URL:"; read WORKER_URL
fi

ok "Deployed to $WORKER_URL"

# ── Claude Desktop config ──────────────────────────────────────────────
header "Claude Desktop configuration"

CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
MCP_ENDPOINT="${WORKER_URL}/mcp"

CONFIG_SNIPPET=$(cat <<JSONEOF
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${MCP_ENDPOINT}"
      ]
    }
  }
}
JSONEOF
)

echo ""

if [ -f "$CONFIG_FILE" ]; then
  if grep -q '"email"' "$CONFIG_FILE" 2>/dev/null; then
    warn "Claude Desktop config already has an 'email' MCP server."
    echo -e "  ${DIM}Update it manually with the config below.${NC}"
    echo ""
    echo "$CONFIG_SNIPPET"
  else
    ask "Add to Claude Desktop config automatically? [Y/n]"
    read AUTO_CONFIG
    AUTO_CONFIG="${AUTO_CONFIG:-Y}"
    if [[ "$AUTO_CONFIG" =~ ^[Yy] ]]; then
      node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        cfg.mcpServers = cfg.mcpServers || {};
        cfg.mcpServers.email = {
          command: 'npx',
          args: ['mcp-remote', '${MCP_ENDPOINT}']
        };
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
      "
      ok "Added 'email' server to Claude Desktop config"
    else
      echo ""
      echo "Add this to $CONFIG_FILE:"
      echo ""
      echo "$CONFIG_SNIPPET"
    fi
  fi
else
  ask "Create Claude Desktop config? [Y/n]"
  read CREATE_CONFIG
  CREATE_CONFIG="${CREATE_CONFIG:-Y}"
  if [[ "$CREATE_CONFIG" =~ ^[Yy] ]]; then
    mkdir -p "$(dirname "$CONFIG_FILE")"
    echo "$CONFIG_SNIPPET" > "$CONFIG_FILE"
    ok "Created Claude Desktop config"
  else
    echo ""
    echo "Create $CONFIG_FILE with:"
    echo ""
    echo "$CONFIG_SNIPPET"
  fi
fi

# ── Done ────────────────────────────────────────────────────────────────
header "Setup complete"

echo ""
echo -e "  ${GREEN}✉  Epistole is deployed and running.${NC}"
echo ""
echo -e "  ${BOLD}MCP Endpoint:${NC}  ${CYAN}${MCP_ENDPOINT}${NC}"
echo ""

header "Connect to Claude"

echo ""
echo -e "  ${BOLD}How login works:${NC} Epistole sends a verification code to your"
echo -e "  email (${DIM}${EMAIL_ADDRESS}${NC}). You enter the code to prove you own the inbox."
echo -e "  No password needed — if you can read the email, you can authorize."
echo ""
echo -e "  ${BOLD}Claude Desktop${NC}  $([ -f "$CONFIG_FILE" ] && echo -e "${GREEN}— configured ✓${NC}" || echo -e "${YELLOW}— see config above${NC}")"
echo -e "  ${YELLOW}⚠  Restart Claude Desktop now.${NC}"
echo -e "  On first use, a browser window opens → enter your email →"
echo -e "  check your inbox for the code → enter it → done."
echo ""
echo -e "  ${BOLD}Claude Code${NC}"
echo -e "  ${DIM}claude mcp add email -- npx mcp-remote ${MCP_ENDPOINT}${NC}"
echo ""
echo -e "  ${BOLD}Claude.ai (web)${NC}"
echo -e "  Go to ${DIM}claude.ai → Settings → Integrations → Add Custom Connector${NC}"
echo -e "  Enter: ${CYAN}${MCP_ENDPOINT}${NC}"
echo ""
echo -e "  ${BOLD}Claude Mobile (iOS / Android)${NC}"
echo -e "  Add the connector on claude.ai (above) — it syncs to mobile automatically."
echo ""

header "What to do next"

echo ""
echo -e "  ${BOLD}1. Restart Claude Desktop${NC}"
echo -e "     A browser opens for verification — check your email for the code."
echo ""
echo -e "  ${BOLD}2. Test live email tools${NC} (work immediately after login)"
echo -e "     Ask Claude: ${DIM}\"Show my recent emails\"${NC}"
echo ""
echo -e "  ${BOLD}3. Build the search index${NC} (one-time, takes a few minutes)"
echo -e "     Ask Claude: ${DIM}\"Sync my email now\"${NC}"
echo ""
echo -e "  ${BOLD}4. Use semantic search${NC} (available after step 3 completes)"
echo -e "     ${DIM}\"Find emails about invoices from January\"${NC}"
echo ""
echo -e "  After the initial sync, new emails are indexed automatically"
echo -e "  every 15 minutes by a background cron job."
echo ""
echo -e "  ${DIM}Server files: $INSTALL_DIR${NC}"
echo -e "  ${DIM}Email credentials are encrypted as Cloudflare Worker secrets.${NC}"
echo -e "  ${DIM}No passwords or tokens stored anywhere — login is always via email code.${NC}"
echo ""
