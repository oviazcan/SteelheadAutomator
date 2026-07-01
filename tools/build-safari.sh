#!/usr/bin/env bash
# build-safari.sh — genera el bundle de la Safari Web Extension (iPad) desde la
# FUENTE ÚNICA: remote/scripts/*.js + remote/config.json. Sin remote-loader (Apple
# Guideline 2.5.2 prohíbe código remoto en iOS): el bundle es estático y se empaqueta
# dentro de la app; cada cambio requiere re-correr este build + recompilar en Xcode.
#
# Qué hace:
#   1. Lee safari/bundle.json → lista blanca de applets (por id) + meta.
#   2. Para cada applet, expande a sus scripts vía config.apps[].scripts.
#   3. Concatena TODAS las listas en orden y DEDUPLICA preservando 1ª aparición
#      (así los helpers compartidos —steelhead-api.js, *-core.js— quedan antes que
#      los applets que los consumen, sin resolver topología a mano).
#   4. Envuelve cada script en un IIFE (aislamiento de scope equivalente al
#      new Function() del remote-loader; la comunicación entre scripts es vía window.*).
#   5. Escribe safari/extension/main-bundle.js y safari/extension/manifest.json
#      (content_scripts world:"MAIN", run_at document_start).
#
# Uso:
#   tools/build-safari.sh           genera el bundle
#   tools/build-safari.sh --check   NO escribe; exit 3 si el bundle en disco está
#                                    desactualizado respecto a la fuente (para deploy.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

python3 - "$ROOT" "${1:-}" <<'PY'
import sys, json, os, re

root  = sys.argv[1]
check = len(sys.argv) > 2 and sys.argv[2] in ('--check', 'check')
ext   = os.path.join(root, 'safari', 'extension')

bundle = json.load(open(os.path.join(root, 'safari', 'bundle.json')))
config = json.load(open(os.path.join(root, 'remote', 'config.json')))
apps   = { a['id']: a for a in config.get('apps', []) }

# 1-3. Expandir applets → scripts, dedup preservando orden de 1ª aparición.
ordered, seen = [], set()
for app_id in bundle['applets']:
    app = apps.get(app_id)
    if not app:
        sys.exit(f"ERROR: applet '{app_id}' no existe en config.apps[]")
    for rel in app.get('scripts', []):
        if rel not in seen:
            seen.add(rel); ordered.append(rel)

# 4. Concatenar con cada script envuelto en IIFE.
parts = [
    "// ==========================================================================",
    f"// {bundle['name']} — main-bundle.js  (v{bundle['version']})",
    "// GENERADO por tools/build-safari.sh desde remote/scripts + config.json.",
    "// NO editar a mano: edita la fuente en remote/scripts/ y re-corre el build.",
    "// Cada applet va en su propio IIFE (scope aislado, como el new Function() del",
    "// remote-loader); la comunicación entre scripts es vía window.* (SteelheadAPI, etc.).",
    "// ==========================================================================",
    "",
]

# Shim: en el MAIN world de Safari NO existe `window.chrome` (en Chrome sí). Varios applets hacen
# chrome.runtime?.onMessage — el ?. NO protege la variable base no declarada, así que sin esto lanzan
# ReferenceError "chrome is not defined" y DETIENEN el bundle (crash de wo-mover/auto-router). Va PRIMERO.
parts += ["// ===== BEGIN sa-shim =====", "(function(){",
          "if (typeof window.chrome === 'undefined') { window.chrome = {}; }",
          "})();", "// ===== END sa-shim =====", ""]

# Config SEMILLA (horneado) — se emite JUSTO DESPUÉS de steelhead-api.js para que
# window.REMOTE_CONFIG + SteelheadAPI.init estén listos ANTES de que los applets corran su
# init() (en document_idle, readyState != 'loading' → los applets inician de inmediato). Muchos
# hacen una query en el arranque (CurrentUserDetails, catálogos) que necesita el config; sin la
# semilla la query falla y su UI no aparece. El bridge (sa-bootstrap) lo REFRESCA en caliente.
# Marcado para que --check IGNORE este bloque: una rotación de hash actualiza la semilla pero NO
# debe marcar el bundle como "drift" (los hashes se sirven en caliente vía bridge).
seed_lines = ["// ===== BEGIN config-seed (ignorado por --check) =====", "(function(){",
              "  window.REMOTE_CONFIG = " + json.dumps(config, ensure_ascii=False) + ";",
              "  try { if (window.SteelheadAPI && window.SteelheadAPI.init) window.SteelheadAPI.init(window.REMOTE_CONFIG); } catch (e) {}",
              "})();", "// ===== END config-seed =====", ""]

