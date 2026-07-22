# batch-name-filter — Filtrar Lote por Nombre

**Versión actual:** 0.1.0-wip — **Core + golden test 25/25 y glue escritos** (sintaxis OK). **PENDIENTE:** registrar el app + hash en `config.json`, firmar (KMS) y deploy (requiere aprobación del usuario). **Fase 2 (>10) BLOQUEADA** (ver abajo).

## Decisiones de comportamiento (definidas con el usuario 2026-07-21)
- **Reemplazar** el filtro de lote actual al aplicar (no acumular).
- **UX:** preview en vivo mientras escribe + **Enter aplica automático** (sin botón separado).
- **>10 es FRECUENTE** → el tope de 10 de FilterSearch NO alcanza; se requiere la Fase 2.

## Apply: por RECARGA de la SPA (pushState descartado)
Validado en vivo: `window.location.assign(<url con inventoryBatchIdFilter>)` re-filtra limpio.
`history.pushState + PopStateEvent('popstate')` **congela** el panel al re-filtrar en caliente
(~15s+), así que el glue aplica por recarga completa (confiable, ~5s). Mejorar a apply suave =
follow-up.

## Anclaje del box en el header (capturado en vivo)
El header del Panel de Envío es un `div.MuiPaper-root` con `display:flex; flex-direction:row` y
6 hijos: `[☰, div, "Panel de Envío", div, <bloque KGM/LBR + filtros>, TextField-buscador]`. El box
se inyecta **antes del hijo que contiene el toggle "KGM"/"LBR"** (códigos de unidad → anclaje
estable, no depende del idioma). Fallback: append al header.

## ⛔ Fase 2 (>10 lotes por nombre): BLOQUEADA — requiere sesión interactiva
El tope de 10 es de `FilterSearch` (autocomplete). Para superar el tope hay que leer una query de
inventory batches sin-tope. **Discovery headless NO viable:** `InventoryBatchViewQuery` /
`GetInventoryBatch` / la pantalla `/Domains/<id>/Inventory` devuelven TODO el inventario sin filtro
y **congelan el renderer** (probado repetidamente, incl. con AbortController + stream reader). La
única vía es capturar la query **ya filtrada por nombre** cuando el OPERADOR aplica el filtro en la
UI real (dataset reducido). Requiere una sesión corta con el usuario en la pantalla de Inventario.
Candidatas con hash conocido (samples vacíos en el scan): `InventoryBatchViewQuery`
`e4fc4cdf098f…`, `InventoryManagementQuery` `08b13f9dbc1a…`, `SearchInventoryItemsFilter` `0014563a…`.

## Qué es / problema

En el **Panel de Envío** (`/Domains/<id>/Shipping`, "Shipping"/"Packing Slips") el filtro nativo
**"Lote de Inventario"** identifica cada lote por su **id de BD** (opaco, no transparente). Muchos
lotes **comparten el mismo nombre visible** (p.ej. "T-125", o nombres **numéricos** como "487577")
pero tienen id distinto. Hoy el operador tiene que **clic-ear uno por uno** cada lote homónimo para
armar el filtro-unión.

**Objetivo:** un cuadro de búsqueda propio en el header del panel donde el operador teclea un
**nombre de lote** y se seleccionan **de un jalón todos los lotes con ese nombre exacto**.

Es un **filtrado read-only del lado cliente** (cambia la URL de filtrado) — **cero mutaciones, cero
riesgo de datos**.

## Los 3 IDs de un lote (aclaración del usuario, confirmada)

| ID | Ejemplo (chip `#16495 - 5310`) | ¿En la URL de filtro? |
|---|---|---|
| **name** (el que se busca) | `5310` / `T-125` / `487577` (puede ser numérico) | ❌ |
| **idInDomain** (consecutivo, `#16495`) | `16495` | ❌ |
| **id de BD** (registro, no transparente) | `1412144` | ✅ = `inventoryBatchIdFilter` |

## Mecanismo — validado EN VIVO 2026-07-21 (Ecoplating TLC dom 344, read-only, Claude-in-Chrome)

1. **Apply por URL.** El panel filtra por
   `…/Domains/344/Shipping?inventoryBatchIdFilter=<dbId>,<dbId>,...&offset=0`.
   SH deriva los chips (`#<idInDomain> - <name>`) y filtra **solo de la URL**.
   *Prueba:* naveguè con `inventoryBatchIdFilter=1412144,1412143` → salieron exactamente los 2
   chips `#15325 - T-125` y `#15326 - T-125`.

2. **Mapeo name→dbIds vía persisted query `FilterSearch`.** Es la fuente del propio dropdown nativo.
   - `operationName`: `FilterSearch`
   - `variables`: `{ key: "inventoryBatchIdFilter", searchQuery: "<texto>" }`
     — el `key` es **texto plano** (= nombre del parámetro de URL), no un token opaco.
   - `hash`: **`1cdd9e39a0ac44d491910f8c1727154d6859fd2eabe49d619f06d54e926d2bc9`**
   - respuesta: `data.tableFilterSearch: [{ display, identifier }]`
     - `identifier` = **el id de BD** que va a `inventoryBatchIdFilter`.
     - `display` = `"<idInDomain><name> (<pn>)"` — **SIN separador** entre idInDomain y name.
   *Prueba:* replay directo del fetch con ese hash → `status 200`, 10 items con los mismos ids.

3. **Límite duro de 10.** `FilterSearch` devuelve **máximo 10** resultados y **NO pagina**
   (`offset` es ignorado: offset:0 y offset:10 devuelven los mismos 10). Es el mismo tope que ve el
   popover nativo. → si un nombre tiene >10 lotes elegibles, se cubren solo 10 (ver Limitaciones).

