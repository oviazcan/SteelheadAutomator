#!/usr/bin/env bash
# wb-deploy.sh — deploy SEGURO de un script desde el worktree `workbench` a
# producción (gh-pages), SIN depender de que la sesión de main suelte su trabajo
# y RESGUARDANDO la WIP y la versión de main.
#
# Qué hace (atómico, con trap de recuperación):
#   1. Localiza el worktree de main.
#   2. Respalda la WIP de main a un patch (safety net) y la guarda en stash.
#   3. Aplica remote/scripts/<script>.js DESDE la rama workbench a main:remote.
#   4. Bumpea config.version DESDE la commiteada (no pisa la intención de main).
#   5. Commit en main (solo el script + config) → espejo gh-pages → push ambas.
#   6. Restaura la WIP de main (stash pop; si choca config.json, gana la deployada).
#   7. Verifica live (check-deploy).
#
# El guard de workbench bloquea push/checkout de main; por eso ESTE deploy se
# invoca con el override deliberado:
#   SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh <script-sin-.js> "<mensaje>" [--minor|--set X.Y.Z]
#
# Si algo falla a media, el trap regresa main a su rama, hace pop del stash y
# avisa con el path del patch — la WIP de main NUNCA se queda atrapada.
set -uo pipefail

SCRIPT_NAME="${1:-}"; MSG="${2:-}"
if [ -z "$SCRIPT_NAME" ] || [ -z "$MSG" ]; then
  echo "Uso: SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh <script-sin-.js> \"<mensaje>\" [--minor|--set X.Y.Z]" >&2
  exit 64
fi
shift 2 || true
BUMP=patch; SETVER=""
while [ $# -gt 0 ]; do case "$1" in
  --minor) BUMP=minor ;; --major) BUMP=major ;; --set) shift; SETVER="${1:-}" ;;
  *) echo "Flag desconocido: $1" >&2; exit 64 ;;
esac; shift || true; done

die() { echo "ERROR: $1" >&2; exit 1; }

SRC="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
SRCFILE="remote/scripts/${SCRIPT_NAME}.js"
git cat-file -e "$SRC:$SRCFILE" 2>/dev/null || die "$SRC no tiene $SRCFILE"

MAINWT="$(git worktree list --porcelain | awk '/^worktree /{wt=substr($0,10)} /^branch refs\/heads\/main$/{print wt; exit}')"
[ -n "$MAINWT" ] || die "no encuentro worktree en main."
G() { git -C "$MAINWT" "$@"; }
echo "→ fuente: $SRC:$SRCFILE   destino: $MAINWT (main)"

G rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && die "main está en medio de un merge."
G fetch -q origin main 2>/dev/null || true
if G rev-parse -q --verify origin/main >/dev/null 2>&1 && ! G merge-base --is-ancestor origin/main main; then
  die "main local está detrás de origin/main — que el agente de main haga pull."
fi

TS="$(date +%Y%m%d-%H%M%S)"
PATCH="/tmp/wb-deploy-mainwip-${TS}.patch"
STASHED=0
ORIG="$(G rev-parse main)"   # HEAD de main ANTES de mutar — ancla de recuperación

cleanup() {
  local rc=$?
  [ $rc -eq 0 ] && return 0
  # Volver a main descartando lo que sea que haya en la rama actual (incl. dance
  # gh-pages a medias), y rebobinar main a su HEAD original (descarta apply/commits
  # parciales). Luego restaurar la WIP de main desde el stash.
  G checkout -f main >/dev/null 2>&1 || true
  G reset --hard "$ORIG" >/dev/null 2>&1 || true
  if [ "$STASHED" = 1 ] && G stash list | grep -q "wb-deploy-$TS"; then
    G stash pop >/dev/null 2>&1 || echo "  ⚠️ pop automático falló; WIP en 'git -C $MAINWT stash list' y en $PATCH" >&2
  fi
  echo "✗ wb-deploy abortó (rc=$rc). main restaurado a ${ORIG:0:7}; WIP respaldada en $PATCH" >&2
}
trap cleanup EXIT

# 1) respaldo + stash de la WIP de main
G diff > "$PATCH" 2>/dev/null || true
if [ -n "$(G status --porcelain | grep -vE '^\?\?' || true)" ]; then
  G stash push -m "wb-deploy-$TS WIP main preservada" >/dev/null || die "no pude stashear la WIP de main."
  STASHED=1
  echo "→ WIP de main guardada (stash + $PATCH)"
else
  echo "→ main sin WIP que resguardar"
fi

# 2) aplicar el script de workbench + bump desde la versión COMMITEADA
G show "$SRC:$SRCFILE" > "$MAINWT/$SRCFILE"
CFG="$MAINWT/remote/config.json"
CUR="$(grep -m1 '"version"' "$CFG" | sed -E 's/.*"([0-9.]+)".*/\1/')"
if [ -n "$SETVER" ]; then NEW="$SETVER"; else
  IFS='.' read -r A B C <<< "$CUR"
  case "$BUMP" in patch) C=$((C+1)) ;; minor) B=$((B+1)); C=0 ;; major) A=$((A+1)); B=0; C=0 ;; esac
  NEW="$A.$B.$C"
