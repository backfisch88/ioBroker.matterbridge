#!/usr/bin/env bash
#
# install.sh - Installs the local iobroker.matterbridge adapter
#              onto an existing ioBroker host.
#
# Usage:
#   ./install.sh [IOBROKER_DIR] [ADAPTER_SRC_DIR]
#
# Example:
#   ./install.sh /opt/iobroker /home/pi/iobroker.matterbridge
#
# Must be run as the user that ioBroker itself runs as (usually
# "iobroker"), NOT as root, unless your setup requires that.

set -euo pipefail

IOBROKER_DIR="${1:-/opt/iobroker}"
ADAPTER_SRC_DIR="${2:-$(cd "$(dirname "$0")" && pwd)}"
ADAPTER_NAME="matterbridge"
INSTANCE="0"

echo "=== ioBroker.matterbridge Installer ==="
echo "ioBroker directory:  $IOBROKER_DIR"
echo "Adapter source:      $ADAPTER_SRC_DIR"
echo

# --- Preflight checks ---------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Please install Node.js." >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm not found." >&2; exit 1; }
command -v iobroker >/dev/null 2>&1 || { echo "ERROR: iobroker CLI not found. Is this script running on the ioBroker host?" >&2; exit 1; }

if [ ! -f "$IOBROKER_DIR/io-package.json" ] && [ ! -d "$IOBROKER_DIR/node_modules/iobroker.js-controller" ]; then
  echo "WARNING: $IOBROKER_DIR does not look like an ioBroker installation. Continuing anyway."
fi

if [ ! -f "$ADAPTER_SRC_DIR/io-package.json" ]; then
  echo "ERROR: $ADAPTER_SRC_DIR does not contain an io-package.json. Wrong path?" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || {
  echo "NOTE: 'jq' not found, it is required to set the configuration."
  echo "Installing it now (apt/yum/brew)..."
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y jq
  elif command -v yum >/dev/null 2>&1; then sudo yum install -y jq
  elif command -v brew >/dev/null 2>&1; then brew install jq
  else echo "ERROR: Please install 'jq' manually." >&2; exit 1
  fi
}

# --- Interactive configuration -------------------------------------------
read -rp "Web frontend port for Matterbridge [8283]: " FRONTEND_PORT
FRONTEND_PORT="${FRONTEND_PORT:-8283}"

read -rp "Matter network port [5540]: " MATTER_PORT
MATTER_PORT="${MATTER_PORT:-5540}"

read -rp "Network interface for mDNS (empty = automatic): " MDNS_INTERFACE

# --- 1. Install dependencies in the adapter directory ---------------------
echo
echo "--> npm install in the adapter directory"
(cd "$ADAPTER_SRC_DIR" && npm install --omit=dev)

# --- 2. Link the adapter into ioBroker -------------------------------------
echo "--> Linking the adapter into ioBroker node_modules"
(cd "$IOBROKER_DIR" && npm install "$ADAPTER_SRC_DIR")

# --- 3. Create the instance (stopped so we can configure it first) --------
echo "--> Creating the instance"
if iobroker list instances --allow-root 2>/dev/null | grep -q "system.adapter.${ADAPTER_NAME}.${INSTANCE}"; then
  echo "Instance already exists, skipping 'iobroker add'"
else
  iobroker add "$ADAPTER_NAME" --enabled false --allow-root
fi

iobroker stop "${ADAPTER_NAME}.${INSTANCE}" --allow-root >/dev/null 2>&1 || true

# --- 4. Set the native configuration (via jq merge over iobroker object) --
echo "--> Setting the configuration"
OBJECT_ID="system.adapter.${ADAPTER_NAME}.${INSTANCE}"
CURRENT_OBJECT="$(iobroker object get "$OBJECT_ID" --allow-root)"

# "iobroker object get" often prints a prefix line before the JSON - so
# extract starting from the first "{".
CURRENT_JSON="$(echo "$CURRENT_OBJECT" | sed -n '/{/,$p')"

UPDATED_JSON="$(echo "$CURRENT_JSON" | jq \
  --argjson frontendPort "$FRONTEND_PORT" \
  --argjson matterPort "$MATTER_PORT" \
  --arg mdnsInterface "$MDNS_INTERFACE" \
  '.native.frontendPort = $frontendPort
   | .native.matterPort = $matterPort
   | .native.mdnsInterface = $mdnsInterface
   | .native.autostart = true
   | .native.autoRestart = true')"

echo "$UPDATED_JSON" | iobroker object set "$OBJECT_ID" --allow-root

# --- 5. Enable and start the instance ---------------------------------------
echo "--> Enabling the instance"
iobroker start "${ADAPTER_NAME}.${INSTANCE}" --allow-root

echo
echo "=== Done ==="
echo "Check the log with:  iobroker logs ${ADAPTER_NAME}.${INSTANCE} --allow-root"
echo "The Matterbridge UI will appear after a successful start at:"
echo "  http://$(hostname -I 2>/dev/null | awk '{print $1}'):${FRONTEND_PORT}/"
echo "as well as an admin tab in the ioBroker interface."
