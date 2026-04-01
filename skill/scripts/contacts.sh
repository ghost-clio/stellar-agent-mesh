#!/bin/bash
# Manage agent contacts — human-friendly names for federation addresses
CONTACTS_FILE="${CONTACTS_FILE:-$(dirname "$0")/../contacts.json}"

case "$1" in
  add)
    # contacts.sh add z alice*mesh.agent
    NAME="$2"
    FED_ADDR="$3"
    if [ -z "$NAME" ] || [ -z "$FED_ADDR" ]; then
      echo "Usage: contacts.sh add <name> <federation_address>"
      exit 1
    fi
    # Create file if it doesn't exist
    [ ! -f "$CONTACTS_FILE" ] && echo '{}' > "$CONTACTS_FILE"
    python3 -c "
import json, sys
with open('$CONTACTS_FILE') as f: contacts = json.load(f)
contacts['$NAME'] = '$FED_ADDR'
with open('$CONTACTS_FILE', 'w') as f: json.dump(contacts, f, indent=2)
print(f'Added: $NAME → $FED_ADDR')
"
    ;;
  remove)
    NAME="$2"
    if [ -z "$NAME" ]; then echo "Usage: contacts.sh remove <name>"; exit 1; fi
    python3 -c "
import json
with open('$CONTACTS_FILE') as f: contacts = json.load(f)
if '$NAME' in contacts:
    del contacts['$NAME']
    with open('$CONTACTS_FILE', 'w') as f: json.dump(contacts, f, indent=2)
    print(f'Removed: $NAME')
else:
    print(f'Not found: $NAME')
"
    ;;
  lookup)
    NAME="$2"
    if [ -z "$NAME" ]; then echo "Usage: contacts.sh lookup <name>"; exit 1; fi
    python3 -c "
import json
with open('$CONTACTS_FILE') as f: contacts = json.load(f)
addr = contacts.get('$NAME')
if addr: print(addr)
else: print(f'Not found: $NAME', file=__import__('sys').stderr); exit(1)
"
    ;;
  list)
    [ ! -f "$CONTACTS_FILE" ] && echo '{}' && exit 0
    python3 -m json.tool "$CONTACTS_FILE"
    ;;
  *)
    echo "Usage: contacts.sh <add|remove|lookup|list> [args]"
    ;;
esac
