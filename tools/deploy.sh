#!/usr/bin/env bash
# deploy.sh — deploy de remote/ a producción (gh-pages) en UN comando atómico.
#
# Hace TODA la danza documentada en CLAUDE.md §"Deploy a producción", de forma
# que no se pueda driftear por pasos hechos a mano:
#   1) Resuelve el worktree de `main` y verifica que esté limpio salvo cambios
#      bajo remote/, y al día con origin/main.
#   2) Bumpea config.json version (patch por default) + lastUpdated a ahora.
#   3) Commit en main con tu mensaje.
#   4) ESPEJA main:remote/ -> gh-pages (todos los scripts/** + config.json),
#      garantizando el invariante byte-a-byte (self-healing si gh-pages driftó).
#   5) Commit en gh-pages y push de AMBAS ramas.
#   6) Corre check-deploy.sh para confirmar publicación en vivo.
#
# Uso:
#   tools/deploy.sh "fix(applet-x): descripción"                # bump patch
#   tools/deploy.sh "feat(applet-x): ..."  --minor              # bump minor
#   tools/deploy.sh "chore: ..."           --set 1.7.0          # versión exacta
#   tools/deploy.sh "..."  --check proceso-calculator          # check-deploy de ese script
#   tools/deploy.sh "..."  --zip                                # + republica el .zip de la extensión
#
# --zip: empaqueta extension/ y lo publica como steelhead-automator.zip EN EL MISMO
#   commit de gh-pages que el config. Tiene que ser el mismo commit por dos razones:
#   el hook pre-push exige que todo push a gh-pages espeje main:remote/ Y suba
#   config.version, y `config.extensionVersion` es lo que dispara el banner de
#   actualización del popup — publicar el config antes que el zip haría que el banner
#   ofreciera el zip viejo. Antes esto se hacía a mano y ya costó un incidente
#   (zip publicado con manifest 1.6.3 mientras el config decía 1.6.4); por eso el
#   flag valida que manifest.version == config.extensionVersion antes de empaquetar.
#
# Pre-requisito: edita tus archivos bajo remote/ EN EL WORKTREE DE main antes de
# correr esto. deploy.sh NO mueve tu trabajo entre ramas; solo deploya lo que ya
# está en main.
set -euo pipefail

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "Uso: tools/deploy.sh \"<mensaje de commit>\" [--minor|--set X.Y.Z] [--check <script>]" >&2
  exit 64
fi
shift || true

BUMP="patch"; SETVER=""; CHECK_SCRIPT=""; PUBLISH_ZIP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --minor) BUMP="minor" ;;
    --major) BUMP="major" ;;
    --set)   shift; SETVER="${1:-}" ;;
    --check) shift; CHECK_SCRIPT="${1:-}" ;;
    --zip)   PUBLISH_ZIP=1 ;;
    *) echo "Flag desconocido: $1" >&2; exit 64 ;;
  esac
  shift || true
done

# --- localizar el worktree de main ---
MAINWT="$(git worktree list --porcelain | awk '
  /^worktree /{wt=substr($0,10)}
  /^branch refs\/heads\/main$/{print wt; exit}')"
if [ -z "$MAINWT" ]; then
  echo "ERROR: no encuentro un worktree en la rama main." >&2
  echo "       Haz checkout de main en algún worktree y reintenta." >&2
  exit 1
fi
echo "→ worktree de main: $MAINWT"
G() { git -C "$MAINWT" "$@"; }

# --- pre-flight ---
G fetch --quiet origin main || true
LOCAL_MAIN="$(G rev-parse main)"
ORIGIN_MAIN="$(G rev-parse origin/main 2>/dev/null || echo "")"
if [ -n "$ORIGIN_MAIN" ] && ! G merge-base --is-ancestor "$ORIGIN_MAIN" "$LOCAL_MAIN"; then
  echo "ERROR: main local está detrás de origin/main. Haz 'git -C \"$MAINWT\" pull' primero." >&2
  exit 1
