#!/usr/bin/env bash
#
# install.sh - Installiert den lokalen iobroker.matterbridge Adapter
#              auf einem bestehenden ioBroker-Host.
#
# Nutzung:
#   ./install.sh [IOBROKER_DIR] [ADAPTER_SRC_DIR]
#
# Beispiel:
#   ./install.sh /opt/iobroker /home/pi/iobroker.matterbridge
#
# Muss als der User ausgeführt werden, unter dem ioBroker selbst läuft
# (üblicherweise "iobroker"), NICHT als root, außer dein Setup verlangt das.

set -euo pipefail

IOBROKER_DIR="${1:-/opt/iobroker}"
ADAPTER_SRC_DIR="${2:-$(cd "$(dirname "$0")" && pwd)}"
ADAPTER_NAME="matterbridge"
INSTANCE="0"

echo "=== ioBroker.matterbridge Installer ==="
echo "ioBroker-Verzeichnis: $IOBROKER_DIR"
echo "Adapter-Quelle:       $ADAPTER_SRC_DIR"
echo

# --- Vorab-Checks -----------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "FEHLER: node nicht gefunden. Node.js installieren." >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "FEHLER: npm nicht gefunden."  >&2; exit 1; }
command -v iobroker >/dev/null 2>&1 || { echo "FEHLER: iobroker-CLI nicht gefunden. Läuft dieses Skript auf dem ioBroker-Host?" >&2; exit 1; }

if [ ! -f "$IOBROKER_DIR/io-package.json" ] && [ ! -d "$IOBROKER_DIR/node_modules/iobroker.js-controller" ]; then
  echo "WARNUNG: $IOBROKER_DIR sieht nicht wie eine ioBroker-Installation aus. Fahre trotzdem fort."
fi

if [ ! -f "$ADAPTER_SRC_DIR/io-package.json" ]; then
  echo "FEHLER: $ADAPTER_SRC_DIR enthält keine io-package.json. Falscher Pfad?" >&2
  exit 1
fi

command -v jq >/dev/null 2>&1 || {
  echo "HINWEIS: 'jq' nicht gefunden, wird für das Setzen der Konfiguration benötigt."
  echo "Installiere es jetzt (apt/yum/brew)..."
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y jq
  elif command -v yum >/dev/null 2>&1; then sudo yum install -y jq
  elif command -v brew >/dev/null 2>&1; then brew install jq
  else echo "FEHLER: Bitte 'jq' manuell installieren." >&2; exit 1
  fi
}

# --- Interaktive Konfiguration -----------------------------------------
read -rp "Web-Frontend-Port für Matterbridge [8283]: " FRONTEND_PORT
FRONTEND_PORT="${FRONTEND_PORT:-8283}"

read -rp "Matter-Netzwerk-Port [5540]: " MATTER_PORT
MATTER_PORT="${MATTER_PORT:-5540}"

read -rp "Netzwerk-Interface für mDNS (leer = automatisch): " MDNS_INTERFACE

# --- 1. Dependencies im Adapter-Ordner installieren --------------------
echo
echo "--> npm install im Adapter-Ordner"
(cd "$ADAPTER_SRC_DIR" && npm install --omit=dev)

# --- 2. Adapter in ioBroker verlinken -----------------------------------
echo "--> Adapter in ioBroker node_modules verlinken"
(cd "$IOBROKER_DIR" && npm install "$ADAPTER_SRC_DIR")

# --- 3. Instanz anlegen (angehalten, damit wir zuerst konfigurieren) ---
echo "--> Instanz anlegen"
if iobroker list instances --allow-root 2>/dev/null | grep -q "system.adapter.${ADAPTER_NAME}.${INSTANCE}"; then
  echo "Instanz existiert bereits, überspringe 'iobroker add'"
else
  iobroker add "$ADAPTER_NAME" --enabled false --allow-root
fi

iobroker stop "${ADAPTER_NAME}.${INSTANCE}" --allow-root >/dev/null 2>&1 || true

# --- 4. Native Konfiguration setzen (per jq-Merge über iobroker object) -
echo "--> Konfiguration setzen"
OBJECT_ID="system.adapter.${ADAPTER_NAME}.${INSTANCE}"
CURRENT_OBJECT="$(iobroker object get "$OBJECT_ID" --allow-root)"

# iobroker object get gibt oft eine Zeile Präfix vor dem JSON aus - daher
# ab der ersten "{" extrahieren.
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

# --- 5. Instanz aktivieren und starten ----------------------------------
echo "--> Instanz aktivieren"
iobroker start "${ADAPTER_NAME}.${INSTANCE}" --allow-root

echo
echo "=== Fertig ==="
echo "Log prüfen mit:  iobroker logs ${ADAPTER_NAME}.${INSTANCE} --allow-root"
echo "Matterbridge-UI erscheint nach erfolgreichem Start unter:"
echo "  http://$(hostname -I 2>/dev/null | awk '{print $1}'):${FRONTEND_PORT}/"
echo "sowie als Admin-Tab in der ioBroker-Oberfläche."
