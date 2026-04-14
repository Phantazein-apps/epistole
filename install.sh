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
echo -e "${DIM}  Deployed as a Cloudflare Worker${NC}"
echo ""

# ── Check dependencies ──────────────────────────────────────────────────
header "Checking dependencies"

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org"
fi
ok "Node.js $(node --version)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. Install Node.js from https://nodejs.org"
fi
ok "npm $(npm --version)"

# npx (comes with npm 5.2+)
if ! command -v npx &>/dev/null; then
  fail "npx not found. Update npm: npm install -g npm"
fi
ok "npx available"

# Wrangler — install globally if not available
if ! command -v wrangler &>/dev/null; then
  info "Installing wrangler globally..."
  npm install -g wrangler 2>&1 | tail -1
  if ! command -v wrangler &>/dev/null; then
    fail "wrangler install failed. Run 'npm install -g wrangler' manually."
  fi
fi
ok "wrangler $(wrangler --version 2>&1 | head -1)"

# Check Cloudflare auth
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

# Username defaults to email
ask "Username [${EMAIL_ADDRESS}]:"; read IMAP_USER
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

secret "Password:"
EMAIL_PASS="$REPLY"

# SMTP credentials — same as IMAP unless specified
SMTP_USER="$IMAP_USER"
SMTP_PASS="$EMAIL_PASS"

# ── Generate MCP token ──────────────────────────────────────────────────
MCP_TOKEN=$(openssl rand -hex 32)
ok "Generated MCP auth token"

# ── Create Cloudflare resources ─────────────────────────────────────────
header "Creating Cloudflare resources"

# D1
info "Creating D1 database..."
D1_OUTPUT=$(wrangler d1 create email-mcp 2>&1) || true
D1_ID=$(echo "$D1_OUTPUT" | grep -o 'database_id = "[^"]*"' | head -1 | cut -d'"' -f2)
if [ -z "$D1_ID" ]; then
  D1_ID=$(wrangler d1 list 2>&1 | grep email-mcp | grep -o '[0-9a-f-]\{36\}' | head -1)
fi
if [ -n "$D1_ID" ]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/database_id = \"[^\"]*\"/database_id = \"$D1_ID\"/" wrangler.toml
  else
    sed -i "s/database_id = \"[^\"]*\"/database_id = \"$D1_ID\"/" wrangler.toml
  fi
  ok "D1 database ready"
else
  warn "Could not determine D1 ID — check wrangler.toml manually"
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

# ── Set secrets ─────────────────────────────────────────────────────────
header "Setting secrets"

set_secret() {
  echo "$2" | wrangler secret put "$1" &>/dev/null 2>&1
  ok "$1"
}

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
set_secret "MCP_TOKEN" "$MCP_TOKEN"

ok "All 11 secrets set (encrypted in Cloudflare)"

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
  # Remove any protocol prefix and trailing slash
  CUSTOM_DOMAIN=$(echo "$CUSTOM_DOMAIN" | sed 's|^https\?://||' | sed 's|/$||')

  # Extract the root domain (last two segments, or last three for co.uk etc.)
  ROOT_DOMAIN=$(echo "$CUSTOM_DOMAIN" | awk -F. '{if (NF>=2) print $(NF-1)"."$NF; else print $0}')

  # Check if the root domain exists in the user's Cloudflare account
  info "Checking if ${ROOT_DOMAIN} is in your Cloudflare account..."
  ZONE_CHECK=$(wrangler dns list-zones 2>&1 || true)

  if echo "$ZONE_CHECK" | grep -qi "$ROOT_DOMAIN"; then
    ok "Zone found: $ROOT_DOMAIN"
  else
    # Fallback: try the API directly via wrangler
    ZONE_API=$(node -e "
      const { execSync } = require('child_process');
      try {
        const out = execSync('wrangler whoami 2>&1', { encoding: 'utf8' });
        console.log('auth_ok');
      } catch { console.log('auth_fail'); }
    " 2>/dev/null)

    # Try deploying anyway — wrangler deploy will give a clear error if the domain isn't available
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
    # Add route to wrangler.toml
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
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -o 'https://[^ ]*\.workers\.dev' | head -1)

# Check for custom domain errors
if [ $DEPLOY_EXIT -ne 0 ] && [ -n "$CUSTOM_DOMAIN" ]; then
  if echo "$DEPLOY_OUTPUT" | grep -qi "domain\|zone\|DNS\|conflict\|ownership"; then
    echo ""
    echo -e "${RED}Deploy failed — custom domain error:${NC}"
    echo "$DEPLOY_OUTPUT" | grep -i "domain\|zone\|DNS\|conflict\|ownership\|error" | head -5
    echo ""
    warn "This usually means:"
    echo -e "  ${DIM}• The root domain (${ROOT_DOMAIN}) is not in your Cloudflare account${NC}"
    echo -e "  ${DIM}• Another Worker is already using this domain${NC}"
    echo -e "  ${DIM}• The subdomain conflicts with an existing DNS record${NC}"
    echo ""
    ask "Retry without custom domain? [Y/n]"
    read RETRY_NO_DOMAIN
    RETRY_NO_DOMAIN="${RETRY_NO_DOMAIN:-Y}"
    if [[ "$RETRY_NO_DOMAIN" =~ ^[Yy] ]]; then
      # Remove the routes block from wrangler.toml
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

