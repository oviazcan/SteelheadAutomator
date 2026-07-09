#!/usr/bin/env bash
# run-tests.sh — corre TODA la suite (Node + Python) y sale !=0 si algo falla.
#
# Por qué existe: los tests se corrían archivo por archivo a mano, sin un comando
# único ni gate. Resultado: 4 archivos se pusieron rojos sin que nadie lo notara
# (bugs de producto + tests desincronizados de refactors). Este script es la
# fuente de verdad del "green build" y el gate que deploy.sh debe correr.
#
# Uso:
#   tools/run-tests.sh              # corre todo, resumen
#   tools/run-tests.sh -v           # muestra la salida completa de cada archivo
#   tools/run-tests.sh --no-python  # solo JS (si no hay pytest en la máquina)
#
# Notas:
#  - Cada .test.js se corre AISLADO (node --test <archivo>): `node --test <dir>`
#    no resuelve el directorio en Node 25, y correrlos juntos comparte estado de
#    módulos (algunos applets cargan el IIFE completo en vm).
#  - Los tools/test/*.test.js son la suite canónica. Los tools/test_*.js de la raíz
#    son tests legacy que aún pasan (se incluyen para no perder cobertura).
#  - node --test refleja el exit code real incluso de los tests con harness propio
#    (po-reconciler usa console.log + process.exit) — verde = exit 0.
set -uo pipefail
cd "$(dirname "$0")/.."

VERBOSE=0
RUN_PYTHON=1
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    --no-python)  RUN_PYTHON=0 ;;
    *) echo "flag desconocido: $arg" >&2; exit 2 ;;
  esac
done

pass=0; fail=0; failed_files=()

run_one() {
  local f="$1"
  if [ "$VERBOSE" = 1 ]; then
    echo "── $f"
    if node --test "$f"; then pass=$((pass+1)); else fail=$((fail+1)); failed_files+=("$f"); fi
  else
    if node --test "$f" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); failed_files+=("$f"); fi
  fi
}

echo "▶ JS (node:test) — tools/test/*.test.js + tools/test_*.js"
shopt -s nullglob
for f in tools/test/*.test.js tools/test_*.js; do run_one "$f"; done
shopt -u nullglob

if [ "$RUN_PYTHON" = 1 ]; then
  echo "▶ Python (pytest) — tools/test_*.py"
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import pytest' >/dev/null 2>&1; then
    for pf in tools/test_*.py; do
      [ -e "$pf" ] || continue
      if [ "$VERBOSE" = 1 ]; then
        echo "── $pf"
        if python3 -m pytest -q "$pf"; then pass=$((pass+1)); else fail=$((fail+1)); failed_files+=("$pf"); fi
      else
        if python3 -m pytest -q "$pf" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); failed_files+=("$pf"); fi
      fi
    done
  else
    echo "  (pytest no disponible — omito Python; usa --no-python para silenciar)"
  fi
fi

echo
echo "──────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  echo "✓ suite VERDE — $pass archivos, 0 rojos"
  exit 0
else
  echo "✗ suite ROJA — $pass verdes, $fail rojos:"
  for ff in "${failed_files[@]}"; do echo "    ✗ $ff"; done
  echo "  Corre con -v para ver el detalle. NO deployar hasta verde."
  exit 1
fi
