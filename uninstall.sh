#!/usr/bin/env bash
#
# uninstall.sh - Entfernt die Matterbridge-Adapterinstanz und den Adapter
# selbst wieder aus ioBroker. Matterbridge-Konfiguration/Storage bleibt
# im ioBroker-Datenverzeichnis erhalten, außer -f wird angegeben.

set -euo pipefail

IOBROKER_DIR="${1:-/opt/iobroker}"
ADAPTER_NAME="matterbridge"
INSTANCE="0"
FULL_CLEAN="${2:-}"

command -v iobroker >/dev/null 2>&1 || { echo "FEHLER: iobroker-CLI nicht gefunden." >&2; exit 1; }

echo "--> Instanz stoppen und löschen"
iobroker stop "${ADAPTER_NAME}.${INSTANCE}" --allow-root >/dev/null 2>&1 || true
iobroker del "${ADAPTER_NAME}.${INSTANCE}" --allow-root || true

echo "--> Adapter aus node_modules entfernen"
(cd "$IOBROKER_DIR" && npm uninstall "iobroker.${ADAPTER_NAME}") || true

if [ "$FULL_CLEAN" = "-f" ]; then
  DATA_DIR="$IOBROKER_DIR/iobroker-data/files/${ADAPTER_NAME}.${INSTANCE}"
  echo "--> Entferne auch Matterbridge-Storage: $DATA_DIR"
  rm -rf "$DATA_DIR"
fi

echo "Fertig. Falls global installiert und nicht mehr benötigt:"
echo "  npm uninstall -g matterbridge"
