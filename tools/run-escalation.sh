#!/usr/bin/env bash
# Wrapper del Nivel B (escalación de recetas rotas). Lo invoca el launchd a :53.
# Gate por needs-attention.json + marcador idempotente diario; refresca ROCP; corre
# claude -p con el prompt de re-descubrimiento. Cero costo en días limpios.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REPO_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"
: "${PYTHON:=/usr/bin/python3}"
: "${REPORTES_SH:=/Users/oviazcan/Projects/Ecoplating/Reportes SH}"
STATE_DIR="$REPO_ROOT/tools/.hash-autopilot"
NEEDS="$STATE_DIR/needs-attention.json"
TODAY="$(date '+%F')"
TRIED_MARK="$STATE_DIR/escalation-tried-$TODAY"
PROMPT="$REPO_ROOT/tools/hash-autopilot/escalation-prompt.md"

# Gate: sin señal → salir en silencio. Ya intentado hoy → salir (idempotente).
[ -f "$NEEDS" ] || { echo "$(date '+%F %T') sin needs-attention → nada que hacer"; exit 0; }
[ -f "$TRIED_MARK" ] && { echo "$(date '+%F %T') ya intenté hoy → skip"; exit 0; }

# Refrescar ROCP (fail-ruidoso: sin auth, no abrir navegador).
if ! ( cd "$REPORTES_SH" && "$PYTHON" -c "import sys; sys.path.insert(0,'scripts'); from steelhead_auth import get_access_token; get_access_token(force_refresh=True)" >/dev/null 2>&1 ); then
  echo "$(date '+%F %T') FATAL: refresh ROCP falló — no corro escalación" >&2
  "$REPO_ROOT/tools/hash-autopilot/autopilot-notify.sh" fallo "Nivel B: auth caída" "El refresh ROCP falló; la escalación no corrió. Corre steelhead_auth.py." 2>/dev/null || true
  exit 2
fi

touch "$TRIED_MARK"   # marca idempotente ANTES de correr (evita loop si claude cuelga)
cd "$REPO_ROOT"
# CLAUDE_BIN permite inyectar un stub en pruebas supervisadas; default = claude real.
"${CLAUDE_BIN:-claude}" -p "$(cat "$PROMPT")" --dangerously-skip-permissions 2>&1 | tee "$STATE_DIR/escalation-last.log"
