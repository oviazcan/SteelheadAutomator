#!/usr/bin/env bash
# deploy-status.sh — GROUND TRUTH del estado de deploy en UN comando.
#
# Imprime la versión de config en: tu rama actual, main, gh-pages (git) y el
# sitio EN VIVO (GitHub Pages), y verifica el invariante:
#     gh-pages  ==  main:remote/   (byte-a-byte: config.json + scripts/**.js)
#
# Para qué sirve: matar la pregunta "¿esto ya está vivo?" sin adivinar mirando
# el config de una rama de trabajo desfasada. Solo lee, no modifica nada.
#
# Uso:
#   tools/deploy-status.sh
set -uo pipefail

GH_PAGES_BASE="https://oviazcan.github.io/SteelheadAutomator"
REPO_ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
cd "$REPO_ROOT"

cfgver() { grep -E '"version"' | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }

CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
MAIN_VER="$(git show main:remote/config.json 2>/dev/null | cfgver)"
GHP_VER="$(git show gh-pages:config.json 2>/dev/null | cfgver)"
LIVE_BODY="$(curl -fsSL -H 'Cache-Control: no-cache' "$GH_PAGES_BASE/config.json?_=$(date +%s)" 2>/dev/null || true)"
LIVE_VER="$(echo "$LIVE_BODY" | cfgver)"

echo "=== Estado de deploy (ground truth) ==="
if git cat-file -e "HEAD:remote/config.json" 2>/dev/null; then
  echo "  rama actual ($CUR_BRANCH): config $(git show HEAD:remote/config.json | cfgver)"
elif git cat-file -e "HEAD:config.json" 2>/dev/null; then
  echo "  rama actual ($CUR_BRANCH): config $(git show HEAD:config.json | cfgver)  [rama de deploy]"
fi
echo "  main (git)   : config ${MAIN_VER:-?}"
echo "  gh-pages(git): config ${GHP_VER:-?}"
echo "  EN VIVO      : config ${LIVE_VER:-(no responde)}"
echo

echo "=== Invariante gh-pages == main:remote/ (byte-a-byte) ==="
DRIFT=0
if ! diff -q <(git show main:remote/config.json 2>/dev/null) <(git show gh-pages:config.json 2>/dev/null) >/dev/null 2>&1; then
  echo "  ✗ config.json difiere entre main:remote/ y gh-pages"; DRIFT=1
fi
while IFS= read -r f; do
  base="${f#scripts/}"
  if ! diff -q <(git show "main:remote/scripts/$base" 2>/dev/null) <(git show "gh-pages:$f" 2>/dev/null) >/dev/null 2>&1; then
    echo "  ✗ scripts/$base difiere (o falta en main:remote/scripts/)"; DRIFT=1
  fi
done < <(git ls-tree -r --name-only gh-pages -- scripts/ 2>/dev/null | grep -E '\.js$')
# scripts SERVIDOS (referenciados en config.apps[].scripts) que faltan en gh-pages.
# OJO: solo cuentan los referenciados; los .js dev-only de remote/scripts/
# (build helpers, módulos de test) NO se sirven y NO son drift.
while IFS= read -r s; do            # s = scripts/foo.js
  [ -n "$s" ] || continue
  if ! git cat-file -e "gh-pages:$s" 2>/dev/null; then
    echo "  ✗ $s referenciado en config pero NO en gh-pages (sin deployar)"; DRIFT=1
  fi
done < <(git show main:remote/config.json 2>/dev/null | grep -oE '"scripts/[^"]+\.js"' | tr -d '"' | sort -u)
[ $DRIFT -eq 0 ] && echo "  ✓ gh-pages espeja main:remote/ (config + scripts .js)"
echo

if [ -n "$MAIN_VER" ] && [ "$MAIN_VER" = "$GHP_VER" ] && [ "$GHP_VER" = "$LIVE_VER" ] && [ $DRIFT -eq 0 ]; then
  echo "✅ Todo alineado: main = gh-pages = EN VIVO = $MAIN_VER"
elif [ "$MAIN_VER" = "$GHP_VER" ] && [ $DRIFT -eq 0 ] && [ "$GHP_VER" != "$LIVE_VER" ]; then
  echo "⏳ git OK ($MAIN_VER) pero el sitio en vivo aún sirve ${LIVE_VER:-?} — GH Pages publicando (~30-60s + caché CDN ~5min)."
else
  echo "⚠️  Desalineado: main=$MAIN_VER  gh-pages=$GHP_VER  vivo=${LIVE_VER:-?}  drift=$DRIFT"
  echo "    Corre tools/deploy.sh para re-espejar y publicar."
fi
