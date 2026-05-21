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

**Actualización 2026-05-15, v0.6.24 (`OperatorMaintenanceNodeDialogQuery`, también `paros-linea`):** el mensaje `{"errors":[{"message":"Must provide a query string."}]}` **NO distingue** entre "hash rotado" y "operación deprecada". El server responde idéntico cuando el hash es desconocido, sin importar la causa (rotación silenciosa o retiro). La pista visible en el modal era "Error: HTTP 400 en OperatorMaintenanceNodeDialogQuery: {..." (truncado a 60 chars en `paros-linea.js:653` para pintar en la `<option>` del select MOTIVO). Síntoma colateral útil: `CreateMaintenanceEventDialogQuery` (que pobla el dropdown de Responsable) seguía viva, lo que indica deprecación selectiva de UN hash, no de la familia. El paso decisivo siempre es el re-scan: el scan fresco mostró la misma op con HTTP 200 y hash distinto (`2a2a6230…` → `b8527dc6f2cb864f…`), confirmando caso A (rotación). El shape de respuesta no cambió. Fix: bump del hash en config + bump de version. **Regla actualizada**: cuando veas `"Must provide a query string."`, NO asumas deprecación dura — re-scanea primero. Si la op aparece con hash distinto y 200 → es rotación. Solo si aparece con mismo hash y 400, o desaparece del UI, es deprecación.

**Playbook 60-segundos cuando un applet rompe con HTTP 400 en una persisted query** (derivado de este ciclo y de v0.5.7):
1. DevTools Network en la tab de Steelhead → filtrar `graphql` → reproducir → click en la fila 400 → tabs `Response` (para `errors[0].message`) y `Payload` (para `operationName` + `extensions.persistedQuery.sha256Hash`).
2. Si el message es `"Must provide a query string."` (firma APQ): buscar el último `~/Downloads/scan_results_*.json` y `jq -r '.scanResults["<OpName>"] | {hash, lastHttpStatus, count}'`.
3. **Hash del scan ≠ hash del config y `lastHttpStatus=200`** → rotación. Bump del hash en `remote/config.json`, bump de `version`+`lastUpdated`, sync a `gh-pages` (worktree o cp manual), push ambas, reload extensión.
4. **Hash del scan == hash del config** o **op ausente del scan** → deprecación. Buscar variantes hermanas vivas en el scan o re-scanear navegando el flujo nativo del UI; pivotar a la viva más cercana (v0.5.7: `CurrentUser → CurrentUserDetails`).
5. Validación final en prod: recargar extensión (Chrome puede cachear `config.json` ~5 min) y reproducir el flujo. **Verificado en producción 2026-05-15** por el usuario: dropdown MOTIVO se puebla correctamente al seleccionar el responsable "🧪 Laboratorio y Procesos" tras el bump 0.6.24.

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

### `invoice-autofill`: lecciones 0.5.60 → 0.5.63 (PS-embedded, AR matcher)
Cuando el usuario abre una invoice desde `Domains/<id>/Shipping/PackingSlips/<id>` (en lugar del flujo "Create Invoice Manually"), Steelhead **renderiza el editor de invoice in-place sin cambiar la URL** y con un layout DOM **distinto** al modal manual. Lecciones del ciclo:

- **URL gate: `/Shipping/PackingSlips` también activa el applet.** El gate inicial solo matcheaba `/Domains/<id>/Invoices`, así que el panel no aparecía en el flujo PS aunque el editor estuviera presente. Patrón: `INVOICE_URL_RE = /\/Domains\/\d+\/(?:Invoices|Shipping\/PackingSlips)(?:\/|$)/`. Aplica a otros applets que se inyectan por URL: si el feature tiene varios "modos" de entrada, lista todos los paths que llevan al mismo editor antes de hardcodear uno solo. (`invoice-autofill.js:16` en 0.5.60)
- **Layout de líneas en flujo PS: dos sub-tables, no form-card con `<p>INCOME</p>`.** Cada línea vive en `<div class="css-7a0s5b">` con (1) header table de 3 columnas (`<th>Line #N - PN</th>`, `<th>Description:</th>`, `<th>Total: $X</th>`) y (2) data table de 11 columnas (Include, Product, Línea, Departamento, Description, Quantity, Price, Subtotal, Tax Code, Close SO Line, **Income Account**). El extractor original buscaba un `<p>INCOME</p>` italic adyacente al combobox (que solo existe en el modal manual / form-card). En PS-embedded ese subtítulo no existe; "Income Account" solo aparece como **encabezado de columna**. Patrón robusto: (1) localizar `<th>Line #N - PN</th>`; (2) walk-up al wrapper que contenga otra table cuyo `:scope > thead > tr > th` incluya `^income account$`; (3) tomar el data row del `<tbody>` con `cells.length === columnHeaders.length` (filtra el sub-row con `colspan=11` de Part Numbers/Locations); (4) `incomeCell = dataRow.cells[incomeIdx]`; (5) **anclar `incomeLabel = incomeCell.firstElementChild`** para que `tryFillIncomeInLine` haga `host = incomeLabel.parentElement = <td>` y `host.querySelector('input[role="combobox"]')` quede scopeado SOLO al td de Income — si anclas en el `<td>` directo, `host = <tr>` y captura el primer combobox del row (Product), no el de Income. Mantener layout legacy como fallback (`if (lines.length > 0) return lines;` antes de barrer headings con `<p>INCOME</p>`). (`invoice-autofill.js:918-1015` en 0.5.63)
- **AR matcher con muchas candidatas: tres defensas combinadas.** Cuando el AR account list trae 60+ opciones para un cliente USD (Schneider Electric MX), tres bugs convergen: (1) regex de currency suffix `\b<CUR>\s*$` excluye accounts donde el sufijo es token interno (`"... 1128 USD"` por truncado UI), debe ser `\b<CUR>\b`; (2) `customer.name` puede venir vacío en el shape — caer a `state.customerName` para construir tokens del cliente; (3) si tras filtros sigue habiendo `>3` candidatas, marcar `tooMany: true` y devolver `account: null` con `reason: 'demasiadas_candidatas_<N>'` — mejor decirle al usuario "no supe cuál" que adivinar. El panel renderiza ✗ con tooltip explicativo en ese caso. (`invoice-autofill.js:576-650` en 0.5.60-0.5.62)
- **Auto-collapse del panel cuando todo está OK.** Patrón: tras `renderPanel()`, `setTimeout(() => { if (isAllDone()) collapse(); }, 1800)`. `isAllDone()` chequea AR + cada línea con resultado success-truthy. Si el usuario cambia algo después, el rerun reabre el panel naturalmente.
- **Re-confirmación de la regla del wrapper HTML.** El ciclo 0.5.60→0.5.63 cerró en una iteración después de pedir el HTML del wrapper; antes hubo dos rondas adivinando que perdimos. **No itera deploys para descubrir el layout** — pide el wrapper, escribe el extractor una sola vez. Esta es la misma regla que ya está en "Trabajo con UI / DOM de Steelhead" arriba; el ciclo simplemente la confirma de nuevo.

### Detección de pendientes en `invoice-auto-regen` (lecciones 0.5.35 → 0.5.37)
El applet detecta facturas timbradas cuyo PDF actual es pre-timbre (necesita regenerar para que el PDF traiga sello SAT, QR, Folio Fiscal). Tres bugs encontrados al refactorizar a pull activo (vs el set acumulado en memoria que crecía sin parar):

- **Shape de `ActiveInvoicesPaged` no trae `createdAt` en PDFs.** `inv.invoicePdfsByInvoiceId.nodes` solo expone `nodeId, invoicePdfViewLogsByInvoicePdfId, __typename` — sin `createdAt`. Por eso `maxPdfAt()` siempre devolvía 0 y `needsRegen()` daba true para TODA invoice con `writtenAt`. Solución: dos fases en `pullPendingCount()` — fase 1 con `ActiveInvoicesPaged` para candidatos preliminares (writtenAt en ventana, no voided, no recently regenerated), fase 2 con `InvoiceByIdInDomain` por candidato (concurrencia 5) que sí trae `pdfs[].createdAt` y permite `needsRegen({requireUuid:true})` real. (`invoice-auto-regen.js:642-758` en 0.5.36)
- **Paginación: `offset`/`first`, no `pageNumber`/`pageSize`.** Steelhead usa Relay-style. Si tu código mira `pageNumber in vars` antes que `offset in vars`, todas las páginas posteriores a la 1 son no-op silencioso (siempre devuelve los primeros N). Antes de paginar, snapshot el template real del UI (`window.__autoRegenLastVars[opName]`) y mira sus claves.
- **`writeResult.uuid` no existe en Steelhead.** El UUID del CFDI mexicano (Folio Fiscal) vive en `writeResult.TaxFolio`. El shape también incluye `XmlBase64File`, `CustomInput.linkxml`, `UrlQR`, `SATSeal`, `SATCertificateSerialNumber` — pero NO `.uuid`. Si filtras `requireUuid: !!wr?.uuid`, descartas TODAS las facturas timbradas. Markers válidos de timbre: `wr.TaxFolio || wr.XmlBase64File || wr.CustomInput?.linkxml`. (`invoice-auto-regen.js:243-260` en 0.5.37; `cfdi-attacher.js:88-91` ya usaba `XmlBase64File`/`linkxml` correctamente)
- **Snapshot del template de variables en el interceptor.** Cuando vas a hacer un pull "global" (paginar hasta el final con filtros limpios), interceptá la primera vez que el UI llame esa op y guarda `JSON.parse(JSON.stringify(bodyObj.variables))`. Después clona, sanitiza filtros (search, customer, status), aplica paginación y dispara. Esto evita hardcodear el shape — sobrevive cambios de Steelhead. Patrón en `patchFetch` líneas 152-157.
- **Diagnóstico: dump del shape antes de filtrar.** Cuando un applet "no detecta" algo que el usuario sabe pendiente, NO asumas que el filtro está bien. Pide al usuario un dump (`console.table` con keys de `writeResult`, primeros niveles de `invoice`, etc.) y compara con tu suposición. Las 3 rondas de fix de este ciclo (0.5.36 paginación, 0.5.36 verify phase, 0.5.37 markers de timbre) se hubieran cerrado en 1 si hubiera dumpeado el shape primero.

### Procesos: construcción, ordenamiento y control
Toda la documentación del modelo de procesos en Steelhead vive en **[`docs/processes-architecture.md`](docs/processes-architecture.md)**: tipos de nodos, esquema GraphQL relevante, canon de 9 nodos top-level, construcción del árbol para `ProcureTree` (shape esperado, sub-árboles expandidos, manejo de duplicados, `ensureSharedRels`), discovery por tag, diagnóstico, y glosario de versiones del applet `process-canon`.

Ese doc es la **fuente de verdad** para cualquier trabajo que toque procesos. Antes de tocar `process-canon.js` o cualquier mutación de árbol, leerlo. Lecciones nuevas se agregan ahí, no aquí.

Resumen de lo más crítico (no sustituye al doc):
- `ProcureTree` espera el árbol **completo expandido** hasta hojas reales (no plano). Síntoma de input plano: `In checkTrees, expected node id=X to have 0 children, but found N`.
- Duplicados activos en catálogo: preferir id que el proceso ya tiene (`findByName`) sobre id del catálogo.
- `loadAllNodes` solo carga `PROCESS+SUB_PROCESS+STEP_SHIPPING`. STEPs (como `SP Inspección Recibo`) requieren `searchNodeByName` con tipos ampliados.
- **Captura el request del UI antes de adivinar shapes**. Cinco rondas de fix a ciegas (0.5.52-55) cerraron en una iteración con la captura (0.5.56).

### `sensor-status-autofill`: lecciones 0.5.57 → 0.5.58
Applet que marca "Use for Status" en members de Sensor Dashboards. Maneja auto-asignación (1 candidato), modal asistido (≥2 candidatos), skip (0 candidatos) y opcionalmente itera todos los dashboards del domain.

- **URL pattern es CamelCase, no kebab-case.** El path real es `/Domains/<id>/Maintenance/SensorDashboards/<idInDomain>?type=BOOLEAN`. Asumir el slug `sensor-dashboards` con guión rompe el match aunque el regex tenga flag `i` — el guión simplemente no existe en la URL. Patrón seguro para detectar dashboards: `/\/sensor-?dashboards\/(\d+)(?:[/?#]|$)/i` (guión opcional). Esto aplica también a otras secciones del UI (`/Maintenance/`, etc. son CamelCase): NO asumir kebab-case sin abrir la página y mirar `window.location.href`. (`sensor-status-autofill.js:14-16` en 0.5.58)
- **502 Bad Gateway en mutations individuales es normal en runs en lote.** El backend de Steelhead (a través de Cloudflare) ocasionalmente devuelve 502 en una llamada de `UpdateSensorMember`/`SaveSensorMember` durante un loop rápido; el resto del lote sigue funcionando. El orchestrator debe capturar el error por member y empujarlo a `results.errors` sin abortar el run. Si el ratio de 502 es alto en uso real, considera retry con backoff (1s/2s/4s) en `updateMember` — es el mismo patrón que tiene `invoice-auto-regen`.
- **Modelo de datos relevante:** `SensorDashboard` → `members[]` (cada member apunta a un `Sensor`) → `Sensor.sensorType` → `SensorType.specFields[]` → `SpecField.spec.specs[]` (revisiones) → `specs[i].params[]` (los candidatos a marcar como "Use for Status"). El `activeId` del member apunta a un param ya seleccionado (cuando existe). Candidatos válidos = todos los `params` de las revisiones activas del `SpecField` referenciado por el member.
- **`AllSensorDashboards` toma `{}` y devuelve `nodes[]` directo** — sin paginación, sin filtros. El plan original asumía template-learning + paginación; eso fue over-engineering verificable solo con scan del UI antes de escribir el código.

### `receiver-date-override`: lecciones 0.5.64 → 0.5.68
Applet que inyecta un campo "Fecha real de recibido:" + selector de hora (default 12:00) en el modal **"Receive Parts from Customer" / "Recibir piezas del cliente"**. Permite editar el `receivedAt` del receiver al momento de creación, eliminando el paso manual de ir a "All Receivers" después.

- **Diferenciar Create vs Update mutations en flujos de "Save".** El modal de crear receiver dispara `CreateReceiverChecked` (hash `6147f74211e1f2caf8778a6c23ecc4b6fb7e9b96002c35bc04cc5c1df5437da3`). Las variables (`variables.receiverPayload`) tienen `notes`, `customInputs`, `inputSchemaId`, `receiverBomItems` pero **NO `receivedAt`** — el server siempre lo setea a NOW(). `UpdateReceiver` (hash `005653bae4baad289db47d65857cc4e9fb89fa51e06caa78a1f0946dce7f92ec`) solo viaja al editar desde "All Receivers", con shape top-level `{id, notes, receivedAt, customInputs, inputSchemaId}`. Asumir que `UpdateReceiver` cubre el flujo create costó dos rondas (0.5.64 lo intercepté y nunca disparó, 0.5.65 pivoteé a la arquitectura correcta). Antes de escribir interceptors de "guardar", **verifica en el scan cuál mutation viaja realmente** — busca por `responseFields` con prefijo `create*`/`save*`/`update*` y matchea contra el botón del UI.
- **Patrón intercept-response + follow-up mutation.** Cuando el server no acepta el campo que quieres sobrescribir en la mutación principal: (1) snapshot del payload + intent del usuario ANTES de pasar el request original; (2) `await origFetch.apply(this, args)`; (3) `response.clone()` y parse JSON para extraer el id devuelto; (4) fire-and-log un POST follow-up con la mutation de update; (5) devolver la response original al UI sin tocar. Detalles críticos: heredar `opts.headers` del request original (Apollo client headers + cookies), heredar `opts.credentials || 'include'`, NO awaitear el follow-up para no bloquear el UI, y manejar errors con `console.warn` (si el follow-up falla el receiver queda con NOW pero el flujo principal no se rompe — el usuario puede editar manualmente). Patrón en `receiver-date-override.js:96-180` (0.5.65).
- **Layout DOM del header del modal Receive Parts (descubierto pidiendo el wrapper HTML al usuario).** El header tiene un row container `.css-xd9ivb` que es **flex-row** (NO grid). Adentro: varios `.css-iyrxkt` que SÍ son grid (`grid-template-columns: auto 1fr` para label | field). **Dos modos de inserción según el caso:** (1) **Campo con fila propia full-width** (tabla, bloque pegado al header) → sibling del `.css-xd9ivb` (afuera del flex). Sibling de un `.css-iyrxkt` específico lo metería como tercer item del flex y comprimiría las columnas existentes. (2) **Campo extra dentro de una columna del header** (mejor uso de real estate) → children directos del `.css-iyrxkt` objetivo, como par `<p style="grid-column:1">` + `<div style="grid-column:2">`; el grid `auto 1fr` se extiende vertical (ver lección 0.5.80 en la sección WLP). Tres rondas de fix visual al inicio (0.5.65 `grid-column: 1/-1` no aplicaba porque parent no es grid; 0.5.66 detectado regex bilingüe del label como red herring; 0.5.67 finalmente correcto al pedir el HTML del padre real). Re-confirmación de la regla del wrapper: **antes de iterar selectores, pide el outerHTML del padre del bloque relevante**.
- **Labels bilingües en Steelhead.** El UI cambia entre inglés y español según el usuario o configuración. Regex de matching de labels DEBE ser bilingüe desde el primer commit, no parchado después. Pares vistos hasta ahora: "Receive Parts from Customer" / "Recibir piezas del cliente"; "Receiver Comments" / "Comentarios del receptor"; "Customer:" / "Cliente:"; "Save" / "Guardar"; "Save and Add Parts to WO" / "Guardar y Agregar Piezas a OT"; "Save and Print all" / "Guardar + Imprimir todas las piezas". Patrón regex: `/^(?:english\s+text|texto\s+español):?$/i` (non-capturing group, colon opcional, case-insensitive). 0.5.66 falló por usar solo "Receiver Comments" — el title del modal sí era bilingüe pero el regex del label no.
- **Date conversion: mediodía local → UTC para evitar drift.** Native `<input type="date">` devuelve `"YYYY-MM-DD"` (string local), `<input type="time">` devuelve `"HH:MM"` (24h). Construir UTC con `new Date(y, m-1, d, hh, mm, 0).toISOString()` evita que un `2026-05-04` se muestre como `2026-05-03` en zonas horarias al oeste de UTC. Default 12:00 con time picker opcional: si user no toca el time, queda mediodía local (cae en el mismo día UTC para todas las TZ del continente). Patrón aplicable a cualquier conversión date-only → ISO timestamp.
- **Flag bilingüe del título del modal vs flag bilingüe del label interno.** El regex del título (`HEADING_SELECTOR`) ya era bilingüe desde 0.5.64; el del label interno (`Receiver Comments`) no, y por eso 0.5.66 fue una iteración extra. Cuando crees un applet de modal-injection, audita TODOS los regex de DOM lookup para que sean bilingües desde el principio.
- **`response.clone()` antes de parsear.** Si haces `response.json()` directo, consumes el body y el caller no puede leerlo (Steelhead falla). Siempre clonar antes: `const json = await response.clone().json();`.