fi
# El worktree de main solo debe tener cambios bajo remote/ (lo que vas a deployar)
DIRTY_NON_REMOTE="$(G status --porcelain | grep -vE '^\?\?' | awk '{print $2}' | grep -vE '^remote/' || true)"
if [ -n "$DIRTY_NON_REMOTE" ]; then
  echo "ERROR: el worktree de main tiene cambios fuera de remote/:" >&2
  echo "$DIRTY_NON_REMOTE" | sed 's/^/   /' >&2
  echo "       Commitea/descarta esos cambios antes de deployar." >&2
  exit 1
fi

# --- gate de INTEGRIDAD: no se publica nada sin firma ---
# INCIDENTE 2026-08-05: el deploy de 1.11.90 corrió sin SA_KMS_KEY en el entorno. Más abajo
# había un `else` que solo IMPRIMÍA un aviso, así que se publicó el config nuevo conservando el
# `config.sig` Y los `scriptIntegrity` de 1.11.89. Como la verificación es FAIL-CLOSED, la
# extensión ENTERA quedó muerta para todos los usuarios («Sin conexión» en el popup) — no sólo
# el applet que se estaba deployando. Un aviso en medio de 30 líneas de salida no es un candado.
#
# El criterio es el mismo que usa el smoke-check del final: si hay pública real embebida estamos
# en Fase 2 y firmar NO es opcional. Si algún día hay que operar sin firma, se vacía la pública
# —una decisión visible y versionada—, no se deploya a ciegas.
PUB_PREFLIGHT=$(node -e "globalThis.self={};require('$MAINWT/extension/integrity-pubkey.js');process.stdout.write(self.SA_INTEGRITY_PUBKEY||'')" 2>/dev/null || true)
if [ -n "$PUB_PREFLIGHT" ] && [ -z "${SA_KMS_KEY:-}" ]; then
  echo "ERROR: SA_KMS_KEY no está en el entorno y la extensión SÍ verifica firma (Fase 2)." >&2
  echo "       Publicar así deja el config sin re-firmar y apaga la extensión ENTERA para" >&2
  echo "       todos los usuarios (fail-closed). Pasó el 2026-08-05 con 1.11.90." >&2
  echo "" >&2
  echo "       La llave vive en ~/.zshrc; si tu shell no la heredó:" >&2
  echo "         export SA_KMS_KEY=\"projects/…/cryptoKeys/config-signing/cryptoKeyVersions/N\"" >&2
  echo "       y confirma el acceso con:  gcloud auth list" >&2
  exit 1
fi

