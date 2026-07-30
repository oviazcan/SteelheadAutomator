# pn-specs-column — Datos del NP (specs, metal, línea, racks, unidades) en el dashboard de Números de Parte

**Versión:** 0.3.2 — **VIVO; salió en config 1.11.7 (tag `v1.11.7`) y el config vivo sigue avanzando con deploys de otros applets. VALIDADO EN VIVO por el operador** («ya quedó», 2026-07-29, con el contador marcando `50/50`). Core **42/42** golden (25 nuevos contra **fixture REAL** del PN 2300153 capturado en vivo). **0.3.2** Specs al final de la barra, racks en 2 renglones, unidades en el orden del ERP, nombre del NP realzado + fix del `<style>` que se recreaba en cada sync. **0.3.1** angostar (fuera Línea; desc+metal dentro de la celda del nombre). **0.3.0** columnas nuevas + todas AL INICIO. **0.2.1** fix del toggle que no se montaba. **0.2.0** criterio "el valor trae dígitos" + spec como link. **0.1.2** estilo. **0.1.1** 2 bugs del run real.
**Categoría:** Números de Parte · **autoInject:true** · ruta: `/PartNumbers` (index, NO la ficha `/PartNumbers/:id`)

## Qué hace

En el dashboard `https://app.gosteelhead.com/PartNumbers` agrega, **al INICIO de la tabla**, hasta **5 columnas** con un **toggle por columna** en el header (junto a "NUEVO NÚMERO DE PARTE"). Todas se alimentan de **una sola** consulta `GetPartNumber` por NP visible:

| Columna | Contenido |
|---|---|
| 🧪 **Especificaciones** | specs activas (cada una **link** a su ficha) y sus **parámetros con valor numérico** (`Espesor: 2 - 5 µm`) |
| ⚗️ **Metal base** | `customInputs.DatosAdicionalesNP.BaseMetal` (`Cobre`) — la columna nativa `Material` es otra cosa |
| 🏭 **Línea** | dimensión contable 349 (`T107-LI Plata Colgado Cx (60.0)`); la nativa existe pero cae en la columna 11 |
| 🧺 **Rack Types** | cada rack type con sus **piezas por carga** (`T102-RA02: 18 pz`) |
| 📐 **Unidades** | **todos** los factores registrados, en unidades por pieza (`KGM: 0.376 /pz`) |

El criterio de "numérico" (desde 0.2.0) es que el **valor** traiga dígitos, no el `specField.type`. Excluye parámetros y specs **archivados**. Todas las columnas arrancan **APAGADAS** (ver §0.3.0: el response pesa 5.84 MB).

## Decisión de diseño (respuesta a la pregunta original del usuario)

> «¿`AllPartNumbers` ya trae el dato para no hacer doble query?»

**No.** Verificado 2026-07-08 contra los payloads reales (`docs/api/Payload: *.txt`):

- `AllPartNumbers` (el query del dashboard) **NO trae specs ni parámetros**. Sus 98 `"SPEC"` son texto libre en `customInputs.NotasAdicionales`.
- `GetPartNumberForPartNumberPage` (liviano) tampoco: solo id/name/customer/labels.
- **Solo `GetPartNumber`** (pesado, 504 campos) expone el árbol de specs.
- Son **persisted queries** (el shape lo fija el server) → no se le pueden "agregar" campos a `AllPartNumbers`. **Sí o sí un 2º query por NP.**

Por eso el enriquecimiento es **opt-in** (toggle) y con memory-hardening completo: con el toggle ON se hace 1 `GetPartNumber` por cada NP visible (~50/página).

## Modelo de datos (dónde vive cada cosa en `GetPartNumber`)

