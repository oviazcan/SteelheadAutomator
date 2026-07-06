#!/usr/bin/env bash
# Wrapper para hash-autopilot (validación+regeneración de hashes session-sensitive).
# Lo invoca el launchd plist (com.ecoplating.steelhead-hash-autopilot).
#
# GATE POR RELEASE (igual que run-hash-validation.sh): solo abre el navegador
# headless si Steelhead publicó un build nuevo — los persisted-query hashes solo
# rotan con un release del frontend. Así el job corre seguido casi gratis.
#
# El motor (hash-autopilot.mjs) auto-deploya los rotados validados SOLO si el repo
# está en main y sin WIP ajeno (salvaguardas de autopilot-deploy.sh); si no, avisa.
#
# Overrides opcionales por env var: REPO_ROOT, NODE
set -uo pipefail

# launchd arranca con PATH mínimo: agrégale homebrew + system para hallar node/git/curl.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REPO_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"
: "${NODE:=/opt/homebrew/bin/node}"
: "${PYTHON:=/usr/bin/python3}"

AUTOPILOT_DIR="$REPO_ROOT/tools/hash-autopilot"
STATE_DIR="$REPO_ROOT/tools/.hash-autopilot"
mkdir -p "$STATE_DIR"

# ── Gate por release: solo correr si el code-id de /version.json cambió ──
RELEASE_FILE="$STATE_DIR/last-release.txt"
CUR_CODEID="$(curl -s -m 15 https://app.gosteelhead.com/version.json 2>/dev/null | "$PYTHON" -c 'import json,sys;print(json.load(sys.stdin).get("code-id",""))' 2>/dev/null || echo "")"
PREV_CODEID="$(cat "$RELEASE_FILE" 2>/dev/null || echo "")"
if [ -z "$CUR_CODEID" ]; then
  echo "$(date '+%F %T') WARN: no pude leer code-id de /version.json — corro de todos modos (defensivo)."
elif [ "$CUR_CODEID" = "$PREV_CODEID" ]; then
  echo "$(date '+%F %T') Sin release nuevo (code-id ${CUR_CODEID:0:8}) — skip."
  exit 0
fi

echo "$(date '+%F %T') Release nuevo (${CUR_CODEID:0:8}) — corriendo hash-autopilot…"

# ── Fase A: primero el validator (detecta stale de las 176 detectables) ──
# Escribe tools/.hash-validation/<date>.json que el motor lee para planificar.
echo "$(date '+%F %T') Corriendo validate-hashes.py (detección)…"
"$PYTHON" "$REPO_ROOT/tools/validate-hashes.py"
VAL_RC=$?
[ "$VAL_RC" != "0" ] && echo "$(date '+%F %T') validate-hashes.py exit $VAL_RC (stale o auth; el motor decide)"

cd "$AUTOPILOT_DIR"
"$NODE" hash-autopilot.mjs
RC=$?

# Marca este release como procesado salvo que la auth se haya caído (exit 2).
if [ "$RC" != "2" ] && [ -n "$CUR_CODEID" ]; then
  echo "$CUR_CODEID" > "$RELEASE_FILE"
fi
exit "$RC"