# --- gate de CANDADO: el hook instalado debe ser el versionado ---
# El pre-push valida espejo, bump Y firma, pero `install-hooks.sh` lo COPIA a .git/hooks:
# mejorar `.githooks/pre-push` NO protege a nadie hasta que cada clon reinstale, y nada avisaba
# del desfase. El 2026-08-05 el hook activo era del 23 de julio —anterior a que se le agregara la
# validación de firma— así que el push roto atravesó un candado que en el repo YA existía.
# Se reinstala solo: es idempotente, y el peor caso de equivocarse es copiar un archivo de más.
HOOKS_SRC="$MAINWT/.githooks"
HOOKS_DST="$(git -C "$MAINWT" rev-parse --git-common-dir)"
case "$HOOKS_DST" in /*) ;; *) HOOKS_DST="$MAINWT/$HOOKS_DST" ;; esac
HOOKS_DST="$HOOKS_DST/hooks"
if [ -d "$HOOKS_SRC" ]; then
  for h in "$HOOKS_SRC"/*; do
    [ -f "$h" ] || continue
    if ! diff -q "$h" "$HOOKS_DST/$(basename "$h")" >/dev/null 2>&1; then
      echo "⚠️  hook '$(basename "$h")' desfasado respecto a .githooks/ — reinstalando"
      "$MAINWT/tools/install-hooks.sh" >/dev/null || {
        echo "ERROR: no pude reinstalar los hooks. Corre tools/install-hooks.sh a mano." >&2; exit 1; }
      break
    fi
  done
fi

# --- gate de calidad: la suite DEBE estar verde antes de tocar producción ---
# Evita deployar con tests rojos (bugs de producto o refactors que rompieron un
# golden). Corre desde el worktree de main = lo que realmente se va a deployar.
# Bypass de emergencia: SH_SKIP_TESTS=1 tools/deploy.sh "..."  (úsalo sabiendo por qué).
if [ "${SH_SKIP_TESTS:-0}" = "1" ]; then
  echo "⚠️  SH_SKIP_TESTS=1 — SALTANDO la suite de tests (bypass de emergencia)."
elif [ -x "$MAINWT/tools/run-tests.sh" ]; then
  echo "→ gate: corriendo la suite de tests (tools/run-tests.sh)…"
  if ! "$MAINWT/tools/run-tests.sh"; then
    echo "ERROR: la suite de tests está ROJA. Aborto el deploy (nada se bumpeó ni commiteó)." >&2
    echo "       Arregla los rojos, o en emergencia: SH_SKIP_TESTS=1 tools/deploy.sh \"...\"" >&2
    exit 1
  fi
else
  echo "⚠️  tools/run-tests.sh no encontrado/ejecutable — deploy SIN gate de tests."
fi

# --- bump de versión en remote/config.json ---
CFG="$MAINWT/remote/config.json"
CUR="$(grep -E '"version"' "$CFG" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
if [ -n "$SETVER" ]; then
  NEW="$SETVER"
else
  IFS='.' read -r MA MI PA <<< "$CUR"
  case "$BUMP" in
    patch) PA=$((PA+1)) ;;
    minor) MI=$((MI+1)); PA=0 ;;
    major) MA=$((MA+1)); MI=0; PA=0 ;;
  esac
  NEW="$MA.$MI.$PA"
fi
NOW="$(date +%Y-%m-%dT%H:%M)"
echo "→ bump config version: $CUR → $NEW   (lastUpdated=$NOW)"
# sed in-place portable (macOS/BSD)
sed -i '' -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+\"/\1$NEW\"/" "$CFG"
sed -i '' -E "s/(\"lastUpdated\"[[:space:]]*:[[:space:]]*\")[^\"]+\"/\1$NOW\"/" "$CFG"

# --- sellar: scriptIntegrity + firma (config.sig) ---
# Firma el config con GCP KMS (raíz de confianza embebida en la extensión). Ver
# docs/superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md.
if [ -n "${SA_KMS_KEY:-}" ]; then
  echo "→ seal: scriptIntegrity + firma KMS"
  node "$MAINWT/tools/seal-config.mjs" --config "$MAINWT/remote/config.json" \
    --sig "$MAINWT/remote/config.sig" --scripts-dir "$MAINWT/remote/scripts" \
    --backend kms --kms-key "$SA_KMS_KEY" || { echo "ERROR: seal falló (¿acceso KMS?). Aborto."; exit 1; }
else
  # Sólo se llega aquí con la pública VACÍA (pre-Fase-0): nadie verifica, así que publicar sin
  # firmar no apaga a nadie. Con pública real el pre-flight de arriba ya abortó.
  echo "⚠️  SA_KMS_KEY no seteada y pública vacía (pre-Fase-0) — deploy SIN firmar."
fi

# --- commit en main ---
G add remote/
G commit -q -m "$MSG

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
echo "→ commit main: $(G log --oneline -1)"

# --- empaquetar el .zip de la extensión (con main aún checkeado) ---
# Se genera ANTES del checkout de gh-pages porque extension/ no existe en esa rama.
ZIPTMP=""
if [ "$PUBLISH_ZIP" = "1" ]; then
  MANV="$(node -e "process.stdout.write(require('$MAINWT/extension/manifest.json').version)")"
  EXTV="$(node -e "process.stdout.write(require('$MAINWT/remote/config.json').extensionVersion||'')")"
  if [ "$MANV" != "$EXTV" ]; then
    echo "ERROR: extension/manifest.json version ($MANV) != config.extensionVersion ($EXTV)." >&2
    echo "       Chrome lee el manifest, no el config: publicarlos desalineados hace que el" >&2
    echo "       banner ofrezca una versión que el .zip no trae. Alinéalos y reintenta." >&2
    exit 1
  fi
  ZIPTMP="$(mktemp -d)/steelhead-automator.zip"
  ( cd "$MAINWT/extension" && zip -qr "$ZIPTMP" . -x '.DS_Store' '*/.DS_Store' '*.map' )
  echo "→ zip extensión $MANV empaquetado ($(node -e "process.stdout.write(String(require('fs').statSync('$ZIPTMP').size))") bytes)"
