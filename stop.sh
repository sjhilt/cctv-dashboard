#!/bin/bash
# ═══════════════════════════════════════════════
#  CCTV Dashboard – Stop Script
# ═══════════════════════════════════════════════

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/dashboard.pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    rm -f "$PID_FILE"
    echo -e "${GREEN}✓  CCTV Dashboard stopped (PID $PID)${NC}"
  else
    echo -e "${YELLOW}⚠  Process $PID not found (already stopped?)${NC}"
    rm -f "$PID_FILE"
  fi
else
  # Fallback: kill by process name
  if pkill -f "node server.js" 2>/dev/null; then
    echo -e "${GREEN}✓  CCTV Dashboard stopped${NC}"
  else
    echo -e "${YELLOW}⚠  Dashboard was not running${NC}"
  fi
fi

echo ""
