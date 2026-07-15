#!/usr/bin/env bash
# worktree-lock.sh — registro de sesiones de Claude por worktree, para que dos
# instancias no trabajen sobre el MISMO worktree y se pisen (incidente 2026-07-08:
# dos sesiones en `main` commiteando/deployando a la vez).
#
# Cada sesión activa deja un lock en:
#   ~/.claude/worktree-locks/<toplevel-hash>/<session_id>  → "FIRST_SEEN|LAST_BEAT|TOPLEVEL"
# FIRST_SEEN se fija al registrar y NO cambia (decide antigüedad/dueño); LAST_BEAT se
# renueva en cada heartbeat (decide vida). Usar un solo timestamp para ambos rompía la
# noción de dueño (el heartbeat lo movía). "Dueña" del worktree = sesión con LAST_BEAT
# fresco (> now - TTL, default 300s) y menor FIRST_SEEN (empate → menor session_id).
# Los stale se purgan — cubre cierres abruptos donde SessionEnd no dispara.
#
# Es fail-open y worktree-aware: si no hay git/toplevel, o algo truena, NO estorba.
#
# Modos:
#   register    (SessionStart)                     renueva mi heartbeat en mi worktree
#   heartbeat   (UserPromptSubmit/PostToolUse)     renueva epoch
#   release     (SessionEnd)                        borra mi heartbeat
#   check       (SessionStart)                      si soy INVITADO, imprime aviso a stdout
#   occupied <root>                                 exit 0 si hay CUALQUIER sesión fresca en <root>
#   owner-of <root>                                 imprime session_id dueño (o vacío)
#   am-owner <root> <sid>                           exit 0 si <sid> es la dueña de <root>
#   pick-free <root>                                imprime path de worktree destino libre
#
# El JSON del hook llega por stdin (para register/heartbeat/release/check).
set -u

TTL="${SH_WT_TTL:-300}"                 # segundos sin heartbeat = lock muerto
LOCKROOT="${SH_WT_LOCKROOT:-$HOME/.claude/worktree-locks}"

mode="${1:-}"

now() { date +%s; }
# hash corto y estable del path del worktree (nombre de subcarpeta)
hash_root() { printf '%s' "$1" | cksum | cut -d' ' -f1; }
toplevel_of() { git -C "${1:-.}" rev-parse --show-toplevel 2>/dev/null; }

# Lee session_id y cwd del payload del hook (stdin). Fail-safe.
read_payload() {
  local input; input="$(cat 2>/dev/null || true)"
  SID="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)"
  HCWD="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"
  [ -n "${SID:-}" ] || SID=""
  [ -n "${HCWD:-}" ] || HCWD="$PWD"
}

dir_for() { echo "$LOCKROOT/$(hash_root "$1")"; }

# Imprime "FIRST_SEEN SID" por cada lock con LAST_BEAT FRESCO en $1 (purga stale).
fresh_locks() {
  local root="$1" d f first beat sid limit
  d="$(dir_for "$root")"
  [ -d "$d" ] || return 0
  limit=$(( $(now) - TTL ))
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    first="$(cut -d'|' -f1 "$f" 2>/dev/null)"
    beat="$(cut -d'|' -f2 "$f" 2>/dev/null)"
    sid="$(basename "$f")"
    case "$beat" in ''|*[!0-9]*) rm -f "$f" 2>/dev/null; continue;; esac  # formato viejo/corrupto → purga
    case "$first" in ''|*[!0-9]*) first="$beat";; esac
    if [ "$beat" -lt "$limit" ]; then rm -f "$f" 2>/dev/null; continue; fi
    echo "$first $sid"
  done
}

# session_id dueño = menor FIRST_SEEN entre frescos (empate → menor sid). Vacío si ninguno.
owner_of() {
  fresh_locks "$1" | sort -k1,1n -k2,2 | head -1 | awk '{print $2}'
}

