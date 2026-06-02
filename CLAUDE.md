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

### Procedimiento (cada vez que cambia algo en `remote/`)
1. **Bump `remote/config.json` `version`** (ej. `0.4.2` → `0.4.3`) y `lastUpdated` a la fecha. Ese version es el cache-bust para que la extensión recargue scripts.
2. **Commit en `main`** con prefijo apropiado (`fix(...)`, `feat(...)`, `chore(config)`).
3. **Sync a `gh-pages`**: stash del .xlsm si está modificado → `git checkout gh-pages` → `git show main:remote/scripts/foo.js > scripts/foo.js` + `git show main:remote/config.json > config.json` → `git add ... && git commit -m "deploy: <descripción> + bump <version>"`.
4. **Push ambas ramas**: `git push origin main && git push origin gh-pages`.
5. **GitHub Pages publica en ~30-60s**. Después: recarga la extensión (chrome://extensions → reload) o reinicia Chrome si cachea.
6. **Verificar byte-exact** con `tools/check-deploy.sh [<script-name>]`.

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
- Constantes de dominio (IDs, schemas) van en `config.json`, no hardcodeadas
- Batching de PNs en grupos de 20 para SaveManyPNP

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
4. Idealmente UN applet por sesión. Si tocan dos applets que comparten helpers (`host-cleanup-shared.js`, `process-canon.js`), coordinar.

**Limpiar al terminar:**
```bash
git worktree remove ../SteelheadAutomator-<feature-name>
git branch -D wt/<feature-name>   # si ya mergeaste o descartaste
```

## Trabajo con UI / DOM de Steelhead
**ANTES de escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — una sola inspección del wrapper resuelve todo en un commit.

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
| `bulk-upload` | 1.5.16 (FK-fallback para scalars bugged del persisted query `GetPartNumber` — los escalares `defaultProcessNodeId / geometryTypeId / customerId / partNumberGroupId` llegan `null` pero las FK relacionales están pobladas; bulk-upload los reenviaba a SavePartNumber y por REPLACE-semantics SH desvinculaba campos, en especial el STEP 6b cleanup tras Call B; observado en piloto Fisher v2 2026-05-30) (+ ext 1.6.2) | [`docs/applets/bulk-upload.md`](docs/applets/bulk-upload.md) |
| `process-deep-audit` | 0.8.0 | [`docs/applets/process-deep-audit.md`](docs/applets/process-deep-audit.md) |
| `spec-params-bulk` | 0.9.0 | [`docs/applets/spec-params-bulk.md`](docs/applets/spec-params-bulk.md) |
| `spec-migrator` (bundle Ajuste Masivo) | original + `validate-duplicate-params` 0.5.5 (CSV multi-cliente + memory hardening completo: mem monitor + guardrail @88% + resume + virtualización preview + host-cleanup-shared) | [`docs/applets/spec-migrator.md`](docs/applets/spec-migrator.md) |
| `invoice-autofill` | 0.5.63+ | [`docs/applets/invoice-autofill.md`](docs/applets/invoice-autofill.md) |
| `invoice-auto-regen` | 0.5.37 | [`docs/applets/invoice-auto-regen.md`](docs/applets/invoice-auto-regen.md) |
| `sensor-status-autofill` | 0.5.58 | [`docs/applets/sensor-status-autofill.md`](docs/applets/sensor-status-autofill.md) |
| `receiver-date-override` | 0.5.68 | [`docs/applets/receiver-date-override.md`](docs/applets/receiver-date-override.md) |
| `warehouse-location-prefill` | 0.5.80 | [`docs/applets/warehouse-location-prefill.md`](docs/applets/warehouse-location-prefill.md) |
| `weight-quick-entry` | 0.5.81 | [`docs/applets/weight-quick-entry.md`](docs/applets/weight-quick-entry.md) |
| `create-order-autofill` | 0.1.0 | [`docs/applets/create-order-autofill.md`](docs/applets/create-order-autofill.md) |
| `wo-mover` (mover OTs entre OVs) | 0.2.0 (solo reasigna encabezado vía `CreateUpdateWorkOrdersChecked`; la parte/PT queda en la OV origen y se asocia manual — la UI no expone la asociación por API) | [`docs/applets/wo-mover.md`](docs/applets/wo-mover.md) |
| `process-canon` | varios | [`docs/processes-architecture.md`](docs/processes-architecture.md) (glosario §9) |
| `hash-scanner` | 0.6.23 | [`docs/applets/hash-scanner.md`](docs/applets/hash-scanner.md) |
| `audit-incomplete-pns` (DevTools, no extensión) | fix-2026-05-25 (Fix MM) + tier scan 2026-05-26 | [`docs/applets/audit-incomplete-pns.md`](docs/applets/audit-incomplete-pns.md) |
| `integrity-tiers` (módulo `duplicate-tiers.js` + UI en `auditor` + tier scan en DevTools tool) | 1.5.3 (hotfix: slim detail + buckets parciales + render stopped) | [`docs/applets/integrity-tiers.md`](docs/applets/integrity-tiers.md) |
| Power Tools — catálogo completo (8 categorías, 17 slots TLC) | n/a (espejo `powertools/synced/`) | [`docs/applets/powertools-catalog.md`](docs/applets/powertools-catalog.md) |
| Power Tools `received-order` (`ordendeventa`) | sync con `powertools/synced/received-order/received-order.ts` | [`docs/applets/powertools-ordendeventa.md`](docs/applets/powertools-ordendeventa.md) |
| Power Tools `pdf:INVOICE_TEMPLATE` (`facturacion-pdf`) | sync con `powertools/synced/pdf/INVOICE_TEMPLATE.ts` | [`docs/applets/powertools-facturacion-pdf.md`](docs/applets/powertools-facturacion-pdf.md) |
| Power Tools `invoice` (`facturacion`) | sync con `powertools/synced/invoice/invoice.ts` | [`docs/applets/powertools-facturacion.md`](docs/applets/powertools-facturacion.md) |
| Power Tools `schedule` | sync con `powertools/synced/schedule/schedule.ts` | [`docs/applets/powertools-schedule.md`](docs/applets/powertools-schedule.md) |
| Power Tools `file-import:QUOTE_IMPORT` | sync con `powertools/synced/file-import/QUOTE_IMPORT.ts` | [`docs/applets/powertools-file-import-quote.md`](docs/applets/powertools-file-import-quote.md) |
| Power Tools `pdf:CERTIFICATION_TEMPLATE` | sync con `powertools/synced/pdf/CERTIFICATION_TEMPLATE.ts` | [`docs/applets/powertools-pdf-certification.md`](docs/applets/powertools-pdf-certification.md) |
| Power Tools `pdf:WORK_ORDER_PART_NUMBER_TEMPLATE` | sync con `powertools/synced/pdf/WORK_ORDER_PART_NUMBER_TEMPLATE.ts` | [`docs/applets/powertools-pdf-work-order-part-number.md`](docs/applets/powertools-pdf-work-order-part-number.md) |
| Power Tools `pdf:RACK_TEMPLATE` | sync con `powertools/synced/pdf/RACK_TEMPLATE.ts` | [`docs/applets/powertools-pdf-rack.md`](docs/applets/powertools-pdf-rack.md) |
| Power Tools `pdf:PACKING_SLIP_TEMPLATE` | sync con `powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts` | [`docs/applets/powertools-pdf-packing-slip.md`](docs/applets/powertools-pdf-packing-slip.md) |
| Power Tools `pdf:PART_NUMBER_TEMPLATE` | sync con `powertools/synced/pdf/PART_NUMBER_TEMPLATE.ts` | [`docs/applets/powertools-pdf-part-number.md`](docs/applets/powertools-pdf-part-number.md) |
| `dual-source-recovery` (tool standalone, no extensión) | 1.0.2 (preservar casing Title Case + limpiar `(seleccione)` residual) | [`docs/applets/dual-source-recovery.md`](docs/applets/dual-source-recovery.md) |

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
1. **Integridad de scripts remotos (ALTO):** `extension/background.js:66` ejecuta `new Function(c)()` sobre código fetched de GitHub Pages sin verificación. Plan: pinear hashes SHA-256 de cada script en `config.json` y verificar antes de ejecutar. Riesgo: si el repo o Pages se compromete, código arbitrario corre en la tab de Steelhead.
2. **XSS vía `innerHTML` (MEDIO):** applets `po-comparator`, `portal-importer`, `bulk-upload`, `spec-migrator` interpolan datos de GraphQL/XLSX en `innerHTML` sin sanitizar. Plan: migrar a `textContent` o helper de escape HTML.
3. **Plan de rollback (MEDIO):** no hay git tags, ni CHANGELOG, ni procedimiento documentado para revertir un deploy malo de `gh-pages`. Plan: tagging atado al bump de `config.version` + doc breve.
4. **CSP explícito (BAJO):** `manifest.json` no declara `content_security_policy`. Plan: agregar `"script-src 'self'; object-src 'self'"` para `extension_pages`.
5. **`console.log` en producción (BAJO):** 18 en `extension/`, 22 en `remote/`. Plan: gate detrás de flag `DEBUG` en `config.json`.

### No aplica (por arquitectura)
- Auth / sessions / HTTPS / DB / CORS / rate limiting / bcrypt / backups / migrations: no hay backend propio; consumimos Steelhead GraphQL vía cookies de sesión del navegador.

Checklist completa pre-producción vive en `~/.claude/CLAUDE.md` (global del usuario).
