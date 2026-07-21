# SteelheadAutomator

## Qué es
Extensión de Chrome MV3 que automatiza carga masiva de cotizaciones y números de parte en Steelhead ERP (app.gosteelhead.com). Usa arquitectura de "remote script loader": la extensión es un cascarón que carga lógica desde GitHub Pages.

## Estructura
- `extension/` — Extensión Chrome (se publica en Chrome Web Store como Unlisted)
- `remote/` — Scripts y config servidos por GitHub Pages (se actualizan con git push)
- `tools/` — Scripts de mantenimiento local (scraping de hashes, etc.)
- `skills/` — Skills reutilizables para Claude sobre la API de Steelhead
- `docs/` — Specs de diseño, bitácoras por applet (`docs/applets/`), playbooks de API (`docs/api/`) y patrones de arquitectura (`docs/architecture/`)

## Carga de contexto bajo demanda
Este archivo es índice + reglas globales. Las bitácoras detalladas de cada applet (lecciones, deploys, hashes, plan de validación) viven en archivos satélite. **Antes de tocar un applet, lee su bitácora correspondiente** del índice de abajo. No es necesario cargar todas las bitácoras para trabajar en un solo applet.

## Deploy a producción
La extensión es un cascarón: en runtime fetchea scripts y `config.json` desde GitHub Pages (rama `gh-pages`). **Editar `remote/` en `main` no afecta a usuarios** hasta hacer el deploy a `gh-pages`.

### Layout
- `main` rama de desarrollo. Scripts viven en `remote/scripts/*.js`, config en `remote/config.json`
- `gh-pages` rama publicada. **Estructura aplanada**: `remote/scripts/foo.js` (main) → `scripts/foo.js` (gh-pages); `remote/config.json` (main) → `config.json` (gh-pages)
- `gh-pages` debe quedar en sync byte-a-byte con el contenido de `remote/` de `main` (verificable con `git diff HEAD:remote/scripts/foo.js gh-pages:scripts/foo.js`)

### Procedimiento — usa `tools/deploy.sh` (NO lo hagas a mano)
Edita tus archivos bajo `remote/` **en el worktree de `main`** y luego corre:
```bash
tools/deploy.sh "fix(applet-x): descripción" --check applet-x
# bump patch + commit main + espejo gh-pages + push ambas + check-deploy
# flags: --minor | --set X.Y.Z | --check <script>
```
`deploy.sh` hace TODA la danza de forma atómica y **self-healing** (re-espeja `main:remote/` → `gh-pages`, así que corrige cualquier drift previo). Solo deploya scripts **referenciados en `config.apps[].scripts`** (los `.js` dev-only de `remote/scripts/` no se empujan).

**Antes de razonar "¿esto ya está vivo?"** corre `tools/deploy-status.sh` — imprime la versión de tu rama, `main`, `gh-pages` y el sitio **EN VIVO**, y verifica el invariante byte-a-byte. **Nunca concluyas el estado de deploy mirando el `config.json` de una rama de trabajo** (puede estar desfasada respecto a `main`/`gh-pages`).

**Candado:** el hook `pre-push` (`.githooks/pre-push`, instalar una vez con `tools/install-hooks.sh`) **bloquea** pushear `gh-pages` si no espeja `main:remote/`. Si te topas el bloqueo, usa `deploy.sh`.

#### Deploy DESDE el worktree `workbench` — usa `tools/wb-deploy.sh` (NO `deploy.sh` + `git show` a mano)
Si tu sesión vive en `workbench` (no en `main`) y quieres publicar un script, **NO** lo lleves a mano
con `git show workbench:remote/scripts/foo.js > <main>/remote/...` + `tools/deploy.sh`. `deploy.sh` hace
`git add remote/` en el worktree de `main`, así que **arrastraría dentro de TU commit de deploy cualquier
WIP sin commitear que la otra sesión de `main` tenga bajo `remote/`** (p.ej. otra feature en curso).
**Pasó el 2026-06-24:** un deploy del auto-router desde workbench casi commitea el WIP de `load-calculator`
de otra sesión; `deploy.sh` ni completó. Síntoma a reconocer: `git -C <main> status` muestra archivos
`remote/...` modificados que **no son tuyos**.

En su lugar:
```bash
SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh <script-sin-.js> "<mensaje>" [--minor|--set X.Y.Z]
```
`wb-deploy.sh` es atómico y **resguarda la WIP de `main`**: la respalda a un patch + `git stash`, aplica TU
script desde `workbench`, bumpea desde la versión **commiteada** de main, commitea **solo tu script + config**,
espeja gh-pages, push ambas y restaura la WIP (trap de recuperación si algo falla). El `SH_ALLOW_DEPLOY=1` es
**obligatorio**: el guard de workbench (`~/.claude/sh-workbench-guard.sh`) bloquea push/checkout de `main` desde
workbench sin él. Es **un script por corrida** — si cambiaste varios (p.ej. batch + panel), corre `wb-deploy.sh`
una vez por cada uno (cada corrida bumpea el patch). Si necesitas cambiar `config.json` (hashes nuevos, no solo
el bump), eso NO lo cubre wb-deploy: hazlo en el worktree de `main` con `deploy.sh`, coordinando que NO haya otra
sesión con WIP en main (regla §"Trabajo paralelo").

