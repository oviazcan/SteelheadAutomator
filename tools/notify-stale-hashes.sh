#!/usr/bin/env bash
# Dispara notificaciones cuando validate-hashes.py detecta rotaciones.
# Uso: ./notify-stale-hashes.sh <path/al/resultado.json>
#
# Canales que dispara:
#   1. gh issue create — issue en repo con stale + JSON adjunto
#   2. osascript Mail.app — email a oviazcan@gmail.com
#   3. append a docs/api/hash-validation-log.md — bitácora
#
# (PushNotification y commit los maneja Claude desde el cron.)
set -euo pipefail

RESULT_JSON="${1:-}"
if [[ -z "$RESULT_JSON" || ! -f "$RESULT_JSON" ]]; then
  echo "ERROR: falta path al JSON de resultado" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$REPO_ROOT/docs/api/hash-validation-log.md"
TODAY="$(date +%Y-%m-%d)"
TIMESTAMP="$(date +%H:%M)"

# ── Destinatarios del email de alerta. Edita esta lista para agregar/quitar. ──
EMAIL_RECIPIENTS=(
  "oviazcan@gmail.com"
  "ernesto.sanchez@proecoplating.com"
  "msierra@proecoplating.com"
)

# Extrae stats con python (jq no garantizado en macOS sin brew).
read -r STALE_COUNT OK_COUNT TOTAL ELAPSED CONFIG_VER STALE_LIST <<EOF
$(python3 - "$RESULT_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = d["totals"]
stale_list = ",".join(f'{s["kind"]}:{s["operation"]}' for s in d.get("stale", []))
print(t["stale"], t["ok"], t["checked"], d["elapsed_s"], d.get("config_version", "?"), stale_list or "-")
PY
)
EOF

if [[ "$STALE_COUNT" == "0" ]]; then
  echo "No hay hashes rotados — nada que notificar."
  exit 0
fi

echo "Disparando notificaciones para $STALE_COUNT hash(es) rotado(s)..."

# Construye lista bullet de stale para markdown/email.
STALE_BULLETS="$(python3 - "$RESULT_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for s in d.get("stale", []):
    print(f"- `{s['kind']} {s['operation']}` (hash `{s['hash'][:12]}...`)")
PY
)"

# ── 1. GitHub issue ──────────────────────────────────────────────────────────
if command -v gh >/dev/null 2>&1; then
  ISSUE_BODY=$(cat <<EOF
Detección automática del cron \`steelhead-hash-validator\` ($TODAY $TIMESTAMP).

## Resumen
- **Config version**: $CONFIG_VER
- **Stale**: $STALE_COUNT
- **OK**: $OK_COUNT / $TOTAL
- **Tiempo**: ${ELAPSED}s

## Hashes rotados
$STALE_BULLETS

## Acción
1. Abrir Steelhead en navegador con la extensión cargada
2. Correr el applet \`hash-scanner\` para re-extraer hashes
3. Actualizar \`remote/config.json\` con los nuevos hashes
4. Bumpear \`version\` en \`config.json\`
5. Deploy a \`gh-pages\` siguiendo procedimiento de \`CLAUDE.md\`

## JSON completo
\`\`\`json
$(cat "$RESULT_JSON")
\`\`\`
EOF
)
  if gh issue create \
       --title "Hashes rotados detectados ($STALE_COUNT) — $TODAY" \
       --body "$ISSUE_BODY" \
       --label "hash-rotation" 2>&1; then
    echo "  ✓ Issue creado"
  else
    echo "  ⚠ gh issue create falló (¿label inexistente o gh no autenticado?)" >&2
  fi
else
  echo "  ⚠ gh CLI no instalado — skip issue" >&2
fi

# ── 2. Email vía Mail.app ────────────────────────────────────────────────────
EMAIL_BODY="Detección automática del cron de validación de hashes ($TODAY $TIMESTAMP).

Hashes rotados ($STALE_COUNT):
$STALE_BULLETS

Stats:
- Config version: $CONFIG_VER
- OK: $OK_COUNT / $TOTAL
- Tiempo: ${ELAPSED}s

Acción: correr hash-scanner en navegador y actualizar config.json.

JSON: $RESULT_JSON"

# Una línea AppleScript "make new to recipient" por cada destinatario de la lista.
RECIPIENT_LINES=""
for _addr in "${EMAIL_RECIPIENTS[@]}"; do
  RECIPIENT_LINES+="        make new to recipient at end of to recipients with properties {address:\"$_addr\"}"$'\n'
done

osascript <<EOF
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"[Steelhead] $STALE_COUNT hash(es) rotado(s) — $TODAY", content:"$EMAIL_BODY", visible:false}
    tell newMessage
$RECIPIENT_LINES        send
    end tell
end tell
EOF
echo "  ✓ Email enviado a: ${EMAIL_RECIPIENTS[*]}"

# ── 3. Append a bitácora ─────────────────────────────────────────────────────
mkdir -p "$(dirname "$LOG_FILE")"
{
  echo ""
  echo "## $TODAY $TIMESTAMP — $STALE_COUNT rotado(s)"
  echo ""
  echo "- Config version: \`$CONFIG_VER\`"
  echo "- OK: $OK_COUNT / $TOTAL · Tiempo: ${ELAPSED}s"
  echo "- Resultado: \`$RESULT_JSON\`"
  echo ""
  echo "**Rotados:**"
  echo "$STALE_BULLETS"
} >> "$LOG_FILE"
echo "  ✓ Bitácora actualizada: $LOG_FILE"

exit 0