### `warehouse-location-prefill`: lecciones 0.5.69 → 0.5.80
Applet hermano de `receiver-date-override` que inyecta un combobox custom "Ubicación inicial:" en el header del modal Receive Parts. Al elegir una ubicación, **intercepta `CreateReceiverChecked` y agrega `locationId` en todos los `receiverBomItems[].inventoryTransferEvent.debitAccounts.accounts[]`** antes de enviar al server. Default del combobox filtra solo ubicaciones con "Aduana" en el path; sentinel "Mostrar todas" da escape al catálogo completo con paginación lazy de a 200.

- **Validar el shape del payload con instrumentación read-only ANTES de mutar (ciclo Task 7 → Task 8 del plan).** El plan original asumía que `locationId` venía null o con default en `accounts[].locationId`, listo para sobrescribir. La instrumentación de Task 7 (window.__saWlpLastPayload + log de keys) reveló que el campo **NO existe en el payload cuando el usuario no toca el combo per-line** — Steelhead lo omite y el server cae al default global. Hay diferencia entre "set" y "add", aunque en JS ambas se escriben igual. Pedir un dump del usuario en producción real para confirmar el shape antes de escribir la mutación cerró el ciclo en una iteración. Lección reforzada del cierre de `process-canon` (0.5.52-56) y `invoice-auto-regen` (0.5.36-37).
- **Sentinel para confirmar shape: dos pruebas, no una.** El primer dump (sin selección de ubicación per-line) mostró `accounts[]` SIN `locationId`. Pero podría haber sido que vivía en otro nivel. La segunda prueba — que el usuario seleccione ubicación específica en el combo nativo per-line de cada renglón — confirmó el path exacto (`debitAccounts.accounts[].locationId` numérico) y descartó alternativas (no era path string, no estaba en `creditAccounts`, no estaba en `createInventoryBatch`). El dump comparativo es lo que da certeza para escribir mutaciones.
- **Disabling visual de combos per-line via overlay CSS, NO `disabled` attribute.** React-select re-renderea agresivamente y pierde el `disabled` en el siguiente render; un overlay sobre `.css-qpe0ht-control` con `pointer-events: none` + opacity sobrevive ciclos de React. El overlay es solo capa de UX — la garantía dura es el interceptor del payload, que sobrescribe `locationId` independientemente de lo que el combo-line haya cargado.
- **Bloqueo REAL de clicks sobre el overlay (0.5.78): `pointer-events: auto` no basta.** El overlay con `pointer-events: auto` capturaba el cursor (visualmente gris, cursor `not-allowed`) pero el click seguía abriendo el dropdown del react-select porque (1) react-select crea su propio stacking context con su input y (2) el overlay no tenía `z-index` explícito. Fix: `z-index: 10` + `cursor: not-allowed` en CSS, y handlers capture-phase en el overlay para `mousedown`, `click`, `focus` que llaman `e.stopPropagation()` + `e.preventDefault()`. La fase capture es importante porque react-select usa eventos burbujeando hacia su control raíz; en capture el overlay los come antes. Patrón aplicable a cualquier UX donde necesitas tapar un widget React-controlado sin desmontarlo.
- **Patrón "intercept-and-mutate" puro** (a diferencia de `receiver-date-override` que requiere follow-up `UpdateReceiver` porque el server siempre setea `receivedAt = NOW()`). Aquí el server SÍ acepta `locationId` en el create, así que la mutación va en el body original, sin follow-up. Más limpio y atómico.
- **Coexistencia con `receiver-date-override`**: cada applet patcha `window.fetch` con su propio guard (`window.__saWlpFetchPatched` / `window.__saRdoFetchPatched`). WLP muta el REQUEST body; RDO clona el RESPONSE para disparar follow-up. Independientes; el orden de carga no importa.
- **Combobox custom (vanilla HTML/CSS), no react-select.** Las lecciones de `invoice-autofill` son claras: react-select pelea contra programmatic value setters y requiere keystroke-by-keystroke con cancellation tokens. Para un combobox que controlamos nosotros desde cero, mucho más simple es construirlo a mano con `<input>` + `<div class="dropdown">` y manejar el state explícito. Costo bajo, cero peleas con React.
- **State channel modal → fetch patch via module-level vars.** El interceptor es singleton global; el modal state vive en WeakMap. Para que el patch sepa qué `locationId` aplicar, hay dos vars module-level (`pendingLocationId`, `pendingLocationOwner`) que `selectLocation`/`clearSelection`/`cleanupModal` actualizan. Detalle crítico de cleanup: `cleanupModal` debe limpiar **incondicionalmente**, no solo si `pendingLocationOwner === modal`. Si `findModalForState` regresa `null` durante `selectLocation` (race raro pero posible), el `pendingLocationOwner` queda `null` y un cleanup guardado nunca se dispara, dejando `pendingLocationId` con un id stale para el siguiente modal.
- **Race en double-click de paginación lazy ("Cargar más").** El handler `mousedown` async no protege contra clicks dobles rápidos: el texto `'Cargando…'` es solo visual. Sin un `state.fullCacheLoading` flag con early-return, dos handlers paralelos disparan `fetchAllLocations(state.fullCacheOffset, 200)` con el MISMO offset y duplican entradas en `fullCache`. Patrón aplicable a cualquier sentinel async de UI: flag in-flight + early-return + `finally` para limpiar.
- **Mutation safety: `opts.body` solo se asigna DESPUÉS de que todos los loops completan, y solo si `totalAccounts > 0`.** Si una excepción rompe a media iteración, el `opts` original queda intacto y el catch path puede pasar `args` originales a `origFetch`. La separación de "calcular mutación" → "commit a opts.body" → "log post-commit" → "return mutated args" hace imposible que un body parcialmente mutado escape al server.
- **Wildcard SQL en `SearchLocationsOnPath` (0.5.79): `searchText: ''` devuelve `[]`.** El backend trata `searchText` como argumento de SQL `LIKE`, así que `LIKE ''` solo matchea path vacío (cero filas). Para "todo el catálogo" hay que pasar `searchText: '%'` y `searchTextLast: '%'` (wildcard que matchea cualquier path no-NULL). Lo mismo ya hacía `fetchAduanaLocations` con `'%Aduana%'` — la lección es que **no hay shortcut "vacío = todos"** en este endpoint. Aplicable a otros queries de Steelhead que usan parámetros de búsqueda parcial.
- **Real estate del modal: ANCLAR DENTRO del `.css-iyrxkt`, no como sibling del `.css-xd9ivb` (0.5.80).** Versiones tempranas de RDO/WLP insertaban su wrapper como sibling del row container `.css-xd9ivb` (flex-row del header), lo que les daba una fila full-width pero solo usaban la columna izquierda — desperdiciando el espacio bajo Comentarios y Entradas Personalizadas. Fix: cada applet añade su par `<p class="css-9l3uo3" style="grid-column:1">label</p>` + `<div style="grid-column:2">controls</div>` directo como children del `.css-iyrxkt` del campo objetivo (RDO bajo Cliente, WLP bajo Comentarios). El grid `auto 1fr` del padre se extiende vertical y los nuevos elementos ocupan rows extra automáticamente. **Refina la nota de 0.5.65-67**: "sibling del row container" sigue siendo correcto cuando el campo necesita su propia fila independiente (full-width, ej. tabla pegada al header); para "campo extra dentro de una columna existente" anchor al `.css-iyrxkt` del campo. Mantén las clases CSS del label idénticas a las nativas (`css-9l3uo3`) para visual consistency.

### `weight-quick-entry`: lección 0.5.81 (auto-hide propio por miscount de inputs)
Applet que inyecta cuadro "Peso rápido" (KG o LB según custom input `unidadmedidapeso` del cliente) en cada fila de la tabla de Cantidad del modal Receive Parts.

- **Helper que cuenta inputs en una celda DEBE excluir los inputs propios (`.sa-wqe-container`) o se auto-oculta.** `getUnitValue(section)` mira `cell.querySelectorAll('input')` con la heurística "si hay >1 input, el primero es un selector de unidad nativo de Steelhead (`Count`/`Peso`); si solo hay 1, es nada más Cantidad". Pero al inyectar el cuadro de Peso Rápido se agrega NUESTRO propio `<input>` a la misma celda, así que `inputs.length` pasa de 1 a 2. `watchUnitChanges` (MutationObserver sobre la celda) entonces lee `inputs[0].value = "1"` (valor de Cantidad), determina `"1" !== 'Count'/'Conteo'` y oculta el cuadro con `display: none`. Síntoma: el cuadro aparece, después de cambiar de cliente o algún re-render se oculta solo. La fila siguiente que agregue el usuario aparece bien porque su MutationObserver no se ha disparado aún. Fix: `const inputs = [...cell.querySelectorAll('input')].filter(inp => !inp.closest('.sa-wqe-container'));`. Aplicable a cualquier helper que cuente nodos en un contenedor donde el propio applet también inyecta: filtra por su clase distintiva ANTES de la heurística de cuenta.
- **Diagnóstico clave: `outerHTML` de las celdas en estado bug.** El log decía "Campos actualizados a LB (1 existentes)" (todo aparentemente OK), pero la UI mostraba la primera fila sin cuadro. Un snippet en consola que dumpeó `outerHTML` de cada `<td>` de Cantidad reveló `style="display: none"` inline en el `.sa-wqe-container` de la primera fila vs la segunda sin ese style. Una sola inspección de DOM cerró el diagnóstico — sin ella, hubiéramos perseguido hipótesis falsas (timing, re-render de Steelhead, custom input mal nombrado, etc.). **Cuando un applet "no aparece" pero los logs dicen que se inyectó, busca primero por `display:none` / `visibility:hidden` / `opacity:0` inline en el contenedor antes de revisar la lógica de inyección.**

### `process-canon`: lecciones 0.5.52 → 0.5.56 (movidas a `docs/processes-architecture.md`)
La construcción de árboles de procesos para `ProcureTree` y todas las lecciones del ciclo de fix tienen su propia doc. No duplicar aquí.

### `process-deep-audit` 0.7.0: bitácora del MVP (2026-05-15, deploy a producción `b74d116`)
Applet hermano de `process-canon`, **read-only**, que evalúa 4 reglas (R1-R4) sobre todos los procesos `PROCESS` del dominio y genera plantilla XLSX con columnas editables (`*_NUEVO`) para futura Fase 2 de carga masiva. Lecciones clave del ciclo MVP:

- **Refactor a módulo compartido `process-shared.js`.** El primer instinto fue extender `process-canon.js` con la auditoría; mala idea porque la lógica de mutación de árboles vive ahí y mezclarla con auditoría read-only viola separación de responsabilidades. Patrón aplicado: tercer script `process-shared.js` con catálogo + queries + helpers de identificación (LINE_MAPPING, GLOBALS, TAG_PATTERNS, NAME_FILTERS, AUX_SUFFIXES, EPOXY_SUFFIXES, PREP_CODES, listoPPName, isSatelliteCode, getLineCode, detectLineSections, extractFinishSuffixes, loadAllNodes, loadScannerNodes, loadSharedByLine, getProcessTree, getProcessDetail, getTreatmentDetail, getTreatmentTimes, getProcessNodeParents, intervalToMinutes, finishProductMap, satelliteOverrides, auditConcurrency). Tanto `process-canon` como `process-deep-audit` lo consumen vía `const PS = window.ProcessShared`. **Orden de carga importa**: en `config.apps.process-canon.scripts` debe ir `api → shared → canon → deep-audit`; en `background.js` el guard `if (!window.ProcessShared) return shim` evita crash si se carga fuera de orden.
- **Refactor surgical, no big-bang.** Al delgazar `process-canon.js` para que use PS, el primer intento `Edit` borró el bloque viejo de constantes pero dejó **160 líneas duplicadas de LINE_MAPPING** + EPOXY/AUX/PREP_CODES sin sustituir, creando errores `Identifier '...' has already been declared`. Lección: cuando borres un bloque grande con `Edit`, **verifica que `old_string` cubra el closer del bloque** (`};`/`}`), no solo el primer item interno. Si dudas, `sed -i '<line_start>,<line_end>d'` con line numbers reales es más confiable que un `Edit` de 200 líneas. Cierre: `sed` para borrar líneas 62-222 y 118-135, luego `node -c` para validar sintaxis antes de continuar.
- **Aliasar vs delegar.** Para constantes (`const LINE_MAPPING = PS.LINE_MAPPING`) basta con aliasar. Para funciones con state local (`loadAllNodes` mutaba `_nodesByName`, `_sharedIds`, etc.), aliasar a `PS.loadAllNodes` requería tirar todo el state y cambiar lookups. Decisión pragmática del MVP: dejar los loaders y lookups locales de `process-canon` intactos (cargarían el catálogo dos veces, pero sin bugs); centralizar **constantes** (que son el grueso del LOC) y dejar que `process-deep-audit` use PS desde cero. La duplicación funcional es deuda técnica reconocida, no bug.
- **XLSX library injection.** `process-deep-audit` usa SheetJS para construir las 6 hojas. El patrón estándar (`scripts/lib/xlsx.full.min.js`) requiere inyección **antes** de los scripts del app porque process-deep-audit toca `window.XLSX` al construir el blob. En `background.js` el case `run-process-deep-audit` hace `fetchScriptCode → executeScript(if !window.XLSX) → injectAppScripts(process-canon)` en ese orden. Reusable: cualquier applet futuro que produzca XLSX debe seguir este patrón en lugar de tratar de `import()` dinámicamente (no funciona en MAIN world con MV3).
- **Captura del JSON del scan ANTES de escribir queries.** Antes del MVP se sacó `scan_results_2026-05-15_182824.json` con el flujo "Edit Times" del UI nativo. Confirmó 6 hashes nuevos (`GetTreatment`, `AllTreatments`, `CreateEditTreatmentTimesDialogQuery`, `StationsByTreatmentId`, `GetProcessNodeParents`, `CreateEditProcessDialogQuery`) y los shapes de respuesta (`Treatment → StationTreatment(stationId, treatmentTime:null) → TreatmentTime(cycleTime, totalTime, timeType)`). Sin el scan previo habríamos adivinado los hashes y el shape (riesgo de gaps como los de `invoice-auto-regen` 0.5.36-37). Verificación rápida: `jq '.scanResults.GetTreatment | {hash, responseSamples: (.responseSamples|length), httpStatus: .lastHttpStatus}'`.
- **Catálogo híbrido de satélites.** R3 requiere identificar todos los satélites (T100, T200, T300, T400, T500 y nodos con sufijos `FIB`/`ANT`/`HOR`/`LIM`/`VIB` etc.). Estrategia: (1) regex `SATELLITE_REGEX = /^[TM]\d+00\s/i` sobre nombres + (2) sufijos auxiliares + (3) override en config (`steelhead.domain.processAudit.satelliteOverrides.include/exclude`). El override permite afinar sin redeploy de scripts (solo bump de `version` y push de `config.json`). Generalizable: **cualquier catálogo derivado de regex que se preste a falsos positivos/negativos debe tener un canal de override por config para no requerir code change**.
- **`finishProductMap` extensible en config.** R4-c valida coherencia entre sufijos del nombre del proceso (`(EST)`, `(NIQ)`, `(CRO)`, etc.) y tokens del nombre del producto (`ESTAÑADO`, `NIQUELADO`, `CROMADO`, etc.). El mapeo vive en `config.steelhead.domain.processAudit.finishProductMap` para que QA/Producción pueda extender sin tocar código. Tokens case-insensitive y strippeo de acentos (`ESTAÑADO` ≡ `estanado`). 9 sufijos arrancando: EST, NIQ, CRO, PLA, COB, ANT, FIB, HOR, ZIN.
- **Pool concurrente + cancellation token.** El audit toca ~300+ procesos. Pool de 5 (`steelhead.domain.processAudit.concurrency`) con semáforo + cancellation token (`runId` monotónico + `isStale()`/`bailIfStale()`), mismo patrón de `invoice-autofill` 0.5.32. Importante: **TODAS las funciones async** del orchestrator (incluyendo helpers de retry como `withRetry`) deben aceptar `myRunId` o tener acceso a `isStale()`, sino el botón "Detener" no responde hasta que termine el lote actual. `retryDelaysMs: [0, 1000, 2000]` por proceso; tras 3 fallos → fila con `EstadoGlobal: ERROR` (no abortar la corrida).
- **Output XLSX con columnas `*_NUEVO` editables.** Las hojas R2/R3/R4 incluyen columnas vacías (`CycleTime_min_NUEVO`, `TotalTime_min_NUEVO`, `TimeType_NUEVO`, `LeadTime_horas_NUEVO`, `ProductName_NUEVO`) que el operador rellena en Excel. Fase 2 (no incluida en este MVP) será un applet hermano que **lee** el XLSX editado y hace las mutaciones de carga masiva. Diseño separado a propósito: read-only es seguro de probar en producción; write-back requiere su propio ciclo de validación.
- **Plan de prueba post-deploy.** Validar 5 procesos curados: 1 esperado OK en todas las reglas, 1 con R1 conocido (Listo no-Scanner), 1 con R2-c (Listo sin tiempos), 1 satélite válido (HOR o FIB con tiempos), 1 sin lead time o sin producto. La cancelación a mitad de corrida debe dejar sin requests colgados, y un 502 individual debe ir a `EstadoGlobal: ERROR` sin abortar.