```
data.partNumberById
  .partNumberSpecsByPartNumberId.nodes[]            ← specs asociadas
     { archivedAt, specBySpecId: { id, name } }
  .partNumberSpecFieldParamsByPartNumberId.nodes[]  ← parámetros
     { archivedAt,                                    (node: histórico si != null)
       specFieldParamBySpecFieldParamId: {
         minimumValue, maximumValue, targetValue,
         unitByUnitId: { name },                      ("µm (micrómetro, micra)")
         specFieldSpecBySpecFieldSpecId: {
           specFieldBySpecFieldId: { name, type },    (type: NUMBER|BOOLEAN|DROPDOWN|TEXT)
           specBySpecId:      { id, name } } } }
```

- `specField.name` = nombre del parámetro (**Espesor**), NO `specFieldParam.name` (ese es el rango, `"1.27 - 3.5 µm"`).
- `specField.type` = discriminador numérico/booleano.
- Variables usadas: `{ partNumberId, usagesLimit: 0, usagesOffset: 0 }` — `usagesLimit:0` aligera el response (no necesitamos los usos del PN).

### GOTCHA clave — `archivedAt` (duplicados)

Los params vienen **DUPLICADOS**: en el PN de referencia (44068-205-01), 5 archivados + 5 activos idénticos. Filtramos `node.archivedAt == null`; eso además **deduplica**. Dedup extra defensivo por `(specId, fieldName, min, max, target)`.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/pn-specs-column-core.js` | Motor puro (sin DOM/red): ruta/ids (`isPartNumbersIndexPath`, `parsePartNumberId`), formato (`unitSymbol`, `fmtNum`, `fmtFactor`, `formatRange`, `formatCellText`, `formatRackTypesText`, `formatUnitFactorsText`) y extracción (`extractSpecsWithNumericParams`, `extractMetalBase`, `buildAcctDimensionCatalog`, `extractDimensionValue`, `extractLinea`, `extractRackTypes`, `extractUnitFactors`, `extractPnRow`). Dual node/browser. |
| `remote/scripts/pn-specs-column.js` | Glue DOM: barra de 5 toggles persistentes, columnas al inicio (`moveToFront`), MutationObserver, pool de `GetPartNumber`, memory-hardening. |
| `tools/test/pn-specs-column-core.test.js` | 30 golden tests (13 sobre fixture real del PN 2300153). |

- **Toggles persistentes** (uno por columna, todos **default OFF** — no sorprender con 50 queries de 5.8 MB): `sa_pn_specs_col_enabled` (la original, se respeta el valor previo), `sa_pn_metal_col_enabled`, `sa_pn_linea_col_enabled`, `sa_pn_racks_col_enabled`, `sa_pn_units_col_enabled`. La acción del popup (`PnSpecsColumn.toggleFromPopup`) sigue apuntando a Specs; las demás solo tienen toggle en el header.
- **Columnas**: `<th>` + `<td>` por fila, **siempre al INICIO** en el orden canónico de `COLS`, reposicionadas en cada sync con `moveToFront` (idempotente). `partNumberId` sale del `<a href="/PartNumbers/:id">` de la celda Nombre y se marca en `data-sa-pnid` de cada celda nuestra.
- **React/MUI**: la tabla es `MuiTable-root` controlada por React. Un `MutationObserver` (debounce 160ms) re-inyecta la columna al paginar/ordenar/filtrar. **Validado en vivo:** insertar `<td>` extra al final de cada `<tr>` **sobrevive** el render de React (50/50 celdas persisten).
- **Estilo**: toggle/toast en **dark-mode** (UI nuestra, regla de diseño); la columna se integra a la tabla clara de SH pero **marcada con acento verde** (`border-left:3px #13a36f`) para señalar que es enriquecimiento de la extensión. Render con `textContent` (no innerHTML de datos → no XSS con nombres de spec).

## Memory hardening (skill `memory-hardening-applets`)

Importa `host-cleanup-shared.js`. Aplica porque el toggle ON dispara ~50 `GetPartNumber` pesados por página y se re-dispara al paginar.

