#!/usr/bin/env bash
# Sincroniza los scripts del candado desde la FUENTE ÚNICA (remote/scripts/) hacia el
# paquete de la Safari Web Extension. Evita divergencia de código entre el candado de
# Chrome (productivo, remote-loader) y el de Safari/iPad (empaquetado). El candado es
# 100% autocontenido (no usa chrome.* ni otros scripts), así que la copia es byte-a-byte.
#
# Corre esto cada vez que cambie la lógica del candado en remote/scripts/, ANTES de
# recompilar la app en Xcode.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/remote/scripts"
DST="$ROOT/safari/extension"

for f in surtido-guard-core.js surtido-guard.js; do
  cp "$SRC/$f" "$DST/$f"
  echo "  ✓ $f"
done
echo "Sync OK. Recuerda recompilar en Xcode (los cambios NO llegan solos como en gh-pages)."
