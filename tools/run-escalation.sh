#!/usr/bin/env bash
# Wrapper del Nivel B (escalación de recetas rotas). Lo invoca el launchd a :53.
# Gate por needs-attention.json + marcador idempotente diario; refresca ROCP; corre
# claude -p con el prompt de re-descubrimiento. Cero costo en días limpios.
set -uo pipefail
# ~/.local/bin PRIMERO: ahí vive el binario real de `claude` (launchd NO carga el .zshrc,
# donde `claude` es una FUNCIÓN shell — en el entorno del cron ese nombre no resuelve sin
# este PATH). Sin esto, `claude -p` daba "command not found" al dispararse el Nivel B real.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

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

# Gate de OCUPACIÓN: `claude -p` corre el binario directo (NO la función shell worktree-aware),
# así que si REPO_ROOT ya tiene una sesión Claude interactiva fresca, el headless la PISARÍA
# (edita route-catalog.json, commitea, deploya). Posponer al PRÓXIMO tick (:53 de la siguiente
# hora) SIN marcar idempotente → reintenta solo. El Nivel B no es urgente (una receta rota
# puede esperar 1h). ESCALATION_FORCE=1 lo salta (pruebas supervisadas).
LOCK="$REPO_ROOT/.claude/hooks/worktree-lock.sh"
if [ "${ESCALATION_FORCE:-0}" != "1" ] && [ -x "$LOCK" ] && bash "$LOCK" occupied "$REPO_ROOT" 2>/dev/null; then
  echo "$(date '+%F %T') main OCUPADO por otra sesión Claude → pospongo al próximo tick (sin marcar idempotente)"
  exit 0
fi

# Refrescar ROCP (fail-ruidoso: sin auth, no abrir navegador).
if ! ( cd "$REPORTES_SH" && "$PYTHON" -c "import sys; sys.path.insert(0,'scripts'); from steelhead_auth import get_access_token; get_access_token(force_refresh=True)" >/dev/null 2>&1 ); then
  echo "$(date '+%F %T') FATAL: refresh ROCP falló — no corro escalación" >&2
  "$REPO_ROOT/tools/hash-autopilot/autopilot-notify.sh" fallo "Nivel B: auth caída" "El refresh ROCP falló; la escalación no corrió. Corre steelhead_auth.py." 2>/dev/null || true
  exit 2
fi

touch "$TRIED_MARK"   # marca idempotente ANTES de correr (evita loop si claude cuelga)
cd "$REPO_ROOT"
# El Nivel B corre con el login claude.ai (SUSCRIPCIÓN), NO con ANTHROPIC_API_KEY: si hay una
# API key en el entorno toma PRECEDENCIA y, sin saldo, claude -p muere con "Credit balance is
# too low" (visto en vivo 2026-07-17). Unset-earla hace que use el login claude.ai (probado:
# responde). En el launchd real normalmente no está (no carga el .zshrc), pero esto lo blinda
# si se hereda. Para usar la API key en su lugar, exporta SA_KEEP_API_KEY=1 (y recárgala).
[ "${SA_KEEP_API_KEY:-0}" = "1" ] || unset ANTHROPIC_API_KEY
# CLAUDE_BIN permite inyectar un stub en pruebas supervisadas; default = claude real (resuelto
# vía ~/.local/bin, ver PATH arriba). --dangerously-skip-permissions: corrida desatendida.
"${CLAUDE_BIN:-claude}" -p "$(cat "$PROMPT")" --dangerously-skip-permissions 2>&1 | tee "$STATE_DIR/escalation-last.log"
rc=${PIPESTATUS[0]}
# Fail-ruidoso: si claude -p no completó (auth caída, binario ausente, crash) avisar — si no,
# el Nivel B fallaría en SILENCIO y la receta rota se quedaría sin reparar sin que nadie lo note.
if [ "${rc:-0}" -ne 0 ]; then
  echo "$(date '+%F %T') claude -p salió con código $rc" >&2
  "$REPO_ROOT/tools/hash-autopilot/autopilot-notify.sh" fallo "Nivel B: claude -p falló (exit $rc)" \
    "El agente de escalación no completó (¿auth de claude? ¿binario? revisa $STATE_DIR/escalation-last.log). needs-attention.json sigue pendiente." 2>/dev/null || true
fi
