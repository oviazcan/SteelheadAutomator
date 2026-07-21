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
#   CAPA 2 · DETECCIÓN — SIEMPRE (cada tick, SIN gate por release, 2026-07-16): corre
#     validate-hashes.py (detecta las ~170 por idp-token; barato: Python sin navegador)
#     y, SOLO si hay stale, dispara el motor completo (enmascaradas + stale) que
#     auto-captura + deploya. Antes se condicionaba a un "release nuevo", pero los hashes
#     ROTAN sin que el code-id de /version.json cambie (SearchProducts el 2026-07-16
#     rotó, el gate no disparó, catalog-fetcher tronó sin aviso) → el gate no protege.
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

# ── LATIDO (heartbeat) — prueba de vida del cron, empujada al git REMOTO ─────
# Un watchdog en GitHub Actions (corre en la NUBE, no en esta Mac) vigila su frescura:
# si el latido deja de llegar (Mac apagada/dormida, launchd descargado, wrapper muerto
# antes de empezar) abre un issue. Es la ÚNICA señal que cubre "el cron local dejó de
# correr" — el resto de alertas son reactivas (el motor avisa CUANDO corre). Se emite AL
# INICIO (antes del refresh auth) → refleja "el launchd disparó", independiente de si la
# captura luego tiene éxito (una auth caída ya la avisa el motor por su cuenta).
# Plumbing (commit-tree + push --force a una rama HUÉRFANA ops/heartbeat) → NO toca el
# branch/working-tree/índice del motor (que commitea en main). --no-verify: el latido no
# es un deploy (el pre-push solo valida gh-pages, pero lo saltamos por higiene).
# Best-effort: si el push falla (blip de red), no rompe la corrida.
emit_heartbeat() {
  ( cd "$REPO_ROOT" 2>/dev/null || exit 0
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    blob="$(printf 'hash-autopilot heartbeat\nutc=%s\nhost=%s\n' "$ts" "$(hostname 2>/dev/null || echo unknown)" | git hash-object -w --stdin 2>/dev/null)" || exit 0
    tree="$(printf '100644 blob %s\theartbeat.txt\n' "$blob" | git mktree 2>/dev/null)" || exit 0
    commit="$(GIT_AUTHOR_NAME='sh-autopilot' GIT_AUTHOR_EMAIL='autopilot@local' GIT_COMMITTER_NAME='sh-autopilot' GIT_COMMITTER_EMAIL='autopilot@local' git commit-tree "$tree" -m "heartbeat $ts" 2>/dev/null)" || exit 0
    git push --no-verify --force origin "${commit}:refs/heads/ops/heartbeat" >/dev/null 2>&1 || true
  ) || true
}
echo "$(date '+%F %T') Latido (heartbeat → ops/heartbeat)…"
emit_heartbeat

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

# ── DETECCIÓN SIEMPRE (SIN gate por release) ────────────────────────────────
# Antes el escaneo completo se condicionaba a un "release nuevo" (code-id de
# /version.json). PERO los hashes ROTAN sin que ese code-id cambie de forma detectable:
# el 2026-07-16 SearchProducts rotó, el gate NO disparó, y el Actualizador de Catálogos
# tronó sin aviso. Conclusión del operador: el gate por release no hace diferencia para
# hashes rotados. → El validador corre en CADA tick (barato: Python puro, sin navegador,
# ~2 min); si detecta stale, dispara el motor completo para auto-capturar y deployar.
# Escribe tools/.hash-validation/<date>.json que el motor lee para planificar.
echo "$(date '+%F %T') Corriendo validate-hashes.py (detección — SIEMPRE, sin gate)…"
"$PYTHON" "$REPO_ROOT/tools/validate-hashes.py"
VAL_RC=$?
if [ "$VAL_RC" = "2" ]; then
  echo "$(date '+%F %T') validate-hashes.py exit 2 (auth roto) — ver correo; NO abro el motor." >&2
  exit 2
fi
if [ "$VAL_RC" = "1" ]; then
  # Hay stale → motor completo (enmascaradas + stale del validador) → auto-captura + deploy + correo.
  echo "$(date '+%F %T') Stale detectado → motor completo (auto-captura + deploy)…"
  cd "$AUTOPILOT_DIR"
  "$NODE" hash-autopilot.mjs
  exit $?
fi
echo "$(date '+%F %T') 0 stale (las enmascaradas ya se recapturaron en la capa 1)."
exit "$MASKED_RC"