fi

# --- danza gh-pages: espejar main:remote/ ---
restore_main() { G checkout main >/dev/null 2>&1 || true; }
trap restore_main EXIT
echo "→ checkout gh-pages + espejo de main:remote/"
G checkout gh-pages >/dev/null 2>&1
G show main:remote/config.json > "$MAINWT/config.json"
# Espejar config.sig si existe en main (deploy firmado); si no, no se toca.
if G cat-file -e main:remote/config.sig 2>/dev/null; then
  G show main:remote/config.sig > "$MAINWT/config.sig"
fi
# Conjunto a espejar = scripts SERVIDOS (referenciados en config) ∪ los ya
# presentes en gh-pages (p.ej. lib/pdf.worker.min.js). NO se empujan los .js
# dev-only de remote/scripts/ que nadie referencia (build helpers, tests).
{
  G show main:remote/config.json | grep -oE '"scripts/[^"]+\.js"' | tr -d '"'
  G ls-tree -r --name-only gh-pages -- scripts/
} | sort -u | while IFS= read -r rel; do   # rel = scripts/foo.js | scripts/lib/bar.js
  [ -n "$rel" ] || continue
  if G cat-file -e "main:remote/$rel" 2>/dev/null; then
    mkdir -p "$MAINWT/$(dirname "$rel")"
    G show "main:remote/$rel" > "$MAINWT/$rel"
  fi
done
G add scripts config.json
[ -f "$MAINWT/config.sig" ] && G add config.sig || true
if [ -n "$ZIPTMP" ]; then
  cp "$ZIPTMP" "$MAINWT/steelhead-automator.zip"
  G add steelhead-automator.zip
  echo "→ zip agregado al commit de gh-pages"
fi
if G diff --cached --quiet; then
  echo "→ gh-pages ya estaba en sync (nada que commitear)"
else
  ZIPMSG=""
  [ -n "$ZIPTMP" ] && ZIPMSG=" + zip extensión $MANV"
  G commit -q -m "deploy: $MSG + bump $NEW$ZIPMSG"
  echo "→ commit gh-pages: $(G log --oneline -1)"
fi
G checkout main >/dev/null 2>&1
trap - EXIT

