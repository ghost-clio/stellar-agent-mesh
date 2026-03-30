#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"

if [ $# -lt 5 ]; then
  echo "Usage: register.sh <id> <price> <capability> <endpoint> <seller>"
  echo "  id          Unique service identifier"
  echo "  price       Price in USDC (e.g., 0.50)"
  echo "  capability  Service capability tag"
  echo "  endpoint    URL where the service is accessible"
  echo "  seller      Your Stellar public key"
  exit 1
fi

ID="$1"
PRICE="$2"
CAPABILITY="$3"
ENDPOINT="$4"
SELLER="$5"

curl -s -X POST "${GATEWAY_URL}/register" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"${ID}\",\"price\":${PRICE},\"capability\":\"${CAPABILITY}\",\"endpoint\":\"${ENDPOINT}\",\"seller\":\"${SELLER}\"}"
