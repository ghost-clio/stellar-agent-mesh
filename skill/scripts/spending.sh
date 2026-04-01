#!/bin/bash
# Query YOUR spending history. Requires your Stellar address.
GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"
ADDRESS="${STELLAR_ADDRESS:-$1}"

if [ -z "$ADDRESS" ]; then
  echo "Usage: spending.sh <your_stellar_address>"
  echo "Or set STELLAR_ADDRESS env var"
  exit 1
fi

curl -s -H "X-BUYER-ADDRESS: $ADDRESS" "$GATEWAY_URL/spending" | python3 -m json.tool 2>/dev/null || \
curl -s -H "X-BUYER-ADDRESS: $ADDRESS" "$GATEWAY_URL/spending"
