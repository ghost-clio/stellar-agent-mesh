#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"

if [ $# -lt 2 ]; then
  echo "Usage: pay.sh <service_id> <proof>"
  echo "  service_id  The service ID to call"
  echo "  proof       Payment proof (transaction hash or signed payload)"
  exit 1
fi

SERVICE_ID="$1"
PROOF="$2"

curl -s "${GATEWAY_URL}/service/${SERVICE_ID}" \
  -H "X-PAYMENT-PROOF: ${PROOF}"
