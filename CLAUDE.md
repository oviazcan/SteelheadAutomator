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

### `process-canon`: lecciones 0.5.52 → 0.5.56 (movidas a `docs/processes-architecture.md`)
La construcción de árboles de procesos para `ProcureTree` y todas las lecciones del ciclo de fix tienen su propia doc. No duplicar aquí.

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
