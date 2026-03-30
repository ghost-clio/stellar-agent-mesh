#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"

if [ $# -lt 1 ]; then
  echo "Usage: discover.sh <capability>"
  echo "  capability  The capability to search for (e.g., web-search, code-review, image-gen)"
  exit 1
fi

CAPABILITY="$1"

curl -s "${GATEWAY_URL}/discover?capability=${CAPABILITY}"
