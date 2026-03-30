#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: balance.sh <address>"
  echo "  address  Stellar public key"
  exit 1
fi

ADDRESS="$1"

RESPONSE=$(curl -s "https://horizon-testnet.stellar.org/accounts/${ADDRESS}")

# Check if the account exists
if echo "${RESPONSE}" | grep -q '"status"'; then
  echo "${RESPONSE}"
  exit 1
fi

# Extract USDC balance from the balances array
USDC_BALANCE=$(echo "${RESPONSE}" | jq -r '
  .balances[] |
  select(.asset_code == "USDC") |
  .balance
' 2>/dev/null)

if [ -z "${USDC_BALANCE}" ] || [ "${USDC_BALANCE}" = "null" ]; then
  echo "{\"address\":\"${ADDRESS}\",\"asset\":\"USDC\",\"balance\":\"0\",\"note\":\"No USDC trustline found\"}"
else
  echo "{\"address\":\"${ADDRESS}\",\"asset\":\"USDC\",\"balance\":\"${USDC_BALANCE}\"}"
fi