**Files tocados (deploy `b74d116`):**
- NUEVO `remote/scripts/process-shared.js` (~865 líneas)
- NUEVO `remote/scripts/process-deep-audit.js` (~860 líneas)
- MODIFICADO `remote/scripts/process-canon.js` (–218 líneas, –10%; constantes centralizadas en PS)
- MODIFICADO `remote/config.json` (6 hashes + satelliteOverrides + finishProductMap + concurrency + action `run-process-deep-audit`; bump 0.6.24 → 0.7.0)
- MODIFICADO `extension/background.js` (globals `ProcessShared`/`ProcessDeepAudit` + case `run-process-deep-audit` con XLSX injection)
- MODIFICADO `docs/processes-architecture.md` (nueva sección 10: "Treatments, stations y tiempos")

**Pendientes derivados (no bloqueantes para MVP):**
- Refactorizar loaders/lookups de `process-canon` para usar `PS.getCatalog()` y eliminar la doble carga del catálogo (deuda técnica conocida; el applet funciona correcto pero hace 2× requests).
- Fase 2: applet hermano que lee el XLSX editado y hace mutaciones bulk de `TreatmentTime` y `UpdateProcessNode` (lead time/producto).
- Pinear hashes SHA-256 de los nuevos scripts en `config.json` (item 1 del audit pre-producción).

#### Hotfix 0.7.1 (2026-05-15, deploy `7cf027e`): STEP_SHIPPING_READY válido en R1
Primera ronda de prod test reveló que R1 reportaba como inválidos los nodos "Listo" del flujo de embarques (tipo `STEP_SHIPPING_READY`). **Ese tipo es válido por diseño** — es el especial para sub-procesos de embarque, no debe reportarse como problema. Fix: agregar `STEP_SHIPPING_READY` al `validTypes` Set de `evaluateR1` junto con `SCANNER_NODE` y `STAGING`. Label `TipoEsperado` actualizado a `"SCANNER_NODE / STAGING / STEP_SHIPPING_READY"`. Diff de 3 líneas funcionales + comentario explicativo en la función.

**Lección generalizable:** las whitelists de tipos válidos por dominio (no solo R1 — aplica a cualquier validador) deben construirse desde la observación del catálogo real, no desde la suposición del diseño. Cuando un validador empieza a reportar falsos positivos en su primera corrida, **el fix es ampliar la whitelist** si el tipo flagged es legítimo, no relajar el matcher. Documentar el "por qué válido" inline en el código (no solo en commit) para que el siguiente que lea evaluateR1 entienda el dominio sin tener que ir al historial git.

**Files tocados:**
- `remote/scripts/process-deep-audit.js` — `validTypes` Set + label `TipoEsperado` + comentario inline + VERSION
- `remote/config.json` — bump 0.7.0 → 0.7.1
- `docs/processes-architecture.md` — sección 10.1 R1 actualizada con nota de validez de STEP_SHIPPING_READY

**Estado de deploy:**
- `main`: commits `8cc4b0f` (bitácora 0.7.0) y `a10efca` (fix 0.7.1) **pendientes de push** (auto-mode bloquea push a default branch sin autorización explícita). El usuario debe correr `git push origin main` manualmente para sincronizar.
- `gh-pages`: deployed como `7cf027e` y pushed a remote.

### `process-deep-audit` 0.8.0: deploy de Detección de Duplicados (2026-05-18, pushed `7991a7c`/`faecdd3`, validación en prod PENDIENTE)
Implementación completa del plan `docs/superpowers/plans/2026-05-18-process-duplicates.md` (T1-T12 + T14). Agrega 3 firmas de duplicado (D1: nombre normalizado, D2: tren de IDs top-level, D3: tren de nombres top-level) sobre universo unificado (PROCESS principales + satélites + RT + SUB_PROCESS + STEP_SHIPPING). Read-only: 10 hojas XLSX (Leyenda + Resumen + R1-R4 + D1/D2/D3 + Catálogos) con `AccionSugerida_NUEVO` editable para Fase 2 futura. Ejecutado vía subagent-driven-development; T6-T10 pasaron spec+quality review en primera iteración (sin rework).

**Patrón clave: cache compartida entre fases.** `state.treesById: Map<id, {treeRoot, processNodeById}>` se llena durante R1-R4 (en `auditProcess` y `evaluateR3`) y `evaluateD` la consume primero. Solo fetchea `getProcessTree` para los faltantes (típicamente SUB_PROCESS/STEP_SHIPPING/RT que R1-R4 no tocan). Pool separado `processAudit.concurrency.trees` (5) para árboles faltantes y `processAudit.concurrency.parents` (5) para `getProcessNodeParents`. Cancelación parcial soportada: si se aborta a mitad del fetch, D1 emite completo (no depende del árbol), D2/D3 con los árboles disponibles, `state.duplicates.partial=true` → panel marca `[PARCIAL]`, Resumen pone `NotaParcial = "PARCIAL_POR_CANCELACION"`.

**Canónico por id+parents.** `pickCanonical(members, parentsByIdCache)` ordena: (1) más referencias entrantes gana (`getProcessNodeParents` count); (2) empate → id más bajo gana. `AccionSugerida` automática: canónico → `MANTENER`; no-canónico con `refs=0` → `ARCHIVAR`; no-canónico con `refs>0` → `FUSIONAR` (re-apuntar referencias antes de archivar); refs desconocido (502/cancelación) → vacío. `parentsByIdCache` se llena solo para miembros de grupos con `size ≥ 2` (evita gasto en singletons).

**Output XLSX expandido.** `addSheet(name, title, rows, headers)` añade fila de título en A1 con merge (`ws['!merges']`) cubriendo todas las columnas. Headers compartidos en D1/D2/D3 (15 cols incluyendo `EsCanonico`, `RefsEntrantes`, `AccionSugerida_NUEVO`, `Notas`, `EstadoGlobal`, `NotaParcial`). Resumen ahora indexa duplicados por ProcessID con helper `bump`, suma `Duplicados_D1/D2/D3` y agrega bloque de filas extra para nodos que solo aparecen en grupos D (SUB_PROCESS/STEP_SHIPPING/RT que no son universo R1-R4).

**Filtros vía config.** `steelhead.domain.processAudit.duplicates`:
- `enabled: false` salta toda la fase D
- `includeSources: [...]` limita buckets del universo
- `ignoreIds: [int]` excluye IDs específicos
- `ignoreNamePatterns: ["regex"]` excluye por nombre (case-insensitive)

**Lección reforzada: cache cross-fase requiere disciplina de identidad.** El primer instinto fue que `evaluateD` re-fetchara todos los árboles. Mala idea: ya R3 los tiene en memoria como árbol completo expandido. La clave es definir el shape del cache (`{treeRoot, processNodeById}`) en `process-shared.js` y que **TODOS los consumidores** (R3 y `auditProcess` en la fase R1-R4 + `evaluateD` en la fase D) usen exactamente el mismo. Sin esto, terminas con dos caches paralelos por accidente. La cache vive en `state` (no module-level) para que la cancelación de la corrida la libere automáticamente.

**Files tocados (deploy pushed 2026-05-18):**
- MODIFICADO `remote/scripts/process-shared.js` — firmas D1/D2/D3, accessor `duplicatesConfig`, helpers `buildAuditUniverse`, `normName`, `extractTopLevel`
- MODIFICADO `remote/scripts/process-deep-audit.js` — `state.treesById`, `evaluateD`, `pickCanonical`, panel UI con 7 tabs (R1-R4 + D1/D2/D3), `RULE_LABELS`, `addSheet`, `buildLeyendaRows`, Resumen con `Duplicados_D1/D2/D3` + `NotaParcial`, `VERSION = '0.8.0'`
- MODIFICADO `remote/config.json` — bump 0.7.1 → 0.8.0, `lastUpdated: 2026-05-18`, bloque `processAudit.duplicates` (enabled/includeSources/ignoreIds/ignoreNamePatterns), `processAudit.concurrency.trees=5` y `parents=5`
- MODIFICADO `docs/processes-architecture.md` — nueva fila al glosario §9 (0.8.0 deep-audit) + nueva sección 12 "Detección de duplicados (process-deep-audit ≥ v0.8.0)" con 6 subsecciones (12.1 Firmas, 12.2 Canónico con code block de `pickCanonical`, 12.3 Universo y filtros, 12.4 Cache `state.treesById`, 12.5 Cancelación parcial, 12.6 Pendientes)
- MODIFICADO `extension/background.js` — sin cambios funcionales (XLSX injection y orden de scripts ya existía de 0.7.0)

**Estado de deploy (2026-05-18):**
- `main`: `7991a7c` (T14 doc) + `9f5a830` (config bump) + commits T1-T10 — **pushed a remote**.
- `gh-pages`: `faecdd3` (deploy 0.8.0 byte-exact con `remote/`) — **pushed a remote**.

