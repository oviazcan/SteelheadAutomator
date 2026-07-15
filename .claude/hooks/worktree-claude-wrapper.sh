# worktree-claude-wrapper.sh — función `claude()` que redirige una sesión NUEVA a un
# worktree libre si el actual ya tiene otra instancia activa (evita que dos sesiones
# se pisen en main). Es la ÚNICA pieza que fija el cwd ANTES de que exista el proceso
# claude (un hook llega tarde: no puede mover la sesión).
#
# GENÉRICO Y TRANSMISIBLE: usa el worktree-lock.sh DEL REPO actual
# (<repo>/.claude/hooks/worktree-lock.sh), no una ruta de una máquina. Así viaja con
# cualquier clone. En un repo sin el harness, o fuera de git, es NO-OP (fail-open).
#
# Instalar (una vez por máquina): agrega a tu ~/.zshrc
#     source /ruta/al/clone/.claude/hooks/worktree-claude-wrapper.sh
# o corre  .claude/hooks/install.sh  desde el repo.
#
# Principios: FAIL-OPEN (ante cualquier error → `command claude` normal); NO redirige
# en --resume/--continue; usa subshell para el cd (tu terminal queda donde estaba).

claude() {
  emulate -L sh 2>/dev/null || true
  local a resume=0 root lock dest
  for a in "$@"; do
    case "$a" in
      --resume|-r|--continue|-c|--resume=*|--continue=*) resume=1 ;;
    esac
  done

  if [ "$resume" = 0 ]; then
    root="$(git rev-parse --show-toplevel 2>/dev/null)"
    lock="$root/.claude/hooks/worktree-lock.sh"
    if [ -n "$root" ] && [ -f "$lock" ] && bash "$lock" occupied "$root" 2>/dev/null; then
      dest="$(bash "$lock" pick-free "$root" 2>/dev/null)"
      if [ -z "$dest" ] && [ -x "$root/tools/new-worktree.sh" ]; then
        local name="s$(date +%m%d-%H%M%S)"
        if ( cd "$root" && tools/new-worktree.sh "$name" ) >/dev/null 2>&1; then
          dest="$root/../$(basename "$root")-$name"
        fi
      fi
      if [ -n "$dest" ] && [ -d "$dest" ] && [ "$dest" != "$root" ]; then
        printf '⚠️  Este worktree ya tiene una sesión de Claude activa:\n    %s\n    → abriendo en un worktree libre: %s\n' "$root" "$dest" >&2
        ( cd "$dest" && command claude "$@" )
        return $?
      fi
      printf '⚠️  Este worktree ya tiene otra sesión de Claude activa (%s).\n    No encontré/creé un worktree libre; abriré aquí. Cuidado con pisarte.\n' "$root" >&2
    fi
  fi

  command claude "$@"
}
