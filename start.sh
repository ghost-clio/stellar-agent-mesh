#!/bin/bash
# Stellar Agent Mesh — Start gateway + battle harness
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# Load env
if [ -f "$DIR/.env" ]; then
  set -a && source "$DIR/.env" && set +a
fi

echo "🌐 Building gateway..."
cd "$DIR/gateway" && npx tsc

echo "⚔️  Building harness..."
cd "$DIR/harness" && npx tsc

echo ""
echo "🚀 Starting gateway on port ${PORT:-3402}..."
cd "$DIR/gateway" && node dist/index.js &
GATEWAY_PID=$!

sleep 2

# Verify gateway
if curl -sf http://localhost:${PORT:-3402}/health > /dev/null 2>&1; then
  echo "✅ Gateway alive (PID $GATEWAY_PID)"
else
  echo "❌ Gateway failed to start"
  kill $GATEWAY_PID 2>/dev/null
  exit 1
fi

echo ""
echo "⚔️  Starting battle harness..."
cd "$DIR/harness" && node dist/index.js &
HARNESS_PID=$!

echo ""
echo "═══════════════════════════════════════════"
echo " Stellar Agent Mesh running"
echo " Gateway:  PID $GATEWAY_PID (port ${PORT:-3402})"
echo " Harness:  PID $HARNESS_PID"
echo " Press Ctrl+C to stop"
echo "═══════════════════════════════════════════"

# Trap and cleanup
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $HARNESS_PID 2>/dev/null
  kill $GATEWAY_PID 2>/dev/null
  wait $HARNESS_PID 2>/dev/null
  wait $GATEWAY_PID 2>/dev/null
  echo "Done."
}

trap cleanup SIGINT SIGTERM

# Wait for either to exit
wait -n $GATEWAY_PID $HARNESS_PID
cleanup
