#!/usr/bin/env bash
# ── START_BOT.sh ──────────────────────────────────────────────────────────────
# Mac / Linux one-click launcher for Aladdin Trading Bot.
# Double-click in Finder/Files, or run:  bash START_BOT.sh
#
# On Mac: right-click → Open  (first time only, to bypass Gatekeeper)
# On Linux: chmod +x START_BOT.sh first, then double-click or ./START_BOT.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
CYAN='\033[0;36m';  BOLD='\033[1m';      RESET='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${RESET}"; }
warn() { echo -e "${YELLOW}⚠️  $1${RESET}"; }
err()  { echo -e "${RED}❌ $1${RESET}"; }
info() { echo -e "${CYAN}ℹ️  $1${RESET}"; }

clear
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║          🤖  ALADDIN TRADING BOT — LAUNCHER              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${RESET}"

# ── Move to bot directory ─────────────────────────────────────────────────────
cd "$(dirname "$0")"

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
    err "Node.js is not installed."
    info "Install with: brew install node  (Mac)"
    info "Or download:  https://nodejs.org"
    # Try to open browser
    open "https://nodejs.org" 2>/dev/null || xdg-open "https://nodejs.org" 2>/dev/null || true
    read -p "Press Enter to exit..."
    exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
    err "Node.js v18+ required. You have v$(node -v)."
    info "Update: brew upgrade node  (Mac)"
    read -p "Press Enter to exit..."
    exit 1
fi
ok "Node.js $(node -v)"

# ── Install dependencies if needed ───────────────────────────────────────────
if [ ! -d "node_modules/express" ]; then
    info "Installing dependencies (first run — takes ~30 seconds)..."
    npm install --ignore-scripts
    ok "Dependencies installed"
else
    ok "Dependencies ready"
fi

# ── .env setup ────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp ".env.example" ".env"
        warn ".env created from .env.example"
        warn "Edit .env with your OANDA API keys before live trading!"
        echo ""
        # Open in default editor
        if command -v open &>/dev/null; then
            open ".env"                         # Mac: opens in TextEdit
        elif command -v xdg-open &>/dev/null; then
            xdg-open ".env"                     # Linux: opens in default editor
        else
            echo "Please open and edit: $(pwd)/.env"
        fi
        echo ""
        read -p "Press Enter when you have saved your .env file..."
    fi
fi
ok ".env found"

# ── Create required directories ───────────────────────────────────────────────
mkdir -p trade_logs backups config
ok "Directories ready"

# ── Show mode ────────────────────────────────────────────────────────────────
PAPER_MODE=$(grep -E '^PAPER_MODE=' .env 2>/dev/null | cut -d= -f2 | tr -d ' ')
if [ "$PAPER_MODE" = "true" ]; then
    ok "Paper mode ON (no real money)"
else
    warn "LIVE TRADING MODE — real money at risk!"
fi

echo ""
echo -e "${BOLD}Starting Aladdin Bot...${RESET}"
echo ""
echo "  📊 Dashboard : http://localhost:3000"
echo "  💚 Health    : http://localhost:8080/health"
echo "  📈 Status    : http://localhost:8080/status"
echo ""
echo "  Press Ctrl+C to stop all processes."
echo ""

# ── Launch ────────────────────────────────────────────────────────────────────
exec node launch.js
