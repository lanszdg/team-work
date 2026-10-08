#!/bin/bash
# ============================================================
# Kanban Board Quick Launch Script
# Usage: ./scripts/start-kanban.sh [team-name] [port]
# ============================================================

TEAM="${1:-my-project-team}"
PORT="${2:-8090}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

export TEAM_MEMORY_SYNC_URL="${TEAM_MEMORY_SYNC_URL:-http://127.0.0.1:3000}"
export TEAM_MEMORY_SYNC_API_KEY="${TEAM_MEMORY_SYNC_API_KEY:-local-development-only}"

echo "╔══════════════════════════════════════════════════╗"
echo "║  Team-Collab Kanban Board                       ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Team:       $TEAM"
echo "║  Port:       $PORT"
echo "║  Sync URL:   $TEAM_MEMORY_SYNC_URL"
echo "║  Access:     http://localhost:$PORT"
echo "╚══════════════════════════════════════════════════╝"

cd "$SCRIPT_DIR"
node -e "
  const { startKanbanServer } = require('./dist/core/kanbanServer.js');
  startKanbanServer('$TEAM', $PORT);
  console.log('');
  console.log('  📍 Open http://localhost:$PORT in your browser');
  console.log('  Press Ctrl+C to stop');
  console.log('');
"
