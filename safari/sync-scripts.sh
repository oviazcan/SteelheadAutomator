#!/usr/bin/env bash
# DEPRECADO. El bundle de Safari/iPad ahora se genera con tools/build-safari.sh, que lee
# la FUENTE ÚNICA (remote/scripts/ + config.json), expande los applets de safari/bundle.json,
# deduplica y concatena en main-bundle.js. Ya no se copian scripts sueltos a safari/extension/.
# Este script solo redirige al build para no romper referencias viejas.
exec "$(cd "$(dirname "$0")/.." && pwd)/tools/build-safari.sh"
