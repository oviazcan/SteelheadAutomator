# SteelheadAutomator

## Qué es
Extensión de Chrome MV3 que automatiza carga masiva de cotizaciones y números de parte en Steelhead ERP (app.gosteelhead.com). Usa arquitectura de "remote script loader": la extensión es un cascarón que carga lógica desde GitHub Pages.

## Estructura
- `extension/` — Extensión Chrome (se publica en Chrome Web Store como Unlisted)
- `remote/` — Scripts y config servidos por GitHub Pages (se actualizan con git push)
- `tools/` — Scripts de mantenimiento local (scraping de hashes, etc.)
- `skills/` — Skills reutilizables para Claude sobre la API de Steelhead
- `docs/` — Specs de diseño

## API de Steelhead
- Endpoint: `POST https://app.gosteelhead.com/graphql`
- Usa Apollo Persisted Queries (solo hashes SHA256, no queries en texto)
- Apollo client version: `"4.0.8"` (obligatorio en headers)
- Auth: cookies de sesión del navegador (no headers de auth)
- Hashes actuales en `remote/config.json`
- Documentación completa en `CLAUDE_CODE_CONTEXT.md`

## Reglas de desarrollo
- JavaScript vanilla (sin React, sin frameworks, sin bundlers)
- Documentación y UI en español
- Código y variables en inglés
- Los hashes de persisted queries cambian cuando Steelhead actualiza — usar siempre los de config.json
- Constantes de dominio (IDs, schemas) van en config.json, no hardcodeadas
- Batching de PNs en grupos de 20 para SaveManyPNP

## Archivos scan_results
- Los `scan_results_*.json` generados por el hash-scanner se descargan al folder de Descargas del navegador (típicamente `~/Downloads`)
- **NUNCA** copiarlos al repo — están en `.gitignore` pero además su contenido puede incluir payloads sensibles redactados
- Cuando necesites analizarlos con Claude, léelos directamente desde `~/Downloads/scan_results_*.json`
- El hash-scanner sanitiza variables desde `remote/scripts/hash-scanner.js` (redacta tokens URL, keys sensibles y trunca strings largas), pero la defensa en profundidad manda: no los muevas al repo

## Seguridad (estado y pendientes)

### Ya implementado (2026-04-14)
- `hash-scanner.js` sanitiza `variablesSamples` con denylist de ops (`email|invoice|send|preview|attach|cfdi`), redacción de keys sensibles (`body`, `rawBody`, `html`, `token`, `emailData`, ...), strip de `?token=` en URLs, truncado > 500 chars, y re-saneado en `mergeResults`
- `.gitignore` cubre `scan_results_*.json` y `~$*.xlsm/xlsx`
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
