# batch-name-filter — Filtrar Lote por Nombre

**Versión actual:** 0.3.0 — **VIVO en producción: config 1.11.12, tag `v1.11.12`** (firma KMS
verificada en vivo; `main = gh-pages = EN VIVO`). Bundle iPad **0.6.10**. Falta la validación
end-to-end del ciclo en vivo (ver Pendientes).
Fuente = `InventoryBatchViewQuery` paginada, `name` estructurado, y desde 0.3.0 **los DOS
universos de `hideCompleted`**. **41/41 tests** (11 nuevos sobre fixtures reales del 2026-07-29).

## 🔴 0.3.0 (2026-07-29) — `hideCompleted` no esconde: SELECCIONA universo, y son DISJUNTOS

Reporte del operador: *«mi filtro de lote de Packing Slips está sin funcionar, simplemente no
hace nada cuando le doy enter»*.

**No era ninguno de los sospechosos.** Descartados con evidencia, en este orden: el hash
(`InventoryBatchViewQuery` vigente — validación del día 17:28, **0 stale** de 249), el deploy
(main = gh-pages = vivo = 1.11.8, invariante byte-a-byte ✓), el gate por URL (los 3 scripts
cargan y `isShippingUrl` da `true`), el montaje del box (aparece en el header junto a KGM/LBR) y
el glue completo (con un lote del universo correcto el preview y la URL se construyen bien).

**La causa raíz, medida en vivo (dominio 344):** el parámetro `hideCompleted` de
`InventoryBatchViewQuery` **no es un "esconder los completados"** —donde `false` sería el
superconjunto—. Es un **SELECTOR DE UNIVERSO**, y los dos universos son **disjuntos**:

| `hideCompleted` | universo | lotes | `totalRemainingMicroQuantity` |
|---|---|---|---|
| `true` | **con material** | 585 (4.3%) | 200/200 ≠ 0 |
| `false` | **agotados** | 12 926 (95.7%) | 200/200 = 0 |
| | **solape** | **0** | unión = 13 511 = todo el inventario |

Comprobado por pares, no por inferencia: `T-233`/`T-232`/`2907202601` → **1 con `true`, 0 con
`false`**; `T-125` → **0 con `true`, 20 con `false`**. El nombre del parámetro miente.

Consultando solo `true`, el applet **no veía el 95.7% de los lotes**. Buscar «T-125» devolvía 0
aunque existen 20 —y el **dropdown NATIVO de SH sí los ofrece**, verificado con `FilterSearch`:
10 items con sus dbIds—. El panel decía «Sin lotes «T-125»» (falso) y `applyCurrent()` retornaba
sin ids: **eso es el "no hace nada"**.

**Por qué apareció con el TIEMPO y no de golpe** — la parte que explica el reporte: un lote
nace en el universo CON MATERIAL y **se muda** al de AGOTADOS al consumirse. El applet solo
servía para lotes frescos. Por eso su validación del 2026-07-22 pasó (C-21568 tenía material
ese día) y una semana después el mismo flujo ya no encontraba nada. **Un applet puede pasar su
validación en vivo y estar roto por diseño si el dato de prueba era el caso favorable.**

**Lección de método (la de fondo):** la premisa vieja —«en Packing Slips los lotes completados
no se pueden filtrar, así que traerlos es inútil»— nunca se verificó contra el ERP; se adoptó
como justificación de un flag cuya semántica se supuso por su NOMBRE. Y era doblemente falsa:
ni `false` significa lo que parece, ni «no se pueden filtrar» es cierto (el nativo los ofrece).

### El fix
- **Se consultan AMBOS universos y se unen** (`SEARCH_UNIVERSES`).
- **El preview DISTINGUE en vez de esconder.** `· agotado` por renglón, desglose «N con
  material, M agotados», los con material primero, y aviso explícito cuando todos están
  agotados. Verificado en vivo: aplicar los 10 chips T-125 **sí filtra** y la lista sale
  vacía porque ya no tienen piezas por enviar — «20 lotes, todos agotados» **explica** ese
  vacío; «Sin lotes» lo ocultaba tras una mentira.