**EJE A (propia):** cache **slim** por `partNumberId` (`window.__saPnSpecsCache` Map → `{specs, total, metal, linea, rackTypes, units}` ≈ 2 KB, **no** el response de **5.84 MB** — medido en vivo, ver §0.3.0); cache se limpia al **navegar fuera** del index; teardown de columnas/observer/pool al desactivar.
**EJE B (host):** `stopDatadogSessionReplay()` al primer fetch real; `createMemMonitor` con guardrail @88% → vacía la cola de enriquecimiento + toast (checkpoint > crash); `makePeriodicDrain(25)` (Apollo) al final de cada worker; pool con `MAX_CONC=4` + `MIN_GAP_MS=130` (~7 req/s) + retry `[0,800,2500]` solo en transitorios.

## Estado de validación (2026-07-08)

- ✅ **Core**: 14/14 golden + payload real (mayo) + **datos reales de hoy** vía fetch en vivo → `44068-205-01` → `E27550 (Plata): Espesor 1.27–3.5 µm` (excluye BOOLEAN/DROPDOWN/archivados). PN sin specs (`SWB-00496986`) → celda vacía correcta.
- ✅ **Hash `GetPartNumber`**: el de config (`8e3fdb52…`) **ROTÓ** (HTTP 400 "Must provide a query string"). Capturado el nuevo del front: **`5efd689d…`** (HTTP 200 verificado). Actualizado en `config.json`.
- ✅ **DOM en vivo**: `findHeaderAnchor` encuentra el ancla; columna inyectada (th + 50 td con pnId); **sobrevive el render de React**.
- ✅ **Deploy**: config 1.7.85 en vivo; `pn-specs-column-core.js` + `pn-specs-column.js` servidos **byte-exact** (sha256 verificado vs `main:remote/`); hash `GetPartNumber` nuevo y app presentes en el config servido.
- ✅ **Run real integrado — CERRADO el 2026-07-29** (quedó abierto desde el 2026-07-08). El operador corrió el applet completo en foreground con las columnas encendidas y el contador marcó **`50/50`** con el medidor de memoria en `338MB / 4192MB (8%)`. Lo que bloqueaba la verificación no era el applet sino el **throttling de Chrome en tabs sin foco**: desde una pestaña automatizada los `fetch` a `/graphql` se congelan (`document.hidden === true` ⇒ `inFlight` se queda clavado). **Regla para futuras validaciones de este applet: el ciclo con red se comprueba en foreground; desde automatización solo se verifica extracción y DOM** (inyectando el row al cache y forzando un sync síncrono con dos `toggle()` seguidos).

## Fixes 0.1.1 (primer run real del usuario, 2026-07-08)

Dos bugs reportados con screenshots (PNs `48186-064-50*` de SCHNEIDER ELECTRIC):

**Bug #1 — la columna se desalineaba al filtrar/paginar.** El `<th>` se insertaba con `insertBefore(lastElementChild)` (posición *relativa*) una sola vez; al re-render de React el `<th>` viejo sobrevivía y React lo reposicionaba ("flotaba") mientras los `<td>` se recreaban en la penúltima → header y chips en columnas distintas. **Fix:** la columna es SIEMPRE la **última** celda (`appendChild`), **re-posicionada en cada sync** (`if (lastElementChild !== cell) appendChild`). Invariante: `<th>` y `<td>` siempre en la misma posición (última), sin importar cómo React reordene. Validado en vivo sobre la tabla MUI real (simulando re-render + flotar → `aligned:true`, índice 15/15).

**Bug #2 — una spec ARCHIVADA (RC Ag) reaparecía; inconsistente con ASTM B700.** `extractSpecsWithNumericParams` (paso 2) creaba el bucket de la spec "al vuelo" desde un param activo. Al archivar una *spec* de un PN, Steelhead NO archiva cada `partNumberSpecFieldParam` → quedan params huérfanos activos apuntando a specs archivadas. RC Ag reaparecía (tenía un Espesor activo) pero ASTM B700 no (sin param activo) → la inconsistencia. **Fix:** `partNumberSpecsByPartNumberId` es la única fuente de verdad de specs activas; un param cuya spec no está en el mapa activo se **ignora** (no se inventan buckets). Golden test `NO resucita una spec ARCHIVADA…`.