# --- push ambas ramas ---
# REINTENTO CON REBASE ante non-fast-forward (incidente 2026-08-05). `gh-pages` es una
# rama COMPARTIDA: la publican los deploys de la extension Y los tres paquetes de
# documentacion, y el `pre-push` EXIME los push "solo-docs" de bumpear version. Que un
# push de docs se adelante al del autopilot es NORMAL, no excepcional — y cuando pasaba,
# el push salia rechazado y el hash quedaba corregido en el repo pero ROTO EN VIVO.
#
# El rebase es seguro aqui porque los cambios NO se solapan (docs tocan */*.html, el
# deploy toca config.json + scripts/*.js). Si SI se solapan, el rebase falla, se aborta y
# se propaga el error: preferimos fallar ruidoso a resolver un conflicto a ciegas sobre
# una rama publicada.
push_con_rebase() {
  local rama="$1"
  if G push origin "$rama" 2>/tmp/sa-push-err.txt; then return 0; fi
  cat /tmp/sa-push-err.txt >&2
  if ! grep -qEi 'non-fast-forward|fetch first|Updates were rejected' /tmp/sa-push-err.txt; then
    echo "🛑 push de $rama rechazado por una causa que NO es non-fast-forward — no reintento." >&2
    return 1
  fi
  echo "⚠️  push de $rama rechazado (non-fast-forward) — otra sesion publico primero. Rebase y reintento…" >&2
  G fetch origin "$rama" || { echo "🛑 fetch de $rama fallo" >&2; return 1; }
  # OJO: este repo maneja gh-pages con checkout IDA Y VUELTA en el worktree de main (no
  # hay worktree dedicado), y al llegar aqui el worktree esta en `main`. Un `git rebase
  # origin/X X` haria checkout de X y DEJARIA el worktree en X, rompiendo el estado que el
  # resto del script asume. Por eso: checkout explicito + restauracion garantizada.
  local previa; previa="$(G rev-parse --abbrev-ref HEAD)"
  local volver=0
  if [ "$previa" != "$rama" ]; then
    G checkout "$rama" >/dev/null 2>&1 || { echo "🛑 no pude checkout $rama para rebasear" >&2; return 1; }
    volver=1
  fi
  local rc=0
  if G rebase "origin/$rama"; then
    echo "→ rebase de $rama OK — reintentando push"
    G push origin "$rama" || { echo "🛑 el re-push de $rama fallo incluso tras rebase." >&2; rc=1; }
  else
    G rebase --abort 2>/dev/null || true
    echo "🛑 rebase de $rama con CONFLICTO — los cambios se solapan. Resuelve a mano; NO publico a ciegas." >&2
    rc=1
  fi
  [ "$volver" = "1" ] && { G checkout "$previa" >/dev/null 2>&1 || echo "⚠️  no pude volver a $previa — revisa el worktree" >&2; }
  return $rc
}

echo "→ push origin main gh-pages"
push_con_rebase main
push_con_rebase gh-pages

# --- tag de release (ancla de rollback) ---
# Cada deploy queda anclado a un tag vX.Y.Z sobre el commit de main del bump, para
# poder revertir gh-pages a un estado conocido con tools/rollback.sh. Aditivo y
# tolerante: si el tag falla, el deploy YA se completó (no se aborta). El fallo dentro
# del `if` no dispara `set -e`.
TAG="v$NEW"
if G rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "⚠️  tag $TAG ya existe — no se re-crea (¿re-deploy de la misma versión?)"
elif G tag -a "$TAG" -m "deploy $NEW: $MSG" main && G push origin "$TAG"; then
  echo "→ tag $TAG creado y pusheado (rollback: tools/rollback.sh $TAG)"
else
  echo "⚠️  no pude crear/pushear el tag $TAG (el deploy YA quedó vivo). Créalo a mano si quieres el ancla."
fi

# --- verificación ---
echo
if [ -n "$CHECK_SCRIPT" ] && [ -x "$MAINWT/tools/check-deploy.sh" ]; then
  echo "→ verificando publicación (puede tardar 30-60s + caché CDN)…"
  "$MAINWT/tools/check-deploy.sh" "$CHECK_SCRIPT" || {
    echo "   (si dice 'no listo' es por el lag de GH Pages; reintenta tools/deploy-status.sh en 1-2 min)"; }
else
  echo "✅ Push hecho. Verifica con: tools/deploy-status.sh   (o check-deploy.sh <script>)"
fi