### ⚠️ Dos variantes de `FilterSearch` (mismo operationName, hash distinto)

`config.json` ya tiene `FilterSearch = 52869c2e78906b009589e441c218bcbfc60f2cf5550399b32db74fc266ffa6de`
(usado por `spec-migrator` para "buscar cliente/etiqueta"). La variante de **este** filtro
(campos `display`/`identifier`, key `inventoryBatchIdFilter`) tiene un hash **distinto**:
`1cdd9e39…926d2bc9`. Son documentos distintos con el mismo operationName. **El applet DEBE usar
`1cdd9e39…`** (expuesto en el Core como `FILTER_SEARCH_HASH`), no el de config. Pendiente de
implementación: hacer que el glue pase el hash literal a `SteelheadAPI.query` (no la key de config,
que resolvería la variante equivocada). No verificado si `52869c2e…` sigue vivo para spec-migrator.

## Ruta de auto-captura del hash (regla de proceso del repo)

Para regenerar el hash de esta variante de `FilterSearch` cuando SH lo rote:
`goto /Domains/<domain>/Shipping` → clic en el menú **"+N"** de filtros → **"Lote de Inventario"**
→ teclear cualquier texto en el input del popover → el front dispara
`FilterSearch({key:"inventoryBatchIdFilter", searchQuery:<texto>})`. Interceptar por `operationName`.
Pendiente: registrar esta ruta en `tools/hash-autopilot/route-catalog.json` (query `shipping-list`
ya existe pero no captura `FilterSearch`; añadir un paso que abra el filtro de lote).

## Arquitectura

- **`remote/scripts/batch-name-filter-core.js`** (puro, sin DOM/red) — **HECHO**, 25/25 tests:
  - `selectExactMatches(items, name)` → `{ ids, count, atLimit }`. Filtro por **nombre exacto**:
    `matchesExactName` ancla el name como sufijo tras los dígitos del idInDomain (`/^\d+<name>$/`
    sobre el display sin ` (pn)`), lo que distingue "T-125" de "T-1250"/"T-1256" **y** funciona con
    names numéricos (no depende de separar idInDomain del name).
  - `buildFilterUrl(currentUrl, dbIds, mode)` — `mode` `'replace'`(default)/`'append'`, offset=0,
    coma literal, preserva otros params. `buildClearUrl` para limpiar.
  - `parseInventoryBatchIdFilter`, `isShippingUrl` (gate: Panel de Envío, NO `/Shipping/PackingSlips`).
  - Constantes: `FILTER_KEY`, `FILTER_SEARCH_HASH`, `FILTER_SEARCH_LIMIT=10`.
- **`remote/scripts/batch-name-filter.js`** (glue) — **PENDIENTE**: input dark-mode en el header
  junto a KGM/LBR; llama `FilterSearch` (hash literal); preview de confirmación; aplica navegando
  (pushState + evento con fallback a recarga); singleton `window.__saBatchNameFilter*`; gate por URL
  + re-scan en `sa-urlchange`.
- **`config.json`** — **PENDIENTE**: registrar el app (`autoInject:true`), `scripts`
  `[steelhead-api.js, batch-name-filter-core.js, batch-name-filter.js]`, firmar (KMS) y deploy.

## Limitaciones conocidas

- **Tope de 10 de `FilterSearch`.** MVP aplica los ≤10 exactos y, si `atLimit` (llegó a 10), avisa
  "10 o más — refina o aplica estos". **Fase 2:** interceptar la query de la lista de Shipping
  (`RacksReadyForShipping`/`ReceivedOrdersReadyForShipping`/`OrderFulfillmentQuery`, sin hash aún)
  para enumerar TODOS los lotes elegibles y superar el tope.
- **Colisión residual con nombres numéricos.** Como el display concatena idInDomain+name sin
  separador, un nombre numérico podría colisionar como sufijo (buscar "87577" traería un lote name
  "487577"). Muy improbable con datos reales; el **preview de confirmación** (el operador ve los
  `display`) lo mitiga. Documentado en el golden test.
- **Anclaje bilingüe.** El texto del filtro es "Filtrar por Lote de Inventario" (ES). Falta el
  string EN para el anclaje del glue (regla del repo: no adivinar traducciones). El gate y el motor
  NO dependen de texto de UI (son URL/API-driven), así que el idioma no rompe la función; solo el
  punto de inyección/label del box necesitará el par ES+EN.

## Decisiones de comportamiento pendientes (preguntadas al usuario)

1. **Reemplazar vs Agregar** al filtro existente (recomendado: reemplazar).
2. **Mini-preview vs Directo con Enter** (recomendado: mini-preview).
3. **¿Nombres con >10 lotes son frecuentes?** (define urgencia de Fase 2).

## Plan de validación en vivo (tras implementar glue + deploy)

- [ ] El box aparece en el header del Panel de Envío (ES y EN).
- [ ] Teclear "T-125" → preview con los N lotes → aplicar → chips correctos, lista filtrada.
- [ ] Nombre numérico real (p.ej. "5310"/"487577") → selecciona el grupo correcto.
- [ ] Nombre con superstring (si existe "T-125" y "T-1250") → NO se cuela el superstring.
- [ ] `atLimit` (nombre con ≥10) → muestra el aviso.
- [ ] Limpiar filtro. Reemplazar vs agregar según lo decidido.
- [ ] No interfiere con `/Shipping/PackingSlips` (invoice-autofill).