## 0.2.0 — criterio "el valor trae números" + link a la spec

**Cambio de criterio (a pedido del usuario, verificado con el PN 3029783 real).** El filtro dejó de ser `specField.type === 'NUMBER'` y ahora es **"el parámetro tiene un valor numérico"**: el `specFieldParam.name` (valLabel — lo que Steelhead muestra) **contiene un dígito**, o hay `min/max/target`. Motivo: parámetros como **"Tiempo s/Corrosión Blanca/Roja"** (spec *Cámara Salina*) son `type: BOOLEAN` pero su valor es `"24 hrs."` / `"72 hrs."` → deben salir; con el criterio viejo no salían. Tabla de verdad (datos reales del PN 3029783):

| Parámetro | type | valLabel | ¿sale? |
|---|---|---|---|
| Espesor | NUMBER | `5 - 8 µm` | ✓ |
| Temperatura (Deshidrogenado) | NUMBER | `176 - 204 °C (375 ± 25 °F)` | ✓ |
| Tiempo s/Corrosión Blanca | **BOOLEAN** | `24 hrs.` | ✓ |
| Tiempo s/Corrosión Roja | **BOOLEAN** | `72 hrs.` | ✓ |
| Adherencia | BOOLEAN | `Sí o No` | ✗ |
| Instrumento de Medición | DROPDOWN | `Elección` | ✗ |

El valor mostrado ahora es el **valLabel tal cual** (`24 hrs.`, `5 - 8 µm`) cuando trae dígitos; si no, se reconstruye de `min/max/target` (fallback). El campo del param pasó de `{name, min, max, target, unit, range}` a **`{name, value}`**.

**Link a la spec.** El nombre de la spec es un `<a>` a **`/Domains/<domainId>/Specs/<idInDomain>/Revisions/<revisionNumber>`** (verificado vs los hrefs reales de la app; NO es `/Specs/<id>`), en **pestaña nueva** (no pierde el filtro del dashboard). `domainId`/`idInDomain`/`revisionNumber` salen de `specBySpecId`. Función pura `specUrl(spec)` (fallback a texto plano si faltan datos).

## Estilo 0.1.2 (integración visual)

A pedido del usuario, la columna se integra al look nativo en vez de destacar en verde:
- **Encabezado**: el `<th>` **hereda la `className` MUI** de un th nativo (en `ensureHeaderCell`) → texto idéntico (font/peso/color/padding). Verificado: `getComputedStyle` de mi th == nativo (12px / 600 / blanco / Roboto / left). El td también hereda la className de una celda nativa.
- **Separador**: `border-left: 1px dashed #c7ccd1` (gris punteado sutil) en vez del verde sólido 3px. Se quitó el fondo verde de th/td (se veía como parche sobre el header oscuro).
- **Toggle**: más delgado — `padding 2px 8px`, switch `26×14`, font 11px, sin el border-left grueso.
- La señal "esto es de la extensión" queda en los **chips verdes** de los parámetros y en el toggle dark-mode.

## Pendientes (reconciliados 2026-07-29)

**Abiertos de verdad:**
- **Recompilar en Xcode** para que el bundle **v0.6.9** llegue al iPad. Es lo único que falta del lado Safari: el artefacto ya está construido, verificado y copiado a `Resources/`.
- **Observer en paginación y guardrail de memoria**: el run real cubrió la carga inicial (`50/50`), pero nadie ha capturado el mem monitor disparando el guardrail al 88% ni ha paginado con las 4 columnas encendidas.

**Cerrados (no volver a abrirlos):**
- ~~Deploy~~ — vive en producción desde config 1.7.85; hoy en **1.11.7**.
- ~~Run real integrado~~ — cerrado por el operador (ver §Estado de validación).
- ~~Rotación del hash `GetPartNumber`~~ — se atendió en su momento y **hoy sigue vigente**: `5efd689d…` respondió HTTP 200 en las pruebas en vivo del 2026-07-29.