#### Procedimiento manual (fallback, si `deploy.sh` falla)
1. **Bump `remote/config.json` `version`** (ej. `0.4.2` → `0.4.3`) y `lastUpdated` a la fecha. Ese version es el cache-bust para que la extensión recargue scripts.
2. **Commit en `main`** con prefijo apropiado (`fix(...)`, `feat(...)`, `chore(config)`).
3. **Sync a `gh-pages`**: stash del .xlsm si está modificado → `git checkout gh-pages` → `git show main:remote/scripts/foo.js > scripts/foo.js` + `git show main:remote/config.json > config.json` → `git add ... && git commit -m "deploy: <descripción> + bump <version>"`.
4. **Push ambas ramas**: `git push origin main && git push origin gh-pages`.
5. **GitHub Pages publica en ~30-60s**. Después: recarga la extensión (chrome://extensions → reload) o reinicia Chrome si cachea.
6. **Verificar byte-exact** con `tools/check-deploy.sh [<script-name>]` o `tools/deploy-status.sh`.

### Notas
- Commits de `gh-pages` siguen formato `deploy: <qué cambió> + bump <version>` (ver `git log gh-pages --oneline`).
- No hay tags ni rollback automatizado todavía (item pendiente del audit).
- Si solo cambia `extension/`, no hace falta tocar `gh-pages` (la extensión empaquetada vive en Chrome Web Store o se distribuye como `.zip`).
- `extensionVersion` en `config.json` solo se bumpea cuando cambia el código de `extension/` y se republica el `.zip` en gh-pages.

## API de Steelhead
- Endpoint: `POST https://app.gosteelhead.com/graphql`
- Usa Apollo Persisted Queries (solo hashes SHA256, no queries en texto)
- Apollo client version: `"4.0.8"` (obligatorio en headers)
- Auth: cookies de sesión del navegador (no headers de auth)
- Hashes actuales en `remote/config.json`
- Documentación complementaria en `CLAUDE_CODE_CONTEXT.md`

**Playbooks específicos:**
- [`docs/api/portal-importer-ov-creation.md`](docs/api/portal-importer-ov-creation.md) — flujo de creación de OV (CreateReceivedOrder + SaveReceivedOrderPartTransforms + SaveReceivedOrderLinesAndItems) y gotchas
- [`docs/api/persisted-queries-playbook.md`](docs/api/persisted-queries-playbook.md) — diagnóstico de hashes rotados vs deprecados (HTTP 400 `"Must provide a query string."`)

## Reglas de desarrollo
- JavaScript vanilla (sin React, sin frameworks, sin bundlers)
- Documentación y UI en español
- Código y variables en inglés
- Los hashes de persisted queries cambian cuando Steelhead actualiza — usar siempre los de `config.json`
- **Ruta de regeneración de hash OBLIGATORIA por applet (regla de proceso).** Todo applet nuevo que introduzca un hash de persisted query DEBE documentar, como parte de su desarrollo, la **ruta exacta de auto-captura headless** de cada hash: la secuencia mínima que hace al frontend disparar la op, registrada en `tools/hash-autopilot/route-catalog.json` (queries: `goto`/`clickFirst`/`clickButton`) o `tools/hash-autopilot/sentinels-config.json` (mutations: ciclo sentinela sobre objeto "Sentinela", o **captura-y-aborta** `sink.abortOps` para escrituras que no deben persistir). Sin esa ruta, el `hash-autopilot` no puede regenerar el hash solo cuando Steelhead lo rote → el applet cae en captura manual con hash-scanner. **Un hash sin ruta de regeneración es deuda.** Ver `tools/hash-autopilot/README.md` y la skill `nuevo-applet`.
- Constantes de dominio (IDs, schemas) van en `config.json`, no hardcodeadas
- Batching de PNs en grupos de 20 para SaveManyPNP
- **UI propia en DARK MODE (regla de diseño).** Todo modal, panel, popover o tooltip que inyecte la extensión va en **tema oscuro** (base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento verde `#13a36f`) para que el operador distinga **de un vistazo** que es UI de la extensión y NO una pantalla nativa de Steelhead (que son CLARAS). Evita confundir nuestra UI con la de SH. Referencia: `auto-router-batch.js`/`auto-router-panel.js` (modales), `board-metal-tooltip.js` inyecta en el popover nativo y ahí sí respeta el estilo de SH (no es UI nuestra, es enriquecimiento del suyo).

## Trabajo paralelo (dos instancias de Claude)
Para correr dos sesiones de Claude sobre este repo sin pisarse, usa **git worktrees**. Cada worktree es un directorio aislado en su propia rama; los commits no chocan hasta que mergees.

**Crear worktree:**
```bash
tools/new-worktree.sh <feature-name> [branch-base]
# ejemplo: tools/new-worktree.sh dup-validator-tier4
# resultado: ../SteelheadAutomator-dup-validator-tier4 en rama wt/dup-validator-tier4
```

**Hot files que NO se deben editar en paralelo** (causan merge conflict casi seguro):
- `remote/config.json` (version bump + hashes compartidos)
- `CLAUDE.md` (índice de applets + reglas globales)
- rama `gh-pages` (deploy mirror — solo una sesión deploya a la vez)

**Reglas:**
1. Solo UNA sesión bumpea `remote/config.json` y deploya a `gh-pages` por vez.
2. Si vas a editar `config.json` o `CLAUDE.md`, hazlo en pasadas cortas (read → edit → commit → push) sin dejarlo WIP largo.
3. Para deploys: la sesión que está deployando hace `git stash` del WIP propio antes de `checkout gh-pages`. Nunca toca el directorio del otro worktree.
4. **Si deployas DESDE `workbench`, usa `SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh <script> "msg"`, NUNCA `git show … > <main>/remote/…` + `deploy.sh` a mano.** `deploy.sh` hace `git add remote/` y se llevaría la WIP sin commitear de la sesión de `main` dentro de tu deploy (incidente 2026-06-24: casi mezcla `load-calculator` con un deploy del auto-router). `wb-deploy.sh` stashea y restaura esa WIP automáticamente. Antes de deployar, verifica con `git -C <worktree-main> status` que no haya `remote/...` modificado ajeno; si lo hay, wb-deploy es obligatorio. Ver §"Deploy DESDE el worktree `workbench`".
5. Idealmente UN applet por sesión. Si tocan dos applets que comparten helpers (`host-cleanup-shared.js`, `process-canon.js`), coordinar.

**Limpiar al terminar:**
```bash
git worktree remove ../SteelheadAutomator-<feature-name>
git branch -D wt/<feature-name>   # si ya mergeaste o descartaste
```

## Trabajo con UI / DOM de Steelhead
**ANTES de escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — una sola inspección del wrapper resuelve todo en un commit.

### Regla: anclajes de texto SIEMPRE bilingües (ES + EN)
**Todo anclaje a DOM/modal/UI que dependa de TEXTO visible del UI de Steelhead debe matchear tanto español como inglés.** La UI de SH cambia de idioma por usuario/config (y a veces es mixta: un mismo modal muestra "Modo:" en español y "Per Part Count Unit Definitions" en inglés). Un anclaje mono-idioma se rompe silenciosamente al cambiar el locale. Aplica a: encabezados de modal (`isCreateOrderModalHeading` ES+EN es el patrón bueno), botones ("Guardar"/"Save", "Cancelar"/"Cancel"), labels de campo, adornos ("/ Part:"/"/ Parte:", "Parts /"/"Partes /"), regex de detección.
- **No adivines la traducción:** obtén el string real de AMBOS locales (pídelo o obsérvalo) antes de anclar. Si solo tienes uno, ánclalo pero **marca la deuda bilingüe** en la bitácora.
- Ejemplos de deuda detectada: `unit-autoconvert` (headingA EN-only, modoP ES-only, "/ Part:" EN-only), `create-order-autofill` (ya corregido a ES+EN).

**Audit COMPLETO 2026-07-09** (workflow multi-agente + grep inline de los que cortó el límite de gasto): **39 applets, detección terminada** → **10 con deuda** (~30 anclajes), **29 limpios** (`weight-quick-entry` = patrón bueno; los 19 API-driven confirmados sin anclaje de texto SH: no usan findByText/tests contra textContent/regex de labels de SH). **1er batch de fixes DEPLOYADO (config 1.7.100)**: labels de traducción confiable en 7 applets (Vendor/Proveedor, Divisa/Currency ×2 applets, Name/Nombre, Line Items/Líneas, Cliente/Customer, Línea/Line, NUEVO NÚMERO/NEW PART NUMBER, Terms/Términos, Modo/Mode). **Aún pendiente:** los *gates* mono-idioma (necesitan evidencia del string en el otro locale antes de anclar — no adivinar): price-confirm-guard `"Part Number Price"`, bill-autofill `"Create Bill"`, invoice-autofill `"Creating Invoice for"`, cfdi-attacher `"Send Invoice Email"`, unit-autoconvert `"Per Part Count Unit Definitions"`/`"/ Part:"`/`"Parts /"`, create-order-autofill `"Enviar a:"`, ~~surtido-guard `"Tareas Programadas:"`/`"Proceso:"`~~ **(RESUELTO v0.2.0: `Tareas Programadas:` ya es ES+EN con `Scheduled tasks:`; el fallback por `"Proceso:"` se eliminó)**, proceso-calculator `"Default Process:"`. Y re-scan de ~19 API-driven (Workflow resumeFromRunId). Reporte HTML en scratchpad.

**PENDIENTE (audit repo-wide de anclajes bilingües):** revisar TODOS los applets de `remote/scripts/*.js` que anclen por texto de UI y confirmar que cada anclaje matchee ES+EN. Priorizar los que corren sobre modales/formularios de SH (autofills, guards, create-order, unit-autoconvert, invoice-*, receiver-date, warehouse, weight-quick-entry, surtido-guard, price-confirm, vale-almacen). Registrar hallazgos por applet y hardenizar con evidencia de ambos locales. Ver task en el tracker.

Patrones específicos (label-driven extractors, react-select, MUI X DatePicker, modal injection, auto-fill con cancellation tokens, etc.) en [`docs/architecture/dom-patterns.md`](docs/architecture/dom-patterns.md).

## Reglas de memoria en applets de larga duración
**ANTES de tocar cualquier applet que procese >200 items, mantenga panel abierto, corra `runPool`, o se ejecute por minutos — invoca el skill `memory-hardening-applets`** (`~/.claude/skills/memory-hardening-applets/SKILL.md`). Cubre los dos ejes: memoria propia del applet (slim responses, parse once, clear Maps, closePanel cleanup, seed pattern) y memoria del SPA host (Datadog RUM stop, Apollo cache drain, mem monitor con guardrail a 88%).

Helpers compartidos en [`remote/scripts/host-cleanup-shared.js`](remote/scripts/host-cleanup-shared.js) → `window.SteelheadHostCleanup` (`stopDatadogSessionReplay`, `apolloCacheDrain`, `createMemMonitor`, `makePeriodicDrain`). Importar via array `scripts` del applet en `config.json`. NO copiar el patrón inline — cada copia rompe los latches `window.__sa_dd_stopped` y la idempotencia entre applets co-residentes.

Estado de adopción y anti-patrones en el skill. Audit pendiente por applet: task #113.

## Procesos: construcción, ordenamiento y control
Toda la documentación del modelo de procesos en Steelhead vive en [`docs/processes-architecture.md`](docs/processes-architecture.md): tipos de nodos, esquema GraphQL, canon de 9 nodos top-level, construcción del árbol para `ProcureTree`, discovery por tag, glosario de versiones de `process-canon`.

Antes de tocar `process-canon.js` o cualquier mutación de árbol, leerlo. Lecciones nuevas se agregan ahí.

## Índice de applets

Cada bitácora incluye versión actual, lecciones, plan de validación pendiente y pendientes derivados.

| Applet | Versión actual | Bitácora |
|---|---|---|
| `proceso-calculator` | 0.1.0 | [`docs/applets/proceso-calculator.md`](docs/applets/proceso-calculator.md) |
| `pn-lifecycle` (Gestor de ciclo de vida de PNs) | 0.2.0 (rediseño del `archiver`: 4 acciones sobre PNs — marcar/quitar validación (opt-ins granulares), desarchivar, archivar=Borrado definitivo. **Dos orígenes**: escanear dominio con filtros ricos + dedup canónica, ó **v0.2.0 "Pegar IDs"** — pega Id SH numéricos → resolución dirigida `GetPartNumber(id)` (pool 4 + drain, `archived` real vía `archivedAt`) → **directo a preview** sin escanear ni filtrar (avisa Id no resueltos / renglones ignorados). Core puro `parsePastedIds`/`fetchPNsByIds`, 28/28 tests. Piloto en vivo por acción pendiente — dry-run+confirm+preview obligatorios) | [`docs/applets/pn-lifecycle.md`](docs/applets/pn-lifecycle.md) |
| `load-calculator` (Calculadora de Piezas por Carga) | 0.1.0 (Fase 1: **Configurador de Estaciones** — datos maestros de tina/línea en `customInputs` de estación vía `CreateStationInputSchema`+`UpdateStationInputs`, por estación o bulk por línea; popup→`openStationConfig`. Motor de cálculo puro cuadrícula/área/barril validado vs golden del `Calculo.xlsx` (87/112/112·47/123/105) + núcleo RMW no-destructivo del configurador, 20 tests. **Deploy + run real OK (confirmado por el operador en producción, 2026-07-17).** Fase 2 pendiente: calculadora en el modal de Rack Types `CreateEditPartsPerRackTypeQuery` + Geometry Type genérico) | [`docs/applets/load-calculator.md`](docs/applets/load-calculator.md) |
| `report-regen` | 0.3.0 (botón ♻️ "Regenerar Reportes" en header secundario, ancla play+correo; cooldown GLOBAL del domain vía `GetRecomputableAt.recomputableAt` server-side; `GenerateDuckDb`+`JobQuery`. **v0.3.0**: hover del botón muestra la fecha-hora de la **última regeneración** (server-side, `JobQuery.currentSession…domainByDomainId.latestDuckdbFileCreatedAt`, mismo campo que `regenerate_duckdb.py`) + antigüedad relativa, en el `title` nativo; fail-safe. **Gating reactivo v0.2.0**: NO llama `CurrentUser` (es session-sensitive → la extensión lo recibe como "Must provide a query string"); intercepta la respuesta de `CurrentUser`/`Profile` del front + fallback Apollo cache; fail-closed. Popup vía handler genérico `fn`, sin tocar `extension/`; **run real OK (operador 2026-07-17)**) | [`docs/applets/report-regen.md`](docs/applets/report-regen.md) |
| `bulk-upload` | 1.5.41 + config 1.7.163 (**2026-07-20: Fast-path SOLO_PRECIO ACTIVO** — una corrida que solo cambia precios de PN existentes (cero enriquecimiento) salta STEP 6 (enrich), un `runPool` que pegaba `SavePartNumber` por CADA PN sin nada que aplicar (N round-trips + REPLACE de arrays); más rápido y más seguro. Motor puro `Parse.planSoloPrecioFastPath` + flag `SOLO_PRECIO_FASTPATH_ENABLED=true` + **13 golden tests** (2 invariantes de seguridad: 1 fila con enrich o 1 PN nuevo DESACTIVA el atajo). Deployado+firmado KMS, verificado EN VIVO (cierra el pendiente "fast-path real SOLO_PRECIO"). Guard mínimo: un `if(!fastPathSoloPrecio)` alrededor del `runPool` de STEP 6; `runIntent` recalculado en `execute()`. **Previo:** retry AddParams (incidente 429 en corrida de 20k), troceo #4 SOLO_PN validado en vivo, **Refactor F1-F5** (módulos puros + golden tests, memory-hardening `host-cleanup-shared`, batches N→1, `classifyRunIntent`+badge), `sa_load_history`→IndexedDB (validado 7 corridas). Ver bitácora para el detalle completo. | [`docs/applets/bulk-upload.md`](docs/applets/bulk-upload.md) |
| `process-deep-audit` | 0.8.0 | [`docs/applets/process-deep-audit.md`](docs/applets/process-deep-audit.md) |
| `spec-params-bulk` | 0.9.0 | [`docs/applets/spec-params-bulk.md`](docs/applets/spec-params-bulk.md) |
| `pn-specs-column` (Specs en Números de Parte) | 0.2.0 **DEPLOYADO** (autoInject en `/PartNumbers`: **toggle persistente en el header** + **columna "Specs / Params num."** que enriquece cada NP visible con sus specs (cada una **link** a `/Domains/<d>/Specs/<idInDomain>/Revisions/<rev>`) y los **parámetros cuyo VALOR trae dígitos** (v0.2.0: criterio por valLabel, no por `type` — así `Tiempo s/Corrosión "24 hrs."` BOOLEAN sale y `Adherencia "Sí o No"` no); excluye archivados. **`AllPartNumbers` NO trae specs/params → 2º query `GetPartNumber` por NP** (opt-in + memory-hardening: cache slim, mem monitor+guardrail, pool 4×/~7req/s, Datadog stop, Apollo drain). Core 15/15 golden. **v0.1.1** corrige 2 bugs del run real: (1) la columna se desalineaba al filtrar/paginar (React reposiciona el `<th>` inyectado) → fix: celda SIEMPRE última + re-posición en cada sync (validado en vivo, `aligned` 15/15); (2) specs ARCHIVADAS reaparecían por params huérfanos activos → fix: `partNumberSpecs` es la única fuente de specs activas, no se inventan buckets al vuelo. **Hallazgo v0.1.0:** el hash `GetPartNumber` rotó (`8e3fdb52…`→`5efd689d…`); actualizado y deployado) | [`docs/applets/pn-specs-column.md`](docs/applets/pn-specs-column.md) |
| `spec-migrator` (bundle Ajuste Masivo) | original + `validate-duplicate-params` 0.5.5 (CSV multi-cliente + memory hardening completo: mem monitor + guardrail @88% + resume + virtualización preview + host-cleanup-shared) + **`assign-pending-params` normalización de falsos pendientes (config 1.7.136, VALIDADO EN VIVO 2026-07-16): PNs marcados "pendientes" por `searchPartNumbers` pero con param ACTIVO de una REVISIÓN ANTERIOR de la spec (mismo nombre, distinto `specFieldParamId`) → `AddParams` chocaba por `specFieldId` (23P01, o HTTP 500 "mudo" bajo carga). Fix: archiva la fila activa vieja (`UpdatePartNumberSpecParam`) + repone el param del catálogo vigente, con preview + guard de equivalencia de nombre + rollback. Módulo puro `spec-migrator-normalize.js` 10/10. También: `steelhead-api` preserva errores 500 sin `message` (antes colapsaba a `undefined`)** | [`docs/applets/spec-migrator.md`](docs/applets/spec-migrator.md) |
| `invoice-autofill` | 0.5.65 (AR matcher reconoce divisa "M.N."=Moneda Nacional/pesos, no solo el código ISO — fix Hubbell "sin cuenta AR para MXN") | [`docs/applets/invoice-autofill.md`](docs/applets/invoice-autofill.md) |
| `invoice-auto-regen` | 0.5.37 | [`docs/applets/invoice-auto-regen.md`](docs/applets/invoice-auto-regen.md) |
| `sensor-status-autofill` | 0.5.58 | [`docs/applets/sensor-status-autofill.md`](docs/applets/sensor-status-autofill.md) |
| `receiver-date-override` | 0.5.68 | [`docs/applets/receiver-date-override.md`](docs/applets/receiver-date-override.md) |
| `warehouse-location-prefill` | 0.5.80 | [`docs/applets/warehouse-location-prefill.md`](docs/applets/warehouse-location-prefill.md) |
| `weight-quick-entry` | 0.5.81 | [`docs/applets/weight-quick-entry.md`](docs/applets/weight-quick-entry.md) |
| `create-order-autofill` | 0.1.3 (**2026-07-09**: 2ª pantalla `/Domains/<id>/SalesOrders` → "New Sales Order" → modal "Create Sales Order" EN. Mismos IDs RJSF → mismo autofill; se amplió el gate (`core.matchesCreateOrderUrl` incl. SalesOrders anclado a la lista) + heading bilingüe ES/EN (`core.isCreateOrderModalHeading`). Cliente vacío al abrir → panel espera en silencio hasta la selección; sin ship-to → Consolidar omitido (no falla). Core **14/14**. Run real OK (operador 2026-07-17). **Previo v0.1.1-0.1.2** (2026-07-03): fix "sin idInDomain" para TODOS — cliente por singleValue con badge `(#N)` + `getModalRoot` no confunde el título (`isDialogRootClass`) + fallback `idInDomain` por nombre vía `CustomerSearchByName`) | [`docs/applets/create-order-autofill.md`](docs/applets/create-order-autofill.md) |
| `unit-autoconvert` | 0.1.0 (**VIVO**; el toggle aparece inyectado. **Riesgo #1 RESUELTO** 2026-07-09: el SAVE hace merge—DMK no se borra—y el usuario configuró DMK como unidad parts-per → ahora tiene campo en el modal y el applet lo **DOM-llena automático** (enrutamiento dinámico, sin cambio de código; label `"DMK Decímetro Cuadrado / Part:"` confirmado vs `findPeerInput`). Pinear id DMK ya no aplica. Deuda: anclajes NO bilingües—ver audit repo-wide) | [`docs/applets/unit-autoconvert.md`](docs/applets/unit-autoconvert.md) |
| `archiver` (Archivador Masivo) | 1.0.0 (filtro por etiquetas AND/OR + archivar/desarchivar + fecha opcional + form en remoto; fase 2 pendiente: grupo/línea/departamento/proceso) | [`docs/applets/archiver.md`](docs/applets/archiver.md) |
| `wo-mover` (mover OTs entre OVs) | 0.2.0 (solo reasigna encabezado vía `CreateUpdateWorkOrdersChecked`; la parte/PT queda en la OV origen y se asocia manual — la UI no expone la asociación por API) | [`docs/applets/wo-mover.md`](docs/applets/wo-mover.md) |
| `auto-router` (Auto-Ruteador) | 0.1.0 (Fase 1 MVP: re-rutea una WO entre líneas, ej. T204→T205. Motor puro con regla **bypass→role-match→reúso de proceso→momentum serpentino** validado contra ground-truth real (22/22 rutas críticas exactas, golden test). Intercepta `StationTreatmentByWorkOrder` del modal nativo → panel preview editable → `CreateUpdateDeleteRoutes` batch. **Run real OK (operador 2026-07-17)** + Fase 0 captura candidatas / Fase 2 batch multi-orden / Fase 3 auto-fill del modal) | [`docs/applets/auto-router.md`](docs/applets/auto-router.md) |
| `surtido-guard` (Candado de Surtido Programado) | 0.2.0 (**v0.2.0 2026-07-20: marcado INVERTIDO — NARANJA en las NO movibles** (antes verde en las movibles); resalta la excepción/lo bloqueado. Señal DOM del marcado ahora **bilingüe ES+EN** (`Tareas Programadas:` / `Scheduled tasks:`, string EN provisto por el usuario) + **salvaguarda anti-falsa-alarma**: si ninguna tarjeta reconoce la señal pero la API sí reporta programadas → no marca (evita todo-naranja). Decisión pura en core (`hasScheduledCardSignal`/`isDomSignalBroken`/`shouldMarkNotMovable`), 16/16 golden. **v0.1.1**: estado `enforcementEnabled` movido a `window.__saSurtidoGuardEnabled` singleton — antes vivía en el closure y `injectAppScripts` re-evaluaba el IIFE en cada acción del popup creando una instancia nueva, así que apagar el candado mutaba una instancia distinta a la que tenía el interceptor de fetch latcheado → "Desactivado" sin efecto. Test `surtido-guard-toggle.test.js`. Bloquea mover piezas NO programadas del step "Preparando Surtido en Almacén" al siguiente proceso. **Programada = la pieza tiene tarea en el programa** — `GetRelatedScheduleData` → `scheduleTaskElement.associatedPartsTransferAccounts.id` (= `fromAccountId` de la mutación). Interceptor de `fetch` bloquea `CreateManyPartsTransfersChecked` tipo STEP (cubre **modal MOVER y drag silencioso**) devolviendo error GraphQL sintético + toast; agrisa botones del modal. Scope por nombre de nodo (`allRecipeNodes`). **Fail-safe** ante dato faltante. Toggle no persistente en popup, default ON. Run real del bloqueo OK (operador 2026-07-17); pendiente validar el naranja en vivo) | [`docs/applets/surtido-guard.md`](docs/applets/surtido-guard.md) |
| `price-confirm-guard` (Candado de Confirmación de Precio) | 0.1.4 (**VIVO en gh-pages desde 2026-07-01, commit `9c8b411`; el usuario confirma que la doble captura funciona en producción sin problemas — 2026-07-09**. Iterado 4× sobre comportamiento real: v0.1.4 suprime el `alert` nativo que SH dispara *tras* nuestro bloqueo. Core 27/27. En el bundle Safari/iPad v0.5.3 con kill-switch en popup. Candado core y preview multi-unidad de v0.1.3 validados en vivo (operador 2026-07-17)). Intercepta `window.fetch` sobre `SaveManyPartNumberPrices` **solo con el modal nativo "Part Number Price" abierto** (no toca la carga masiva de `bulk-upload`) → modal dark-mode que exige **reconfirmar el precio tipo password** (`pricesMatch` exacto normalizado), **muestra la divisa** y **bloquea si falta** (`customInputs.DatosPrecio.Divisa` vacío = sin divisa; fail-closed), **muestra la unidad** (`unitId` null=pieza) y calcula el **equivalente por pieza** sobre el valor reconfirmado (factor API-first `GetPartNumber`→`GetAvailableUnits`, fallback manual). Confirmar → deja pasar el fetch real; Cancelar/Esc/mismatch → `Response` sintético `{errors}`. Core puro `price-confirm-core.js`. Estado singleton `window.__saPriceGuard*` + latch idempotente (lección surtido-guard). Toggle popup default ON no persistente. `textContent` (no XSS). Fase 2: guardar factor, leer factor del DOM Panel A/B, persistir toggle) | [`docs/applets/price-confirm-guard.md`](docs/applets/price-confirm-guard.md) |
| `sensor-graph-hide-all` (Auto-ocultar sensores + combo aislar) | 0.2.0 (config 1.7.77). **Fase 1** (validada en vivo): al ENTRAR esconde todos. **Fase 2** (combo aislar UN sensor NUMBER en ambas vistas — inline + modo gráfica; intercepta `SensorDashboardQuery` para el tipo, ancla en `button[value="NUMBER"]`, aísla vía ojitos, sincroniza combos con `deriveComboValue`; core 20/20 golden; **VALIDADO en vivo end-to-end** — combo puebla vía replay de `SensorDashboardQuery` (el hook se perdía la carga inicial; hash estaba rotado `bde56bd6→038f4822`), aislar + Todos/Ninguno OK). Al ENTRAR a un Sensor Dashboard (`/Maintenance/SensorDashboards/<id>`) esconde TODOS los sensores de la gráfica (deja los ojitos tachados) para que el operador destache solo el que quiere ver. El ojito es **puro estado de React (0 mutaciones GraphQL)** → se resetea a "todos visibles" en cada carga; esconder es gratis/reversible. Auto-inyectado (`autoInject:true`, molde guards, **sin republicar extensión**), toggle popup vía handler genérico `fn`. Poll de entrada (no while-loop: clicar NO actualiza el DOM síncrono, React re-renderiza async) con contrato **"una vez por entrada"** — latchea y NO re-esconde lo que el operador destache/refreshee. Selectores por `aria-label` + fallback `data-testid` (VisibilityIcon/VisibilityOffIcon). Core 12/12 golden. Validación DOM en vivo parcial (14→0 en una pasada; timers congelados en tab oculta). | [`docs/applets/sensor-graph-hide-all.md`](docs/applets/sensor-graph-hide-all.md) |
| `vale-almacen` (Vale de Almacén) | 0.1.0 (FAB 📦 en Producción/Mantenimiento/Sensores/Inventario → panel multi-línea que emite un evento de mantenimiento sobre nodo **Surtimiento** (raíz + 3 pasos; paso 0 = sensores `NUMBER` = artículos con cantidad vía `measurement`; también TEXT/BOOLEAN para EPP). Cada línea `artículo+cantidad+usuario` queda como **comentario estructurado parseable** `[VALE]…[/VALE]` (motor puro `vale-almacen-engine.js`, 19 tests) con núm. de empleado (`UserDialogQuery`→`customInputs.DatosLaborales.CodigoEmpleado`); "Asignado"=quien recoge. Modelo validado vs 2 scans reales. Hashes: `GetMaintenanceEvent`/`UpdateMaintenanceNodeEvent`/`UserDialogQuery`. **Deployado a gh-pages (config 1.7.37) + incluido en bundle Safari/iPad v0.3.0 (FAB).** Run real OK (operador 2026-07-17)) | [`docs/applets/vale-almacen.md`](docs/applets/vale-almacen.md) |
| `process-canon` | varios | [`docs/processes-architecture.md`](docs/processes-architecture.md) (glosario §9) |
| `hash-scanner` | 0.6.23 | [`docs/applets/hash-scanner.md`](docs/applets/hash-scanner.md) |
| `audit-incomplete-pns` (DevTools, no extensión) | fix-2026-05-25 (Fix MM) + tier scan 2026-05-26 | [`docs/applets/audit-incomplete-pns.md`](docs/applets/audit-incomplete-pns.md) |
| `integrity-tiers` (módulo `duplicate-tiers.js` + UI en `auditor` + tier scan en DevTools tool) | 1.5.3 (hotfix: slim detail + buckets parciales + render stopped) | [`docs/applets/integrity-tiers.md`](docs/applets/integrity-tiers.md) |
| **Power Tools / Low-Code (`.ts`)** — _movidos a repo aparte (2026-06-16)_ | **Ya NO viven aquí.** Repo dedicado: `SteelheadPowerTools` (hermano de este repo; backup en `github.com/oviazcan/SteelheadPowerTools`). Incluye hooks `.ts`, lógica pura espejada + tests, `lowcode_sync.py` y todas las bitácoras `powertools-*`. | Ver `CLAUDE.md`/`docs/` de **SteelheadPowerTools** |
| `dual-source-recovery` (tool standalone, no extensión) | 1.0.2 (preservar casing Title Case + limpiar `(seleccione)` residual) | [`docs/applets/dual-source-recovery.md`](docs/applets/dual-source-recovery.md) |
| `wb-produccion-access` (tool standalone DevTools, no extensión) | 1.0.0 (panel inyectado: pega nombres → unión con acceso actual → `updateWorkboardLabelUsers` a labelId 9746; solo toca WB Producción, match por nombre, **run real OK (operador 2026-07-17)**) | [`docs/applets/wb-produccion-access.md`](docs/applets/wb-produccion-access.md) |
| `archive-inventory-batch-statuses` (tool standalone DevTools, no extensión) | 1.0.0 (panel: lista estatus por type con color/id + checkboxes + **detector de lotes en uso** vía `InventoryBatchViewQuery.pagedData.totalCount`. **Root cause:** `ArchiveInventoryBatchStatus` truena `"An unexpected error occurred."` solo si el estatus tiene lotes activos; **éxito = ausencia de `errors`**, NO el valor de `data` (siempre `null`). Callejones descartados: `archivedAt:"NOW"` y que `UpdateInventoryBatchStatus` no expone `archivedAt`. Run real: `#322` archivado OK) | [`docs/applets/archive-inventory-batch-statuses.md`](docs/applets/archive-inventory-batch-statuses.md) |

## Archivos scan_results
- Los `scan_results_*.json` generados por el hash-scanner se descargan al folder de Descargas del navegador (típicamente `~/Downloads`).
- **NUNCA** copiarlos al repo — están en `.gitignore` pero además su contenido puede incluir payloads sensibles redactados.
- Cuando necesites analizarlos con Claude, léelos directamente desde `~/Downloads/scan_results_*.json`.
- El hash-scanner sanitiza variables desde `remote/scripts/hash-scanner.js` (redacta tokens URL, keys sensibles y trunca strings largas), pero la defensa en profundidad manda: no los muevas al repo.

## Seguridad (estado y pendientes)

### Ya implementado (2026-04-14, actualizado 2026-05-14)
- `hash-scanner.js` sanitiza `variablesSamples` con redacción **key-level** (recursiva: `body`, `rawBody`, `html`, `htmlBody`, `token`, `accessToken`, `authToken`, `emailData`, ...), strip de `?token=` en URLs, truncado > 500 chars, y re-saneado en `mergeResults`. (El antiguo op-level denylist `email|invoice|send|...` se quitó en 0.6.23 — era demasiado ancho; la protección real viene de la key-level. Ver `docs/applets/hash-scanner.md`.)
- `responseSamples` y `errorSamples` aplican el mismo `sanitizeValue` recursivo antes de guardarse.
- `.gitignore` cubre `scan_results_*.json` y `~$*.xlsm/xlsx`.
- Historial git purgado de `scan_results_*.json` (filter-repo + force-push a main/gh-pages/feat/po-comparator). Ticket abierto a GitHub Support para GC de commits huérfanos (`789375b`, `c37c9e8`).

### Pendientes del audit pre-producción (por prioridad)
1. **Integridad de scripts remotos (ALTO) — ✅ FASE 0/1/2 HECHAS (2026-07-17):** `extension/background.js` ejecutaba `new Function(c)()` sobre código de GitHub Pages sin verificar. **Solución: firma criptográfica ECDSA P-256** (no solo hashes-en-config, que no detiene un compromiso de repo/Pages). `config.json` firmado (`config.sig` separado) + `scriptIntegrity` por script; verificación fail-closed en `background.js`; privada en **GCP KMS del cliente** (`steelhead-ecoplating`, handoff = cambio de IAM), pública embebida. **Estado:** Fase 0 (KMS provisionado) + Fase 1 (deploy firmado, config 1.7.145) + Fase 2 (extensión republicada con pública embebida, ext 1.6.6) — todo verificado en vivo. **Único pendiente: rollout gradual** — cada máquina activa la verificación fail-closed al actualizar al zip 1.6.6 (las que no actualizan siguen fail-open; break-glass por popup). Ver bitácora [`docs/applets/security-integrity-signing.md`](docs/applets/security-integrity-signing.md).
2. **XSS vía `innerHTML` (MEDIO) — ✅ HECHO EN WORKBENCH (2026-07-15, pendiente deploy).** Barrido repo-wide: 32 sitios RIESGO-ALTO (nombres de PN/spec/cliente/reporte/label de GraphQL —vector cross-user— o de CSV/XLSX) ahora escapados con `escHtml` en `report-liberator`, `wo-deadline-changer` (+`safeColor`), `inventory-reset`, `spec-migrator`, `bulk-upload`, `extension/popup.js`. `po-comparator`/`portal-importer` ya estaban limpios. Suite 62/0.
3. **Plan de rollback (MEDIO) — ✅ HECHO EN WORKBENCH.** `deploy.sh` crea tag `vX.Y.Z` por bump (aditivo/tolerante); `tools/rollback.sh <tag>` revierte gh-pages self-healing; doc [`docs/architecture/rollback.md`](docs/architecture/rollback.md). Los tags son el CHANGELOG.
4. **CSP explícito (BAJO) — ✅ HECHO EN WORKBENCH (requiere republicar .zip para efecto).** `manifest.json` declara `content_security_policy.extension_pages: "script-src 'self'; object-src 'self'"`. Seguro: el `new Function` del remote-loader corre en `world:'MAIN'`, fuera del alcance de esa CSP.
5. **`console.log` en producción (BAJO) — ✅ HECHO (gate central; resto derivado).** Flag `sa_debug` (localStorage) / `config.debug`: `steelhead-api.js log()` gateado (lo usan 21+ applets; `warn` + persistencia intactos), `content.js` (por-carga) e `invoice-auto-regen` (poller, `console` sombreado local). Derivado: `console.log` directos de `weight-quick-entry`/`warehouse`/`paros-linea` (mismo patrón de shim).
6. **Anclajes bilingües ES+EN (audit) — ✅ MAPA COMPLETO; hardening bloqueado por evidencia del usuario.** 25 anclajes mono-idioma en 12 applets en [`docs/architecture/bilingual-anchoring-debt.md`](docs/architecture/bilingual-anchoring-debt.md). **Corrección 2026-07-16:** `surtido-guard` NO es riesgo de seguridad (se marcó P1 por error) — su candado es **API-driven** (`evaluateMove` vs `scheduledAccountIds` de `GetRelatedScheduleData`), bloquea en cualquier idioma; las cadenas de idioma solo alimentan el marcado cosmético (v0.2.0 naranja para no-movibles, ya **bilingüe ES+EN** + salvaguarda con el set de la API). La deuda restante son autofills/labels que dejan de dispararse (no seguridad). No se hardeniza sin el string real del otro locale (regla dura: no adivinar).
7. **Memory-hardening audit por applet (#113) — ✅ HECHO.** Estado de adopción de `host-cleanup-shared` en [`docs/applets/memory-hardening-audit.md`](docs/applets/memory-hardening-audit.md): 9 ADOPTADO, 5 PARCIAL, 2 NO-ADOPTADO (portal-importer, po-comparator), 0 INLINE-DUP. Adopción de los faltantes = follow-up no urgente.

**Nota (2026-07-15):** items 2-7 **DEPLOYADOS a producción, config 1.7.120, tag `v1.7.120`** (scripts remotos verificados en vivo). También se corrigió un test rojo pre-existente del `auto-router` (`destinationLines` seguía excluyendo la línea origen — bug Image #6 vivo). **Otros canales:** (a) los cambios de `extension/` (CSP en manifest, XSS en `popup.js`, gate en `content.js`) **NO se despliegan a la Chrome Web Store por diseño** — la extensión inyecta código remoto (remote script loader con `new Function`), incompatible con las políticas de MV3/CWS, así que **quedan en el repo sin desplegar** hasta que cambie esa arquitectura; no es un pendiente accionable hoy. (b) **bundle Safari/iPad rebundleado (v0.5.7, 2026-07-17, build-safari 10/10; sincronizado a Resources de Xcode)** — solo falta **recompilar en Xcode**.

### No aplica (por arquitectura)
- Auth / sessions / HTTPS / DB / CORS / rate limiting / bcrypt / backups / migrations: no hay backend propio; consumimos Steelhead GraphQL vía cookies de sesión del navegador.

Checklist completa pre-producción vive en `~/.claude/CLAUDE.md` (global del usuario).
