#!/usr/bin/env bash
# Notificación por correo de hash-autopilot vía Mail.app (mismo patrón que
# notify-stale-hashes.sh). Uso: autopilot-notify.sh <tipo> <asunto> <cuerpo>
#   tipo ∈ exito | fallo | revision  (solo va en el subject, para filtrar)
set -euo pipefail

TIPO="${1:?falta tipo}"
ASUNTO="${2:?falta asunto}"
CUERPO="${3:?falta cuerpo}"
DEST="oviazcan@gmail.com"

# Escapar comillas dobles y backslashes para AppleScript.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
ASUNTO_AS="$(esc "$ASUNTO")"
CUERPO_AS="$(esc "$CUERPO")"

osascript <<EOF
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"[hash-autopilot ${TIPO}] ${ASUNTO_AS}", content:"${CUERPO_AS}", visible:false}
    tell newMessage
        make new to recipient at end of to recipients with properties {address:"${DEST}"}
        send
    end tell
end tell
EOF
