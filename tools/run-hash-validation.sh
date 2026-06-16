#!/usr/bin/env bash
# Wrapper para la validación diaria de persisted-query hashes de Steelhead.
# Lo invoca el launchd plist (com.ecoplating.steelhead-hash-validator).
#
# Hace:
#   - cd al repo (auto-detectado por la ubicación de este script)
#   - corre tools/validate-hashes.py
#   - exit 1 (stale)  -> notify-stale-hashes.sh (issue+email+bitácora) + notificación macOS
#   - exit 2 (auth)   -> notificación macOS "re-login"
#   - exit 0 (ok)     -> append "0 rotado(s)" a la bitácora + commit/push (deja rastro)
#
# Overrides opcionales por env var: REPO_ROOT, PYTHON
set -uo pipefail

# launchd arranca con PATH mínimo: agrégale homebrew + system para hallar python3/gh.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REPO_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"
: "${PYTHON:=/usr/bin/python3}"

LOG_DIR="$REPO_ROOT/tools/.hash-validation"
LOG_FILE="$LOG_DIR/runner.log"
TODAY="$(date +%Y-%m-%d)"
RESULT_JSON="$LOG_DIR/$TODAY.json"

cd "$REPO_ROOT" || { echo "ERROR: no pude cd a $REPO_ROOT" >&2; exit 2; }
mkdir -p "$LOG_DIR"

notify() {  # notify <título-corto> <mensaje> <sonido>
  osascript -e "display notification \"$2\" with title \"Steelhead hash-validator\" subtitle \"$(date '+%Y-%m-%d %H:%M')\" sound name \"$3\"" 2>/dev/null || true
}

{
  echo ""
  echo "========================================================================"
  echo "  Hash validation  —  $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "========================================================================"
  "$PYTHON" tools/validate-hashes.py
  rc=$?
  echo "Exit code: $rc  ($(date '+%Y-%m-%d %H:%M:%S %Z'))"

  case "$rc" in
    0)
      echo "OK: todos los hashes vigentes."
      printf '\n## %s — 0 rotado(s) (launchd)\n' "$(date '+%Y-%m-%d %H:%M')" >> docs/api/hash-validation-log.md
      ;;
    1)
      echo "STALE detectado — disparando notificaciones."
      if [ -f "$RESULT_JSON" ]; then
        bash tools/notify-stale-hashes.sh "$RESULT_JSON" || echo "WARN: notify-stale-hashes.sh falló"
      else
        echo "WARN: no existe $RESULT_JSON"
      fi
      notify "stale" "Hashes de Steelhead ROTADOS. Revisa el issue/email y corre el hash-scanner." "Basso"
      ;;
    2)
      echo "FATAL/AUTH (exit 2)."
      notify "auth" "El hash-validator no pudo autenticar (refresh token expirado). Re-login en Reportes SH." "Basso"
      ;;
    *)
      echo "Exit inesperado: $rc"
      notify "error" "hash-validator salió con código $rc. Revisa runner.log." "Basso"
      ;;
  esac

  # Rastro auditable en git: commit + push SOLO de la bitácora. El `git add` es
  # SELECTIVO (solo este archivo) → nunca arrastra otros cambios sin commitear ni
  # toca el working tree del usuario. Push defensivo: si falla (non-ff), loguea y
  # sigue; la próxima corrida lo reintenta.
  if ! git diff --quiet -- docs/api/hash-validation-log.md 2>/dev/null; then
    git add docs/api/hash-validation-log.md
    if git commit -q -m "chore(hash-validation): corrida $TODAY (exit $rc) [launchd]"; then
      git push -q origin main 2>/dev/null && echo "bitácora commiteada+pusheada" \
        || echo "WARN: push de bitácora falló (non-ff?); se sincroniza en la próxima corrida o a mano."
    fi
  fi

  exit "$rc"
} 2>&1 | tee -a "$LOG_FILE"

# preservar el exit code real del pipeline (tee devuelve 0)
exit "${PIPESTATUS[0]}"
