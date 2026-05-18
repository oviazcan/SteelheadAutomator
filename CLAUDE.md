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