write_hb() {   # write_hb <root> <sid>: fija FIRST_SEEN la 1ª vez, renueva LAST_BEAT siempre
  local d f first; d="$(dir_for "$1")"; f="$d/$2"
  mkdir -p "$d" 2>/dev/null || return 0
  first="$(cut -d'|' -f1 "$f" 2>/dev/null)"
  case "$first" in ''|*[!0-9]*) first="$(now)";; esac   # nuevo o formato viejo → arranca ahora
  printf '%s|%s|%s' "$first" "$(now)" "$1" > "$f" 2>/dev/null || true
}

case "$mode" in
  register|heartbeat)
    read_payload
    [ -n "$SID" ] || exit 0
    root="$(toplevel_of "$HCWD")"; [ -n "$root" ] || exit 0
    write_hb "$root" "$SID"
    exit 0
    ;;

  release)
    read_payload
    [ -n "$SID" ] || exit 0
    root="$(toplevel_of "$HCWD")"; [ -n "$root" ] || exit 0
    rm -f "$(dir_for "$root")/$SID" 2>/dev/null || true
    exit 0
    ;;

  check)
    read_payload
    [ -n "$SID" ] || exit 0
    root="$(toplevel_of "$HCWD")"; [ -n "$root" ] || exit 0
    # registro mi heartbeat primero (para que el dueño se calcule con mi llegada)
    write_hb "$root" "$SID"
    owner="$(owner_of "$root")"
    if [ -n "$owner" ] && [ "$owner" != "$SID" ]; then
      dest="$(bash "$0" pick-free "$root" 2>/dev/null || true)"
      if [ -n "$dest" ]; then
        hint="Muévete a un worktree LIBRE antes de editar/commitear:  cd \"$dest\""
      else
        hint="Crea un worktree aislado:  tools/new-worktree.sh <nombre>  (y trabaja en ../SteelheadAutomator-<nombre>)"
      fi
      cat <<EOF
[worktree-guard] ⚠️ OTRA sesión de Claude (${owner:0:8}) ya trabaja en este worktree:
  $root
Para NO pisarla (incidente 2026-07-08: dos sesiones en main se pisaron al commitear/deployar):
  · $hint
Mientras sigas en este worktree, el guard bloqueará tus escrituras (Edit/Write/commit)
salvo que uses SH_ALLOW_DEPLOY=1 para un deploy deliberado. La sesión dueña trabaja libre.
EOF
    fi
    exit 0
    ;;

  occupied)   # occupied <root> → exit 0 si hay CUALQUIER sesión fresca (para el wrapper)
    root="$(toplevel_of "${2:-.}")"; [ -n "$root" ] || exit 1
    [ -n "$(fresh_locks "$root")" ] && exit 0 || exit 1
    ;;

  owner-of)
    root="$(toplevel_of "${2:-.}")"; [ -n "$root" ] || exit 0
    owner_of "$root"
    ;;

  am-owner)   # am-owner <root> <sid>
    root="$(toplevel_of "${2:-.}")"; sid="${3:-}"
    [ -n "$root" ] && [ -n "$sid" ] || exit 0    # fail-open: si no sé, no bloqueo
    owner="$(owner_of "$root")"
    # dueño real, o nadie aún (yo soy el primero) → soy dueño
    [ -z "$owner" ] || [ "$owner" = "$sid" ]
    ;;

  pick-free)  # pick-free <root> → path del worktree destino libre (workbench o nuevo)
    root="$(toplevel_of "${2:-.}")"; [ -n "$root" ] || exit 0
    # candidatos: worktrees existentes del repo que NO estén ocupados, workbench primero
    wb=""; others=""
    while IFS= read -r wt; do
      [ -n "$wt" ] || continue
      [ "$wt" = "$root" ] && continue
      if [ -n "$(fresh_locks "$wt")" ]; then continue; fi   # ocupado
      case "$wt" in *workbench*) wb="$wt";; *) others="${others:-$wt}";; esac
    done < <(git -C "$root" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}')
    if [ -n "$wb" ]; then echo "$wb"; else echo "${others:-}"; fi
    ;;

  *)
    echo "worktree-lock.sh: modo desconocido '$mode'" >&2
    exit 64
    ;;
esac