**Ideas, no compromisos:** tooltip on-hover con TODOS los params (incluidos los cualitativos); recordar la posición de scroll.

## Safari/iPad
En el bundle desde **v0.5.3** (2026-07-09). Es **FAB-only**: `autoInject:true` pone la barra de toggles en el header de `/PartNumbers`, no requiere lanzador de popup. Sin bloqueadores iOS (read-only, sin descarga ni clipboard).

Al día en **v0.6.9** (2026-07-29). Rebuilds de esta tanda: **0.6.7** trajo 0.3.0 (y saldó de paso `wo-schedule-button` 0.9.0), **0.6.8** trajo 0.3.1, **0.6.9** trajo 0.3.2. Ninguno agregó applets — el scanner dio 0 integrables las tres veces. **Falta recompilar en Xcode** (el bundle es estático).

## v0.2.1 (2026-07-27) — el toggle no se montaba si arrancaba apagado

Mismo bug que `wo-listing-columns` (este applet es su molde) y encontrado a raíz de aquél:

```js
function syncColumn() {
  if (!isEnabled() || !onIndex()) return;   // ← toggle apagado = no reintenta
  ensureToggle();                            // ← nunca monta
```

`ensureToggle()` ancla al botón "NUEVO NÚMERO DE PARTE", que en el `init` puede no estar
renderizado; el `MutationObserver` es el único reintento y estaba capado por `isEnabled()`.
Como el toggle arranca apagado, si el applet llegaba antes que React el operador se quedaba sin
forma de encenderlo.

Estuvo oculto por timing hasta que se aceleró el loader el mismo día (ver
[`../architecture/applet-load-gating.md`](../architecture/applet-load-gating.md)).

**Fix:** `ensureToggle()` siempre que la ruta aplique; el trabajo pesado detrás de `isEnabled()`.

## v0.3.0 (2026-07-29) — 4 columnas nuevas y todas AL INICIO

Pedido del operador: mover Specs a la izquierda y agregar **metal base**, **línea**,
**rack types con su cantidad** y **todos los factores de unidad registrados**.

### Por qué a la izquierda (el pedido dentro del pedido)

La tabla nativa de `/PartNumbers` tiene **20 columnas** y ya trae `Línea`, `Departamento`,
`Material` y `Dimensions` — pero en las **posiciones 10-12**, fuera de vista sin scroll
horizontal (verificado en vivo: el header nativo es *Nombre · In Stock · Accounting ID/Name ·
Group · Customer · Default Process · Price/Part · Material · Geometry Type · Dimensions ·
**Línea** · Departamento · Source Operation · Cut Stock? · GL Account · Labels · OEMs · Notas
Adicionales · Acciones*). Por eso duplicar `Línea` no es redundante: la nuestra la trae al
frente, junto al resto del bloque. La nativa `Material` **no** es el metal base (es el material
de inventario, vacío en los NP revisados); el metal base solo vive en `customInputs`.

Patrón `moveToFront` copiado de `wo-listing-columns` (ya validado en piso). Verificado sobre la
tabla real: las 5 celdas quedan en los índices 0-4 del `thead` y de las **50 filas** (0
desalineadas), heredan la className MUI, `moveToFront` es **idempotente** (re-correrlo no mueve
nada → el MutationObserver no entra en bucle con sus propias mutaciones) y **recupera** cuando
se simula que React las flota al final (20-24 → 0-4).

### Un solo query para las 5 columnas — verificado en vivo, no supuesto

Todo sale del **mismo** `GetPartNumber` que ya se pagaba (hash `5efd689d…`, HTTP 200, PN 2300153
"51004727AA", 2026-07-29):

