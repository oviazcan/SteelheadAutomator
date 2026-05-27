#!/usr/bin/env bash
# new-worktree.sh — Crea un git worktree aislado para correr una segunda
# instancia de Claude (o cualquier edición paralela) sin pisar al main.
#
# Uso:
#   tools/new-worktree.sh <feature-name> [branch-base]
#
# Ejemplo:
#   tools/new-worktree.sh dup-validator-tier4
#   tools/new-worktree.sh hash-rescan main
#
# Resultado:
#   - Crea rama "wt/<feature-name>" desde [branch-base] (default: main)
#   - Crea worktree en "../SteelheadAutomator-<feature-name>"
#   - Recuerda los hot files que NO debes tocar en paralelo

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "uso: $0 <feature-name> [branch-base]" >&2
  exit 1
fi

FEATURE="$1"
BASE_BRANCH="${2:-main}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_BRANCH="wt/${FEATURE}"
WORKTREE_PATH="${REPO_ROOT}/../SteelheadAutomator-${FEATURE}"

# Validar nombre (solo alfanumérico, guiones, underscores)
if ! [[ "$FEATURE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "❌ feature-name solo puede contener [a-zA-Z0-9_-]: '$FEATURE'" >&2
  exit 1
fi

cd "$REPO_ROOT"

# 1. Verificar que la rama base existe localmente
if ! git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  echo "❌ La rama base '$BASE_BRANCH' no existe localmente" >&2
  exit 1
fi

# 2. Verificar que la rama wt/ no existe ya
if git rev-parse --verify "$WORKTREE_BRANCH" >/dev/null 2>&1; then
  echo "❌ La rama '$WORKTREE_BRANCH' ya existe. Borra primero o usa otro nombre:" >&2
  echo "   git branch -D $WORKTREE_BRANCH" >&2
  exit 1
fi

# 3. Verificar que el path destino no existe
if [ -e "$WORKTREE_PATH" ]; then
  echo "❌ El path '$WORKTREE_PATH' ya existe" >&2
  exit 1
fi

# 4. Crear worktree
echo "→ Creando worktree '$WORKTREE_PATH' en rama '$WORKTREE_BRANCH' (base: $BASE_BRANCH)..."
git worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_PATH" "$BASE_BRANCH"

# 5. Reminder de hot files que NO se deben editar en paralelo
cat <<EOF

✅ Worktree listo: $WORKTREE_PATH
   Rama: $WORKTREE_BRANCH (desde $BASE_BRANCH)

────────────────────────────────────────────────────────────
⚠  REGLAS DE COORDINACIÓN PARA DOS INSTANCIAS DE CLAUDE
────────────────────────────────────────────────────────────

Hot files — editarlos en paralelo causa merge conflict casi seguro:
  • remote/config.json       (version bump + hashes compartidos)
  • CLAUDE.md                 (índice de applets + reglas globales)
  • rama gh-pages             (deploy mirror — solo una sesión deploya a la vez)

Reglas:
  1. Solo UNA sesión bumpea remote/config.json y deploya a gh-pages por vez.
  2. Si vas a editar config.json o CLAUDE.md, avísale a la otra sesión o
     hazlo en pasadas cortas (read → edit → commit → push) sin dejarlo WIP.
  3. Para deploys: la sesión que está deployando hace 'git stash' del WIP
     de la otra rama antes de checkout gh-pages, no toca el worktree ajeno.
  4. Toca solo UN applet por sesión, idealmente. Si tocan dos applets que
     comparten helpers (host-cleanup-shared.js, process-canon.js), coordinar.

Cómo empezar la segunda sesión:
  cd $WORKTREE_PATH
  claude       # abre Claude Code en este worktree

Cuando termines:
  cd $REPO_ROOT
  git worktree remove $WORKTREE_PATH
  git branch -D $WORKTREE_BRANCH   # si ya mergeaste o descartaste

EOF
