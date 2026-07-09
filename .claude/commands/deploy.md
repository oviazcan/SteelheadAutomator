---
description: Corre la suite y deploya a producción con tools/deploy.sh, verificando el estado en vivo.
argument-hint: "<mensaje de commit> [--minor|--set X.Y.Z] [--check <script>]"
---
Vas a deployar a producción (gh-pages). Procede paso a paso y DETENTE si algo falla:

1. Verifica que estás en el worktree de `main` y que el working tree está limpio salvo
   cambios bajo `remote/`. Si hay WIP ajena o el worktree está ocupado por otra sesión,
   NO fuerces: reporta y resuelve el conflicto primero (ver `.claude/hooks/README.md`).
2. Corre `tools/deploy.sh "$ARGUMENTS"`. deploy.sh YA corre el gate de tests
   (`tools/run-tests.sh`) internamente y aborta si la suite está roja — no lo saltes con
   `SH_SKIP_TESTS=1` salvo emergencia real y justificada.
3. Al terminar, corre `tools/deploy-status.sh` y confirma el invariante:
   `main = gh-pages = EN VIVO`, byte-a-byte OK.
4. Reporta: versión publicada, qué scripts cambiaron, y el resultado del invariante.

Nunca concluyas "ya está vivo" mirando el config.json de una rama de trabajo — usa
`deploy-status.sh` como fuente de verdad (lee CLAUDE.md §"Deploy a producción").
