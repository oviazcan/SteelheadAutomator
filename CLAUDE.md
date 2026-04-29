# SteelheadAutomator

## Qué es
Extensión de Chrome MV3 que automatiza carga masiva de cotizaciones y números de parte en Steelhead ERP (app.gosteelhead.com). Usa arquitectura de "remote script loader": la extensión es un cascarón que carga lógica desde GitHub Pages.

## Estructura
- `extension/` — Extensión Chrome (se publica en Chrome Web Store como Unlisted)
- `remote/` — Scripts y config servidos por GitHub Pages (se actualizan con git push)
- `tools/` — Scripts de mantenimiento local (scraping de hashes, etc.)
- `skills/` — Skills reutilizables para Claude sobre la API de Steelhead
- `docs/` — Specs de diseño

## Deploy a producción
La extensión es un cascarón: en runtime fetchea scripts y `config.json` desde GitHub Pages (rama `gh-pages`). **Editar `remote/` en `main` no afecta a usuarios** hasta hacer el deploy a `gh-pages`.

### Layout
- `main` rama de desarrollo. Scripts viven en `remote/scripts/*.js`, config en `remote/config.json`
- `gh-pages` rama publicada. **Estructura aplanada**: `remote/scripts/foo.js` (main) → `scripts/foo.js` (gh-pages); `remote/config.json` (main) → `config.json` (gh-pages)
- `gh-pages` debe quedar en sync byte-a-byte con el contenido de `remote/` de `main` (verificable con `git diff HEAD:remote/scripts/foo.js gh-pages:scripts/foo.js`)

