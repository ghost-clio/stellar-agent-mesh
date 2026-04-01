#!/bin/bash
# Send XLM to a contact or federation address — the "Venmo" command
# Usage: send.sh <name_or_federation_addr> <amount> [memo]
# Examples:
#   send.sh z 100              → looks up z in contacts, sends 100 XLM
#   send.sh databot 20   → looks up databot in contacts
#   send.sh bob*mesh.agent 5   → direct federation address (skips contacts)

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3402}"
STELLAR_SECRET="${STELLAR_SECRET:?Set STELLAR_SECRET env var}"
SCRIPTS_DIR="$(dirname "$0")"

RECIPIENT="$1"
AMOUNT="$2"
MEMO="${3:-sent_via_mesh}"

if [ -z "$RECIPIENT" ] || [ -z "$AMOUNT" ]; then
  echo "Usage: send.sh <name_or_address> <amount> [memo]"
  exit 1
fi

# If it doesn't contain * or G..., try contacts lookup
if [[ "$RECIPIENT" != *"*"* ]] && [[ "$RECIPIENT" != G* ]]; then
  FED_ADDR=$(bash "$SCRIPTS_DIR/contacts.sh" lookup "$RECIPIENT" 2>/dev/null)
  if [ -z "$FED_ADDR" ]; then
    echo "❌ '$RECIPIENT' not in contacts and not a federation/Stellar address"
    echo "Add them: contacts.sh add $RECIPIENT <their_federation_address>"
    exit 1
  fi
  echo "📇 $RECIPIENT → $FED_ADDR"
  RECIPIENT="$FED_ADDR"
fi

# Send payment
echo "💸 Sending $AMOUNT XLM to $RECIPIENT..."
RESULT=$(curl -s -X POST "$GATEWAY_URL/pay" \
  -H "Content-Type: application/json" \
  -d "{\"senderSecret\":\"$STELLAR_SECRET\",\"destination\":\"$RECIPIENT\",\"amount\":\"$AMOUNT\",\"memo\":\"$MEMO\"}")

echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
