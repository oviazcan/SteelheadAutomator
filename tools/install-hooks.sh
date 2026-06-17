#!/usr/bin/env bash
# install-hooks.sh — instala los git hooks versionados (.githooks/) en este clon.
#
# Copia .githooks/* al directorio de hooks COMÚN del repo (.git/hooks), que se
# consulta siempre, sin importar qué rama tenga checkouteada cada worktree. Se
# copia (no symlink) para que el hook exista aunque un worktree esté parado en
# gh-pages (que no tiene .githooks/). Re-córrelo si editas un hook.
#
# Uso (una vez por clon, y tras editar cualquier hook):
#   tools/install-hooks.sh
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
HOOKS_SRC="$REPO_ROOT/.githooks"
# directorio de hooks común (sirve a todos los worktrees). --git-common-dir puede
# devolver una ruta RELATIVA (".git") relativa a REPO_ROOT, no a tu cwd; en un
# worktree linkeado ".git" es un ARCHIVO, así que hay que resolverla a absoluta.
COMMON="$(git -C "$REPO_ROOT" rev-parse --git-common-dir)"
case "$COMMON" in /*) ;; *) COMMON="$REPO_ROOT/$COMMON" ;; esac
HOOKS_DST="$COMMON/hooks"

mkdir -p "$HOOKS_DST"
installed=0
for h in "$HOOKS_SRC"/*; do
  [ -f "$h" ] || continue
  name="$(basename "$h")"
  cp "$h" "$HOOKS_DST/$name"
  chmod +x "$HOOKS_DST/$name"
  echo "  ✓ instalado: $name → $HOOKS_DST/$name"
  installed=$((installed+1))
done
[ "$installed" -eq 0 ] && echo "  (no hay hooks en $HOOKS_SRC)"
echo "Listo. Hooks activos en $HOOKS_DST"
