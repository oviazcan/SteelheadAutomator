---
description: Scaffold de un applet nuevo siguiendo las convenciones del repo (core puro + golden test + bitácora + registro).
argument-hint: "<applet-id> \"<descripción corta>\""
---
Crea el andamiaje del applet `$1` ("$2") siguiendo las convenciones de SteelheadAutomator.
Antes de escribir código, lee: CLAUDE.md §"Reglas de desarrollo" y §"UI dark mode"; y si
toca DOM, `docs/architecture/dom-patterns.md`. Si el applet procesa listas largas o corre
por minutos, invoca la skill `memory-hardening-applets`.

Pasos:
1. `remote/scripts/$1-core.js` — MÓDULO PURO dual-export (`module.exports` + `window.X`),
   SIN DOM/fetch: solo la lógica testeable.
2. `remote/scripts/$1.js` — glue/UI que consume el core. UI en DARK MODE (base #1c2430,
   texto #e6e9ee, acento #13a36f). Usa `textContent`, no `innerHTML`, con datos externos.
3. `tools/test/$1-core.test.js` — golden tests con `node:test` + `node:assert/strict` y
   fixtures de payload REAL. Corre `node --test` hasta VERDE.
4. `docs/applets/$1.md` — bitácora (versión, lecciones, plan de validación) y agrega la
   fila al índice de applets de CLAUDE.md.
5. Registra el applet en `remote/config.json` (`apps[]`). El bump de config es hot file:
   hazlo en una pasada corta y coordina si hay otra sesión (regla de trabajo paralelo).
6. **Ruta de regeneración de hash (OBLIGATORIO si el applet introduce un hash nuevo).**
   Por CADA hash de persisted query que agregues a `config.json`, documenta su **ruta de
   auto-captura headless** para que el `hash-autopilot` la regenere sola cuando rote:
   - **Query** → agrega/verifica una ruta en `tools/hash-autopilot/route-catalog.json`
     (`goto` a la pantalla; `clickFirst`/`clickButton` si requiere abrir un modal). Si la
     op solo se dispara desde una interacción (no navegando), agrégala a `_interactionOps`.
   - **Mutation** → declara un sentinela en `tools/hash-autopilot/sentinels-config.json`
     (objeto de prueba "Sentinela") con su handler DOM en `mutation-deps.mjs`; para
     escrituras que NO deban persistir, usa **captura-y-aborta** (`sink.abortOps`).
   - Confirma la ruta en vivo (`node hash-autopilot.mjs --only=<Op> --dry-run` o
     `--no-deploy` para mutations) y déjala anotada en la bitácora del applet.
   **Un hash sin ruta de regeneración es deuda** (cae en captura manual con hash-scanner).

Reglas: código y variables en inglés; docs y UI en español; batching de PNs en grupos de 20.
NO deployes — deja el andamiaje listo y los tests verdes. Reporta qué creaste.
