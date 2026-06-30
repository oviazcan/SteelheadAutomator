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
import sys, json, os

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
for rel in ordered:
    src = os.path.join(root, 'remote', rel)
    if not os.path.exists(src):
        sys.exit(f"ERROR: no existe el script {rel} (esperado en remote/{rel})")
    code = open(src, encoding='utf-8').read()
    parts += [f"// ===== BEGIN {rel} =====", "(function(){", code.rstrip("\n"), "})();",
              f"// ===== END {rel} =====", ""]
bundle_js = "\n".join(parts) + "\n"

manifest = {
    "manifest_version": 3,
    "name": bundle["name"], "description": bundle["description"], "version": bundle["version"],
    "host_permissions": bundle["matches"],
    "content_scripts": [{
        "matches": bundle["matches"], "js": ["main-bundle.js"],
        "run_at": "document_start", "world": "MAIN", "all_frames": False,
    }],
    "icons": {"16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png"},
}
manifest_str = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

bundle_path   = os.path.join(ext, 'main-bundle.js')
manifest_path = os.path.join(ext, 'manifest.json')

def read(p):
    return open(p, encoding='utf-8').read() if os.path.exists(p) else None

if check:
    drift = (read(bundle_path) != bundle_js) or (read(manifest_path) != manifest_str)
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