| Columna | Ruta en el response |
|---|---|
| ⚗️ Metal base | `partNumberById.customInputs.DatosAdicionalesNP.BaseMetal` → `"Cobre"` |
| 🏭 Línea | selección `{dimensionId:349, dimensionCustomValueId:154}` cruzada contra `allAcctDimensions` → `"T107-LI Plata Colgado Cx (60.0)"` |
| 🧺 Rack Types | `partNumberRackTypesByPartNumberId.nodes[] {partsPerRack, rackTypeByRackTypeId{name}}` → `T102-RA02: 18`, `T107-FL01: 54` |
| 📐 Unidades | `inventoryItemByPartNumberId.inventoryItemUnitConversionsByInventoryItemId.nodes[] {factor, unitByUnitId{name}}` → 5 factores |

**Hallazgo: el `GetDimension` extra de `load-calculator-modal` no hace falta.** El catálogo de
dimensiones contables viaja **en el mismo response**, a nivel raíz (`allAcctDimensions`, con los
**30** valores de la dim 349 y 19 de la 586 — verificado). Lo que la selección **NO** trae es el
objeto anidado `acctDimensionCustomValueByDimensionCustomValueId`: ese shape existe en
`searchPartNumbers` (de donde lo lee `pn-lifecycle-core`) pero **no** en `GetPartNumber`, que
solo da el id. Confundir los dos shapes es lo que empuja a pedir un query de más.

**`partNumberRackTypes` no tiene `archivedAt`** — las llaves del nodo son
`nodeId/id/partsPerRack/rackTypeByRackTypeId/partNumberId`. No se filtra por archivado porque no
existe tal estado ahí.

**`factor` = unidades de esa unidad por PIEZA** (el mismo número que el operador captura como
"X / Part"; ver `unit-autoconvert-core`). Comprobado con los datos: KGM `0.376` × 2.20462 =
`0.828937` = LBR; CMK `120.58` × 0.00107639 = `0.129791` = FTK.

### El response pesa 5.84 MB — el dato que cambia las decisiones

Medido en vivo (PN 2300153). La bitácora anterior decía "pesado, 504 campos", que subestima el
problema: **50 filas × 5.84 MB ≈ 290 MB** de responses transitorios por página. De ahí que:

- las 4 columnas nuevas nazcan **APAGADAS**. Encenderlas por default habría convertido un deploy
  de config en 50 consultas de 5.8 MB para todo el que entre a `/PartNumbers`, sin pedirlo;
- `extractPnRow` destile el response **una sola vez** a ~2 KB (`{specs, metal, linea, rackTypes,
  units}`) y suelte el crudo — el cache slim ya existía, ahora guarda las 5 columnas;
- el pool siga en 4 con `MIN_GAP_MS` 130 y el guardrail de memoria al 88% intacto.

La key de Specs (`sa_pn_specs_col_enabled`) **no cambió**: quien la tenía encendida la conserva.

### Precisión de los factores (`fmtFactor`)

`fmtNum` redondea a 6 significativos, y eso convertía `0.1297911062` en `0.129791`: aceptable
para un rango de spec, **no** para un dato maestro que el operador puede querer copiar. Se agregó
`fmtFactor` = `fmtNum(n, 10)`, que además limpia el ruido de float binario del server
(`6.3933979999999995` → `6.393398`). El default de `fmtNum` quedó igual (los tests viejos lo fijan).

### Otras decisiones

- **Un toggle por columna** (5 en una barra dark-mode en el header), no un maestro: el ancho es
  el recurso escaso y el operador necesita apagar lo que no usa sin perder el enriquecimiento.
  El contador `done/total` vive en el de Specs y ahora cuenta **NPs**, no celdas (una consulta
  alimenta las 5 columnas).
- **`partsPerRack` ausente se muestra `?`, nunca 1.** Asumir "1 pieza por carga" en silencio es
  exactamente lo que en `wo-schedule-button` convierte 141 minutos en ~112 días. Hay un test que
  lo fija.
- **Línea: ID primero, nombre después.** Se usa `config.steelhead.domain.dimensionIds.linea`
  (349); si ese id no aparece en el catálogo, se cae a buscar la dimensión por nombre **ES+EN**
  (`/^(línea|line)$/i`). El texto solo **AMPLÍA** el match, nunca lo reduce — jerarquía de
  anclaje del repo. Si no matchea nada, la celda queda vacía: **no agarra otra dimensión**.
