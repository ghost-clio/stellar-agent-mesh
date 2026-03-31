#!/bin/bash
# Query agent spending history
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"
ADDRESS="$1"

if [ -z "$ADDRESS" ]; then
  echo "Usage: spending.sh <stellar_address>"
  exit 1
fi

curl -s "$GATEWAY_URL/spending/$ADDRESS" | python3 -m json.tool 2>/dev/null || curl -s "$GATEWAY_URL/spending/$ADDRESS"