seed_emitted = False
for rel in ordered:
    src = os.path.join(root, 'remote', rel)
    if not os.path.exists(src):
        sys.exit(f"ERROR: no existe el script {rel} (esperado en remote/{rel})")
    code = open(src, encoding='utf-8').read()
    parts += [f"// ===== BEGIN {rel} =====", "(function(){", code.rstrip("\n"), "})();",
              f"// ===== END {rel} =====", ""]
    if rel == 'scripts/steelhead-api.js':
        parts += seed_lines            # config listo antes de los applets
        seed_emitted = True
if not seed_emitted:
    parts += seed_lines                # bundle sin steelhead-api: igual expón REMOTE_CONFIG

# Bootstrap: refresca el config en caliente cuando bridge.js lo trae de gh-pages.
boot = os.path.join(root, 'safari', 'sa-bootstrap.js')
if os.path.exists(boot):
    parts += ["// ===== BEGIN sa-bootstrap.js =====", "(function(){",
              open(boot, encoding='utf-8').read().rstrip("\n"), "})();",
              "// ===== END sa-bootstrap.js =====", ""]

bundle_js = "\n".join(parts) + "\n"

icons = {"16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png"}
manifest = {
    "manifest_version": 3,
    "name": bundle["name"], "description": bundle["description"], "version": bundle["version"],
    "permissions": ["storage"],
    "host_permissions": bundle["matches"],
    "content_scripts": [
        # Mundo AISLADO: bridge.js fetchea config.json (→ MAIN) y propaga flags de toggle
        # (storage → data-attributes que leen los applets).
        {"matches": bundle["matches"], "js": ["bridge.js"], "run_at": "document_idle"},
        # Mundo MAIN: helpers + applets + config-seed + bootstrap.
        {"matches": bundle["matches"], "js": ["main-bundle.js"],
         "run_at": "document_idle", "world": "MAIN", "all_frames": False},
    ],
    "action": {"default_popup": "popup.html", "default_icon": icons},
    "icons": icons,
}
manifest_str = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

bundle_path   = os.path.join(ext, 'main-bundle.js')
manifest_path = os.path.join(ext, 'manifest.json')

def read(p):
    return open(p, encoding='utf-8').read() if os.path.exists(p) else None

def strip_seed(s):
    # El config-seed (datos, no código) cambia con cada rotación de hash. --check lo ignora
    # para no marcar "drift" cuando los hashes solo deben refrescarse en caliente (bridge).
    return re.sub(r'// ===== BEGIN config-seed.*?// ===== END config-seed =====', '<<SEED>>', s or '', flags=re.S)

if check:
    drift = (strip_seed(read(bundle_path)) != strip_seed(bundle_js)) or (read(manifest_path) != manifest_str)
    if drift:
        print("DRIFT: el bundle de Safari/iPad está desactualizado respecto a la fuente.")
        sys.exit(3)
    print("Bundle de Safari/iPad en sync con la fuente.")
    sys.exit(0)

os.makedirs(ext, exist_ok=True)
open(bundle_path, 'w', encoding='utf-8').write(bundle_js)
open(manifest_path, 'w', encoding='utf-8').write(manifest_str)

print(f"Bundle '{bundle['name']}' v{bundle['version']}")
print(f"  applets ({len(bundle['applets'])}): " + ", ".join(bundle['applets']))
print(f"  scripts concatenados ({len(ordered)}):")
for rel in ordered:
    print(f"    - {rel}")
print(f"  → safari/extension/main-bundle.js  ({len(bundle_js)} bytes)")
print(f"  → safari/extension/manifest.json")
PY

if [ "${1:-}" != "--check" ]; then
  echo "Listo. Regenera el proyecto Xcode con el converter (ver docs/deploy-safari.html) y recompila."
fi
