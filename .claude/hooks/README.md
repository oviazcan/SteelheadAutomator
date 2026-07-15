# Harness de Claude Code — candado de convivencia entre sesiones

Evita que **dos instancias de Claude trabajen sobre el mismo worktree** y se pisen
(incidente 2026-07-08: dos sesiones en `main` commiteando y deployando a la vez →
deploy roto + baile de git para recuperar).

Todo vive en el repo y **se transmite con el clone**. Solo hay un paso manual por
máquina (el wrapper de shell), que el instalador automatiza.

## Instalación (una vez por máquina, tras clonar)

```bash
.claude/hooks/install.sh
source ~/.zshrc     # recarga para activar el wrapper claude()
```

Eso es todo. Los demás componentes (heartbeat, guard, aviso) se activan solos vía
`.claude/settings.json` (versionado) al abrir Claude en el repo.

## Piezas

| Archivo | Rol | Cómo se activa |
|---|---|---|
| `worktree-lock.sh` | lock por worktree (`FIRST_SEEN\|LAST_BEAT`) + dueña/`occupied`/`pick-free` | hooks de `.claude/settings.json` |
| `worktree-guard.sh` | `PreToolUse`: bloquea escrituras de la sesión invitada dentro del worktree ocupado | hook `PreToolUse` |
| `worktree-claude-wrapper.sh` | función `claude()`: redirige una sesión NUEVA a un worktree libre antes de arrancar | `source` en `~/.zshrc` (via `install.sh`) |
| `install.sh` | conecta el wrapper al shell + instala git hooks del repo | manual, una vez |

## Modelo

Cada sesión activa deja un lock en `~/.claude/worktree-locks/<hash>/<session_id>`
(estado LOCAL, no versionado) con `FIRST_SEEN|LAST_BEAT|TOPLEVEL`:
- **FIRST_SEEN** fija la antigüedad (no cambia); **LAST_BEAT** se renueva en cada
  heartbeat (vida). **Dueña** = la sesión fresca con menor FIRST_SEEN.
- Locks stale (sin heartbeat > TTL 300s) se purgan → cubre cierres abruptos.

## Comportamiento

- **Sesión NUEVA** (`claude` sin `--resume`) en worktree ocupado → el wrapper hace
  `cd` a **workbench** (o crea un worktree nuevo) y arranca ahí. `--resume` no redirige.
- El **guard** bloquea que la invitada edite/commitee/deploye DENTRO del worktree
  ocupado (pasan lecturas, y escrituras fuera como scratchpad/tmp).
  - **Deploy con bisturí desde una invitada**: antepón `SH_ALLOW_DEPLOY=1`.
  - La **dueña** nunca se bloquea.

## Config asociada

- `.claude/settings.json` (proyecto, versionado) — wiring de los hooks vía `$CLAUDE_PROJECT_DIR`.
- `.claude/settings.local.json` (local, gitignorado) — permisos/overrides de tu máquina.

## Desactivar

Borra la línea `source …worktree-claude-wrapper.sh` de `~/.zshrc`, y/o el bloque
`hooks` de `.claude/settings.json`. Bypass puntual: `SH_ALLOW_DEPLOY=1 <comando>` o
abre con `--resume`. Ajustar TTL: `export SH_WT_TTL=<segundos>`.

## Límite conocido

Un hook no puede mover el cwd de una sesión ya abierta (por eso la redirección vive
en el wrapper de shell). `SessionEnd` es best-effort; el TTL cubre cierres abruptos.
