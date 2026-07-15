#!/usr/bin/env bash
# Wrapper para hash-autopilot (validación+regeneración de hashes). Lo invoca el
# launchd plist (com.ecoplating.steelhead-hash-autopilot), cada hora a :23.
#
# DOS CAPAS (2026-07-15 — rediseño "refresh-siempre de enmascaradas"):
#   CAPA 1 · ENMASCARADAS — SIEMPRE (cada tick, SIN gate): refresca el ROCP y corre
#     el motor en --masked-only. Recaptura las ops session-sensitive (masked-ops.json)
#     que el validador Python NO puede ver de forma confiable, y auto-deploya si
#     rotaron. Es barato (pocas rutas). Objetivo: NO esperar a que truenen — esas ops
#     rotan sin dejar señal para el validador (p.ej. AllCustomers el 2026-07-03, que
#     dejó la carga masiva con 0 clientes y el validador reportó "0 rotado").
#   CAPA 2 · ESCANEO COMPLETO — con GATE POR RELEASE: solo si Steelhead publicó un
#     build nuevo corre validate-hashes.py (detecta las ~170 detectables por idp-token)
#     + el motor completo (enmascaradas + stale del validador). Así el escaneo pesado
#     corre casi gratis (los hashes solo rotan con un release del frontend).
#
# El motor auto-deploya los rotados validados SOLO si el repo está en main y sin WIP
# ajeno (salvaguardas de autopilot-deploy.sh); si no, avisa por correo.
#
# Frecuencia de la CAPA 1 = frecuencia del launchd (hoy 1/hora). Para bajarla (menos
# aperturas de Chromium en la laptop) ajusta StartCalendarInterval del plist; en un
# servidor 24/7 (migración pendiente) el costo es trivial.
#
# Overrides opcionales por env var: REPO_ROOT, NODE, PYTHON, REPORTES_SH
set -uo pipefail

# launchd arranca con PATH mínimo: agrégale homebrew + system para hallar node/git/curl.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REPO_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"
: "${NODE:=/opt/homebrew/bin/node}"
: "${PYTHON:=/usr/bin/python3}"
: "${REPORTES_SH:=/Users/oviazcan/Projects/Ecoplating/Reportes SH}"

AUTOPILOT_DIR="$REPO_ROOT/tools/hash-autopilot"
STATE_DIR="$REPO_ROOT/tools/.hash-autopilot"
mkdir -p "$STATE_DIR"

# ── Refrescar el ROCP (force) ANTES de abrir cualquier navegador ────────────
# El motor inyecta el access token en el localStorage del SPA headless. Si está por
# vencer, el SPA lo refresca en su localStorage EFÍMERO → ROTA el refresh token
# (Authentik rota en cada uso) y lo PIERDE al cerrar → la próxima corrida usa un
# refresh ya invalidado → authFailed silencioso. Refrescar aquí garantiza un access
# FRESCO (~8h) → el SPA NO refresca durante la corrida (minutos) → no rota;
# steelhead_auth persiste el refresh rotado. Fail-RUIDOSO: si el refresh no es posible,
# avisa y NO abre el navegador (en vez de fingir authFailed y quemar el gate).
echo "$(date '+%F %T') Refrescando ROCP (force) antes del motor…"
REFRESH_OUT="$( cd "$REPORTES_SH" && "$PYTHON" -c "import sys; sys.path.insert(0,'scripts'); from steelhead_auth import get_access_token; get_access_token(force_refresh=True)" 2>&1 )"
if [ $? -ne 0 ]; then
  echo "$(date '+%F %T') FATAL: refresh del ROCP falló — NO abro el navegador (evito authFailed silencioso):" >&2
  printf '%s\n' "$REFRESH_OUT" | tail -3 >&2
  "$AUTOPILOT_DIR/autopilot-notify.sh" fallo "AUTH caída (refresh ROCP revocado)" \
    "El refresh token ROCP se revocó (invalid_grant). El motor NO corrió (ni enmascaradas ni escaneo). Re-pega cookie/refresh en 'Reportes SH/.env' y corre steelhead_auth.py." 2>/dev/null || true
  exit 2
fi
echo "$(date '+%F %T') ROCP fresco ✓ (access ~8h) — el SPA no refrescará durante la corrida"

# ── CAPA 1: ENMASCARADAS — SIEMPRE (sin gate) ───────────────────────────────
echo "$(date '+%F %T') Recaptura de enmascaradas (--masked-only)…"
( cd "$AUTOPILOT_DIR" && "$NODE" hash-autopilot.mjs --masked-only )
MASKED_RC=$?
[ "$MASKED_RC" != "0" ] && echo "$(date '+%F %T') masked-only exit $MASKED_RC (auth o deploy; ver correo)"

# ── Gate por release: el ESCANEO COMPLETO solo corre con build nuevo ────────
RELEASE_FILE="$STATE_DIR/last-release.txt"
CUR_CODEID="$(curl -s -m 15 https://app.gosteelhead.com/version.json 2>/dev/null | "$PYTHON" -c 'import json,sys;print(json.load(sys.stdin).get("code-id",""))' 2>/dev/null || echo "")"
PREV_CODEID="$(cat "$RELEASE_FILE" 2>/dev/null || echo "")"
if [ -z "$CUR_CODEID" ]; then
  echo "$(date '+%F %T') WARN: no pude leer code-id de /version.json — corro escaneo completo de todos modos (defensivo)."
elif [ "$CUR_CODEID" = "$PREV_CODEID" ]; then
  echo "$(date '+%F %T') Sin release nuevo (code-id ${CUR_CODEID:0:8}) — escaneo completo skip (las enmascaradas YA corrieron)."
  exit "$MASKED_RC"
fi

echo "$(date '+%F %T') Release nuevo (${CUR_CODEID:0:8}) — escaneo completo…"

# ── Fase A: validator (detecta stale de las detectables por idp-token) ──
# Escribe tools/.hash-validation/<date>.json que el motor lee para planificar.
echo "$(date '+%F %T') Corriendo validate-hashes.py (detección)…"
"$PYTHON" "$REPO_ROOT/tools/validate-hashes.py"
VAL_RC=$?
[ "$VAL_RC" != "0" ] && echo "$(date '+%F %T') validate-hashes.py exit $VAL_RC (stale o auth; el motor decide)"

# ── Fase B: motor completo (enmascaradas + stale del validador) ──
cd "$AUTOPILOT_DIR"
"$NODE" hash-autopilot.mjs
RC=$?

# Marca este release como procesado salvo que la auth se haya caído (exit 2).
if [ "$RC" != "2" ] && [ -n "$CUR_CODEID" ]; then
  echo "$CUR_CODEID" > "$RELEASE_FILE"
fi
exit "$RC"
