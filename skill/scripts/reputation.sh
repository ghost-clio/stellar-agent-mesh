#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"

if [ $# -lt 1 ]; then
  echo "Usage: reputation.sh <address>"
  echo "  address  Agent's Stellar public key"
  exit 1
fi

ADDRESS="$1"

curl -s "${GATEWAY_URL}/reputation/${ADDRESS}"
