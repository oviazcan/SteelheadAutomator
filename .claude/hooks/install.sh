#!/usr/bin/env bash
# install.sh — conecta el harness de Claude Code de este repo a la máquina actual.
# Corre esto UNA VEZ tras clonar el repo. Idempotente y seguro de repetir.
#
#   .claude/hooks/install.sh
#
# Qué hace:
#   1. Source del wrapper `claude()` en tu ~/.zshrc (redirige una 2ª sesión concurrente
#      a un worktree libre — la ÚNICA parte que no puede vivir en un hook).
#   2. Instala los git hooks del repo (pre-push del invariante de deploy).
# Los hooks de Claude (heartbeat/guard/aviso del candado) NO requieren instalación:
# se activan solos vía .claude/settings.json (versionado) al abrir Claude en el repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAP="$ROOT/.claude/hooks/worktree-claude-wrapper.sh"
ZRC="${ZDOTDIR:-$HOME}/.zshrc"

echo "→ Instalando harness de: $ROOT"

# 1) wrapper de zsh
if [ -f "$ZRC" ] && grep -q 'worktree-claude-wrapper.sh' "$ZRC"; then
  echo "  ✓ wrapper ya referenciado en $ZRC"
else
  {
    echo ""
    echo "# Candado de convivencia de sesiones de Claude (harness de $(basename "$ROOT"))"
    echo "[ -f \"$WRAP\" ] && source \"$WRAP\""
  } >> "$ZRC"
  echo "  ✓ wrapper agregado a $ZRC  — recárgalo con:  source \"$ZRC\""
fi

# 2) git hooks del repo
if [ -x "$ROOT/tools/install-hooks.sh" ]; then
  ( cd "$ROOT" && tools/install-hooks.sh ) >/dev/null 2>&1 && echo "  ✓ git hooks del repo instalados" || echo "  · (tools/install-hooks.sh no aplicó; revísalo a mano si usas deploy)"
fi

echo "→ Listo. Abre Claude en este repo normalmente."
echo "  Una 2ª sesión concurrente sobre el mismo worktree se redirige sola a workbench,"
echo "  y el guard bloquea escrituras que pisen a la sesión dueña. Ver .claude/hooks/README.md"
