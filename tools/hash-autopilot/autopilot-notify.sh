#!/usr/bin/env bash
# Notificación por correo de hash-autopilot vía Mail.app (mismo patrón que
# notify-stale-hashes.sh). Uso: autopilot-notify.sh <tipo> <asunto> <cuerpo>
#   tipo ∈ exito | fallo | revision  (solo va en el subject, para filtrar)
#
# Destinatarios: lista separada por comas. Default = el operador + su equipo.
# Override con SA_NOTIFY_DEST="a@x.com,b@y.com" (p.ej. para una prueba a un solo buzón).
set -euo pipefail

TIPO="${1:?falta tipo}"
ASUNTO="${2:?falta asunto}"
CUERPO="${3:?falta cuerpo}"
DEST_DEFAULT="oviazcan@gmail.com,msierra@proecoplating.com,ernesto.sanchez@proecoplating.com"
DESTS="${SA_NOTIFY_DEST:-$DEST_DEFAULT}"

# Escapar comillas dobles y backslashes para AppleScript.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
ASUNTO_AS="$(esc "$ASUNTO")"
CUERPO_AS="$(esc "$CUERPO")"

# Una línea AppleScript "make new to recipient" por destinatario (trim + escape).
RCPT_LINES=""
IFS=',' read -ra ADDRS <<< "$DESTS"
for addr in "${ADDRS[@]}"; do
  addr="$(printf '%s' "$addr" | xargs)"   # trim espacios
  [ -z "$addr" ] && continue
  RCPT_LINES="${RCPT_LINES}        make new to recipient at end of to recipients with properties {address:\"$(esc "$addr")\"}"$'\n'
done

osascript <<EOF
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"[hash-autopilot ${TIPO}] ${ASUNTO_AS}", content:"${CUERPO_AS}", visible:false}
    tell newMessage
${RCPT_LINES}        send
    end tell
end tell
EOF