- `isDepletedBatch` → `true`/`false`/**`null`** si falta el dato. Ausente no es agotado (mismo
  fail-safe que no asumir 1 pieza por carga cuando `partsPerRack` no existe).
- **Guardarraíl de volumen**, porque duplicar el universo duplica el tráfico: mínimo de 2
  caracteres (`searchQuery:'T'` = **12 793** lotes), tope `tooBroad` por `totalCount`
  (`searchQuery:'T-1'` = **1 009** → pide el nombre completo en vez de bajar 5 000), cap de
  páginas que **se reporta**, `alive()` que corta las páginas en vuelo de una búsqueda ya
  reemplazada, y debounce 300→450 ms.

### ⚠️ Incidente durante la validación (vale como advertencia de método)
Validando el fix **colgué el `/graphql` de la sesión** con una ráfaga de 5 búsquedas × 2
universos sin espera: el renderer dejó de responder (`Runtime.evaluate` timeout ×3) y **no se
recuperó al recargar la pestaña** — es el modo de falla ya documentado en `po-listing-filters`
(~40-45 requests, sin 429 ni error, **límite por SESIÓN, no por pestaña**). Al validar contra
el ERP productivo: **una búsqueda a la vez**. El guardarraíl del applet acota a ≤6 requests por
búsqueda; lo que colgó la sesión fue el arnés de prueba, no el applet.

### Pendientes
- [x] **Deploy** — hecho: **config 1.11.12, tag `v1.11.12`**. Cerró de paso una **deriva de 3
      versiones** (gh-pages llevaba horas en 1.11.8 mientras `main:remote/` iba en 1.11.11, con
      los fixes de este applet y de `spec-migrator` commiteados pero sin publicar). Verificado
      en el código SERVIDO, no solo en el config: el core vivo define los 5 símbolos nuevos y
      el glue vivo los consume.
- [ ] **Validar el ciclo end-to-end en vivo** con el código deployado (teclear → preview con
      desglose → Enter → chips). **No se pudo cerrar en esta sesión: el `/graphql` seguía
      colgado del incidente de más abajo.** Lo verificado contra el servidor real ANTES de
      colgarlo: la unión de universos, los 20 T-125, la clasificación y que los chips se
      aplican.
- [x] **Bundle iPad 0.6.10** — verificado EN EL ARTEFACTO (los 5 símbolos pasaron de 0 a
      presentes; `node --check` OK; `build-safari` 10/10) y sincronizado a `Resources/`.
      **Falta recompilar en Xcode** (el bundle es estático). En el iPad este fix pesa doble:
      el operador de piso busca lotes VIEJOS para revisar, que son justo los que caían en el
      universo escondido.
- [ ] `tools/archive-inventory-batch-statuses.js` llama esta misma query **sin pasar
      `hideCompleted`** (usa el default del server) para su detector de "lotes en uso". Según
      cuál sea el default, el conteo puede quedar parcial. Falla ruidosa (la mutación truena),
      no silenciosa → no urgente, pero conviene fijar el flag explícito.

---

## Historia previa (0.2.1)

**Versión:** 0.2.1 — VIVO y validado end-to-end en producción (config 1.7.169).
Fuente = `InventoryBatchViewQuery` (paginada, `name` estructurado, `hideCompleted:true`) →
**supera el tope de 10** (probado con 18 T-125) y matching exacto robusto (adiós regex + colisión
numérica). **30/30 tests.**

**Validación en vivo (2026-07-22):** box en el header ✓; teclear un nombre → preview con la lista
`#idInDomain — name` ✓; Enter → chips aplicados (probado: "C-21568" → 3 chips `#16083/#14635/#12780`) ✓;
panel `position:fixed` (no recortado por el `overflow:hidden` del header) ✓.

**Historial de deploys:** 1.7.167 (MVP FilterSearch ≤10) → **1.7.168** (Fase 2: InventoryBatchViewQuery
+ fix panel) → **1.7.169** (fix lista del preview: nodos sin `display` → `#idInDomain — name`).

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

## ✅ Fase 2 RESUELTA (>10 lotes por nombre) — `InventoryBatchViewQuery`

La fuente correcta (la encontró el usuario en el scan `2026-07-22_090514`): **`InventoryBatchViewQuery`**
`e4fc4cdf098f41e10881a512e63ce6fb068bcd8d5bd57b8627c86e5fda025d44`.
- Variables: `{ includeArchived:'NO', hideCompleted:true, orderBy:['CREATED_AT_DESC'], offset, first, searchQuery }`.
- Respuesta: `data.pagedData.{ totalCount, nodes:[{ id(=dbId), idInDomain, name }] }`.
- **`searchQuery`** filtra por substring del name; **`first`/`offset` paginan de verdad** (sin tope de 10).
- El **`name` es estructurado** → matching exacto en cliente (`selectByExactName`), sin regex ni
  colisión numérica. `name` limpio = "T-125" / "487577".

**Validado en vivo (2026-07-22):** `searchQuery:'T-125'` con `hideCompleted:false` → **18 lotes**
T-125 (vs 10 de FilterSearch = supera el tope); con `hideCompleted:true` → 1 (el único no-completado).

~~**Decisión de producto (usuario):** en producción `hideCompleted:true` — en Packing
Slips/Scheduling los lotes **completados no se pueden filtrar** (no muestran piezas), así que
traerlos es inútil + menos eficiente.~~ **❌ REFUTADO el 2026-07-29 — era LA causa del bug.**
Doblemente falso: (1) `hideCompleted:false` no "incluye además", es el **complemento disjunto**,
así que `true` no era "lo mismo pero más limpio" sino **otro universo** (4.3% del inventario);
(2) los lotes agotados **sí se pueden filtrar** — el dropdown nativo los ofrece y aplicarlos
produce chips válidos. Ver §"0.3.0" arriba. El cap de 25 páginas también se retiró (era
5 000 lotes por búsqueda contra un `/graphql` que se cuelga a ~45 requests).

**Discovery headless de esta query:** llamarla SIN `searchQuery` devuelve los ~10k lotes y congela el
renderer; con `searchQuery` filtrando la respuesta es chica y no congela. Por eso antes fallaba.

**FilterSearch queda como fuente legada** (aún en el Core/tests para referencia); el glue usa
InventoryBatchViewQuery. El hash `FilterSearchInventoryBatch` sigue en config pero ya no se consume.

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

## Safari/iPad
En el bundle desde **v0.5.9** (2026-07-23); **v0.6.10** (2026-07-29) lo trae con el fix 0.3.0 de
los dos universos. Verificado en el artefacto: `SEARCH_UNIVERSES`/`isDepletedBatch`/
`planPagination` ×4, `shouldWarnAllDepleted` ×3, `fetchUniverse` ×2 y `DEBOUNCE_MS = 450` — los
seis en **0** antes del rebuild. 1 600 211 bytes. (Recordatorio: `build-safari.sh` imprime
**caracteres**, no bytes — compara los bloques `BEGIN/END`, no el número que imprime.) Clasificación: **directo / autoInject / sin lanzador** — el box inline se
auto-inyecta en el header del Panel de Envío por su propio gate (`autoInject:true`), así que basta agregar el `id` a
`safari/bundle.json.applets[]`; no requiere cablear `LAUNCHERS`/`LAUNCH_FN`. Sin bloqueadores iOS: intercepta/consulta
vía `fetch` nativo (`InventoryBatchViewQuery`) y aplica por **recarga de la SPA** (compatible con Safari), sin
`a.download`, sin portapapeles, sin `chrome.storage`. Deps en el bundle: `steelhead-api.js`, `batch-name-filter-core.js`,
`batch-name-filter.js`. **Tras editar el applet → recompilar en Xcode** (el bundle es estático).
