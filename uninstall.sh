#!/usr/bin/env bash
#
# uninstall.sh - Removes the Matterbridge adapter instance and the adapter
# itself from ioBroker. Matterbridge configuration/storage in the
# ioBroker data directory is kept unless -f is given.

set -euo pipefail

IOBROKER_DIR="${1:-/opt/iobroker}"
ADAPTER_NAME="matterbridge"
INSTANCE="0"
FULL_CLEAN="${2:-}"

command -v iobroker >/dev/null 2>&1 || { echo "ERROR: iobroker CLI not found." >&2; exit 1; }

echo "--> Stopping and deleting the instance"
iobroker stop "${ADAPTER_NAME}.${INSTANCE}" --allow-root >/dev/null 2>&1 || true
iobroker del "${ADAPTER_NAME}.${INSTANCE}" --allow-root || true

echo "--> Removing the adapter from node_modules"
(cd "$IOBROKER_DIR" && npm uninstall "iobroker.${ADAPTER_NAME}") || true

if [ "$FULL_CLEAN" = "-f" ]; then
  DATA_DIR="$IOBROKER_DIR/iobroker-data/matterbridge"
  echo "--> Also removing Matterbridge storage: $DATA_DIR"
  rm -rf "$DATA_DIR"
fi

echo "Done. If installed globally and no longer needed:"
echo "  npm uninstall -g matterbridge"