# Use custom domain if set
if [ -n "$CUSTOM_DOMAIN" ]; then
  WORKER_URL="https://${CUSTOM_DOMAIN}"
  ok "Custom domain active: $WORKER_URL"
fi

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
        "${MCP_ENDPOINT}",
        "--header",
        "Authorization: Bearer ${MCP_TOKEN}"
      ]
    }
  }
}
JSONEOF
)

echo ""

# Check if config file exists and has mcpServers
if [ -f "$CONFIG_FILE" ]; then
  # Check if it already has an "email" server
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
      # Read existing config, merge mcpServers
      EXISTING=$(cat "$CONFIG_FILE")
      if echo "$EXISTING" | grep -q '"mcpServers"'; then
        # Has mcpServers — inject our server into it
        # Use node for reliable JSON manipulation
        node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
          cfg.mcpServers = cfg.mcpServers || {};
          cfg.mcpServers.email = {
            command: 'npx',
            args: ['mcp-remote', '${MCP_ENDPOINT}', '--header', 'Authorization: Bearer ${MCP_TOKEN}']
          };
          fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
        "
        ok "Added 'email' server to Claude Desktop config"
      else
        # No mcpServers key — add it
        node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
          cfg.mcpServers = {
            email: {
              command: 'npx',
              args: ['mcp-remote', '${MCP_ENDPOINT}', '--header', 'Authorization: Bearer ${MCP_TOKEN}']
            }
          };
          fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
        "
        ok "Added 'email' server to Claude Desktop config"
      fi
    else
      echo ""
      echo "Add this to $CONFIG_FILE:"
      echo ""
      echo "$CONFIG_SNIPPET"
    fi
  fi
else
  # Create the config file
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
echo -e "  ┌─────────────────────────────────────────────────────┐"
echo -e "  │  ${BOLD}MCP Endpoint${NC}                                        │"
echo -e "  │  ${CYAN}${MCP_ENDPOINT}${NC}"
echo -e "  │                                                     │"
echo -e "  │  ${BOLD}Auth Header${NC}                                         │"
echo -e "  │  ${DIM}Authorization: Bearer ${MCP_TOKEN:0:12}...${NC}"
echo -e "  │                                                     │"
echo -e "  │  ${BOLD}Full Token${NC} (save this — shown only once)            │"
echo -e "  │  ${DIM}${MCP_TOKEN}${NC}"
echo -e "  └─────────────────────────────────────────────────────┘"
echo ""
echo -e "  ${BOLD}Use with any MCP client:${NC}"
echo -e "  The endpoint above works with any app that supports"
echo -e "  remote MCP servers (Streamable HTTP transport)."
echo -e "  Pass the URL and the Authorization header."
echo ""
echo -e "  ${BOLD}Claude Desktop:${NC} $([ -f "$CONFIG_FILE" ] && echo -e "${GREEN}configured ✓${NC}" || echo -e "${YELLOW}see config above${NC}")"
echo -e "  ${BOLD}Claude Code:${NC}    Add via ${DIM}claude mcp add email -- npx mcp-remote ${MCP_ENDPOINT} --header \"Authorization: Bearer ${MCP_TOKEN:0:12}...\"${NC}"
echo -e "  ${BOLD}Other clients:${NC}  Point any MCP client at the endpoint with the auth header"
echo ""

header "What happens next"

echo ""
echo -e "  ${BOLD}Right now:${NC} Live email tools work immediately."
echo -e "  Try asking Claude: ${DIM}\"Show my recent emails\"${NC} or ${DIM}\"List my folders\"${NC}"
echo ""
echo -e "  ${BOLD}Semantic search:${NC} Not ready yet — you need to build the index first."
echo -e "  Ask Claude: ${DIM}\"Sync my email now\"${NC}"
echo -e "  This fetches all your messages, generates embeddings, and indexes them."
echo -e "  The first sync may take a few minutes depending on mailbox size."
echo ""
echo -e "  ${BOLD}Check progress:${NC} Ask Claude: ${DIM}\"What's my email sync status?\"${NC}"
echo -e "  It will show how many messages are indexed and any errors."
echo ""
echo -e "  ${BOLD}After the first sync:${NC} semantic search is ready."
echo -e "  Try: ${DIM}\"Find emails about invoices from January\"${NC}"
echo -e "  New emails are synced automatically every 15 minutes."
echo ""
echo -e "  ${DIM}Server files: $INSTALL_DIR${NC}"
echo -e "  ${DIM}Credentials are encrypted as Cloudflare Worker secrets (never stored locally).${NC}"
echo ""