### Procedimiento (cada vez que cambia algo en `remote/`)
1. **Bump `remote/config.json` `version`** (ej. `0.4.2` → `0.4.3`) y `lastUpdated` a la fecha. Ese version es el cache-bust para que la extensión recargue scripts
2. **Commit en `main`** con prefijo apropiado (`fix(...)`, `feat(...)`, `chore(config)`)
3. **Sync a `gh-pages`**: en commits previos el patrón es `git checkout gh-pages && cp ../main-checkout/remote/scripts/foo.js scripts/foo.js && cp ../main-checkout/remote/config.json config.json && git add ... && git commit -m "deploy: <descripción> + bump <version>"`. Sin worktree formal — el usuario hace switch de rama y copia manualmente
4. **Push ambas ramas**: `git push origin main && git push origin gh-pages`
5. **GitHub Pages publica en ~30-60s**. Después: recarga la extensión (chrome://extensions → reload) o reinicia Chrome si cachea

### Notas
- Los commits de `gh-pages` siguen formato `deploy: <qué cambió> + bump <version>` (ver `git log gh-pages --oneline`)
- No hay tags ni rollback automatizado todavía (item pendiente del audit)
- Si solo cambia `extension/`, no hace falta tocar `gh-pages` (la extensión empaquetada vive en Chrome Web Store o se distribuye como `.zip`)
- `extensionVersion` en `config.json` solo se bumpea cuando cambia el código de `extension/` y se republica el `.zip` en gh-pages

## API de Steelhead
- Endpoint: `POST https://app.gosteelhead.com/graphql`
- Usa Apollo Persisted Queries (solo hashes SHA256, no queries en texto)
- Apollo client version: `"4.0.8"` (obligatorio en headers)
- Auth: cookies de sesión del navegador (no headers de auth)
- Hashes actuales en `remote/config.json`
- Documentación completa en `CLAUDE_CODE_CONTEXT.md`

### Portal Importer: flujo de creación de OV (resuelto 2026-04-16, v0.4.23)
`ov-operations.js:createNewOV` crea una OV con líneas en **dos pasos** (el UI de Steelhead hace lo mismo):

1. **`CreateReceivedOrder`** — crea la OV vacía. Devuelve `id` (internal) e `idInDomain` (display `#529`).
2. **`SaveReceivedOrderPartTransforms`** — una llamada **por PN único** (no por línea). La unique constraint `steelhead_received_order_part_transform_unique_constraint` rechaza duplicados por `(receivedOrderId, partNumberId, ...)`, así que si un PO tiene varias líneas con el mismo PN (común en Hubbell = múltiples entregas), hay que **agrupar por `partNumberId` y sumar cantidades**. Input shape:
   ```js
   { input: [{
     isBillable: true,
     receivedOrderId,
     shipToId: formData.shipToAddressId || null,
     partNumberPriceId: null,
     maxPartTransformCount: totalCount,  // total ordenado del PN
     count: 0,                           // recibido (arranca en 0 / TBD)
     partNumberId,
     orderType: 'MAKE_TO_ORDER',
     description: '',
     deadline: formData.deadline,
     children: []
   }] }
   ```
3. **`SaveReceivedOrderLinesAndItems`** — una llamada, `newLines[]` con una entrada por línea del PO (las que comparten PN apuntan al mismo `transform.id`):
   ```js
   { input: { receivedOrderId, newLines: [{
     id: null,
     name: pnString,
     description: '',
     lineItems: [{
       archive: false,
       description: pnString,
       quantity: String(lineQty),     // ← string
       price: String(unitPrice || '0'),// ← string
       productId: null,               // null para Hubbell (no forzar producto)
       unitId: null,
       quoteLineItemId: null,
       receivedOrderLineItemPartTransforms: [{
         receivedOrderPartTransform: {
           id: transformId,           // del paso 2
           partNumberId,
           partNumberPriceId: null,
           maxPartTransformCount: totalCount,  // REPETIR o null-ea el campo
           count: 0,
           description: ''
         }
       }]
     }]
   }] } }
   ```

**Gotchas importantes:**
- `quantity` y `price` son **strings** en la mutación aunque el backend los guarde como números.
- `productId: null` es válido (no forzar con `SearchProducts` — se ve feo en el UI).
- `maxPartTransformCount` debe pasarse en AMBAS llamadas; omitirlo en la segunda null-ea Max Count en la UI.
- `verifyOVLines` usa `GetReceivedOrder` y la respuesta puede venir con raíz `receivedOrder` (hash viejo) o `receivedOrderByIdInDomain` (hash nuevo), con lines en `receivedOrderLines.nodes` o `receivedOrderLinesByReceivedOrderId.nodes`.

### Persisted queries deprecadas: síntoma y diagnóstico (resuelto 2026-04-27, v0.5.7)
Steelhead **deprecó server-side la operación `CurrentUser`** (hash `18c6574c…`). Síntoma: `paros-linea` rompía en cold start con `HTTP 400 {"errors":[{"message":"Must provide a query string."}]}` en cada reload, y NO había FAB. Variantes hermanas (`CurrentUserDetails`, `CurrentUserActiveSegments`, `CurrentUserQuery`) seguían vivas con sus hashes intactos.

**Diagnóstico engañoso #1**: el hash en config seguía siendo el mismo que el UI escaneado en `scan_results_*.json` con `status: known` y `responseSchema` válido — parece "está bien". Falso. Lo que pasa: el server marcó esa operación como no-aceptada (`acceptApqHashesOnly`-style); ya no acepta el hash con request hash-only ni acepta queries arbitrarias con `query` string libre. Solo deja pasar hashes de operaciones "vivas".

**Diagnóstico engañoso #2**: parece race condition (Apollo Client del UI calienta APQ después de cold start). NO ES. Reintentar con backoff `[0, 600, 1200, 1800] ms` da los 4 fallos. Y disparar **el mismo body shape desde el contexto del UI** (DevTools console, sin nuestra extensión) también devuelve 400. La operación está muerta server-side, no es timing.

**Cómo diferenciar entre "hash desactualizado" vs "operación deprecada"**:
1. Re-scanear con `hash-scanner.js` y mirar el hash de la op en `scan_results_*.json`. Si difiere del config → solo es un hash rotado, actualízalo. Si es **igual** al config (`status: known`) y la app sigue rota, es deprecación.
2. Probar el body shape en consola desde el UI vivo (con `extensions.persistedQuery.sha256Hash`). Si responde 400 también, no es nada de nuestra extensión.
3. Probar variantes hermanas con sus hashes en consola — si esas viven, el server solo mató esa operación específica.

**Fix pattern**: pivotar a la variante viva más cercana. `CurrentUserDetails` no trae `currentManagedPermissions` pero sí `id` e `isAdmin` — suficiente para gating ligero. `paros-linea.isAuthorized` ya tenía branch graceful (`!Array.isArray(managedPermissions) → permitido`), así que solo fue cambiar `operationName` y devolver `managedPermissions: undefined`.

**Pendiente derivado**: `extension/background.js:212` (handler `get-current-user` del popup de permisos) sigue invocando `CurrentUser`. Cuando el usuario abre la pestaña de permisos del popup, va a fallar igual. Fix futuro: mismo pivot a `CurrentUserDetails` o intento con fallback. No-bloqueante (los applets autoinyectados no dependen de ese handler).

## Reglas de desarrollo
- JavaScript vanilla (sin React, sin frameworks, sin bundlers)
- Documentación y UI en español
- Código y variables en inglés
- Los hashes de persisted queries cambian cuando Steelhead actualiza — usar siempre los de config.json
- Constantes de dominio (IDs, schemas) van en config.json, no hardcodeadas
- Batching de PNs en grupos de 20 para SaveManyPNP

### Trabajo con UI / DOM de Steelhead
**ANTES de empezar a escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — perdimos varias rondas en `invoice-autofill` (0.5.16 → 0.5.25) asumiendo `<label for>` cuando el modal manual usaba `<p>Label:</p>` con el field como SIBLING. Una sola inspección del wrapper hubiera resuelto todo en un commit.

Patrones de label en Steelhead vistos hasta ahora:
- **Forms RJSF (página invoice editada):** `<label class="control-label">` con input/select como sibling cercano. ID típicamente `root_<field>`.
- **Modal "Create Invoice Manually":** `<p class="MuiTypography-body1">Ship Date:</p>` (no `<label>`) seguido por `<div>...input...</div>` SIBLING. Para wrapper-de-un-solo-hijo, sube hasta el labelRoot que sea sibling del field.
- **Comboboxes react-select:** `<input role="combobox" aria-autocomplete="list">` dentro de `<div class="...-control">`. NO usar `value` setter — abrir con click, escribir search, click en option.
- **MUI X DatePicker (masked):** ignora native `value` setter; requiere keystroke-by-keystroke con `beforeinput`/`input` events.
- **react-datepicker (plain `<input type="text">`):** sí responde a native value setter + InputEvent.

### Auto-fill que reacciona a cambios del usuario (modal manual de Invoice)
Lecciones del ciclo `invoice-autofill` 0.5.26 → 0.5.32 cuando el applet llena varios campos async tras una elección del usuario (cliente seleccionado) y el usuario puede cambiar esa elección a media carrera:

- **Cancellation token, no flag binario.** No basta con `filling = true` para evitar runs paralelos. Si el usuario cambia cliente mientras un run está corriendo, hay que **cancelar** el anterior para que devuelva focus a la UI. Patrón: `runId` monotónico, captura local `myRunId`, `isStale = () => state.runId !== myRunId`, `bailIfStale()` entre cada paso async. Las helpers de retry largo (selectFirstOption, selectOptionMatching) deben aceptar `{ isStale }` y abortar dentro del loop — si no, esperan 4×600ms y siguen abriendo dropdowns aunque el run ya esté muerto. Al cancelar: `body.click()` cierra dropdowns abiertos. (`invoice-autofill.js:1255-1287, 1480-1610`)
- **Idempotencia de acciones "create"**. Si un paso del fill agrega filas/líneas/algo nuevo (ej. clickear "New Line"), agrega un guard que detecte si ya existe antes de re-clickear. Sin esto, cada cambio de cliente apila una entrada vacía. Patrón: `clickNewLine` busca `^Line #\d+$` en el DOM antes de clickear el botón. (`invoice-autofill.js:1469-1488`)
- **Reset `filled=false` al cambiar de input upstream.** Si tienes un guard `if (!state.filled) fill();`, recuerda invalidar `filled` cuando cambia la dependencia (cliente). De lo contrario, después de un fill exitoso, cambiar cliente no re-llena.
- **Network drops se ven como "sin opciones tras retries".** Si los retries de un combobox react-select fallan masivamente y los logs muestran `ERR_HTTP2_PING_FAILED` o `[Network error <Query>]: Failed to fetch`, no es bug del applet — es que la query GraphQL del propio Steelhead que pobla las opciones no respondió. No subas retries indefinidamente; mejor reportar `success:false` y dejar que el usuario reintente (la cancelación lo permite).
- **Pausar el fill mientras el usuario interactúa con el upstream input.** El `singleValue` de un react-select solo cambia cuando el usuario *confirma* una opción, así que el listener "cliente cambió → cancela y rellena" se dispara después del select. Pero el usuario puede *re-abrir* el combobox (sin cambiar singleValue todavía) para escribir un cliente diferente — durante ese tiempo el fill sigue corriendo y le roba focus al usuario. Patrón: (1) `isCustomerComboboxActive()` mira `document.activeElement` dentro del wrapper del combo + `aria-expanded="true"`; (2) `focusin` listener global con capture: si el target cae dentro del combo → bumpa `runId` y marca `state.deferred = true`; (3) `isStale` del fillImpl considera `deferred` como stale; (4) `handleManualModal` no relanza fill mientras `isCustomerComboboxActive()` — solo lo hace cuando el observer ve que el usuario salió y `deferred` sigue true. Sin esto, cambiar de cliente a media carrera dispara dropdowns paralelos (Bill To/Ship To/Contact) que pelean por focus con el combobox de Customer. (`invoice-autofill.js:1277-1302, 1252-1318` en 0.5.33)
- **Lectura de un campo específico: label-driven, NO walking-up desde singleValues.** Buscar `singleValue`s en todo el documento y caminar hacia arriba buscando un sibling con cierto texto suena robusto pero falla en layouts donde varios labels (`<p>Customer:</p>`, `<p>Terms:</p>`, ...) son siblings dentro del **mismo** wrapper (el modal manual de Invoice usa `css-iyrxkt` así). Al limpiar Customer su singleValue desaparece y el walker, partiendo del singleValue de Terms, llega al ancestro común y encuentra el `<p>Customer:</p>` de OTRO field como sibling — devuelve el value de Terms (ej. `"10 Días"`) como si fuera el cliente, disparando ciclos espurios de "customer changed → fill". El fix correcto es localizar el wrapper exacto del campo por su label (`findReactSelectControlByLabel`) y consultar el singleValue **solo dentro** de ese container. Sin singleValue ahí → `return null`. Aplica también a forms RJSF y a cualquier otro caso donde lees el "valor actual" de un combobox específico. (`invoice-autofill.js:723-783` en 0.5.34)

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