fi
NOW="$(date +%Y-%m-%dT%H:%M)"
sed -i '' -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+\"/\1$NEW\"/" "$CFG"
sed -i '' -E "s/(\"lastUpdated\"[[:space:]]*:[[:space:]]*\")[^\"]+\"/\1$NOW\"/" "$CFG"
node --check "$MAINWT/$SRCFILE" >/dev/null 2>&1 || die "el script aplicado no pasa node --check."
echo "→ aplicado $SCRIPT_NAME + bump ${CUR} → ${NEW}"

# 2b) gate de calidad: la suite debe estar verde CON el script de workbench ya
# aplicado a main:remote. Si falla, `die` dispara el trap → restaura main + WIP.
# Bypass de emergencia: SH_SKIP_TESTS=1 SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh ...
if [ "${SH_SKIP_TESTS:-0}" = "1" ]; then
  echo "⚠️  SH_SKIP_TESTS=1 — SALTANDO la suite de tests (bypass de emergencia)."
elif [ -x "$MAINWT/tools/run-tests.sh" ]; then
  echo "→ gate: corriendo la suite de tests (tools/run-tests.sh)…"
  "$MAINWT/tools/run-tests.sh" || die "suite de tests ROJA con el script aplicado (bypass: SH_SKIP_TESTS=1)."
fi

# 2c) sellar: scriptIntegrity + firma (config.sig). Mismo candado que deploy.sh — este
# path NO llama a deploy.sh, así que debe sellar por su cuenta (si no, en Fase 2 pushearía
# un config.json bumpeado con config.sig viejo/ausente y el pre-push lo bloquearía).
if [ -n "${SA_KMS_KEY:-}" ]; then
  echo "→ seal: scriptIntegrity + firma KMS"
  node "$MAINWT/tools/seal-config.mjs" --config "$MAINWT/remote/config.json" \
    --sig "$MAINWT/remote/config.sig" --scripts-dir "$MAINWT/remote/scripts" \
    --backend kms --kms-key "$SA_KMS_KEY" || die "seal falló (¿acceso KMS?)."
else
  echo "⚠️  SA_KMS_KEY no seteada — deploy SIN firmar (pre-Fase-0)."
fi

# 3) commit main (solo el script + config)
G add "$SRCFILE" remote/config.json
[ -f "$MAINWT/remote/config.sig" ] && G add remote/config.sig || true
G commit -q -m "$MSG

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || die "commit main falló."
echo "→ commit main: $(G log --oneline -1)"

# 4) espejo gh-pages (set servido ∪ lo ya presente) + commit
G checkout gh-pages >/dev/null 2>&1 || die "no pude checkout gh-pages."
G show main:remote/config.json > "$MAINWT/config.json"
if G cat-file -e main:remote/config.sig 2>/dev/null; then
  G show main:remote/config.sig > "$MAINWT/config.sig"
fi
{ G show main:remote/config.json | grep -oE '"scripts/[^"]+\.js"' | tr -d '"'
  G ls-tree -r --name-only gh-pages -- scripts/ ; } | sort -u | while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if G cat-file -e "main:remote/$rel" 2>/dev/null; then
    mkdir -p "$MAINWT/$(dirname "$rel")"; G show "main:remote/$rel" > "$MAINWT/$rel"
  fi
done
G add scripts config.json
[ -f "$MAINWT/config.sig" ] && G add config.sig || true
G diff --cached --quiet || G commit -q -m "deploy: $SCRIPT_NAME ($MSG) + bump $NEW"
G checkout main >/dev/null 2>&1 || die "no pude regresar a main (revisa el worktree)."
echo "→ gh-pages espejado y commiteado"

# 5) push ambas (el pre-push valida espejo + versión sube)
G push origin main || die "push main falló (¿pre-push?)."
G push origin gh-pages || die "push gh-pages falló (¿pre-push?)."
echo "→ push main + gh-pages OK"

# 6) restaurar WIP de main (resolver config.json a la deployada si choca)
if [ "$STASHED" = 1 ]; then
  if ! G stash pop >/dev/null 2>&1; then
    G restore --source=HEAD --staged --worktree -- remote/config.json 2>/dev/null || true
    if [ -n "$(G diff --name-only --diff-filter=U)" ]; then
      echo "  ⚠️ conflictos sin resolver tras el pop (aparte de config.json). Revisa $PATCH" >&2
    else
      G stash drop >/dev/null 2>&1 || true
      echo "  (config.json resuelto a la versión deployada; bump redundante de main descartado)"
    fi
  fi
  G reset -q HEAD -- . 2>/dev/null || true   # dejar su WIP SIN stagear, como estaba
  STASHED=0
  echo "→ WIP de main restaurada"
fi
trap - EXIT

# 7) verificar
echo
[ -x "$MAINWT/tools/check-deploy.sh" ] && "$MAINWT/tools/check-deploy.sh" "$SCRIPT_NAME" 2>&1 | tail -14 || true
echo
echo "✅ wb-deploy: $SCRIPT_NAME desplegado a $NEW. GH Pages publica en ~30-60s (+ caché)."
echo "   Verifica cuando quieras: tools/deploy-status.sh  (corre en el worktree de main)"
