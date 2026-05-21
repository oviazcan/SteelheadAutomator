#!/usr/bin/env bash
# check-deploy.sh — valida que el último push a gh-pages ya está publicado.
#
# Compara byte-a-byte el config.json y bulk-upload.js servidos por GitHub Pages
# contra los que están en remote/ del checkout local. Si los MD5 coinciden y
# la versión local matchea la remota, el deploy está vivo.
#
# Uso:
#   tools/check-deploy.sh                 # check default (bulk-upload + config)
#   tools/check-deploy.sh wo-deadline-changer  # check de otro script
#
# Tip: si GH Pages cachea ~5 min, espera y vuelve a correr. Si Chrome cachea
# después de eso, copia el snippet de DevTools que imprime el segundo capa.

set -euo pipefail

GH_PAGES_BASE="https://oviazcan.github.io/SteelheadAutomator"
REPO_ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
SCRIPT_NAME="${1:-bulk-upload}"

cd "$REPO_ROOT"

echo "=== Check de deploy a GitHub Pages ==="
echo "Base: $GH_PAGES_BASE"
echo

# --- 1) config.json ---
LOCAL_CONFIG="remote/config.json"
REMOTE_CONFIG_URL="$GH_PAGES_BASE/config.json"

if [[ ! -f "$LOCAL_CONFIG" ]]; then
  echo "ERROR: no encuentro $LOCAL_CONFIG" >&2
  exit 1
fi

LOCAL_VERSION=$(grep -E '"version"' "$LOCAL_CONFIG" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
LOCAL_LASTUPD=$(grep -E '"lastUpdated"' "$LOCAL_CONFIG" | head -1 | sed -E 's/.*"lastUpdated"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
LOCAL_CONFIG_MD5=$(md5 -q "$LOCAL_CONFIG")

REMOTE_CONFIG_BODY=$(curl -fsSL -H 'Cache-Control: no-cache' "$REMOTE_CONFIG_URL?_=$(date +%s)" || echo "")
if [[ -z "$REMOTE_CONFIG_BODY" ]]; then
  echo "❌ No pude fetchear $REMOTE_CONFIG_URL"
  exit 2
fi
REMOTE_VERSION=$(echo "$REMOTE_CONFIG_BODY" | grep -E '"version"' | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
REMOTE_LASTUPD=$(echo "$REMOTE_CONFIG_BODY" | grep -E '"lastUpdated"' | head -1 | sed -E 's/.*"lastUpdated"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
REMOTE_CONFIG_MD5=$(echo -n "$REMOTE_CONFIG_BODY" | md5 -q)

echo "config.json"
echo "  local:  version=$LOCAL_VERSION  lastUpdated=$LOCAL_LASTUPD  md5=$LOCAL_CONFIG_MD5"
echo "  remote: version=$REMOTE_VERSION  lastUpdated=$REMOTE_LASTUPD  md5=$REMOTE_CONFIG_MD5"

CONFIG_OK=1
if [[ "$LOCAL_VERSION" != "$REMOTE_VERSION" ]]; then
  echo "  ❌ version mismatch"
  CONFIG_OK=0
fi
if [[ "$LOCAL_CONFIG_MD5" != "$REMOTE_CONFIG_MD5" ]]; then
  echo "  ⚠️  md5 mismatch (puede ser sólo trailing newline; mira version+VERSION del script para confirmar)"
fi
[[ $CONFIG_OK -eq 1 ]] && echo "  ✅ version coincide"
echo

# --- 2) bulk-upload.js (o el script que pasaste) ---
LOCAL_SCRIPT="remote/scripts/${SCRIPT_NAME}.js"
REMOTE_SCRIPT_URL="$GH_PAGES_BASE/scripts/${SCRIPT_NAME}.js"

if [[ ! -f "$LOCAL_SCRIPT" ]]; then
  echo "ERROR: no encuentro $LOCAL_SCRIPT" >&2
  exit 1
fi

LOCAL_SCRIPT_VER=$(grep -E "const VERSION = " "$LOCAL_SCRIPT" | head -1 | sed -E "s/.*'([^']+)'.*/\1/")
LOCAL_SCRIPT_MD5=$(md5 -q "$LOCAL_SCRIPT")

REMOTE_SCRIPT_BODY=$(curl -fsSL -H 'Cache-Control: no-cache' "$REMOTE_SCRIPT_URL?_=$(date +%s)" || echo "")
if [[ -z "$REMOTE_SCRIPT_BODY" ]]; then
  echo "❌ No pude fetchear $REMOTE_SCRIPT_URL"
  exit 2
fi
REMOTE_SCRIPT_VER=$(echo "$REMOTE_SCRIPT_BODY" | grep -E "const VERSION = " | head -1 | sed -E "s/.*'([^']+)'.*/\1/")
REMOTE_SCRIPT_MD5=$(echo -n "$REMOTE_SCRIPT_BODY" | md5 -q)

echo "scripts/${SCRIPT_NAME}.js"
echo "  local:  VERSION='$LOCAL_SCRIPT_VER'  md5=$LOCAL_SCRIPT_MD5"
echo "  remote: VERSION='$REMOTE_SCRIPT_VER'  md5=$REMOTE_SCRIPT_MD5"

SCRIPT_OK=1
if [[ "$LOCAL_SCRIPT_VER" != "$REMOTE_SCRIPT_VER" ]]; then
  echo "  ❌ VERSION mismatch (GH Pages aún cachea o falta push)"
  SCRIPT_OK=0
fi
if [[ "$LOCAL_SCRIPT_MD5" != "$REMOTE_SCRIPT_MD5" ]]; then
  echo "  ⚠️  md5 mismatch (puede ser sólo trailing newline; mira VERSION para confirmar)"
fi
[[ $SCRIPT_OK -eq 1 ]] && echo "  ✅ VERSION coincide"
echo

# --- veredicto ---
if [[ $CONFIG_OK -eq 1 && $SCRIPT_OK -eq 1 ]]; then
  echo "=== ✅ DEPLOY PUBLICADO — GH Pages sirviendo $LOCAL_VERSION ==="
  echo
  echo "Siguiente paso: recarga la extensión en chrome://extensions (botón ↻)"
  echo "y pega esto en DevTools (Console) de la tab de Steelhead para confirmar"
  echo "que Chrome ya cargó la versión nueva:"
  echo
  cat <<'SNIPPET'
(async () => {
  const cfg = await fetch('https://oviazcan.github.io/SteelheadAutomator/config.json?_=' + Date.now()).then(r => r.json());
  console.log('config remoto:', cfg.version, '|', cfg.lastUpdated);
  const apps = ['SteelheadAutomator','BulkUpload','ProcessCanon','ProcessDeepAudit','SpecParamsBulk','InvoiceAutofill','InvoiceAutoRegen','ReceiverDateOverride','WarehouseLocationPrefill','WeightQuickEntry','ParosLinea','SensorStatusAutofill','PoComparator','PortalImporter','SpecMigrator','WoDeadlineChanger'];
  for (const a of apps) if (window[a]?.VERSION) console.log(a, '→', window[a].VERSION);
})();
SNIPPET
  exit 0
else
  echo "=== ❌ DEPLOY NO LISTO ==="
  echo
  echo "Posibles causas:"
  echo "  1. Aún no pasan los 30-60s del refresh de GH Pages → espera y reintenta."
  echo "  2. Olvidaste 'git push origin gh-pages' → revisa con: git log gh-pages --oneline -3"
  echo "  3. GH Pages está cacheando el config viejo (~5 min TTL) → espera."
  exit 3
fi
