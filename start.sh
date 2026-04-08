#!/bin/bash
# ═══════════════════════════════════════════════
#  CCTV Dashboard – Startup Script
# ═══════════════════════════════════════════════

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3000
LOG="$DIR/dashboard.log"
PID_FILE="$DIR/dashboard.pid"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        🎥  CCTV Dashboard            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── Check if already running ──────────────────
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo -e "${YELLOW}⚠  Dashboard already running (PID $OLD_PID)${NC}"
    echo -e "   Open: ${CYAN}http://localhost:${PORT}${NC}"
    echo ""
    echo -e "   Run ${RED}./stop.sh${NC} to stop it first."
    echo ""
    exit 0
  else
    rm -f "$PID_FILE"
  fi
fi

# ── Check Node.js ─────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗  Node.js not found. Install it from https://nodejs.org${NC}"
  exit 1
fi

# ── Install dependencies if needed ───────────
if [ ! -d "$DIR/node_modules" ]; then
  echo -e "${YELLOW}📦  Installing dependencies...${NC}"
  cd "$DIR" && npm install --silent
  echo -e "${GREEN}✓  Dependencies installed${NC}"
fi

# ── Start the server ──────────────────────────
cd "$DIR"
echo -e "🚀  Starting server..."
nohup node server.js > "$LOG" 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$PID_FILE"

# ── Wait for it to be ready ───────────────────
echo -n "   Waiting for server"
for i in {1..20}; do
  sleep 0.5
  if curl -s "http://localhost:${PORT}/api/cameras" &>/dev/null; then
    echo ""
    break
  fi
  echo -n "."
done

# ── Verify ────────────────────────────────────
if curl -s "http://localhost:${PORT}/api/cameras" &>/dev/null; then
  echo ""
  echo -e "${GREEN}✓  Dashboard is running!${NC}"
  echo ""
  echo -e "   🌐  ${CYAN}http://localhost:${PORT}${NC}"
  echo -e "   📄  Logs: ${LOG}"
  echo -e "   🛑  Stop: ${YELLOW}./stop.sh${NC}"
  echo ""
  # Open browser automatically
  open "http://localhost:${PORT}" 2>/dev/null || xdg-open "http://localhost:${PORT}" 2>/dev/null || true
else
  echo ""
  echo -e "${RED}✗  Server failed to start. Check logs:${NC}"
  echo -e "   cat ${LOG}"
  echo ""
  cat "$LOG" | tail -20
  rm -f "$PID_FILE"
  exit 1
fi