- Sin links a rack types ni a unidades: no se verificó la URL de esas fichas y no se inventan.

### Validación

Al momento de escribir 0.3.0 quedaba pendiente el run integrado; **se cerró el mismo día** tras
las iteraciones 0.3.1 y 0.3.2 (ver §Estado de validación). Lo verificado en el momento del deploy
fue la **extracción** (golden con fixture real) y el **posicionamiento DOM** (simulacro sobre la
tabla real de 50 filas).

### Safari/iPad — bundle v0.6.7 (2026-07-29)

Rebuild sin altas (`safari-bundle-scan.py`: 0 integrables). `pn-specs-column` ya estaba en la
lista blanca desde v0.5.3, así que bastó reconstruir para que el artefacto tomara las 5 columnas
— verificado en `main-bundle.js`: `extractPnRow` ×3, `extractUnitFactors` ×3, `fmtFactor` ×4,
`sa-pncol-metal` ×2 (antes: 0 de cada uno). Es **FAB-only**: el `autoInject:true` pone la barra
de toggles en el header de `/PartNumbers`, no necesita lanzador de popup.

El mismo rebuild saldó el pendiente de `wo-schedule-button` **0.9.0** (`pickAnchorSteps` ×3,
también ausente antes). `node --check` OK, `build-safari.test.js` 10/10, suite 83/83.
Artefacto: **1 579 883 bytes** (antes 1 548 318). Ojo con el número que imprime
`build-safari.sh` — son **caracteres**, no bytes.

**Falta recompilar en Xcode** (el bundle es estático). Los `Resources/` del proyecto ya están
sincronizados con `bridge.js`, `popup.js`, `popup.html`, `main-bundle.js` y `manifest.json` 0.6.7.

## v0.3.1 (2026-07-29) — angostar lo que 0.3.0 ensanchó

Cinco correcciones del operador tras ver 0.3.0 en pantalla. El hilo común: **el ancho es el
recurso escaso**. La tabla nativa ya trae 20 columnas, así que cada columna propia se paga con
scroll horizontal — y 0.3.0 agregó cuatro.

**1. Fuera la columna de Línea.** *«ya vi que se repite»*: la nativa está en la posición 11 y
dice lo mismo. Se retira la columna; `extractLinea` se queda en el core (probada, barata) por si
vuelve a pedirse, y `dropRetiredKeys()` borra la key huérfana `sa_pn_linea_col_enabled` en el
init — si no, un flag de una columna que ya no existe seguiría contando en `anyOn()` y dispararía
consultas sin pintar nada.

**2. Descripción + metal base dentro de la celda del NOMBRE, no como columna.** Idea del
operador, y es la que más ancho ahorra: aprovecha una celda que ya existe. Verificado en vivo
antes de escribirlo, porque enriquecer una celda **nativa** no es lo mismo que agregar una
propia: React la pinta como `<td><div class="css-…"><a>…</a></div></td>` y nuestro `<div>` va
como hermano de ese div. Queda `51004727AA ⏎ CONECTOR · Cobre`.

> **`syncNameInfo` es idempotente por contrato** (`data-sa-txt` guarda el texto ya pintado y no
> se toca el DOM si no cambió). Sin eso, cada sync mutaría la celda → el MutationObserver
> dispararía otro sync → bucle. El riesgo es mayor que con las columnas propias justamente
> porque el subárbol lo comparte React.

`descriptionMarkdown` puede traer markdown, así que `extractDescription` lo limpia (negritas,
encabezados, links, multilínea → un renglón): si alguien escribe `**CONECTOR**`, la celda no
debe mostrar los asteriscos.

**3. Specs acotada.** `max-width` 340 → 230 px con `width` fijo. La causa real del desborde eran
los chips en `white-space:nowrap`, que **forzaban** el ancho; ahora envuelven
(`overflow-wrap:anywhere`).

