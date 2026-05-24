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

## Trabajo con UI / DOM de Steelhead
**ANTES de escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — una sola inspección del wrapper resuelve todo en un commit.

Patrones específicos (label-driven extractors, react-select, MUI X DatePicker, modal injection, auto-fill con cancellation tokens, etc.) en [`docs/architecture/dom-patterns.md`](docs/architecture/dom-patterns.md).

## Procesos: construcción, ordenamiento y control
Toda la documentación del modelo de procesos en Steelhead vive en [`docs/processes-architecture.md`](docs/processes-architecture.md): tipos de nodos, esquema GraphQL, canon de 9 nodos top-level, construcción del árbol para `ProcureTree`, discovery por tag, glosario de versiones de `process-canon`.

Antes de tocar `process-canon.js` o cualquier mutación de árbol, leerlo. Lecciones nuevas se agregan ahí.

## Índice de applets

Cada bitácora incluye versión actual, lecciones, plan de validación pendiente y pendientes derivados.

| Applet | Versión actual | Bitácora |
|---|---|---|
| `bulk-upload` | 1.4.29 | [`docs/applets/bulk-upload.md`](docs/applets/bulk-upload.md) |
| `process-deep-audit` | 0.8.0 | [`docs/applets/process-deep-audit.md`](docs/applets/process-deep-audit.md) |
| `spec-params-bulk` | 0.9.0 | [`docs/applets/spec-params-bulk.md`](docs/applets/spec-params-bulk.md) |
| `invoice-autofill` | 0.5.63+ | [`docs/applets/invoice-autofill.md`](docs/applets/invoice-autofill.md) |
| `invoice-auto-regen` | 0.5.37 | [`docs/applets/invoice-auto-regen.md`](docs/applets/invoice-auto-regen.md) |
| `sensor-status-autofill` | 0.5.58 | [`docs/applets/sensor-status-autofill.md`](docs/applets/sensor-status-autofill.md) |
| `receiver-date-override` | 0.5.68 | [`docs/applets/receiver-date-override.md`](docs/applets/receiver-date-override.md) |
| `warehouse-location-prefill` | 0.5.80 | [`docs/applets/warehouse-location-prefill.md`](docs/applets/warehouse-location-prefill.md) |
| `weight-quick-entry` | 0.5.81 | [`docs/applets/weight-quick-entry.md`](docs/applets/weight-quick-entry.md) |
| `create-order-autofill` | 0.1.0 | [`docs/applets/create-order-autofill.md`](docs/applets/create-order-autofill.md) |
| `process-canon` | varios | [`docs/processes-architecture.md`](docs/processes-architecture.md) (glosario §9) |
| `hash-scanner` | 0.6.23 | [`docs/applets/hash-scanner.md`](docs/applets/hash-scanner.md) |
| `audit-incomplete-pns` (DevTools, no extensión) | fix-2026-05-23 | [`docs/applets/audit-incomplete-pns.md`](docs/applets/audit-incomplete-pns.md) |
| Power Tools `ordendeventa.ts` | n/a (low-code hook) | [`docs/applets/powertools-ordendeventa.md`](docs/applets/powertools-ordendeventa.md) |
| Power Tools `facturacion-pdf.ts` | n/a (low-code hook `getPdfCustomization`) | [`docs/applets/powertools-facturacion-pdf.md`](docs/applets/powertools-facturacion-pdf.md) |
| Power Tools `facturacion.ts` | n/a (low-code hook `getInvoicePricing`) | [`docs/applets/powertools-facturacion.md`](docs/applets/powertools-facturacion.md) |

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