# --- smoke-check de firma EN VIVO (lag-aware) ---
# Tras publicar, verifica que la firma EN VIVO de gh-pages verifique con la pública
# embebida ANTES de declarar éxito. Caza un error de firma en tu terminal, no en las
# pantallas de los operadores (que quedarían fail-closed). GitHub Pages tarda 30-60s →
# pollea la versión nueva antes de verificar.
REMOTE_BASE="https://oviazcan.github.io/SteelheadAutomator"
PUB=$(node -e "globalThis.self={};require('$MAINWT/extension/integrity-pubkey.js');process.stdout.write(self.SA_INTEGRITY_PUBKEY||'')" 2>/dev/null || true)
if [ -n "$PUB" ]; then
  echo "→ smoke-check: esperando propagación de v$NEW y verificando firma EN VIVO"
  ok_ver=0
  for i in $(seq 1 20); do
    curl -s "$REMOTE_BASE/config.json?cb=$RANDOM" > /tmp/sa-live-config.json || true
    live=$(node -e "try{process.stdout.write(require('/tmp/sa-live-config.json').version||'')}catch(e){}" 2>/dev/null || true)
    if [ "$live" = "$NEW" ]; then ok_ver=1; break; fi
    sleep 12
  done
  if [ "$ok_ver" = "1" ]; then
    curl -s "$REMOTE_BASE/config.sig?cb=$RANDOM" > /tmp/sa-live-config.sig || true
    if node "$MAINWT/tools/verify-config-sig.mjs" /tmp/sa-live-config.json /tmp/sa-live-config.sig "$PUB"; then
      echo "✓ smoke-check: firma EN VIVO de v$NEW verifica"
    else
      echo "🛑 La firma EN VIVO de v$NEW no verifica. Quien ya actualizó se bloqueará. Revisa YA."
      exit 1
    fi
  else
    echo "⚠️  smoke-check: v$NEW no propagó en ~4min (lag de Pages). El pre-push ya validó la firma en git; re-verifica con deploy-status."
  fi
else
  echo "→ smoke-check omitido (pública aún placeholder — pre-Fase-2)"
fi

# --- verificación del .zip publicado ---
# El gotcha registrado (docs/applets/bulk-upload.md): no basta con que el zip pese distinto,
# hay que confirmar el manifest DENTRO del zip SERVIDO. Chrome lee ese manifest, no el config.
if [ "$PUBLISH_ZIP" = "1" ]; then
  echo "→ verificando el .zip publicado…"
  ok_zip=0
  for i in $(seq 1 10); do
    if curl -fsS "$REMOTE_BASE/steelhead-automator.zip?cb=$RANDOM" -o /tmp/sa-live-ext.zip 2>/dev/null; then
      livemanv="$(unzip -p /tmp/sa-live-ext.zip manifest.json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).version)}catch(e){}})" || true)"
      if [ "$livemanv" = "$MANV" ]; then ok_zip=1; break; fi
    fi
    sleep 12
  done
  if [ "$ok_zip" = "1" ]; then
    echo "✓ zip EN VIVO trae manifest $MANV"
  else
    echo "⚠️  el zip EN VIVO aún no reporta manifest $MANV (lag de Pages). Re-verifica con:"
    echo "    curl -s $REMOTE_BASE/steelhead-automator.zip -o /tmp/z.zip && unzip -p /tmp/z.zip manifest.json | grep version"
  fi
fi

# --- guardrail anti-divergencia Safari/iPad (handoff) ---
# El bundle de Safari/iPad (safari/extension/main-bundle.js) se genera con tools/build-safari.sh
# desde remote/scripts + config.json y NO se actualiza con git push. Avisa (de forma determinística)
# si quedó desactualizado, para que un sucesor que deploya a Chrome no olvide regenerar el bundle iPad
# y recompilar en Xcode. Ver safari/README.md / docs/deploy-safari.html.
if [ -f "$MAINWT/safari/bundle.json" ] && [ -x "$MAINWT/tools/build-safari.sh" ]; then
  if ! "$MAINWT/tools/build-safari.sh" --check >/dev/null 2>&1; then
    echo
    echo "⚠️  Bundle Safari/iPad DESACTUALIZADO respecto a la fuente (remote/scripts + config.json)."
    echo "    Si tu cambio toca un applet del bundle: corre 'tools/build-safari.sh' y recompila en Xcode."
  fi
fi