**4. Rack types compactos**: `T102-RA02 (18 pz)` en un renglón, en vez de nombre y cantidad en
extremos opuestos de la celda.

**5. Unidades legibles de un vistazo**: el `/pz` se movió al **encabezado** (`Unidades /pz`) — se
repetía 5 veces por celda —, y los factores van a **3 decimales, miles con coma y punto decimal**,
alineados a la derecha con cifras tabulares para que los puntos queden en columna.

> **Guarda contra el falso cero.** Redondear a 3 convierte un factor chico en `0.000`, que se
> lee como *«esta unidad no aplica»*. `fmtQty3` devuelve `<0.001` en ese caso: perder precisión
> es aceptable, mentir sobre la existencia del dato no. El valor exacto (10 significativos) sigue
> disponible en el `title` de cada renglón.

**Resultado medido en la tabla real:** las 3 columnas propias suman **340 px** (150 + 96 + 94) —
lo que antes ocupaba la de specs sola. Core **38/38**.

### Safari/iPad — bundle v0.6.8

Rebuild sin altas. Verificado en el artefacto: `fmtQty3` ×5, `sa-pncol-nameinfo` ×3,
`formatRackChip` ×3 y `sa-pncol-linea` **×0** (la columna retirada no viaja). 1 587 695 bytes;
`node --check` OK, build-safari 10/10. `Resources/` sincronizado; **falta recompilar en Xcode**.

## v0.3.2 (2026-07-29) — cuatro detalles de lectura + un bug propio

**1. El toggle de Specs se movió al FINAL de la barra.** Es el único que arrastra el contador
(`50/50`) y el medidor de memoria (`Mem: 338MB / 4192MB (8%)`); puesto al inicio empujaba él solo
al último toggle a un segundo renglón. `TOGGLE_ORDER` (orden de la barra) es ahora independiente
de `COLS` (orden de las columnas) — el popup sigue apuntando a `specs` explícitamente, porque el
orden de la barra es cosmético y no debe decidir a qué apunta una acción.

**2. Rack types en dos renglones por diseño.** Ocupaban dos líneas de todos modos, pero el wrap
natural partía por donde caía (`T102-RA02 (18` / `pz)`). Ahora el corte es deliberado: nombre
arriba, `(18 pz)` abajo con `nowrap`.

**3. Unidades en el orden del ERP, no alfabético.** El operador pasó la captura del modal
*Per Part Count Unit Definitions*: **KGM · LBR · DMK · FTK · CMK · FOT · LM · LO** — peso,
superficie, longitud, lote. Alfabético mezclaba kilos con centímetros cuadrados y obligaba a
buscar. `UNIT_ORDER` en el core; `KG` (sin M) se ordena junto a `KGM` —mismo alias que canoniza
`unit-autoconvert-core`— y una unidad que el ERP agregue mañana cae al final en vez de colarse
en medio.

**4. El nombre del NP a 14px/700** (nativo: 12px/400). Con las columnas encendidas la fila lleva
tanto dato que el nombre —el ancla de la fila— se perdía. La regla cuelga de una clase en
`<body>` (`sa-pn-active`), **no** del `className` del `<td>`: ese lo pinta React y lo reescribiría
en cada render.

### Bug propio encontrado al hacer esto

`injectStyles()` comparaba `data-sa-v === '3'` pero escribía `'2'`: la condición de salida nunca
se cumplía, así que **borraba y recreaba el `<style>` en cada sync**. Entró en 0.3.1 al subir el
número en un solo lado. No rompía nada visible —por eso sobrevivió al deploy— pero era churn de
DOM en cada mutación de la tabla. Ambos valores están ahora en `'4'`, con un comentario que ata
uno al otro.

Core **42/42**. Bundle Safari **v0.6.9** (verificado en el artefacto: `UNIT_ORDER` ×5,
`sa-pncol-rack-qty` ×3, `sa-pn-active` ×3, y **cero** ocurrencias del `'2'` viejo).
