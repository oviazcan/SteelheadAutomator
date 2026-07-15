#!/usr/bin/env bash
# worktree-guard.sh — PreToolUse guard: impide que una sesión INVITADA (no dueña
# del worktree) MODIFIQUE el worktree compartido y pise a la sesión dueña.
# Incidente 2026-07-08: dos sesiones en `main` commiteando/deployando a la vez.
# Complementa worktree-lock.sh. Fail-open, worktree-aware, rápido.
#
# Bloquea (exit 2) SOLO si la sesión NO es la dueña del worktree Y la tool escribe
# DENTRO de ese worktree:
#   · Edit / Write / NotebookEdit con file_path dentro del worktree ocupado
#   · Bash con git mutante (commit/add/checkout/reset/…) o deploy.sh / wb-deploy.sh
# Deja pasar: lecturas, escrituras fuera del worktree (scratchpad/tmp), y a la DUEÑA.
# Override deliberado (deploy con bisturí desde una invitada): SH_ALLOW_DEPLOY=1.
set -u
# El lock manager vive AL LADO de este guard (en el repo, transmisible con el clone),
# no en una ruta global de una máquina.
LOCK="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/worktree-lock.sh"
[ -f "$LOCK" ] || exit 0        # sin lock manager → no estorbar

payload="$(cat 2>/dev/null || true)"
parse() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null; }
SID="$(parse '.session_id // empty')"
HCWD="$(parse '.cwd // empty')"
TOOL="$(parse '.tool_name // empty')"
[ -n "$HCWD" ] || HCWD="$PWD"
[ -n "$SID" ] || exit 0         # sin sid → fail-open

root="$(git -C "$HCWD" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$root" ] || exit 0        # fuera de repo → no aplica

# ¿soy la DUEÑA? → trabajo libre (incluye deploys con bisturí). am-owner es fail-open.
if bash "$LOCK" am-owner "$root" "$SID"; then exit 0; fi

# Soy INVITADA. ¿esta tool escribe DENTRO del worktree ocupado?
writes=0
case "$TOOL" in
  Edit|Write|NotebookEdit)
    fp="$(parse '.tool_input.file_path // .tool_input.notebook_path // ""')"
    case "$fp" in
      "$root"/*) writes=1 ;;    # dentro del worktree compartido → escritura peligrosa
      *) writes=0 ;;            # scratchpad / /tmp / otro → permite
    esac
    ;;
  Bash)
    cmd="$(parse '.tool_input.command // ""')"
    printf '%s' "$cmd" | grep -q 'SH_ALLOW_DEPLOY=1' && exit 0   # override de deploy
    if printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+(commit|add|checkout|switch|reset|merge|rebase|stash|push|rm|mv|apply|restore|clean)([[:space:]]|$)|(^|/)(wb-)?deploy\.sh'; then
      writes=1
    fi
    ;;
esac
[ "$writes" = 1 ] || exit 0     # lectura o escritura fuera del worktree → pasa

# BLOQUEAR (exit 2: stderr se le devuelve a Claude como motivo)
owner="$(bash "$LOCK" owner-of "$root" 2>/dev/null)"
dest="$(bash "$LOCK" pick-free "$root" 2>/dev/null)"
{
  echo "🔒 [worktree-guard] BLOQUEADO: eres una sesión INVITADA en este worktree y pisarías a otra."
  echo "   worktree: $root"
  echo "   dueña:    ${owner:0:8} (llegó primero; trabaja aquí sin restricción)"
  echo "   Muévete a un worktree LIBRE antes de escribir/commitear:"
  if [ -n "$dest" ]; then echo "     cd \"$dest\"    # y reanuda ahí"; else echo "     tools/new-worktree.sh <nombre>"; fi
  echo "   Deploy deliberado desde aquí (con bisturí): antepón  SH_ALLOW_DEPLOY=1  al comando."
} >&2
exit 2
