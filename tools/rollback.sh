#!/usr/bin/env bash
# rollback.sh — revierte gh-pages (lo que ven los operadores) al estado de un deploy
# anterior anclado por tag vX.Y.Z. Alivio inmediato ante un deploy malo.
#
# Modelo: deploy.sh crea un tag vX.Y.Z sobre el commit de main de cada bump. Este
# script re-espeja `<tag>:remote/` -> gh-pages (config.json + config.sig + scripts
# servidos), byte-a-byte, igual que la danza de deploy.sh — pero SIN bumpear versión
# y SIN tocar main. Es idempotente/self-healing (reconstruye gh-pages desde el tag).
#
# Uso:
#   tools/rollback.sh v1.7.118            # revierte gh-pages al deploy v1.7.118
#   tools/rollback.sh --list              # lista tags de deploy disponibles
#
# IMPORTANTE — esto revierte SOLO gh-pages. `main` sigue apuntando al commit malo, así
# que el PRÓXIMO deploy.sh volvería a espejar main y re-introduciría el problema. Tras
# estabilizar, arregla main (git revert <commit-malo>) antes del siguiente deploy.
# Ver docs/architecture/rollback.md.
set -euo pipefail

# --- localizar el worktree de main (idéntico a deploy.sh) ---
MAINWT="$(git worktree list --porcelain | awk '
  /^worktree /{wt=substr($0,10)}
  /^branch refs\/heads\/main$/{print wt; exit}')"
if [ -z "$MAINWT" ]; then
  echo "ERROR: no encuentro un worktree en la rama main. Haz checkout de main y reintenta." >&2
  exit 1
fi
G() { git -C "$MAINWT" "$@"; }

# --- --list ---
if [ "${1:-}" = "--list" ] || [ "${1:-}" = "-l" ]; then
  echo "Tags de deploy (más reciente primero):"
  G tag -l 'v*' --sort=-version:refname --format='  %(refname:short)  %(creatordate:short)  %(contents:subject)' | head -30
  exit 0
fi

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "Uso: tools/rollback.sh <vX.Y.Z> | --list" >&2
  exit 64
fi
[ "${TAG#v}" = "$TAG" ] && TAG="v$TAG"   # acepta 1.7.118 o v1.7.118

# --- validaciones ---
G fetch --quiet origin --tags || true
if ! G rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "ERROR: el tag $TAG no existe. Lista con: tools/rollback.sh --list" >&2
  exit 1
fi
if ! G cat-file -e "$TAG:remote/config.json" 2>/dev/null; then
  echo "ERROR: $TAG no contiene remote/config.json (¿tag previo al esquema de deploy?)." >&2
  exit 1
fi
# El worktree de main debe estar limpio (vamos a hacer checkout gh-pages ahí)
if [ -n "$(G status --porcelain | grep -vE '^\?\?' || true)" ]; then
  echo "ERROR: el worktree de main tiene cambios sin commitear. Límpialo antes de rollback." >&2
  exit 1
fi

TARGET_VER="$(G show "$TAG:remote/config.json" | grep -E '"version"' | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
LIVE_VER="$(G show gh-pages:config.json 2>/dev/null | grep -E '"version"' | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || echo '???')"

echo "──────────────────────────────────────────────"
echo "  ROLLBACK de gh-pages"
echo "  vivo ahora (gh-pages): $LIVE_VER"
echo "  revertir a  ($TAG):    $TARGET_VER"
echo "──────────────────────────────────────────────"
echo "Esto reescribe gh-pages al estado de $TAG y lo publica. main NO se toca."
printf "Escribe el tag para confirmar (%s): " "$TAG"
read -r CONFIRM
if [ "$CONFIRM" != "$TAG" ]; then
  echo "Abortado (no coincide)."
  exit 1
fi

# --- danza gh-pages: espejar <TAG>:remote/ (mismo mecanismo que deploy.sh) ---
restore_main() { G checkout main >/dev/null 2>&1 || true; }
trap restore_main EXIT
echo "→ checkout gh-pages + espejo de $TAG:remote/"
G checkout gh-pages >/dev/null 2>&1
G show "$TAG:remote/config.json" > "$MAINWT/config.json"
if G cat-file -e "$TAG:remote/config.sig" 2>/dev/null; then
  G show "$TAG:remote/config.sig" > "$MAINWT/config.sig"
fi
# Conjunto a espejar = scripts servidos en el tag ∪ los presentes hoy en gh-pages
# (para no dejar huérfanos). Si un script no existe en el tag, se elimina de gh-pages.
{
  G show "$TAG:remote/config.json" | grep -oE '"scripts/[^"]+\.js"' | tr -d '"'
  G ls-tree -r --name-only gh-pages -- scripts/
} | sort -u | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if G cat-file -e "$TAG:remote/$rel" 2>/dev/null; then
    mkdir -p "$MAINWT/$(dirname "$rel")"
    G show "$TAG:remote/$rel" > "$MAINWT/$rel"
  else
    G rm -q --cached "$rel" >/dev/null 2>&1 || true
    rm -f "$MAINWT/$rel"
  fi
done
G add -A scripts config.json
[ -f "$MAINWT/config.sig" ] && G add config.sig || true
if G diff --cached --quiet; then
  echo "→ gh-pages ya estaba en el estado de $TAG (nada que revertir)"
else
  G commit -q -m "rollback: gh-pages a $TAG ($TARGET_VER)"
  echo "→ commit gh-pages: $(G log --oneline -1)"
fi
G checkout main >/dev/null 2>&1
trap - EXIT

echo "→ push origin gh-pages"
G push origin gh-pages

echo
echo "✅ gh-pages revertido a $TAG ($TARGET_VER). Verifica en vivo: tools/deploy-status.sh"
echo "⚠️  main sigue en su commit actual. Antes del PRÓXIMO deploy, arregla main"
echo "    (git revert del commit malo) o el siguiente deploy.sh re-espejará el problema."