**T13 (validación en prod) PENDIENTE.** El usuario tiene que reanudar en otra sesión: recargar la extensión en Chrome (chrome://extensions → reload) tras esperar ~30-60s del refresh de GitHub Pages, luego correr el applet en producción y validar contra 5 procesos curados:
1. Un proceso esperado OK en todas las reglas (R1-R4 sin hallazgos, no aparece en D1/D2/D3).
2. `SP Embarque en Almacén` — el caso conocido de 7 IDs activos duplicados; debe aparecer en D1 con `Duplicados_D1=7` y un canónico marcado.
3. Un proceso que aparezca en D3 (clones por "Save As..." con mismo tren de nombres top-level pero IDs distintos).
4. Un satélite (HOR/FIB/etc.) válido — debe aparecer en R3 con tiempos OK y, si tiene clones, también en D1/D2/D3 según corresponda.
5. Una corrida cancelada a media fase D — verificar que el panel marca `[PARCIAL]`, Resumen muestra `NotaParcial = "PARCIAL_POR_CANCELACION"` y D1 emite completo aunque D2/D3 estén truncados.

Cosas a chequear durante la validación:
- Que `Duplicados_D1/D2/D3` en Resumen cuadren con las filas de las hojas D.
- Que `EsCanonico=true` en cada grupo apunte al ID con más referencias entrantes (o id más bajo en empate).
- Que `AccionSugerida_NUEVO` venga pre-llenada (MANTENER/ARCHIVAR/FUSIONAR) y editable.
- Que la hoja Leyenda explique R1-R4 + D1-D3 con sigla → descripción → subcaso → estado posible → acción típica.
- Que el título mergeado (A1) muestre nombre del dominio + fecha de la corrida.
- 502 individual en `getProcessTree` o `getProcessNodeParents` debe ir a `EstadoGlobal: ERROR` sin abortar la corrida.

Si la corrida revela algún gap (regex mal calibrado, falso positivo, output XLSX mal formado), abrir nueva sesión con el `scan_results_*.json` de la corrida + screenshot del panel y el XLSX descargado para diagnóstico.

**Pendientes derivados (no bloqueantes):**
- **Fase 2 — applet hermano de write-back.** Leer XLSX editado con `AccionSugerida_NUEVO ∈ {ARCHIVAR, FUSIONAR, MANTENER}` y aplicar mutaciones. Para `FUSIONAR` requiere re-apuntar referencias entrantes al canon antes de archivar (mutation `ArchiveProcessNode` o equivalente — **no investigado aún, requiere capturar el flujo nativo del UI primero**).
- **D4 full-depth.** Si D3 top-level resulta insuficiente en la práctica, recursar firmas. Requiere `flattenTree` enriquecido y costo recursivo controlado.
- **Detección incremental.** Persistir resultado en `chrome.storage.local` para reportar "nuevos grupos vs corrida anterior".
- **Refactor doble-carga del catálogo en `process-canon`.** Ítem ya documentado en bitácora 0.7.0; sigue pendiente.

### `spec-params-bulk` 0.9.0: MVP de carga masiva de SpecParam (2026-05-18, pushed `de9ce8d`/`9630dab`, validación en prod PENDIENTE)
Applet nuevo con dos actions independientes que comparten el mismo bundle:
- **`download-spec-params`** — panel selector (filtros Tipo Internal/External, "Excluir MP", buscador), pool 5 `GetSpec` + pool 10 `GetSpecFieldParamToEdit` para shape completo, genera XLSX con hoja **Params** (1 fila por SpecParam, columnas `*_NUEVO` editables paralelas) + hoja **Leyenda** con reglas de uso.
- **`upload-spec-params`** — file-picker, re-fetchea shape actual de cada `ParamID` para reconstruir el `paramToInputShape` (no se confía en lo que viene del XLSX salvo el id), emite diff preview con 3 tabs (Cambios / Sin cambio / Omitidas), batches de 50 secuenciales con retry exponencial `[1000, 2000, 4000]ms`, bitácora XLSX descargable al final (hojas Aplicadas / Errores / Omitidas).

**Decisiones de diseño cerradas con el usuario antes de implementar:**
- Campos editables: TODOS (15 columnas `_NUEVO`: name, descriptionMarkdown, min/max/target, sampleCount, samplingIntervalMin, sensorValidDurationMin, sensorWarningThresholdMin, 7 flags inputRequired/inputRequested/mustBePassing/failingRequiresResolution/requestDocument/oneAtATime/drivesCoupons).
- Filtro MP: doble señal — label exacto `"MP"` OR `name` que arranca con `/^IMP/i` (Inspección de Materia Prima).
- Revisión: solo la activa más reciente por spec (no soporta multi-revisión en MVP).
- Filas nuevas en upload: NO se crean params; filas con `ParamID` vacío o inexistente van a Omitidas.
- Layout XLSX: una sola hoja `Params` con título mergeado A1 + headers en row 2 + autofilter + 41 columnas. La hoja `Leyenda` documenta cada columna y la lista de Reglas (NO agregar filas, `_NUEVO` vacío = conservar, booleans TRUE/FALSE).

**Lecciones clave del ciclo (primera ronda, sin rework — la captura previa pagó):**
- **Captura del scan ANTES de adivinar shapes.** El `scan_results_2026-05-18_140842.json` se sacó con el flujo "Edit Times" del UI nativo y traía `AllSpecs`, `GetSpec`, `GetSpecFieldParamToEdit`, `SaveMultipleSpecFieldParams` con hashes 200-OK y `responseSamples` reales. Sin el scan habríamos adivinado: el `GetSpec` del config estaba **desactualizado** (`88dad363…` → ahora `ab70f1e8…`), y `SaveMultipleSpecFieldParams` no estaba registrado. La inspección con `jq '.scanResults.GetSpec.lastHttpStatus'` y comparar contra config confirma rotación silenciosa de hash (mismo síntoma del playbook "rotación vs deprecación").
- **Dos queries por param en download (no una).** `GetSpec` regresa el árbol `specFieldSpecsBySpecId.nodes[].defaultValues.nodes[]` con la mayoría de campos, **PERO NO** trae `failingRequiresResolution`, `isDefault`, `derivedFromId`, ni `specFieldParamDropdownId`. Esos viven solo en `GetSpecFieldParamToEdit(specFieldParamId, specFieldId)`. Decisión: enriquecer con un segundo pool concurrente de 10 por paramId. Costo: ~250 calls para 50 specs con 5 params cada una, ~30-60s — aceptable porque la descarga es operación poco frecuente. Patrón aplicable a otros applets donde una query "lista" trae shape parcial y otra query "edit" trae el shape completo: hacer fase 1 lista + fase 2 enriquecer, no hardcodear la query "edit" como única (mata performance).
- **No confiar en columnas `_NUEVO` para reconstruir el shape de la mutation.** En upload, el path correcto es: leer SOLO `ParamID` y `FieldID` del XLSX (ambos read-only, lookups), llamar `GetSpecFieldParamToEdit` para obtener el shape actual fresh del server, y solo entonces aplicar los `_NUEVO` como overrides. Si el operador editó por accidente `SpecFieldSpecID` o `DerivedFromID`, no rompemos nada. Patrón generalizable: para mutaciones de update sobre rows editados externamente, la fuente de verdad del estado actual es **siempre** el server, no el archivo subido.
- **`extractIdFromNodeId(nodeId)` como fallback robusto.** El `nodeId` de Steelhead es base64 de `["spec_field_specs", 173321]`. Decodificarlo con `atob` + `JSON.parse` y tomar `arr[1]` es más confiable que castear `Number(xlsxRow.SpecFieldSpecID)` (que puede haber sido editado por accidente). Aplicable a cualquier sitio donde Steelhead te dé un `nodeId` y necesites el id numérico — siempre prefiere decodificar el nodeId sobre confiar en otra columna.
- **Cancellation token + pool con semáforo + retry exponencial: mismo patrón de `process-deep-audit`.** `state.runId` monotónico, `isStale(myRunId)` / `bailIfStale(myRunId)`, `runPool(items, worker, concurrency, onProgress, myRunId)` con semáforo manual, `withRetry(fn, label, myRunId)` que respeta cancelación entre intentos. El "Cancelar" del panel hace `nextRunId()` que invalida todos los `myRunId` capturados localmente. Hasta los helpers de retry deben aceptar `myRunId`, o el botón Detener no responde hasta que termine el lote actual.
- **`SpecShared` como módulo compartido desde el primer día.** No esperar hasta que un segundo applet quiera reusar — meter constantes + queries + helpers en `spec-shared.js` desde el principio facilita Fase 2 (write-back desde XLSX editado a mano) o un applet hermano que solo lea. Sigue el patrón de `process-shared.js`.

**Hashes registrados en `remote/config.json` (deploy 0.9.0):**
| Operación | Hash | Tipo |
|---|---|---|
| `AllSpecs` | `0710bf2eb9fa02f1fff3899be3629d1169d0af92564ec9aadb0a25ddd5ab19cb` | query (ya estaba) |
| `GetSpec` | `ab70f1e818961973705ce720e3f22e8eefc7c204e0f14543de8d5825a41155c3` | query (REEMPLAZADO desde `88dad363…`) |
| `GetSpecFieldParamToEdit` | `f4aedfe3fbe7ef82ae55c7bd37b76637d18c9ce6fbfe257ef9618fd8b85aa75b` | query (ya estaba) |
| `SaveMultipleSpecFieldParams` | `bffd36ff1ea5e3e5b7ff91b23ebf33c5c7879ee54c35d86ad90e86eab3214b7b` | mutation (NUEVO) |

**Shape de input de `SaveMultipleSpecFieldParams`** (uno por param dentro del array `input.specFieldParams[]`):
```js
{
  id, isDefault, specFieldSpecId, derivedFromId, descriptionMarkdown,
  inputRequired, inputRequested, mustBePassing, failingRequiresResolution,
  requestDocument, minimumValue, maximumValue, targetValue, samplingRate,
  sampleCount, sampleSetId, samplingIntervalMinutes, specFieldParamDropdownId,
  oneAtATime, name, unitId, sensorValidDurationMinutes,
  sensorWarningThresholdMinutes, processNodes: [], defaults: [], optInOuts: [],
  updateDerivedFroms: true, operation: null, drivesCoupons, classificationIds: []
}
```
Atención: `processNodes`, `defaults`, `optInOuts`, `classificationIds` se mandan SIEMPRE vacíos en MVP (no editables). Si en Fase 2 se quiere editar `processNodeSpecFieldParams` o `optInOuts`, hay que construir el shape correcto desde sub-hojas del XLSX.

**Files tocados (deploy `de9ce8d` main / `9630dab` gh-pages):**
- NUEVO `remote/scripts/spec-shared.js` (~314 LOC) — catálogo lazy + helpers compartidos.
- NUEVO `remote/scripts/spec-params-bulk.js` (~1027 LOC) — applet download/upload.
- MODIFICADO `remote/config.json` — bump 0.8.0 → 0.9.0; `GetSpec` hash; `SaveMultipleSpecFieldParams` mutation; app `spec-params-bulk` con 2 actions; sección `domain.specParamsBulk` (concurrency.fetchDetails=5, concurrency.editShape=10, batchSize=50, retryDelaysMs=[1000,2000,4000], page.first=400, labelMP="MP", impPrefixRegex="^IMP").
- MODIFICADO `extension/background.js` — globals `SpecShared`/`SpecParamsBulk` + cases unificados `download-spec-params`/`upload-spec-params` con XLSX injection.

**Estado de deploy:**
- `main`: `de9ce8d` — **pushed** a remote.
- `gh-pages`: `9630dab` — **pushed** a remote.

**Plan de validación PENDIENTE (a ejecutar tras reload de extensión, ~30-60s después del push):**

*Descarga:*
1. Abrir applet → action **Descargar XLSX**.
2. Filtros `Externas` + `Excluir MP=off` + búsqueda vacía → verificar que el contador del botón ≈ totalCount esperado.
3. Filtros `Internas` + `Excluir MP=✓` → specs con nombre `IMP…` o label `MP` deben desaparecer.
4. Búsqueda `T104` → filtrado client-side correcto.
5. Seleccionar 2-3 specs conocidas + descargar → XLSX abre en Excel, 2 hojas (Params + Leyenda), autofilter en row 2, columnas `_NUEVO` vacías, título mergeado A1.

*Carga (caso del scan):*
6. En el XLSX descargado, ubicar `ParamID = 19938651` ("20 - 62 g/L" del field "T104-TI00-001 Concentración de Alcalinidad", spec T104-LI #341).
7. Llenar `SensorValidDurationMin_NUEVO = 5760` y `SensorWarningThresholdMin_NUEVO = 5700`.
8. Guardar y subir → action **Cargar XLSX editado**.
9. Verificar preview: 1 cambio, 0 sin cambio, 0 omitidas; el diff debe mostrar `sensorValidDurationMinutes: 4320 → 5760` y `sensorWarningThresholdMinutes: 4260 → 5700`.
10. Confirmar → bitácora descargable + cross-check en UI nativo (abrir el param, confirmar valores nuevos).

*Edge cases:*
11. Fila con `ParamID = ""` → Omitidas, motivo `"ParamID vacío"`.
12. Fila con `ParamID = 99999999` (inexistente) → Omitidas, motivo `"paramId desconocido"` (o el error que devuelva el server).
13. Todos los `_NUEVO` vacíos → `sinCambio = N`, `cambios = 0`, botón Confirmar deshabilitado.
14. Cancelar a media descarga (con 30+ specs seleccionadas) → pool aborta sin XLSX descargado, panel cierra.
15. Simular 502 (interrumpir red durante un batch) → retry 1s/2s/4s; tras 3 fallos, batch va a `errors[]` sin abortar la corrida.
16. Cancelar a media carga multi-batch → batches previos quedan aplicados, bitácora marca PARCIAL.

Si la validación revela algún gap (regex mal calibrado, shape distinto en alguna spec con campos opcionales raros, output XLSX mal formado, comportamiento del UI nativo distinto), abrir sesión nueva con el screenshot del panel + el XLSX descargado + (si aplica) un `scan_results_*.json` fresh.

**Pendientes derivados (no bloqueantes para MVP):**
- **Fase 2 — soporte de campos relacionales.** Editar `unitId`, `sampleSetId`, `classificationIds`, `processNodes`, `optInOuts`, `specFieldParamDropdownId`. Requiere hojas extra "Units", "SampleSets", "Classifications", etc. con catálogos auxiliares y validación de FKs en upload. No-bloqueante: MVP edita los 15 campos atómicos que cubren 95% del uso real (vigencia, rangos, flags).
- **Fase 2 — creación de SpecParams nuevos** (no solo edición). Requiere validar `specFieldSpecId`, `derivedFromId`, `isDefault`, y manejo de `updateDerivedFroms: true` cuando se crea un derivado.
- **Multi-revisión.** Descargar todas las revisiones (no solo la activa). El usuario explícitamente eligió MVP solo activa.
- **Refactor de `spec-migrator`** para que use `SpecShared.loadSpecCatalog()` y elimine la lógica duplicada de paginación de `AllSpecs`. Deuda técnica reconocida; el MVP funciona sin esto.
- **Pinear hashes SHA-256** de `spec-shared.js` y `spec-params-bulk.js` en `config.json` (item 1 del audit pre-producción global).

### `bulk-upload` 1.0.0: hardening para corrida masiva de 18k filas (2026-05-18, deploy `18a453e` main / `4e91ffe` gh-pages, validación en prod PENDIENTE)
Refactor mayor del applet `bulk-upload.js` (1,709 → 2,427 LOC, +844 / –104). Aplica 7 fixes mínimos para sostener una corrida de Schneider Electric MX – Planta Rojo Gómez (>9,000 filas COTIZACIÓN+NP) sin perder integridad, más chunks de SOLO_PN de 2,000 filas para los otros ~79 clientes. Plan completo en `~/.claude/plans/ahora-necesito-regresar-a-frolicking-goblet.md`.

**Shape real de la carga (18k filas, división en 4 cargas):**

| # | CSV | Modo | Tamaño | Estrategia |
|---|---|---|---|---|
| 1 | `schneider-activos-2025.csv` | COTIZACIÓN+NP | ~5,000 filas | Single run, sin chunks |
| 2 | `schneider-archivados-2023-24.csv` | COTIZACIÓN+NP | ~4,000+ filas (LAST_ORDER) | Single run, sin chunks |
| 3 | `resto-activos.csv` | SOLO_PN | ~3-4k filas | Chunks de 2,000 |
| 4 | `resto-archivados.csv` | SOLO_PN | resto | Chunks de 2,000 |

**Trampa crítica conocida:** la opción `modify` del modal de conflicto de cotización **borra todos los PartNumberPrices previos** y reinserta desde el CSV (`bulk-upload.js:996-1000`). Por eso Schneider NO se puede chunkear — un segundo chunk borraría el primero. Cada cotización Schneider debe correr completa en un solo run.

**7 fixes aplicados:**

1. **Pool concurrente para `SavePartNumber` enrich** (1.5-2.5 h → 15-30 min para 9k PNs). Patrón `runPool(items, worker, concurrency, onProgress, myRunId)` portado de `spec-params-bulk.js`/`process-deep-audit.js`. Concurrencia 5 (config `steelhead.domain.bulkUpload.concurrency.savePartNumber`).
2. **Paginación real de `AllPartNumbers` en `checkPNExistence`** (`first: 200`, cap `maxResults: 1000`, loop `while (hasMore && !foundExact)`). Esta es la única defensa contra duplicados silenciosos cuando `searchQuery` matchea >50 PNs del cliente — es el mismo síntoma del bug `b4ccc7d` (2026-04-08) disfrazado.
3. **Cancellation token + panel con botón "Detener"**. `state.runId` monotónico + `nextRunId()` + `isStale(myRunId)` + `bailIfStale(myRunId)` + `BailError`, propagado a todos los loops async y al `withRetry` helper. Patrón idéntico al de `process-deep-audit`.
4. **Preview paginado del modal** (sustituye `<tr>` por PN interpolado en `innerHTML` — 9k filas congelaba Chrome). Conteos agregados arriba (X nuevas, Y existentes, Z forzadas), tabla con paginación cliente-side `PAGE_SIZE = 100`, filtros por status + cliente, `selected` Set persistente entre páginas. **No-fix:** XSS via `innerHTML` queda pendiente (item 2 del audit pre-producción global).
5. **Retry-with-backoff global `[1s, 2s, 4s]`**. Helper `withRetry(fn, label, myRunId, delaysMs)` que respeta cancelación entre intentos y solo reintenta en HTTP 429/503/network. Para `unique_constraint` mantiene la lógica progresiva existente. Aplicado en `SavePartNumber` (ambas fases), `SaveManyPNP`, `CreateQuote`, `SaveQuoteLines`, `UpdateQuote`, `UpdatePartNumber`, `SavePartNumberRackTypes`, `UpdateInventoryItemPredictedUsage`.
6. **Pool concurrente para archivado final** (mismo `runPool`, concurrencia 5). Combina `pnsToArchive` + `oldPnsToArchive` + `pnsToUnarchive` en una sola pasada.
7. **Resume tras crash** con `localStorage` (NO `chrome.storage.local` — MAIN world no expone `chrome.*` confiablemente). `runKey = sha256(csvText)` como handle. Schema en `localStorage['sa_bulk_resume_<runKey>']` con `phase, completedPNs[], failedPNs[], quoteId, quoteAction, lastUpdatedAt`. Índice en `localStorage['sa_bulk_resume_index']` con purga ≥ 7 días. Modal "Detecté corrida previa, ¿Reanudar / Empezar de cero / Cancelar?" al inicio de `execute()` cuando matchea. Persiste cada 50 PNs (no por cada uno) + en cada cambio de fase.

**Lecciones del ciclo:**

- **`chrome.storage.local` NO funciona en MAIN world.** El plan original pedía `chrome.storage.local` pero la inyección MAIN no expone `chrome.*` APIs de forma confiable. Pivot a `localStorage` con prefijo `sa_bulk_resume_` + índice separado. Mismo patrón que `paros-linea`, `invoice-auto-regen`, `bill-autofill`. Límite 5MB por origen es holgado (~300KB JSON para 9k entries). **Regla derivada**: cuando un plan de applet pida persistencia y el applet corra MAIN world, usar `localStorage` desde el principio — `chrome.storage.local` se reserva para applets que corran en el background.js o que tengan `chrome.runtime.sendMessage` round-trip.
- **`myRunId` debe declararse en el scope donde arranca cada fase.** El primer commit del Fix 1 quedó con `runPool(items, worker, 5, cb, myRunId)` referenciando una variable que nunca se declaró en `execute()`. Fixed agregando `const myRunId = nextRunId(); showPanel(); setPanelPhase('Iniciando...');` al inicio del `try` de execute, y pasando `myRunId` a TODOS los helpers async que arranque la fase (incluyendo `checkPNExistence(parts, myRunId)`). Lección: cuando portas el patrón de cancellation token de un applet existente, **el primer paso es capturar `myRunId` en el scope público de `execute()`**, no en cada loop interno. Si está disperso, hay funciones que silenciosamente no aceptan cancelación.
- **`enrichWorker` con resume skip requiere stubs tempranos.** Cuando aplicas fixes en orden numérico (1→2→3...), el Fix 1 (pool concurrente para enrich) puede referenciar `resumeState` y `persistResumeState()` que solo se implementan en Fix 7. Para evitar `ReferenceError` durante desarrollo iterativo, agregar **stubs** (`let resumeState = null;` + `async function persistResumeState() {}`) inmediatamente después de `state` y reemplazarlos en Fix 7. Patrón aplicable a cualquier refactor multi-fix donde fixes posteriores definen helpers que fixes anteriores usan: stub-first, real implementation later.
- **PN unique identifier es `(name.toUpperCase(), customerId)`.** Para el `resumeCompletedSet` la clave es `${part.pn.toUpperCase()}|${part.customerId}`. No `name` solo — dos clientes pueden tener PNs con el mismo nombre. No `name` lowercase — Steelhead trata uppercase como canónico (la mutación `SavePartNumber` también upper-casea).
- **Defensive config defaults.** El applet lee `bulkCfg()` que devuelve defaults si la sección `steelhead.domain.bulkUpload` no existe en `config.json`. Importante para no romper deploys antiguos durante el rollout. Patrón: cada nueva sección de config tiene un accessor con defaults inline.
- **Patrón "deploy de bulk-upload": stash + checkout + cp + commit + push + restore.** Modificaciones tempranas al `.xlsm` bloquearon el checkout de `gh-pages`. Workflow: (1) `git stash push -u -m "wip" -- Plantilla_Cotizaciones_y_NP_v84_1.xlsm` para sacar el .xlsm del index; (2) `git checkout gh-pages`; (3) `cp ../main-checkout/remote/scripts/bulk-upload.js scripts/bulk-upload.js && cp ../main-checkout/remote/config.json config.json`; (4) `git add scripts/bulk-upload.js config.json && git commit -m "deploy: bulk-upload 1.0.0 ..."`; (5) `git push origin gh-pages && git checkout main && git stash pop`. **Verificación crítica**: `git diff HEAD:remote/scripts/bulk-upload.js gh-pages:scripts/bulk-upload.js` debe dar 0 bytes de diferencia.

**Configuración nueva en `remote/config.json`:**
```json
"bulkUpload": {
  "concurrency": { "savePartNumber": 5, "archive": 5 },
  "retry": { "delaysMs": [1000, 2000, 4000] },
  "paging": { "allPartNumbers": { "first": 200, "maxResults": 1000 } },
  "preview": { "pageSize": 100 },
  "resume": { "maxEntries": 20, "purgeAgeDays": 7 }
}
```

**Files tocados (deploy `18a453e` main / `4e91ffe` gh-pages):**
- MODIFICADO `remote/scripts/bulk-upload.js` (+844 / –104 LOC; VERSION bumped a `'1.0.0'`).
- MODIFICADO `remote/config.json` — bump 0.9.0 → 1.0.0; nueva sección `steelhead.domain.bulkUpload`.
- `extension/background.js` SIN cambios (el handler `case 'run-csv'` en `background.js:324` ya estaba).

**Estado de deploy:**
- `main`: `18a453e` — **pushed** a remote.
- `gh-pages`: `4e91ffe` — **pushed** a remote.

**Plan de validación PENDIENTE** (a ejecutar antes del primer run real de Schneider):

*Etapa 0 — Sanity check de hashes:* confirmar que los hashes de persisted queries en `remote/config.json` siguen vivos (AllPartNumbers, SavePartNumber, SaveManyPartNumberPrices, CreateQuote, SaveQuoteLines, UpdateQuote, UpdatePartNumber, AllQuotes, SavePartNumberRackTypes, UpdateInventoryItemPredictedUsage, AddParamsToPartNumber). Si alguno responde HTTP 400 con `"Must provide a query string."`, aplicar el playbook 60-segundos.

*Etapa 1 — Test unitario con CSV de 10 filas reales:*
1. Construir CSV con 10 filas representativas extraídas del archivo Schneider grande.
2. Correr modo COTIZACIÓN+NP en cotización temporal "TEST-Schneider-2026-05-19".
3. Verificar: preview paginado renderiza sin freeze, botón Detener funciona, pool concurrente respeta `concurrency.savePartNumber = 5` (revisar Network tab en DevTools), `AllPartNumbers` paginado detecta correctamente PNs existentes incluso con >50 matches del searchQuery, runKey se guarda en `localStorage` y se purga al `phase: 'done'`.
4. Archivar la cotización TEST y verificar que el archivado final con pool funciona.

*Etapa 2 — Test medio con CSV de 100 filas:*
1. Mismo CSV-test pero con 100 filas. Cotización temporal distinta.
2. **Crítico: validar flujo de resume.** Iniciar corrida → cerrar tab a los ~30s → reabrir Steelhead, recargar extensión → relanzar el MISMO CSV → modal de resume aparece → reanudar → completa sin duplicar PNs.
3. Conteos esperados: cotización con 100 PNPs, 0 duplicados, 0 errores no esperados.

*Etapa 3-5 — Runs reales:* Schneider activos 2025+ (single run), Schneider archivados 2023-24 (single run), chunks SOLO_PN 2k cada uno. Mirar Network tab para verificar que retry absorbe 429/503 esporádicos y el contador de "Reintentos" en el panel los reporta.

### `bulk-upload` 1.1.0 + 1.2.0: dedup QuoteIBMS + Pase 3 con comparación inline (2026-05-20)

**1.1.0** (plan `docs/superpowers/plans/2026-05-20-bulk-upload-quoteibms-dedup.md`, T0-T14, deploy `6dac175`):
- **Pase 1 (autoritativo):** match por `customInputs.DatosAdicionalesNP.QuoteIBMS`. Resuelve renombres del PN (mismo IBMS, nombre nuevo → MODIFY al PN viejo).
- **Pase 2 (composite):** `(customerId, name, metalBase, acabadosOrdenados)` con regla anti-colisión: si ambos IBMS no-vacíos y distintos, cae a Pase 3 en vez de MODIFY ciego.
- **Pase 3 (near-match):** hasta 3 candidatos por nombre exacto, ordenados por matchScore (acabados compartidos + metalBase + IBMS preference + id asc). El usuario decide con dropdown.
- **Blacklist de acabados:** `SMY, STX, SXC, SRG, SCM, SQR, SQ2, NP desconocido, En desarrollo, Muestras, Lote, Obsoleto` se ignoran al construir el composite (etiquetas operativas, no acabados químicos).
- **MODIFY overwrites everything** desde el CSV (no merge). Esto es por diseño del flujo de "actualización masiva" de Schneider.
- **Auto-detect dual-mode:** `parts.length > massiveThreshold` (default 1000) → modo masivo (prefetch global de PNs del cliente, ~250 queries); ≤1000 → modo día (on-demand AllPartNumbers searchQuery por PN).
- **Reporte XLSX** con 3 hojas: Resumen (stats por pase), Decisiones Pase 3 (auditoría línea por línea), Errores.
- **Resume schema extendido** con classifications[] para reanudar tras crash sin re-clasificar (cache caliente del prefetch sobrevive en localStorage).

**1.2.0 (R1-R5, deploy `<NEW>`):** UX refinement del Pase 3 driven por feedback del usuario:
- **Default invertido:** Pase 3 con candidatos defaultea ahora **MODIFY al top match** (era NEW por defecto). El usuario puede override en el dropdown a otro candidato o a "🆕 Crear nuevo PN".
- **Comparación inline visible:** cada fila Pase 3 muestra debajo del dropdown:
  - Fila CSV: `📄 CSV — metal:CU · etiq:[NIQ,CRO] · proc:niquelado-cromado · IBMS:Q1`
  - Fila candidato seleccionado: `🎯 #ID — metal:AL · etiq:[NIQ] · proc:niquelado · IBMS:Q2`
  - La fila candidato se actualiza al cambiar el dropdown (re-render in-place)
- **Lazy fetch de specs:** botón `📋 specs` por fila despliega panel comparativo con specs del CSV (instantáneo) + specs del PN candidato (lazy fetch a `GetPartNumber`). Cache module-level `Map<id, {state, specs}>` evita refetch.
- **AllPartNumbers ya expone `processNodeByDefaultProcessNodeId.name`** sin tocar hash; `extractPNShape` lo guarda en `processName` para mostrarlo inline.
- **userOverride semántica nueva:** `null` = default (top match), `numero` = override a otro candidato, `'__new__'` = override explícito a NEW.
- **generateRunReport** ahora usa `s.status === 'existing'` (no `s.userOverride != null`) para decidir MODIFY vs NEW. Stats de Resumen distinguen 3 sub-casos del Pase 3: default top match / override otro / override Crear nuevo.

**Hash rotado en 1.2.0:** `GetPartNumber` 55bf9e21... → 60bee2e1... (síntoma idéntico al playbook de "rotación silenciosa": HTTP 400 `"Must provide a query string."` con el hash viejo en cold start; scan fresh muestra mismo shape con hash nuevo y HTTP 200).

**Lecciones del ciclo 1.2.0:**
- **UX matters en Pase 3.** El plan original (1.1.0) cumple el spec funcional pero el usuario lo encontró friccional en uso real: tener que clickear cada dropdown para decidir manualmente cuando había un top match razonable era doloroso para CSVs de cientos de filas. El refactor a default MODIFY ahorra clicks; los inline previews + lazy specs hacen el override decision una operación de segundos en lugar de tener que abrir cada PN en pestañas separadas.
- **Re-scan antes de adivinar deprecación.** `GetPartNumber` parecía deprecado (errores 400 en cold start), pero scan fresh confirmó rotación (hash distinto, mismo shape, HTTP 200). El playbook `Persisted queries deprecadas` aplica: NO asumir deprecación sin re-scanear. Lección reforzada de v0.5.7 y v0.6.24.
- **AllPartNumbers ya trae el processName.** Antes de bumpear su hash, verificar la query nativa: muchos campos "nice to have" ya viajan en la respuesta porque el UI los necesita en otros flujos. `n.processNodeByDefaultProcessNodeId.name` no requirió tocar nada en el config — solo agregar la propiedad en `extractPNShape`.
- **Lazy fetch + cache module-level vs prefetch global.** Para campos opcionales que el usuario consulta poco frecuentemente (specs en R4), lazy fetch on-demand + cache por PN es más eficiente que prefetch global de specs durante la clasificación. El cache vive en el IIFE del applet (no en state.runState), así sobrevive entre clics del usuario en distintas filas pero no entre reloads — patrón aceptable porque el usuario raramente reabre el mismo preview.

**Files tocados 1.2.0 (deploy `<NEW>`):**
- MODIFICADO `remote/scripts/bulk-upload.js` — VERSION 1.1.0 → 1.2.0, default Pase 3 MODIFY, csvLabels/csvMetalBase/csvIBMS/csvProceso/csvSpecs en row, dl9-p3-wrap + selrow + csv + cand + specs UI, `fetchCandidateSpecs` + cache, `generateRunReport` con 3 sub-casos.
- MODIFICADO `remote/config.json` — bump 1.1.0 → 1.2.0, rotación `GetPartNumber` hash.
- MODIFICADO `tools/test/bulk-upload-helpers.test.js` — Casos 6/anti-colisión actualizados al nuevo default MODIFY.

**Plan de validación 1.2.0 (USUARIO):** correr CSV de prueba con 3-5 PNs que caigan en Pase 3 (mismo nombre, distinto metalBase o IBMS). Verificar:
1. Dropdown abre con el top match preseleccionado (no "Crear nuevo").
2. Las dos líneas inline (📄 CSV, 🎯 candidato) muestran metal/etiq/proc/IBMS correctamente.
3. Cambiar a otro candidato actualiza la línea 🎯 in-place.
4. Cambiar a "🆕 Crear nuevo" pinta verde "se creará un PN nuevo".
5. Click `📋 specs` carga las specs del candidato sin freeze (cache, re-clic instantáneo).
6. Sin candidatos parecidos (Caso 7) → fila no entra a Pase 3, queda como NEW limpio.

### `bulk-upload` 1.2.11: 6 bugs de producción + UI override de archivado (2026-05-21, deploy PENDIENTE)
Ciclo F+H sobre el applet. F1/F2/F3 cerraron temas heredados (dedup strict-match en alternates, colores reales de chips CSV). H1-H8 son los 6 bugs reportados por el usuario tras correr en producción un CSV con varias filas que comparten `(name, customerId)` (Schneider Electric México con 9k filas):

| Bug | Causa raíz | Fix (H) |
|---|---|---|
| A: NEW + `archivarAnterior=true` se re-crea cada corrida (loop) | No había forma de ver/override que se iba a archivar | H5 toggle global + checkbox per-row + H6 lectura desde state |
| B: Specs anteriores NO se archivaban en MODIFY | Cache stale entre iteraciones de duplicados (Map `${name}|${cust}` colapsa) | H2 maps por rowIdx |
| C: Rack Type fantasma cargado a PN sin rack | `pnLookup` colapsado: la segunda iteración del duplicado escribe sobre la primera | H2 + H7 dedup por `(rackTypeId, pn.id)` |
| D: Predictive Inventory combina dos PNs | Mismo problema que C | H2 |
| E: Línea 5 sin productos, línea 6 con ambos | `SaveQuoteLines` itera por `${name}|${cust}` → mismo `ql.id`, idsToDelete stale | H4 SaveQuoteLines per-rowIdx |
| F: PN físico con Custom Inputs vacíos y solo SRG/SCM | `SavePartNumber` enrich llamado 2 veces sobre mismo pn.id; customInputs/labels replace en lugar de append | H3 capa A/B serializada |

**Premisa crítica corregida en este ciclo:** Steelhead **permite múltiples PartNumbers con mismo `(name, customerId)`** — son PNs físicos distintos con mismo nombre, distinguidos solo por id interno. La unique constraint que dispara error es **per-call**: dentro de un mismo `SavePartNumber` request batch, no puedes crear dos rows. Pero serializando llamadas (Capa A primero todos los únicos en paralelo, Capa B segundos/terceros duplicados en serie), sí crea N PNs físicos con el mismo nombre. Esto significa que **forzar las filas duplicadas del CSV a NEW colapsadas era el bug** — el clasificador (Pase 1/2/3) debe decidir cada fila por separado y respetar IBMS matches que apunten a PNs físicos distintos.

**Decisión arquitectónica clave H2:** las claves de `newPnIds` y `pnLookup` cambian de `${name}|${customerId}` a `rowIdx` (índice en `parts[]`). Side-effect: hay que mantener un `lineNumberToOrigIdx: Map<lineNumber, rowIdx>` para reconectar el output de `SaveManyPNP` (que devuelve `qpnp.lineNumber`) con la fila original del CSV.

**Capa A/B en STEP 2a (H3):**
```js
// Agrupa newOrDupParts por (name, customerId).
// Capa A = primer elemento de cada grupo (corren en paralelo con pool).
// Capa B = segundos/terceros (corren en serie, después de Capa A).
const seenNameCust = new Map();
for (let j = 0; j < newOrDupParts.length; j++) { /* ... */ }
const capaA = [], capaB = [];
for (const indices of seenNameCust.values()) {
  if (indices.length === 1) capaA.push(indices[0]);
  else { capaA.push(indices[0]); for (let n = 1; n < indices.length; n++) capaB.push(indices[n]); }
}
const orderedJs = [...capaA, ...capaB];
// Iterar orderedJs secuencialmente (en este patch — concurrencia para A puede agregarse después)
```

**UI override H5 (decidido con el usuario, "Ambos"):**
- **Toggle global** en el header del preview "🗄️ Archivar PNs viejos (CSV)" (default ON). Apaga = ninguna fila archiva (blanket override). Set/reset `state.archiveGlobal` en cambio.
- **Checkbox per-row** "🗄️ Arch ant" en la celda Acción solo para filas `forceDup` con `archivarAnterior=true` en el CSV. Set `parts[idx].archiveOverride = true|false`. Si el valor coincide con el global, se borra del part para que vuelva a seguir el global.
- **Chip "🔄 DUP n/m"** junto al PN cuando la fila es duplicado interno del CSV. Solo informativo — el classifier ya decide cada fila por separado.

**STEP 8 archive flow (H6):**
```js
const archiveGlobal = (state.archiveGlobal !== false); // default true
for (let i = 0; i < parts.length; i++) {
  const csvWantsArchive = !!part.archivarAnterior;
  const rowOverride = part.archiveOverride; // boolean | undefined
  const willArchive = (rowOverride === true) || (rowOverride === undefined && csvWantsArchive && archiveGlobal);
  if (status.status === 'forceDup' && willArchive && status.existingId) { /* push to oldPnsToArchive */ }
}
```
Tres niveles de override (en orden de precedencia: per-row > global > CSV default):
- `archiveOverride === true` → archiva siempre (aunque global esté off)
- `archiveOverride === false` → no archiva nunca (aunque CSV diga true)
- `archiveOverride === undefined` → sigue `archiveGlobal && csvWantsArchive`

**Dedup en STEP 7 (racks) y STEP 8 (archive)**: ahora la iteración por `parts[]` puede tocar el mismo pn.id N veces (cuando dos filas del CSV apuntan a MODIFY al mismo PN). Para evitar requests redundantes, cada loop tiene su `Set` de seen: `archiveSeen`, `oldArchiveSeen`, `unarchiveSeen`, `rackInSeen` (este último con clave `${rt.id}|${pn.id}`).

**Lecciones clave del ciclo:**

- **Maps key collapse es un bug silencioso.** El refactor 1.2.10 → 1.2.11 demostró que cualquier `Map<"${name}|${customerId}", ...>` se rompe cuando el CSV tiene duplicados internos legítimos. La cura es **rowIdx siempre** que el ámbito sea per-row, y mantener una `Map<lineNumber, rowIdx>` cuando hay un bridge entre el output del server (que usa lineNumber) y la fila origen. Aplicable a cualquier futuro applet que itere `parts[]` y haga lookup sobre identidad-natural.

- **El tradeoff "informar visualmente" vs "forzar collapse" tiene una respuesta clara: informar.** Mi primer instinto en H1 era colapsar las filas duplicadas en una sola NEW. El usuario me corrigió: "esto aplica sólo si no hizo match directo con quote, porque varios NP con mismo nombre pueden tener quotes distintas". O sea: el clasificador conoce mejor que una heurística de "todas igual" — si una fila duplicada tiene IBMS match, debe MODIFY a SU PN específico; si otra no tiene match, debe crear NUEVO. La UI hace el chip "🔄 DUP n/m" para que el operador valide la decisión, pero la lógica respeta cada fila.

- **`state` es accesible desde funciones lambda dentro del IIFE.** El módulo es un IIFE singleton, así que `state.archiveGlobal = checked` desde un event handler del preview persiste para cuando STEP 8 lo lea. No hace falta `Promise` callback ni context object pasado a `showPreview()`. Limitación: el state se resetea en `nextRunId()`, así que si el usuario cancela y reanuda, el toggle vuelve a default ON — ok, es lo esperable.

- **Sentinel coherente en checkbox per-row.** Para que el override sea "limpio", uso 3 estados: `undefined` (sigue global+CSV), `true` (explícito archive), `false` (explícito skip). Si el checkbox cambia a un valor que coincide con el default, lo borro de `parts[idx]` con `delete` — así el resume serialization no carga overrides ruidosos que el operador nunca quiso fijar.

- **Tests de regresión documentan el bug.** El test `1.2.11 H2 contraste — Map<"name|cust",...> SÍ colapsa (el bug que arreglamos)` reproduce el patrón roto y afirma `last-write-wins: fila 0 (1001) se perdió`. Si alguien futuro vuelve a usar la key compuesta, este test falla apuntando exactamente al motivo.

**Files tocados:**
- MODIFICADO `remote/scripts/bulk-upload.js` (~+800 LOC sobre 1.2.10; VERSION ya estaba en `'1.2.11'` desde F1/F2/F3, no se re-bumpea).
- MODIFICADO `remote/config.json` (`version: 1.2.10 → 1.2.11`, `lastUpdated: 2026-05-21`).
- MODIFICADO `tools/test/bulk-upload-helpers.test.js` (+8 tests H1/H2/H5; total 45 tests pasando).

**Plan de validación PENDIENTE (USUARIO):**
1. **Sanity**: cargar CSV pequeño con 3-5 filas únicas (sin duplicados internos). Verificar que no hay regresión vs 1.2.10 — el chip "🔄 DUP" NO aparece y el toggle global rige.
2. **Duplicados con IBMS distinto**: CSV con 2 filas mismo PN+cliente, IBMS distintos → ambas deben aparecer con chip "🔄 DUP 1/2" y "🔄 DUP 2/2", clasificador decide MODIFY a IDs físicos distintos. La cotización resultante debe tener 2 líneas, cada una con su PN, con sus productos correctamente asignados.
3. **Duplicados sin IBMS match** → Capa A/B serializa la creación de NEW; ambos PNs deben aparecer en Steelhead con id distinto pero mismo nombre+cliente.
4. **forceDup + archivar anterior**: una fila con `archivarAnterior=true` que entra a forceDup → mostrar checkbox "🗄️ Arch ant" marcado por default. Desmarcar → tras Ejecutar, el PN viejo NO se archiva. Re-correr el mismo CSV → no se crea otro PN (porque no se archivó el primero).
5. **Toggle global off**: prender el toggle, todos los checkboxes per-row se desmarcan visualmente. Apagar = ninguno archiva.
6. **Override per-row con global off**: con toggle global apagado, marcar manualmente un checkbox per-row → ese PN sí se archiva aunque el global esté off.
7. **Specs archivadas en MODIFY**: PN existente con specs A/B/C, CSV trae specs B/D → al ejecutar, A y C se archivan, B se conserva, D se agrega (validación del archive sentinel de 1.2.5 que se rompía con el bug B).
8. **Rack Type sin dato en CSV**: PN duplicado, una fila con Rack=PalmTree, otra con Rack vacío → el PN físico con rack vacío NO recibe Rack Type alguno (validación del bug C).
9. **Predictive Inventory sin combinar**: dos PNs duplicados con consumos predictivos distintos → cada PN físico debe tener solo SU consumo (validación del bug D).

### `bulk-upload` 1.2.12: Opción B (Pase 1/2 ven archivados) + sentinel `-` predictives + montoMinimo strip + getter `__state` + bitácora Bug 2 (2026-05-21, deploy PENDIENTE)
Ciclo de hotfixes encima de 1.2.11 sin redeploy intermedio. Cinco cambios concretos:

**1. Pase 1 + Pase 2 ven archivados (rompe el loop de auto-archivado por re-corrida con misma QuoteIBMS).**

Antes: `classifyOnePN` filtraba `archivedAt` de `pnsForCustomer` ANTES de cualquier pase, así que un PN con QuoteIBMS=Q1 auto-archivado por la corrida anterior era invisible para el classifier en la siguiente. Resultado: Pase 1 no encontraba match → caía a Pase 3 sin candidatos → NEW → si la fila traía `archivarAnterior=true`, archivaba el nuevo PN también → loop infinito de duplicados con misma IBMS.

Ahora (opción B): Pase 1 y Pase 2 buscan sobre `allPns` (incluye archivados). Pase 3 sigue limitado a `activePns` para no ensuciar el dropdown near-match con históricos. Cuando un archivado matchea, el resultado lleva `wasArchived: true` y `confidence` con suffix `-desarchiva` (`ibms-exacto-desarchiva`, `composite-exacto-pn-sin-ibms-desarchiva`, etc.). Este suffix se strippe en `dedupModifyTargets.confRank` para que el ranking sea el mismo que el de su variante activa.

El **desarchivado real** no requiere código nuevo: STEP 8 ya tenía `pnsToUnarchive.push({...})` cuando `pnStatus[i].status === 'existing'` y `UpdatePartNumber, archivedAt: null` se intentaba sobre TODOS los existing (silencioso si ya estaba activo). Con el cambio del classifier, ahora también incluye archivados correctamente. UI muestra chip "🔓 desarch" junto al nombre del PN en el preview.

**Razonamiento de la opción B vs A vs C** (decisión del usuario): A (sólo Pase 1) habría dejado el composite con el mismo bug si el cliente no usa IBMS o lo deja vacío. C (todos los pases) ensucia Pase 3 con archivados de hace años que nadie quiere revivir. B captura los dos identificadores fuertes (IBMS único + composite exacto) sin meter ruido a la decisión near-match.

**2. Bug 1A — sentinel `-` en BB (Predictive Inventory) borra usages existentes.**

Antes: `gn()` (parseFloat) colapsaba `-` a null indistinguible de celda vacía, así que `predictiveUsage` quedaba `[]` cuando el CSV traía dashes y el sentinel `predAreDash` nunca se disparaba. Los predictives viejos persistían silenciosamente.

Ahora: `bbRaw = g(row, 53)` se lee en CRUDO (antes de `gn`); si es `'-'`, se inyecta un placeholder `{ inventoryItemId: PREDICTIVE_MATERIALS[0].inventoryItemId, usagePerPart: '-', name: ... }` que `predAreDash`/`predIsDash` detectan correctamente. STEP 6a extendido: cuando `predIsDash`, en lugar de `continue` (que saltaba el PN), itera `exMap.values()` y agrega un patch `{ id: exId, microQuantityPerPart: 0, inventoryUsageLowCodeId: null }` por cada existente. Workaround necesario porque **no hay mutation de archive de InventoryItemPredictedUsage en el scan**; setear `microQuantityPerPart=0` los deja inertes (no afectan planeación) aunque sigan listados visualmente.

**3. Bug 3 — `MontoMinimo` se borra siempre del legacy.**

El campo `DatosPlanificacion.MontoMinimo` ya no existe en el esquema de RJSF, pero los PNs legacy lo tienen embebido en `customInputs`. `mergeCustomInputs(existing, part)` ahora hace `delete ci.DatosPlanificacion.montoMinimo` y `delete ci.DatosPlanificacion.MontoMinimo` (ambas capitalizaciones por seguridad) inmediatamente después del JSON deep clone — antes de aplicar overrides del CSV. Cualquier MODIFY sobre legacy lo limpia. No requiere acción del operador.

**4. UX — getter `window.BulkUpload.__state` para snippets diagnósticos.**

`state` es module-level dentro del IIFE y `nextRunId()` lo reasigna, así que un snapshot pegado a `window.BulkUpload` quedaría stale. Solución: getter en la return del IIFE:
```js
return { execute, setProgressCallback, parseCSV, parseRows, __helpers, get __state() { return state; } };
```
Ahora cualquier diagnóstico de consola (ver al final de esta entrada) lee el state vivo.

**5. UX — Texto del progress bar.**

Antes: `setPanelPhase('Verificando PNs existentes (97 búsquedas)')`. Ahora: `(97 búsquedas únicas / 100 registros)`. El operador entiende que el dedup es por `(name|customerId)` y que las 3 filas faltantes son duplicados internos del CSV (no faltantes).

**Bug 2 — diagnóstico (NO es bug del applet; Steelhead UI quote line no filtra `archivedAt`).**

Síntoma reportado: tras MODIFY exitoso de un PN, la UI nativa de Steelhead muestra ambas specs (la archivada vieja y la nueva activa) en la línea de la cotización. Diagnóstico desde `~/Downloads/scan_results_2026-05-21_085044.json`: 5 PNs (`46007-580-01`, `46007-902-01`, `46008-071-01`, `46032-583-01`, `48182-577-01`) muestran shape `partNumberSpecsByPartNumberId.nodes[]` con DOS entries — una con `archivedAt` timestamped (la vieja), otra sin `archivedAt` (la nueva). **El archive sentinel de bulk-upload funciona correctamente** (el `partNumberSpecsToArchive` en `SavePartNumber` SÍ marca el link como archivado).

Donde está el bug: la query `GetQuote` que pobla la línea de la cotización en Steelhead NO filtra `archivedAt` en `partNumberSpecsByPartNumberId.nodes[]`. Esto es bug nativo del UI de Steelhead, no de bulk-upload. La query del PN aislado (`GetPartNumber`) SÍ filtra correctamente — solo el contexto de "spec en línea de cotización" muestra archivados.

**Workaround del operador**: en la quote line, las specs archivadas aparecen tachadas o con marker visual distinto (depende del flujo). Si Steelhead alguna vez expone una mutation de hard-delete (`DeletePartNumberSpec` o similar), se podría considerar; el scan actual no la tiene capturada y no hay forma de borrar el link, solo archivarlo.

**No-fix consciente.** Documentar y mover.

**Files tocados (deploy PENDIENTE):**
- MODIFICADO `remote/scripts/bulk-upload.js`:
  - `VERSION` 1.2.11 → 1.2.12
  - `classifyOnePN` (líneas ~3679-3805): Pases 1/2 sobre `allPns`, Pase 3 sobre `activePns`, `wasArchived` en todos los returns
  - `buildClassifiedRow` (línea ~1006): propaga `wasArchived` al row
  - `classifyPNsOnDemand` (línea ~1124): propaga `wasArchived` al pnStatus
  - `dedupModifyTargets.confRank` (línea ~3850): `stripArch()` para que `'-desarchiva'` no rompa el ranking
  - `mergeCustomInputs` (línea ~697): `delete ci.DatosPlanificacion.{m,M}ontoMinimo`
  - Parse BB raw (línea ~602): sentinel `-` en predictives antes de `gn`
  - STEP 6a (línea ~3144): `predIsDash` → iter `exMap.values()` con `microQuantityPerPart: 0`
  - `setPanelPhase` (línea 909): texto "búsquedas únicas / N registros"
  - return del IIFE (línea 3929): `get __state()`
  - CSS (línea 1064): nueva clase `.dl9-unarch-chip`
  - Render de preview (línea ~1352): chip "🔓 desarch" cuando `r.wasArchived`
- MODIFICADO `remote/config.json` (`version: 1.2.11 → 1.2.12`, `lastUpdated: 2026-05-21`).
- MODIFICADO `tools/test/bulk-upload-helpers.test.js`:
  - Test viejo "archivedAt excluye PNs aunque matcheen" actualizado a "1.2.12 archivedAt YA NO excluye en Pase 1 (opción B)"
  - +5 tests nuevos para opción B (Pase 1 con archivado, Pase 2 con archivado, Pase 1 activo no marca wasArchived, Pase 3 sigue ignorando archivados, Pase 1-IBMS-archivado gana sobre Pase 3-name-activo)
  - Total: 50 tests pasando.

**Plan de validación PENDIENTE (USUARIO):**

*Sanity post-deploy:*
1. Recargar extensión (chrome://extensions → reload) ~30-60s después del push de gh-pages.
2. En la tab de Steelhead, abrir DevTools → Console → `window.BulkUpload?.VERSION` → debe decir `'1.2.12'`.
3. Pegar el siguiente snippet ANTES de cargar el CSV (sólo para confirmar que el getter funciona):
   ```js
   console.log('state vacío esperado:', window.BulkUpload?.__state);
   ```
   Debe devolver un objeto con `runId`, `parts: []`, etc., NO undefined.

*Opción B (auto-unarchive):*
4. Tomar un PN del cliente Schneider que esté actualmente archivado y tenga QuoteIBMS=X (ej. cualquier PN de la corrida previa que disparó el loop).
5. Construir CSV de 1 fila con ese mismo nombre + cliente + QuoteIBMS=X.
6. Subir CSV → preview debe mostrar:
   - Fila clasificada como MODIFY al PN archivado (no NEW).
   - Chip azul "🔓 desarch" junto al PN.
   - Confidence en el dropdown: `ibms-exacto-desarchiva`.
7. Ejecutar → en Steelhead, abrir el PN → debe estar desarchivado con datos del CSV aplicados.

*Sentinel `-` en predictives (Bug 1A):*
8. PN con consumos predictivos existentes (ej. Estaño=0.5 g/pza, Plata=0.2 g/pza).
9. CSV con `-` en BB (columna Plata) → predictive `microQuantityPerPart` de los 2 records debe quedar en 0 tras ejecutar.
10. Verificar en la UI nativa: el bloque "Predicted Inventory Usage" debe mostrar los items con valor 0 (NO archivados pero inertes).

*MontoMinimo strip (Bug 3):*
11. PN legacy con `customInputs.DatosPlanificacion.montoMinimo: 1000` (puedes confirmar con DevTools → `JSON.parse(localStorage.getItem('sa_bulk_resume_<key>')||...)` o leer del XLSX descargado del Pase 3).
12. Cargar CSV que dispare MODIFY sobre ese PN (cualquier cambio mínimo).
13. Tras ejecutar, leer el PN con `GetPartNumber` desde consola: `customInputs.DatosPlanificacion.montoMinimo` no debe existir.

*UX del progress bar:*
14. Cargar CSV de 100 filas con 3 duplicados internos (mismo PN+cliente repetidos).
15. Durante la fase de búsqueda, debe leer "Verificando PNs existentes (97 búsquedas únicas / 100 registros)".

**Snippet diagnóstico actualizado (poscarga del CSV) para que el usuario pueda inspeccionar el state vivo:**
```js
(() => {
  const s = window.BulkUpload?.__state;
  if (!s) { console.log('state no disponible — recarga la extensión, debe ser 1.2.12+'); return; }
  console.log('runId:', s.runId);
  console.log('parts:', s.parts?.length || 0, 'rows');
  console.log('archiveGlobal:', s.archiveGlobal);
  // Primeras 5 filas con flags clave:
  (s.parts || []).slice(0, 5).forEach((p, i) => {
    console.log(`[${i}]`, p.pn, '| customer:', p.customerId, '| quoteIBMS:', p.quoteIBMS, '| archivarAnterior:', p.archivarAnterior, '| archiveOverride:', p.archiveOverride);
  });
  // pnStatus si existe (después de clasificación):
  if (s.pnStatus) {
    console.log('pnStatus:', s.pnStatus.length);
    const wasArch = s.pnStatus.filter(x => x.wasArchived);
    console.log(`PNs desarchivables (Pase 1/2): ${wasArch.length}`);
    wasArch.slice(0, 10).forEach(x => console.log('  →', x.pn, '#'+x.existingId, x.confidence));
  }
})();
```

**Pendientes derivados (no bloqueantes):**
- Cuando Steelhead exponga una mutation de hard-delete de `partNumberSpecs`, evaluar si vale la pena migrar de archive a delete para que Bug 2 (UI nativo de quote line) deje de mostrar specs viejas. Hoy no existe esa mutation en el scan.
- Auditar todos los demás campos `customInputs` legacy que pudieran haber quedado huérfanos del schema actual (similar a `montoMinimo`) y agregar strip-on-MODIFY si aparecen.

### `bulk-upload` 1.2.13: `includeArchived: 'YES'` + diff de IDs para sintetizar `archivedAt` + expone state.parts/pnStatus (2026-05-21, deploy PENDIENTE)
Hotfix sobre 1.2.12 que cierra el último gap de la Opción B: aunque el classifier ya sabía cómo matchear archivados, el applet NUNCA recibía PNs archivados porque el persisted query de `AllPartNumbers` los filtra server-side por defecto. Resultado en la corrida del 2026-05-21: 80 de 100 filas defaultearon a "Crear nuevo PN" aunque para muchas existía un archivado con la misma QuoteIBMS, disparando el loop de auto-archivado que la Opción B intentaba romper.

**Descubrimiento del parámetro.** El UI nativo de Steelhead usa `includeArchived` (enum) cuando el operador activa "Show archived" en el catálogo de PNs. Probando valores en consola (snippet del 2026-05-21):
- `EXCLUSIVELY` → solo archivados (lo que el UI usa para el toggle "sólo archivados")
- `YES` → activos + archivados (es lo que necesitamos)
- `NO` → solo activos (default cuando el parámetro se omite)
- `INCLUSIVELY`, `INCLUDE`, `BOTH`, `ALL`, `NEVER`, `OPTIONAL` → HTTP 400 (no son enum válidos)

**Gap del persisted query: `archivedAt` no viene en el selection set.** Confirmado dumpeando los 5 resultados de `AllPartNumbers(includeArchived: 'YES', searchQuery: '46007-902-01')`: las 28 keys del nodo (nodeId, id, createdAt, creatorId, name, shortName, uuid, isTemplate, inventoryItem..., customInputs, ...) NO incluyen `archivedAt`. La query selecciona los campos que el UI del catálogo de PNs necesita y "Archivado SÍ/NO" no es uno de ellos — el UI lo infiere de otro flag o lo ignora visualmente. Para nosotros eso significa que `extractPNShape` siempre vería `archivedAt: null` aunque el PN realmente estuviera archivado.

**Approach: dos pasadas con diff por ID.** Para cada llamada a `AllPartNumbers` (modo masivo y modo día), hacemos:
1. Pasada NO: `includeArchived: 'NO'` → llenamos el resultado normal Y construimos un `Set<id>` de activos.
2. Pasada YES: `includeArchived: 'YES'` → para cada PN cuyo ID NO esté en el Set de activos, lo agregamos con `shape.archivedAt = ARCHIVED_SENTINEL` (sentinel `'archived'`, no un ISO timestamp).
3. Los callers existentes usan `!p.archivedAt` para distinguir, así que un string truthy basta. La lógica de Pase 1/2 (1.2.12) ya respeta el flag (`byIbms.archivedAt ? '-desarchiva' : ''`).

**Costo.** Duplicamos las queries de `AllPartNumbers`. Modo masivo: ~250 calls → ~500 (dominio ~50k PNs). Modo día: ~|uniq(PN,cliente)| calls → 2×. Aceptable porque (a) ya teníamos paginación de 200/page y retry exponencial, (b) los archivados son pasada secundaria — si el operador no tiene CSV con muchos archivados, el segundo loop trae 0 nodos relevantes y termina rápido.

**Lección clave.** Las persisted queries no son contratos del backend de Steelhead — son selection sets congelados de cómo el UI usa GraphQL hoy. Si un applet necesita un campo que el UI no necesita, no llegará en la respuesta aunque el campo exista en el esquema. Tres opciones cuando esto pasa:
1. **Sintetizar el campo localmente** vía diff de dos queries con filtros distintos (lo que hicimos aquí — barato si los filtros se pueden invertir cleanly).
2. **Llamar `GetPartNumber` por PN** que sí trae el campo (caro: ~|N| queries adicionales — descartado para bulk-upload).
3. **Pinear un nuevo hash** que incluya el campo — requiere que Steelhead ya tenga esa variante registrada (que no hay garantía).

Aplicable a futuros applets que necesiten campos no expuestos por persisted queries del catálogo.

**Bonus 1.2.13: `state.parts`, `state.pnStatus`, `state.archiveGlobal` expuestos en state.** El snippet diagnóstico del 1.2.12 (`window.BulkUpload.__state`) devolvía `parts: 0 rows`, `archiveGlobal: undefined` porque esas eran variables LOCALES de `execute()` no parte del state module-level. Ahora:
- `state.parts` se asigna después de `parseRows(parseCSV(csvClean))` (es la misma referencia que `parts`, así que muta automáticamente cuando los STEPs filtran).
- `state.pnStatus` se asigna después de `checkPNExistence(parts, myRunId)`.
- `state.archiveGlobal` defaulta a `true` en el state inicial y en `nextRunId()` (antes solo se setteaba si el operador interactuaba con el checkbox global).

El snippet diagnóstico del 1.2.12 ahora reporta los valores reales.

**Files tocados (deploy PENDIENTE):**
- MODIFICADO `remote/scripts/bulk-upload.js`:
  - `VERSION` 1.2.12 → 1.2.13
  - Nueva constante `ARCHIVED_SENTINEL = 'archived'` (línea ~52)
  - `state` inicial + `nextRunId()`: agregan `parts: []`, `pnStatus: []`, `archiveGlobal: true`
  - `prefetchPNsByCustomer` (línea ~755): dos pasadas NO + YES con diff
  - `classifyPNsOnDemand` (línea ~910): dos pasadas NO + YES por uniq con diff
  - `execute()`: `state.parts = parts` después del parse; `state.pnStatus = pnStatus` después de `checkPNExistence`
- MODIFICADO `remote/config.json`: bump 1.2.12 → 1.2.13.
- MODIFICADO `tools/test/bulk-upload-helpers.test.js`: SIN cambios (50/50 siguen pasando porque la lógica del classifier no cambió — solo de dónde le llegan los datos).

**Estado de deploy:** PENDIENTE de autorización del usuario.

**Plan de validación PENDIENTE (USUARIO, tras deploy):**

*Sanity post-deploy:*
1. Recargar extensión (chrome://extensions → reload) ~30-60s después del push de gh-pages.
2. En la tab de Steelhead, abrir DevTools → Console → `window.BulkUpload?.VERSION` → debe decir `'1.2.13'`.
3. Validar que `__state` está vacío esperablemente: `console.log(window.BulkUpload.__state)` antes de cargar CSV → debe traer `runId`, `parts: []`, `pnStatus: []`, `archiveGlobal: true`.

*Caso clave (PN duplicado de Schneider con archivado):*
4. Subir el mismo CSV que disparó las "80 decisiones pendientes" en 1.2.12.
5. Para el PN `46007-902-01` (5 instancias: 4 activos + 1 archivado #3016647 con IBMS=35219): si la fila CSV tiene IBMS=35219, debe matchear el archivado vía Pase 1 con confidence `ibms-exacto-desarchiva` y mostrar chip "🔓 desarch" en el preview.
6. Para PNs cuyo CSV IBMS NO matchea ningún activo ni archivado, debe caer a Pase 3 normal (sin contaminar el dropdown con archivados — Pase 3 sigue limitado a activos).
7. La estadística "decisiones pendientes" debe bajar significativamente vs 1.2.12 (idealmente <20 de 100).

*Snippet diagnóstico (debería funcionar ahora):*
```js
(() => {
  const s = window.BulkUpload?.__state;
  if (!s) { console.log('state no disponible'); return; }
  console.log('runId:', s.runId);
  console.log('parts:', s.parts?.length || 0, 'rows');
  console.log('archiveGlobal:', s.archiveGlobal);
  console.log('pnStatus:', s.pnStatus?.length || 0);
  const wasArch = (s.pnStatus || []).filter(x => x.wasArchived);
  console.log(`PNs desarchivables (Pase 1/2): ${wasArch.length}`);
  wasArch.slice(0, 10).forEach(x => console.log('  →', x.pn, '#'+x.existingId, x.confidence));
})();
```

*Performance check:*
8. Verificar en Network tab que aparecen DOS bloques de queries `AllPartNumbers` por uniq (NO seguido de YES). Si el segundo bloque es muy rápido (0 resultados por PN porque el cliente no tiene archivados), confirma que la duplicación de costo es real pero acotada.

**Pendientes derivados (no bloqueantes):**
- Considerar caché de archivados por dominio: si el operador corre múltiples CSVs en una sesión, podríamos cachear el resultado de la pasada YES por (customerId, runId) y solo refrescar cada N minutos. Aplicable solo si el deploy actual resulta lento.
- Investigar si el hash de `AllPartNumbers` que usa el UI cuando se activa el toggle "Show archived" trae un selection set distinto con `archivedAt`. Si existe, podríamos pinear ese hash y eliminar la segunda pasada. Re-scan con el toggle activado lo confirmaría.

### `bulk-upload` 1.3.0: Quote Chunking — partir cotizaciones grandes COTIZACIÓN+NP en lotes de N líneas (2026-05-21, deploy PENDIENTE)
Motivación: la cotización de Schneider Electric México con 5,000+ líneas tarda ~6 minutos en abrir en Steelhead (regla empírica observada: `t ≈ 1 + 0.07n` segundos para N líneas — 100 líneas ≈ 8s; 5000 ≈ 6min). El usuario aclaró que para Schneider la cotización se usa como **diccionario de facturación** (PN → productos/lote para el facturador), NO como fuente de órdenes de venta, así que partirla en varias cotizaciones más pequeñas no cambia el flujo operativo. Para otros clientes la cotización SÍ dispara OV; el chunk loop respeta a ambos porque solo agrega un sufijo cuando `chunks.length > 1`.

**Decisiones de diseño cerradas con el usuario antes de implementar:**

1. **Default 250 líneas por chunk, editable en el preview** (input number `min=10 step=10`). Solo visible en COTIZACIÓN+NP (no aplica a SOLO_PN).
2. **Sufijo del nombre:** si todo cabe en 1 chunk → nombre original sin sufijo. >1 chunks → `<name> 01`, `<name> 02`, etc. (espacio + 2 dígitos zero-padded vía `padStart(2,'0')`, que escala gracefully a 3+ dígitos si pasamos 99). Cita exacta del usuario: *"quítale el &, era sólo concatenar, déjalo en espacio y número forzado a dos dígitos: 01, 02, 03, etc."*
3. **Chunks contiguos puros** — slicing simple por orden de `custParts`. No agrupa duplicados entre chunks. El usuario: *"OK continuos puros, da lo mismo."* Los duplicados internos del CSV ya se ven informativamente vía el chip "🔄 DUP n/m" en el preview (1.2.11 H1) y el classifier los decide por separado fila por fila.
4. **Resume vs restart fresco** — comportamiento dual:
   - **Resume** (CSV idéntico → `runKey` hash matches): salta chunks ya completados en `resumeState.completedChunks[cid]`. El `chunkSize` queda lockeado de la corrida original (no se respeta cambio en el preview si haces resume).
   - **Restart fresco** (decidió "Empezar de cero" en el modal de resume): cada chunk vuelve a disparar `findExistingQuote` + modal modify/skip/create estándar, igual que si fuera la primera corrida.
   Cita del usuario: *"si es resume sí, si es empezar de nuevo se modifican."*

**Arquitectura:**

```
Estructura de execute() COTIZACIÓN+NP, after STEP 2 (SaveManyPNP):

  partsByCustomer = Map<cid, [{part, status, origIdx}, ...]>

  // Pre-cómputo: chunks por cliente + total global para barras de progreso.
  chunkSize = resumeState.chunkSize || state.chunkSize || bulkCfg().chunking.defaultChunkSize
  chunksByCust = Map<cid, [chunkSlice[], ...]>
  totalChunks = sum(chunks.length por cliente)

  for (const [cid, custParts] of partsByCustomer):
    for (cIdx = 0; cIdx < chunks.length; cIdx++):
      if (resumeState.completedChunks[cid].includes(cIdx)) continue
      chunkSlice = chunks[cIdx]
      thisQuoteName = makeChunkQuoteName(quoteName, cIdx, chunks.length)
      [pipeline existente: findExistingQuote → modal → CreateQuote/Modify →
       SaveManyPNP (sobre chunkSlice) → GetQuote → pnLookup → SaveQuoteLines
       (sobre chunkSlice) → UpdateQuote notes]
      // Persistir chunk completado:
      resumeState.completedChunks[cid].push(cIdx)
      await persistResumeState()
```

**Helpers nuevos en bulk-upload.js (line ~4060, expuestos en `__helpers`):**

```js
function chunkParts(arr, chunkSize) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const size = Math.max(1, Math.floor(Number(chunkSize) || 1));
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function makeChunkQuoteName(originalName, chunkIndex, totalChunks) {
  if (totalChunks <= 1) return originalName;
  return `${originalName} ${String(chunkIndex + 1).padStart(2, '0')}`;
}
```

**State + resume schema extendidos:**

- `state.chunkSize: number | null` — se setea en el handler EJECUTAR del preview leyendo `#dl9-chunksize`. `null` en isSoloPN.
- `resumeState.chunkSize: number | null` — lockeado al iniciar `resumeState` por primera vez; hidratado al hacer resume desde corrida pre-1.3.0 (`if !chunkSize → state.chunkSize || default`).
- `resumeState.completedChunks: { [cid: string]: number[] }` — mapa cid (string del customerId) → array de chunk indices completados. Se persiste vía `persistResumeState()` después de cada chunk exitoso (UpdateQuote notes ok).

**Preview UI:**

En showPreview, si `!isSoloPN`, se inyecta un campo nuevo en la fila de filtros junto al toggle archive:

```html
<label>Chunk:
  <input type="number" id="dl9-chunksize" min="10" step="10" value="${defaultChunkSize}">
  <span id="dl9-chunkpreview">→ N cliente(s), M cotización(es)</span>
</label>
```

El span de preview se recalcula on `input` event y on cualquier cambio de selección (vía hook `onSelChange` agregado a `updateSelCount()` para no romper strict mode con monkey-patching). Computa `ceil(parts[cliente].length / size)` sumado para los clientes con al menos 1 fila seleccionada.

**Lecciones del ciclo:**

- **Strict mode prohíbe reasignar function declarations.** El primer intento del live-preview hizo `updateSelCount = function() { ... }` para wrappear la función con un trigger de recálculo. Fallo silencioso en producción (assignment to function declaration es TypeError en strict mode). Refactor a callback hook: `let onSelChange = null;` en el scope superior, `updateSelCount()` lo llama si está seteado, y el bloque de chunking lo asigna a `recalcChunkPreview`. Patrón aplicable a cualquier widget que necesite reaccionar a state interno de otro widget sin tocar su declaración.

- **Node test sandbox `assert.deepEqual([], [])` falla cross-context.** Cuando los helpers se exportan vía `__helpers` y el test los carga con `vm.runInThisContext`, los arrays retornados por el sandbox tienen un constructor `Array` distinto al del módulo de test. `assert.deepEqual(H.chunkParts([], 250), [])` arroja `Values have same structure but are not reference-equal`. Workaround: `assert.equal(r.length, 0)` o `assert.deepStrictEqual` con valores primitivos. Aplica a cualquier test futuro que invoke helpers via vm sandbox.

- **resumeState como single-source-of-truth para "lockear" parámetros del flujo.** El user puede editar el chunkSize en el preview entre corridas, pero un resume debe respetar el tamaño de la corrida original (cambiarlo a mitad de corrida partiría chunks distintos y crearía cotizaciones duplicadas). Patrón general: cualquier parámetro que afecte particionamiento del trabajo se persiste en `resumeState` al iniciarla y se lee de ahí en lugar de `state` cuando hay resume. Aplica a futuros applets con persistencia (chunk size, batch size, paginación, etc.).

- **Pre-cómputo de totales antes del loop.** El `quoteSeq / partsByCustomer.size` original sub-reporta el progreso cuando hay chunks (`totalChunks > partsByCustomer.size`). El fix: `totalChunks = sum(chunks.length)` calculado UNA vez antes del loop, usado en todos los `setProgressBar` y `showProgressUI`. Patrón aplicable a cualquier loop anidado donde la barra de progreso debe reflejar el total real de operaciones, no la cardinalidad del outer.

**Files tocados (deploy PENDIENTE):**

- MODIFICADO `remote/scripts/bulk-upload.js`:
  - `VERSION` 1.2.13 → 1.3.0
  - `state` inicial + `nextRunId()`: agregan `chunkSize: null`
  - `bulkCfg()` accessor: agrega `chunking.defaultChunkSize` con default 250
  - `showPreview()`: input `#dl9-chunksize` + span `#dl9-chunkpreview` (solo `!isSoloPN`), callback `onSelChange`, captura del valor en handler EJECUTAR
  - `execute()` COTIZACIÓN+NP: pre-cómputo `chunksByCust` + `totalChunks`, loop interno `for (cIdx = 0; cIdx < chunks.length; cIdx++)` con skip por resume + bailIfStale + persist al final, `custParts` → `chunkSlice` en SaveManyPNP + SaveQuoteLines
  - Resume schema inicial: `chunkSize` + `completedChunks: {}`; hidratación para resume pre-1.3.0
  - Helpers nuevos `chunkParts` + `makeChunkQuoteName` expuestos en `__helpers`
- MODIFICADO `remote/config.json`: bump 1.2.13 → 1.3.0, nueva sección `steelhead.domain.bulkUpload.chunking.defaultChunkSize: 250`.
- MODIFICADO `tools/test/bulk-upload-helpers.test.js`: +8 tests (5 para `chunkParts` cobertura edge cases + 3 para `makeChunkQuoteName` incluyendo el caso 3 dígitos). Total: 58 tests pasando.

**Plan de validación PENDIENTE (USUARIO, tras deploy):**

*Sanity post-deploy:*
1. Recargar extensión (chrome://extensions → reload) ~30-60s después del push de gh-pages.
2. En la tab de Steelhead, DevTools → Console → `window.BulkUpload?.VERSION` → debe decir `'1.3.0'`.

*Caso "una cotización" (sin sufijo):*
3. CSV de 50 filas COTIZACIÓN+NP, un solo cliente. Preview: chunk input default `250`, preview span dice `→ 1 cliente(s), 1 cotización(es)`. Ejecutar → en Steelhead aparece UNA cotización con el `quoteName` original (sin " 01").

*Caso "tres chunks" (con sufijo):*
4. CSV de 600 filas COTIZACIÓN+NP, un solo cliente. Preview: chunk input default `250`, preview span dice `→ 1 cliente(s), 3 cotización(es)`. Ejecutar → en Steelhead aparecen 3 cotizaciones nombradas `<quoteName> 01`, `<quoteName> 02`, `<quoteName> 03` con 250/250/100 líneas respectivamente.

*Caso "edición del chunk size en preview":*
5. Mismo CSV de 600 filas. En el preview, cambiar el chunk input a `300`. El preview span debe actualizar a `→ 1 cliente(s), 2 cotización(es)` instantáneamente. Ejecutar → 2 cotizaciones `<name> 01` (300) y `<name> 02` (300).

*Caso "multi-cliente con chunks dispares":*
6. CSV con 2 clientes: Cliente A con 100 filas (cabe en 1 chunk), Cliente B con 500 filas (necesita 2 chunks). Preview span debe decir `→ 2 cliente(s), 3 cotización(es)`. Ejecutar → 1 cotización para A sin sufijo, 2 cotizaciones para B con " 01" y " 02".

*Caso "resume tras crash":*
7. CSV de 800 filas COTIZACIÓN+NP, un solo cliente. Iniciar (genera 4 cotizaciones esperadas). Cerrar tab a media corrida (cuando ya completaron 1-2 chunks según el log). Reabrir Steelhead, recargar extensión, relanzar el MISMO CSV. Modal de resume debe aparecer → elegir "Reanudar". Verificar en el log: `${cust.name} chunk 1/4: ya completado, saltando` (y/o 2/4). Las cotizaciones ya completas NO se re-tocan; solo continúa con las pendientes.

*Caso "restart fresco":*
8. Mismo CSV de 800 filas, con corrida previa parcialmente completa en localStorage. Lanzar → modal de resume → elegir "Empezar de cero". Las 4 cotizaciones deben dispararse desde el inicio. Por cada chunk que ya existe en Steelhead (de la corrida abortada), el modal modify/skip/create debe aparecer. Decidir "modify" para todos → las cotizaciones existentes se sobrescriben con datos frescos del CSV.

*Sanity Schneider real:*
9. CSV de Schneider Electric MX activos 2025 (5,000+ filas, 1 cliente). Default 250 → 20 cotizaciones. Verificar que el run completo termina sin que ninguna cotización se atore esperando a Steelhead abrir (el bug original). El log debe mostrar avance de `Quote 1/20 → 2/20 → ... → 20/20`.

**Pendientes derivados (no bloqueantes):**

- **Manejo de fail-fast por chunk.** Hoy si un chunk falla (CreateQuote 502 que excede los retries, p.ej.), se loguea el error y el chunk NO se marca completado (resume lo intentará después). El siguiente chunk del mismo cliente igualmente continúa. Si el operador prefiere "abortar todo el cliente al primer fallo", habría que agregar un flag `state.abortClienteAlFallar` o similar — no incluido en MVP.
- **Chunks paralelos por cliente.** Hoy es secuencial dentro del loop por cliente. Steelhead probablemente tolera 2-3 cotizaciones nuevas en paralelo (cada `CreateQuote` + `SaveManyPNP` + `SaveQuoteLines` es atómico). Si el throughput resulta insuficiente para CSVs muy grandes (>10k filas), considerar `runPool(chunks, ..., 2)` para chunks de un mismo cliente. No incluido en MVP por simplicidad — la corrida secuencial es razonable.
- **Resume con chunks que cambian de definición.** Hoy un resume requiere que el CSV sea byte-idéntico (runKey hash). Si el operador edita el CSV (reordena filas, agrega 1 fila), el runKey cambia y todo se reclasifica. Eso es correcto pero hay un edge case: si el CSV es exactamente el mismo pero el operador cambió el chunkSize en el preview a mitad de un resume — el `resumeState.chunkSize` original gana y el preview value se ignora. La UI no comunica esto; podríamos mostrar un aviso "Resume usa chunkSize=N (de corrida original)" al detectar el caso. No-bloqueante.

#### VBA Module2 v11: macro Refrescar Listas con catálogos desde libro externo (2026-05-21, sin deploy — vive en el .xlsm)
Archivo nuevo `VBA_Module2_v11.txt` que reemplaza la macro `RefrescarListas` del legacy v84 (que leía catálogos desde hojas internas hardcoded). El v11 ahora lee desde el libro externo `Plantilla_Cotizaciones_y_NP_v84_1_catalogos.xlsx` (Productos, Clientes, Acabados, Procesos, RackTypes, Métricas, etc.) y popula los rangos nombrados de la plantilla activa con datos frescos. El usuario instala manualmente igual que Module1 v11 (Alt+F11 → Module2 → reemplazar todo el contenido). Sin deploy a `remote/` ni a `gh-pages` porque el .xlsm no se distribuye desde GitHub Pages.

#### VBA Module1 v11: hardening del exportador de CSV (2026-05-19, sin deploy — vive en el .xlsm)
Refactor de la macro `ExportarCSV()` de `Plantilla_Cotizaciones_y_NP_v84_1.xlsm` para producir CSVs deterministas que sobrevivan el flujo de resume tras crash de `bulk-upload` 1.0.0. Archivo nuevo `VBA_Module1_v11.txt` en la raíz del proyecto (los `VBA_*v10.txt` y `VBA_*v84.txt` viejos fueron eliminados en este ciclo; quedaron solo los 5 archivos v10 activos + el v11 nuevo).

**5 cambios al v10:**

1. **Validación de Modo (G1) + QuoteName (G3)**. Bloquea export si G1 no es `COTIZACIÓN+NP`/`SOLO_PN`, o si COTIZACIÓN+NP no trae quoteName en G3. Normalización Ó→O para tolerar Excel-Mac (que pierde acentos en algunos casos) vs Excel-Win.
2. **Cliente único en COTIZACIÓN+NP.** Si la plantilla mezcla varios clientes por error, aborta. Una cotización vive bajo un solo customer; mezclar rompe el flujo del modal `modify`. Hasta 6 clientes listados en el mensaje de error para diagnóstico rápido.
3. **Orden determinístico (Cliente, PN) en libro temporal antes del SaveAs.** Sin esto, dos exports del mismo dataset producen byte-strings distintos si el usuario re-ordena entre crashes, y el `runKey = sha256(csv)` se invalida. El sort vive en `tmpWs` (no en `ws`) para no tocar el orden visual de la hoja Upload del usuario.
4. **Sugerencia inteligente de nombre de archivo** según modo + fecha (`solopn-yyyymmdd-hhnn` o `<quoteName>-yyyymmdd`). El timestamp en el nombre **NO afecta runKey** (que se calcula sobre el contenido del CSV, no el filename). Solo ayuda al usuario a distinguir archivos en Descargas.
5. **Aviso si SOLO_PN > 2,000 filas.** Recomienda chunkear antes de exportar. El usuario puede confirmar continuar — pero se le advierte que el run será largo y dificulta el resume.

**Lección clave del ciclo VBA:**
- **Determinismo del CSV es responsabilidad del exportador, no del applet.** El applet calcula `sha256(csvText)` sin manipular nada. Si el VBA emite filas en orden distinto entre exports, el runKey cambia y el resume no aplica. Mover el sort a VBA (no al applet) tiene dos ventajas: (1) byte-exact garantizado en la fuente, (2) el applet no necesita complicar su parser. Aplica a cualquier futura integración Excel↔extensión donde haya state persistente keyed por hash del input.
- **`SaveAs FileFormat:=62` (CSV UTF-8) ya emite CRLF estable en ambos OS.** No requiere conversión manual de line endings. Único caveat: Excel-Win agrega BOM `EF BB BF` al inicio, Excel-Mac a veces no. Esto puede dar runKeys distintos entre máquinas, pero si el usuario siempre exporta desde la misma máquina, es consistente. No-bloqueante para MVP.
- **Limpieza de versiones viejas en el repo.** Antes del ciclo había 7 archivos VBA en root: 5 v10 (vigentes) + `VBA_Module1_v84.txt` (61 cols, layout name en C4 — superseded) + `VBA_Module2_RefrescarListas.txt` (lee catálogos desde hojas internas en vez del archivo externo — superseded). Eliminados con `rm`. Ahora son 5 v10 + 1 v11 (Module1) = 6 archivos activos.

**Files tocados (sin deploy, solo en `main`):**
- NUEVO `VBA_Module1_v11.txt` (~175 líneas) — reemplazo de `VBA_Module1_v10.txt` en la macro Module1 del .xlsm.
- ELIMINADOS `VBA_Module1_v84.txt`, `VBA_Module2_RefrescarListas.txt`.
- SIN cambios en el .xlsm todavía (el usuario debe abrir Plantilla, Alt+F11, borrar contenido de Module1 y pegar el v11).

**Pendientes derivados (no bloqueantes para corrida):**
- El usuario debe instalar manualmente el v11 en el .xlsm antes de exportar los 4 CSVs (paso documentado en el chat de la sesión).
- Después de la corrida completa exitosa, considerar promover el v11 a `VBA_Module1_v10.txt` (renombrar) para que sea la versión "vigente" sin confusión de números — o cambiar la convención de naming a sin sufijo de versión + git tags.
- Tests automatizados del parser CSV del applet (item ya en pendientes del audit pre-producción).
- Eliminar duplicación de la lógica de "limpiar caracteres inválidos" entre `csvName` y `baseName` en VBA — quedó ligeramente redundante pero funcional.

### `hash-scanner`: lecciones 0.6.22 → 0.6.23 (autosuficiencia de `scan_results_*.json`)
Refactor en 9 fixes para que un solo `scan_results_*.json` sirva para construir applets sin pedir nuevos payloads/responses/hashes al usuario en consola. Antes el scanner tenía gaps silenciosos (truncados, depth caps, denylists, no captura de errors/headers/timing) que forzaban round-trips. Driver del refactor: TDD con tests explícitos en `tools/test/hash-scanner.test.js` (23 tests passing). Detalles por bug:

- **#1 `init()` rebuilding maps from scratch.** `knownHashMap = {}` reasignaba la referencia, así que cualquier consumer que hubiera guardado el ref viejo (incluyendo `_internal.knownHashMap` para tests) leía datos stale. Fix: mutar en place con `Object.keys(map).forEach(k => delete map[k])` antes de repoblar. Aplicable a cualquier singleton con maps que se re-inicializan: si exportas el ref vía `_internal`, mantén la identidad del objeto.
- **#2 Hashes truncados a 12 chars en `api-knowledge.js`.** Líneas 35/52/86 hacían `.slice(0,12) + '…'` "para legibilidad" en consola, lo que rompía cualquier uso programático (re-disparar desde DevTools, copiar a config.json). Fix: devolver el hash completo o `null` cuando no hay. Regla general: si una capa de presentación trunca datos, NUNCA lo haga el data layer — el truncado va en el UI consumer.
- **#3 Op-level redaction era over-blanking.** El regex `SENSITIVE_OP_PATTERN = /email|invoice|send|preview|attach|cfdi/i` borraba TODAS las variables de cualquier op cuyo nombre matcheara, incluyendo IDs, filtros, paginación — datos que no son secretos y que son cruciales para repro. Lo que sí protege secretos es la key-level redaction (que sigue intacta: `body|rawBody|html|token|...`). Quitar el op-level no degrada seguridad; sí mejora utilidad. Lección: las denylists basadas en nombre son demasiado anchas; la redacción por shape (key name + valor) es más quirúrgica.
- **#4 `analyzeSchema` con depth cap 4 + truncado `"..."`.** Schemas reales de Steelhead (ej. `ReceivedOrder` con `lines → lineItems → partTransforms → ...`) tienen 6-7 niveles. El cap los mochaba con `"..."` literal y se perdía la firma de los leaves. Fix: sin cap, con cycle guard via `WeakSet`. Añadido `mergeSchema(a, b)` para enriquecer el schema entre llamadas (la primera respuesta puede traer arrays vacíos `[null]`, una respuesta posterior con `[{id:1}]` enriquece a `[{id:'number'}]`). Marker `[null]` para arrays vacíos en lugar de string `"[]"` (distingue "vacío de tipo desconocido" de "string literal `[]`"). Reconstrucción de `responseFields` desde el schema mergeado cada vez (no append crudo).
- **#5 `variablesSamples` cap 3 + dedup por `JSON.stringify`.** El cap de 3 era miope para ops con paginación o filtros variados. El dedup por stringify trataba `{id:1}` y `{id:2}` como distintos (no útil — misma shape). Fix: cap 10 + dedup por `shapeSignature(value)` (recursive sorted-keys + type signature). `{id:1, name:'foo'}` y `{id:99, name:'bar'}` colapsan a 1 entry; `{id:1, extra:true}` agrega entry distinta. Ahora dedupea por **forma**, que es lo que sirve para "qué shape de variables acepta esta op". El `_sigs` Set se strippea en `getResults()` para no leakear set internals.
- **#6 Raw response samples para repro.** Antes solo había schema (tipos), nunca data real. Para repro en consola hace falta un ID válido. Fix: `responseSamples: []` cap 2 entries, cada una el `responseData.data` sanitizado vía `sanitizeValue` (mismas reglas de key redaction). 2 es suficiente para tener 2 IDs distintos si los hay sin inflar el JSON.
- **#7 Sin captura de errors/HTTP status.** Hashes deprecados (ver lección "Persisted queries deprecadas" arriba) responden con HTTP 400 + `{errors:[{message:"Must provide a query string."}]}`. El scanner antes ignoraba ambos, así que no había forma de detectar deprecaciones desde el JSON. Fix: `lastHttpStatus`, `errorSamples[]` (cap 3, cada uno el array `errs` completo sanitizado), `errorCount` acumulado. Detectar deprecación = `lastHttpStatus === 400 && errorCount > 0`.
- **#8 Sin URL ni Apollo client version.** Algunos debugs requieren confirmar que el header `apollographql-client-version` viaja como `"4.0.8"` y que la URL es el endpoint canónico. Fix: `url` y `apolloVersion` capturados del request. Soporta `Headers` instance (`headers.get(...)`) y plain object (`headers['apollographql-client-version']`).
- **#9 Sin event log cronológico.** Antes `discovered[op]` colapsaba todas las llamadas a una op en una sola entry sin orden ni timing. Algunas investigaciones requieren saber "qué llamada vino antes" (ej. invalidar caché tras una mutation, race conditions, cold start sequence). Fix: `eventLog[]` append-only con `{ts, op, varsSig, ok, status}`, cap 2000 (drop oldest). Se expone vía `getResults()` que ahora devuelve `{ ops, eventLog }` en vez de solo `ops`. Consumers de `background.js` actualizados en 4 callsites.

**Meta-lección del ciclo:** el scanner era "good enough" hasta que vi 4-5 sesiones consecutivas donde le pedía al usuario re-capturar algo que en teoría el scanner ya debía tener. Cada gap silencioso (truncado, depth cap, denylist, "no, eso no lo capturo") cuesta una iteración futura. Un TDD pass disciplinado con tests que afirman explícitamente "el hash completo está aquí", "el responseSamples[0].id existe", "errorSamples está poblado cuando status=400" surfacea esos gaps de golpe. La inversión en cobertura del scanner reduce iteraciones en TODOS los applets futuros, no solo en uno. Política a futuro: cuando un applet necesite un dato que el scanner no tiene, agregar el campo al scanner antes de hardcodear el dato — capitaliza el trabajo en la herramienta, no en el caso de uso.

**Verificación rápida del JSON (jq):**
```bash
JSON=~/Downloads/scan_results_*.json
jq '.ops | to_entries | map({op: .key, hash_len: (.value.hash|length), samples: (.value.variablesSamples|length), responseSamples: (.value.responseSamples|length // 0), httpStatus: .value.lastHttpStatus, errs: .value.errorCount}) | .[0:5]' $JSON
jq '.eventLog | length' $JSON  # → 30+ para sesión normal
```

### Low-code hooks de Steelhead (Power Tools): `rowKey` como handle de WO por crear (2026-05-15, `ordendeventa.ts`)
Los Power Tools de Steelhead exponen hooks TS (`getReceivedOrderCustomization`, `getInvoicePricing`, etc.) cuyo `LowCodeResult` declara campos como `workOrderLabels: { workOrderId: number, labelId: number }[]`. El typedef obliga `workOrderId: number`, pero en flujos donde la WO **aún no nace** (ej. "Add Parts to Sales Order") el `row.workOrder` viene como placeholder:

```ts
row.workOrder = {
  name: "New WO#1",                              // visual del dropdown
  fromRowKey: "29917336-b496-4a3b-a05c-...",     // no está en el typedef
  createdBy: { id: 11973, name: "..." }           // del usuario, no del WO
}
// no hay row.workOrder.id porque la WO no existe aún
```

**Hallazgo**: el runtime de Steelhead acepta `{ rowKey, labelId }` en `workOrderLabels` (mismo patrón que `partNumberWorkOrdersToGroup`, donde `rowKey` ya es el handle oficial). Etiqueta la WO al momento de nacer. Hay que castear a `any` porque el typedef no lo declara:
```ts
result.workOrderLabels!.push({ rowKey: group.rowKey, labelId: loteLabel.id } as any);
```
Verificado: la etiqueta `Lote` aparece en la WO 2503 recién creada al guardar.

**Generalizable**: cuando un campo de `LowCodeResult` pide un id pero estás en flujo "create" (sin id todavía), prueba `rowKey` casteado antes de descartar. Si el typedef de TS lo prohíbe pero existe un campo hermano que sí usa `rowKey` como handle (`partNumberWorkOrdersToGroup`), es señal fuerte de que el runtime acepta el mismo patrón en otros.

**Diagnóstico del shape**: `helpers.log` parece no imprimir en el panel "Test" del Power Tool (al menos no en este flujo). Atajo: dumpear el shape en un `helpers.addErrorMessage` temporal (`severity: 'info'`) con `JSON.stringify(...)` — sale directo en el UI. Se quita cuando el dato esté claro.

**Otras lecciones del mismo ciclo (`ordendeventa.ts`, lote mínimo + NP Desconocido):**
- **Piezas pedidas en "Add Parts to Sales Order"**: `row.lineItems` viene vacío (las líneas se crean al guardar). Las piezas reales son `row.quantity / row.selectedUnitConversion.factor + sum(row.inventory[].depleteQuantity)`. Si calculas desde `row.lineItems` el lote mínimo nunca se dispara.
- **"PN tiene proceso default"**: `partNumber.partNumberTreatment` viene vacío incluso cuando el PN sí tiene proceso. La señal confiable es `row.process != null` (Steelhead lo auto-rellena del default del PN).
- **`specFieldParam` para rango de Espesor**: el shape NO trae `.name` con el rango como string; trae `minimumValue` + `maximumValue` numéricos (y `targetValue` opcional). Construir `"${min}-${max}"` directamente, no caer al `name` que es undefined.
- **Etiquetas en PN vs en WO**: `LowCodeResult` no tiene canal para escribir `partNumberLabels` (solo lee). Probadas 3 formas casteadas a `any` en `getReceivedOrderCustomization` (2026-05-15) — todas aparecen sanas en el output del test pero ninguna aplica al backend al presionar Save:
  - `(result as any).partNumberLabels = [{partNumberId, labelId}]` (top-level inexistente)
  - `partNumberUpdates.push({partNumberId, labels: [labelId]} as any)` (extender con `labels`)
  - `partNumberUpdates.push({partNumberId, partNumberLabels: [{id, name}]} as any)` (shape exacto del input)

  `partNumberUpdates` solo acepta `customInputs` para escritura. A diferencia de `workOrderLabels` (donde `rowKey` sí se proyectó como canal alterno), aquí ningún cast funcionó. Para "NP Desconocido" (PN sin proceso o sin spec) el operador etiqueta manual; el mensaje del hook lo guía. Si en el futuro se necesita etiquetar PNs desde código, hay que abrir otro canal (mutation GraphQL desde un applet de extensión).
- **Consolidación de mensajes por severidad**: el UI de Steelhead apila cada `addErrorMessage` como row del alert panel. Si tienes N PNs con N issues, juntar chips por severidad en una sola llamada por bucket (`error`, `warning`, `info`) evita saturar el panel. Patrón: array de chips por bucket → `addErrorMessage({severity, message: bucketChips.join(' | ')})` al final.
- **Multi-fuente para detectar precio default**: `row.lineItems[].unitPrice` viene en algunos flujos pero **sin `unit` asociado** (visto en "Add Parts to Sales Order"). No condicionar la captura a `li.unit`; caer a `row.selectedUnitConversion.unitByUnitId` como unidad. Y agregar fallbacks: `row.unitPrice` (string, populado cuando hay precio default activo) → `row.quotePartNumber?.priceDollars` (de la quote vinculada). Si exiges `li.unit`, los PNs con precio default sin lineItem-unit reportan falsamente "Sin precio default".
- **Distinguir "precio asignado" de "precio positivo"**: `unitPrice === 0` es un valor válido en ciertos casos (ej. excepciones comerciales — Schneider Electric México en Javier Rojo Gómez requiere $0). El flag `priceAssigned = unitPrice != null` (incluye 0); el flag `hasPositivePrice = unitPrice > 0` (para mostrar monto de lote mínimo). Mezclar los dos lleva a falsos negativos.
- **Validaciones de precio NO dependen del groupMap del lote mínimo**: si el groupMap se crea solo cuando hay conversión LO, todas las validaciones que viven en el group loop (sinPrecio, excepciones comerciales) se brincan para PNs sin conversión. Patrón correcto: el groupMap se crea **siempre**, `piezasPorLote` se vuelve nullable, y solo el bloque `aplicaLoteMinimo` requiere `piezasPorLote != null`. Captura en `ordendeventa.ts` (2026-05-15) cuando el usuario borró la conversión LO para probar y desapareció el warning de "Sin precio default" — no era bug del warning, era que el path nunca corría.
- **Excepción de cliente por nombre + ship-to**: `inputs.customer.name` y `inputs.receivedOrder.shipToAddress.address` permiten gating por cliente. Patrón case-insensitive con `.includes()` tolera variantes ortográficas ("SCHNEIDER ELECTRIC MEXICO" vs "Schneider Electric México"). Para reglas atadas a una bodega del cliente, también checa el ship-to (ej. Schneider tiene varias plantas; solo "Javier Rojo Gómez" requiere $0).

## Archivos scan_results
- Los `scan_results_*.json` generados por el hash-scanner se descargan al folder de Descargas del navegador (típicamente `~/Downloads`)
- **NUNCA** copiarlos al repo — están en `.gitignore` pero además su contenido puede incluir payloads sensibles redactados
- Cuando necesites analizarlos con Claude, léelos directamente desde `~/Downloads/scan_results_*.json`
- El hash-scanner sanitiza variables desde `remote/scripts/hash-scanner.js` (redacta tokens URL, keys sensibles y trunca strings largas), pero la defensa en profundidad manda: no los muevas al repo

## Seguridad (estado y pendientes)

### Ya implementado (2026-04-14, actualizado 2026-05-14)
- `hash-scanner.js` sanitiza `variablesSamples` con redacción **key-level** (recursiva: `body`, `rawBody`, `html`, `htmlBody`, `token`, `accessToken`, `authToken`, `emailData`, ...), strip de `?token=` en URLs, truncado > 500 chars, y re-saneado en `mergeResults`. (El antiguo op-level denylist `email|invoice|send|...` se quitó en 0.6.23 — era demasiado ancho; la protección real viene de la key-level. Ver bitácora `hash-scanner: lecciones 0.6.22 → 0.6.23`.)
- `responseSamples` y `errorSamples` aplican el mismo `sanitizeValue` recursivo antes de guardarse.
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
