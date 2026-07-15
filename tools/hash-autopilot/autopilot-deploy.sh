#!/usr/bin/env bash
# Auto-deploy de hashes rotados detectados por hash-autopilot.
# Uso: autopilot-deploy.sh Op1=hash1 Op2=hash2 ...
# Salvaguardas: solo en main, sin WIP ajeno en remote/, stash defensivo de todo
# lo que no sea remote/ (el bundle Safari suele estar WIP y deploy.sh aborta si hay
# cambios fuera de remote/). Restaura el stash pase lo que pase (trap).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

[ "$#" -ge 1 ] || { echo "ABORT: sin pares op=hash"; exit 5; }

# 1. Debe estar en main (deploy.sh espeja main:remote/ → gh-pages).
BR="$(git branch --show-current)"
[ "$BR" = "main" ] || { echo "ABORT: no en main (rama=$BR)"; exit 4; }

# 2. No pisar WIP ajeno DENTRO de remote/ (solo config.json lo tocamos nosotros).
AJENO="$(git status --porcelain remote/ | grep -v 'remote/config.json' || true)"
[ -z "$AJENO" ] || { echo "ABORT: WIP ajeno en remote/:"; echo "$AJENO"; exit 3; }

# 3. Stash defensivo de todo lo que NO sea remote/ (con trap de restauración).
STASHED=0
if [ -n "$(git status --porcelain -- . ':(exclude)remote/')" ]; then
  git stash push --include-untracked -m "hash-autopilot-autodeploy" -- . ':(exclude)remote/' >/dev/null && STASHED=1
fi
restore() { if [ "$STASHED" = "1" ]; then git stash pop >/dev/null 2>&1 || echo "⚠️ no se pudo restaurar el stash (revisar 'git stash list')"; fi; }
trap restore EXIT

# 4. Editar config.json con los pares op=hash (preserva formato, no re-serializa).
node -e "import('./tools/hash-autopilot/config-io.mjs').then(m=>{const u=Object.fromEntries(process.argv.slice(1).map(a=>{const i=a.indexOf('=');return [a.slice(0,i),a.slice(i+1)];}));m.writeConfigHashes('./remote/config.json',u);console.log('config actualizado:',Object.keys(u).join(', '));})" "$@"

# 5. Deploy oficial: bump + commit main + espejo gh-pages + push ambas + check.
tools/deploy.sh "fix(hashes): rotación auto-detectada ($*) [hash-autopilot]"
