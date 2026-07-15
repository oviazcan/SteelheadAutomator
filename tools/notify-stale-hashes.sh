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

# Bloques ENRIQUECIDOS: por cada op rotada, applets que truenan + descripción +
# flag de whitelist (falso-positivo probable). Ver tools/hash-stale-report.py.
STALE_MD="$(python3 "$REPO_ROOT/tools/hash-stale-report.py" "$RESULT_JSON" --format md 2>/dev/null || echo "$STALE_BULLETS")"
STALE_PLAIN="$(python3 "$REPO_ROOT/tools/hash-stale-report.py" "$RESULT_JSON" --format plain 2>/dev/null || echo "$STALE_BULLETS")"

# Acciones de recuperación (mismas para issue/email/bitácora). Responde:
# "qué acciones hacer en el scan para recuperar los hashes rotados".
read -r -d '' RECOVERY_STEPS <<'STEPS' || true
Cómo recuperar (acciones en el scan):

1. Abre Steelhead con la extensión cargada y haz HARD-RELOAD (Cmd+Shift+R) para
   bustear el cache del bundle del frontend.
2. Navega a las pantallas de los APPLETS AFECTADOS (listados arriba) para que el
   frontend dispare esas operaciones. Guía por op típica:
     - Customer / AllCustomers  -> Clientes, detalle de cliente, o una factura.
     - SensorDashboardQuery / AllSensorDashboards -> sección Sensor Dashboards.
     - (en general: la pantalla donde el applet afectado hace su trabajo)
3. Corre el applet HASH-SCANNER -> "Iniciar scan" -> navega por esas pantallas
   -> descarga scan_results_*.json (queda en ~/Downloads, NUNCA en el repo).
4. Abre el scan y para CADA op rotada localiza su entrada (busca por operationName):
     * ROTACIÓN REAL -> la entrada trae "status":"changed" + "lastHttpStatus":200
       y su "hash" DIFIERE del de config.json. Ese hash es el nuevo: cópialo.
     * FALSO POSITIVO -> el "hash" del scan es IGUAL al de config.json y la entrada
       trae responseFields / scanCount>0 (source "...escaneada"). El hash funciona
       en el navegador; el validador (cliente externo) da un falso "Must provide".
       NO toques config.json -> agrega la op a tools/hash-validator-whitelist.json.
5. Si hubo ROTACIÓN REAL: reemplaza el hash viejo por el nuevo en remote/config.json,
   bumpea "version" + "lastUpdated", y deploya con:
       tools/deploy.sh "fix(hashes): rotación <op>"
6. Re-corre el validador para confirmar 0 stale:
       cd "/Users/oviazcan/Projects/Ecoplating/Reportes SH" \
         && python3 /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/validate-hashes.py
STEPS

# ── 1. GitHub issue ──────────────────────────────────────────────────────────
if command -v gh >/dev/null 2>&1; then
  ISSUE_BODY=$(cat <<EOF
Detección automática del cron \`steelhead-hash-validator\` ($TODAY $TIMESTAMP).

## Resumen
- **Config version**: $CONFIG_VER
- **Stale**: $STALE_COUNT
- **OK**: $OK_COUNT / $TOTAL
- **Tiempo**: ${ELAPSED}s

## Hashes rotados — applets que truenan
$STALE_MD

> 🟡 = op en whitelist (\`tools/hash-validator-whitelist.json\`): falso-positivo
> probable del validador. El hash es válido en el navegador; **verifica en el
> scan antes de tocar \`config.json\`**.

## $RECOVERY_STEPS

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

HASHES ROTADOS ($STALE_COUNT) — QUÉ APPLETS TRUENAN:
$STALE_PLAIN

Nota: las ops marcadas [FALSO POSITIVO probable — en whitelist] tienen hash
válido en el navegador; el validador (cliente externo) da 'Must provide'. NO
toques config.json para esas — verifícalas en el scan.

Stats:
- Config version: $CONFIG_VER
- OK: $OK_COUNT / $TOTAL
- Tiempo: ${ELAPSED}s

$RECOVERY_STEPS

JSON: $RESULT_JSON"

# Una línea AppleScript "make new to recipient" por cada destinatario de la lista.
RECIPIENT_LINES=""
for _addr in "${EMAIL_RECIPIENTS[@]}"; do
  RECIPIENT_LINES+="        make new to recipient at end of to recipients with properties {address:\"$_addr\"}"$'\n'
done

# Sanitiza el body para incrustarlo en una string de AppleScript: escapa primero
# los backslashes y luego las comillas dobles (el body ahora trae rutas con
# comillas y snippets JSON tipo "status":"changed" que romperían la string).
EMAIL_BODY_AS="${EMAIL_BODY//\\/\\\\}"
EMAIL_BODY_AS="${EMAIL_BODY_AS//\"/\\\"}"

osascript <<EOF
tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:"[Steelhead] $STALE_COUNT hash(es) rotado(s) — $TODAY", content:"$EMAIL_BODY_AS", visible:false}
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
  echo "**Rotados — applets que truenan:**"
  echo ""
  echo "$STALE_MD"
} >> "$LOG_FILE"
echo "  ✓ Bitácora actualizada: $LOG_FILE"

exit 0
