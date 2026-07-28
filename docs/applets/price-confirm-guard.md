# Applet: `price-confirm-guard` — Candado de Confirmación de Precio

**Versión actual:** 0.1.5 (**gate ESTRUCTURAL, no bilingüe** — el modal de precio se llama «Precio del número de parte» en español y el gate por título `/Part Number Price/i` **nunca matcheaba**; hoy la señal primaria es el schema RJSF `root_DatosPrecio*` y el título quedó como red de seguridad ES+EN. Además `isSaveErrorAlert` reconoce el string REAL en español «Error al guardar el precio» —ese alert es BLOQUEANTE y congelaba la pestaña tras cada cancelación—. Core 32/32. Verificado en vivo el 2026-07-27: `gatePorTitulo:false`, `gatePorSchema:true`)
**Versión previa:** 0.1.4 (suprime el `alert` nativo "Error saving price" que SH dispara tras nuestro bloqueo —ventana corta post-bloqueo vía `window.__saPriceGuardSuppressUntil`, parche de `window.alert`, `isSaveErrorAlert` puro—; los errores de guardado legítimos siguen mostrándose. Core 27/27. **preview multi-unidad** (v0.1.3): precio convertido a todas las unidades disponibles del NP. Factor DOM-first (Panel A + tabla Units → API → manual). **✅ validado en vivo** — core + preview multi-unidad, operador 2026-07-17, confirmado 2026-07-22)
**Archivos:** `remote/scripts/price-confirm-guard.js` (glue DOM/red) + `remote/scripts/price-confirm-core.js` (puro)
**Tests:** `tools/test/price-confirm-core.test.js` (27/27 verdes)
**Global:** `window.PriceConfirmGuard` · core `window.PriceConfirmCore` · estado en `window.__saPriceGuard*`
**Spec:** [`docs/superpowers/specs/2026-07-01-price-confirm-guard-design.md`](../superpowers/specs/2026-07-01-price-confirm-guard-design.md)

## Qué es
Al **guardar** en el modal nativo **"Part Number Price"** (alta/edición de precio de un NP), abre un
modal propio (dark-mode) que exige **reconfirmar el precio tipo password**: el operador re-teclea el
precio a ciegas y solo se permite guardar si coincide con lo capturado. Además **muestra la divisa** y
**bloquea el guardado si no hay divisa**, **muestra la unidad** (pieza / kg / etc.) y ofrece una
**calculadora de equivalente por pieza** para validar el orden de magnitud.

## Cómo funciona (arquitectura)
Patrón `surtido-guard`: **interceptor de `window.fetch`** como *gate asíncrono*.
1. Intercepta `operationName === "SaveManyPartNumberPrices"`.
2. **Gate anti-falso-positivo:** solo actúa si el modal nativo "Part Number Price" está abierto
   (`nativePriceModalOpen()` busca `[role="dialog"]` cuyo `.MuiDialogTitle-root` matchee
   `/Part\s*Number\s*Price/i`). Así **no** intercepta la carga masiva de `bulk-upload` (misma mutación,
   sin ese modal).
3. `PriceConfirmCore.extractLines(vars)` aplana el payload → una fila por `partNumberPriceLineItem`.
4. `await openConfirmModal(lines)` → `Promise<'proceed'|'block'>`.
   - **Confirmar** (todas las líneas coinciden + todas con divisa) → deja pasar `origFetch` (SH guarda).
   - **Cancelar / Esc / click en scrim / error / mismatch** → `Response` sintético `{errors:[…]}`
     (fail-closed; SH no guarda y su modal sigue abierto para corregir).

## Payload interceptado (`SaveManyPartNumberPrices`)
```jsonc
{ "input": { "partNumberPrices": [ {
  "partNumberId": 3235631,
  "customInputs": { "DatosPrecio": {} },   // divisa: DatosPrecio.Divisa ("USD"/"MXN"); {} = SIN divisa
  "partNumberPriceLineItems": [ { "title": "Plateado - FAKE PART OMAR", "price": 1, "productId": 14506 } ],
  "unitId": null                           // null = por pieza; nº = por kg/lb/m/área
} ] } }
```
- **Divisa** vacía = el operador no la eligió (el `<select id="root_DatosPrecio_Divisa">` es `required`
  en el DOM, pero se refuerza aquí a nivel de mutación).
- **Precio:** `partNumberPriceLineItems[].price`.

## Calculadora de equivalente por pieza
Solo si `unitId ≠ pieza`. Factor **unidad→pieza** (ej. kg/pza) por prioridad (v0.1.2 — **DOM-first**,
porque el DOM refleja lo que el operador tiene/cambia en el mismo save, más fresco que la API):
1. **DOM · Panel A** — modal *Editar NP*: `[data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_PER_PART_COUNT_UNIT_DEFINITIONS"]`.
   Fila con `<p>KGM Kilogramo / Part:</p>` (código = primer token, `isPerPartLabel`) + `input[type=number]` value.
2. **DOM · tabla Units** — página del NP: `[data-steelhead-component-id="PART_NUMBER_PAGE_UNITS"]`.
   Fila con `<a href="/Units/3969">` (match por `unitId` del href **o** por código) + `<p>1 KGM … / part</p>`
   (factor = `parseLeadingNumber`).
3. **API** `GetPartNumber {id}` → `partNumberById.inventoryItemByPartNumberId.id` →
   `GetAvailableUnits {inventoryItemId}` → `…inventoryItemUnitConversionsByInventoryItemId.nodes[].{factor, unitByUnitId.id}`.
4. Si nada → **input manual** editable.

### Preview multi-unidad (v0.1.3)
El modal muestra el precio capturado convertido a **todas** las unidades disponibles del NP (no solo por
pieza): `precio_por_pieza = precio × factor_de_la_unidad_capturada`; `precio_por_V = precio_por_pieza / factor_V`
para cada unidad `V` con factor. Sirve para validar p. ej. "capturé por ft² → ¿cuánto da por pieza / por kg?".
- Se lee el **mapa completo** de factores (`readAllFactorsFromDOM` → `resolveAllFactors`): Panel A (todas las
  filas `CODE … / Part:`), tabla Units (todas las filas), o API (`UNIT_BY_ID` mapea `unitId`→código).
- Núcleo puro `buildEquivalences({price, priceUnitCode, priceUnitFactor, factorsByCode})` → `[{code, unitPrice, isPriceUnit}]`
  con `pieza` primero; `[]` si el precio o el factor de la unidad capturada son inválidos. Golden tests.
- El **factor de la unidad capturada** queda editable (por si lo cambian en el save) → recalcula toda la tabla.
  El equivalente usa el **valor reconfirmado** (no revela el original). La fila de la unidad capturada se resalta.
- Anclas de lectura DOM: `data-steelhead-component-id` (estables), no clases CSS hasheadas. Parsing puro en
  `price-confirm-core.js` (`unitCodeFromLabel`, `isPerPartLabel`, `parseLeadingNumber`, `buildEquivalences`).

## Decisiones de diseño
- **Disparo:** todo guardado del modal (alta y cambio), no solo cambios.
- **Divisa:** se muestra (solo lectura) y se exige; NO se re-selecciona (solo se re-teclea el precio).
- **Match de precio:** exacto tras normalizar (`1` == `1.00`; `1` ≠ `1.5`; vacío/`abc` nunca; coma decimal
  NO se interpreta — el input usa punto, como el modal nativo).
- **Toggle** popup default ON, no persistente (estado en `window.__saPriceGuardEnabled`; reload → ON).
- **Estado en `window`** (no closure) + latch idempotente `window.__saPriceGuardFetchPatched` +
  `window.__saPriceGuardInit`: sobrevive la re-evaluación del IIFE en cada acción del popup.

## Lección: montaje dentro del MuiDialog (focus-trap / inert)
**Síntoma (v0.1.0):** el modal aparecía pero el input de precio no aceptaba foco ni tecleo.
**Causa:** el modal nativo "Part Number Price" es un `MuiDialog` que aplica **focus-trap** +
`inert`/`aria-hidden` a todo lo que está FUERA del dialog. El overlay se montaba en `document.body`
(fuera del trap) → visible pero no interactivo. **Fix (v0.1.1):** montar el overlay **dentro** del
`.MuiDialog-container` nativo (`getNativePriceModal().closest('.MuiDialog-container')`, fallback
`document.body`) → queda dentro del trap y no-inert. Mismo espíritu que la inyección de `surtido-guard`
en `.MuiDialogContent-root`. **Regla:** cualquier UI propia que conviva con un MUI Dialog abierto debe
montarse dentro del contenedor del dialog, no en `body`.

## Lección (v0.1.5): la respuesta a un anclaje mono-idioma es ESTRUCTURA, no traducirlo
**Verificado en vivo el 2026-07-27** (dominio 344, UI en español, NP 3235631):

| Señal | Valor real |
|---|---|
| Título del sub-modal de precio | **«Precio del número de parte»** (español) |
| `MODAL_TITLE_RE.test(título)` | **false** |
| `[id^="root_DatosPrecio"]` presente | **true** ← lo único que sostenía el gate |
| `alert` nativo tras bloquear | **«Error al guardar el precio»** (español) |

El gate vivía de `MODAL_TITLE_RE || hasPriceSchema`. Con la UI en español el primer término
**siempre era falso**: el candado se sostenía entero del ancla de schema que se agregó el
2026-07-16 (`dc0717b`) — es decir, **antes de esa fecha el candado no se disparaba en el
sub-modal de precio del asistente Editar NP**. Eso es lo peligroso de un anclaje por texto en un
candado: no falla ruidosamente, **se apaga en silencio** y el precio se guarda sin reconfirmar.

**La corrección NO fue "hacerlo bilingüe"**, fue invertir la jerarquía (el repo ya se movió a
anclas del HTML: `data-steelhead-component-id`, ids de schema RJSF, estructura de tabla):
1. **Estructura primero** — `root_DatosPrecio*`, el formulario RJSF del precio. Solo existe en
   ese modal y no depende del idioma. Es la señal que decide.
2. **Texto como red de seguridad** — el título ES+EN (ambos strings **observados**, no
   traducidos a ojo). Solo AMPLÍA el gate: si SH renombra el schema, el candado sigue vivo.
   Nunca lo reduce.

La decisión vive en el core puro (`PriceConfirmCore.isPriceModal({hasPriceSchema, title})`,
7 casos golden incl. un título en un idioma que no conocemos → matchea igual por estructura);
el selector DOM vive en el glue, con fallback a la señal estructural si el core no cargó.

**Dónde SÍ va un anclaje bilingüe:** `isSaveErrorAlert`. Es un `window.alert` — **no hay
estructura que anclar, solo texto**. Ahí el bilingüe es la única herramienta, y por eso se
capturó el string real en producción en vez de traducirlo. No es cosmético: el alert nativo es
**bloqueante** y congela la pestaña hasta que alguien lo cierre (pasó durante esta misma
investigación).

## Nota: el borrado del asistente Editar NP NO lo causa este applet (bug de Steelhead)
Reporte del operador (2026-07-27): «capturo datos en el modal Editar NP, adjunto un precio, y al
guardar el precio **después del candado** se borra todo lo capturado». Se investigó con
experimento controlado, y el candado quedó **descartado**:

| Corrida | ¿Se guarda el precio? | Datos del asistente |
|---|---|---|
| Candado **apagado** (prueba del operador) | sí | **se borran** |
| Candado **bloqueando** (Cancelar; verificado 2026-07-27) | no | **sobreviven intactos** |

⇒ Lo que borra es **el guardado del precio en sí**, no nuestro modal, ni el robo de foco, ni la
retención del `fetch`. Contexto que lo explica: el asistente **desmonta los pasos inactivos**
(sus valores viven solo en el estado de React) y el sub-modal de precio **renderiza su propia
copia del formulario de entradas personalizadas del NP** (mismos ids `root_*`) cargada del
servidor, o sea sin lo que el operador acaba de teclear. Reportado a `support@gosteelhead.com`.
**Mitigación para piso:** adjuntar el precio ANTES de capturar, o guardar el asistente y
reabrirlo para el precio.

## Lección: suprimir el `alert` nativo de SH tras un bloqueo
Al cancelar/bloquear devolvemos un `Response` sintético con `errors`; SH reacciona con un
**`window.alert('Error saving price')` nativo** (bloqueante, ruidoso — es eco de NUESTRO bloqueo, no un
fallo real). Se parchea `window.alert` (latch `window.__saPriceGuardAlertPatched`) y solo se suprime si
`Date.now() < window.__saPriceGuardSuppressUntil` (ventana de 4s que se activa **únicamente** al bloquear)
**y** `isSaveErrorAlert(msg)`. Fuera de esa ventana `alert` es normal → los errores de guardado legítimos
siguen visibles. Como un guardado legítimo no pasa por bloqueo, su `alert` nunca cae en la ventana.

## Seguridad / robustez
- Todo texto del payload va por `textContent` (helper `el()` con `text`) — no reintroduce el XSS
  pendiente del audit (`innerHTML`).
- `removeOverlay` + `removeEventListener('keydown')` al cerrar; toast autodestruye 5s.
- **Fail-closed** ante cualquier error de extracción/render; la falla de la calculadora (red) degrada a
  manual y **no** bloquea la reconfirmación del precio (validación central).

## Plan de validación en vivo — ✅ COMPLETADO (core + preview multi-unidad; operador 2026-07-17, confirmado 2026-07-22; se usó "FAKE PART OMAR", PN 3235631)
1. Guardar precio en el modal → aparece el modal de confirmación; reconfirmar **igual** → guarda.
2. Reconfirmar **distinto** → ✖, Confirmar deshabilitado, Cancelar → SH no guarda.
3. **Sin divisa** (`DatosPrecio` vacío) → banner rojo, no deja confirmar.
4. Unidad ≠ pieza (kg): con factor guardado → prefill + equivalente; sin factor → input manual.
5. **Carga masiva** de `bulk-upload` corriendo → NO se intercepta (modal ausente).
6. Toggle OFF desde popup → guarda sin pedir confirmación; reload → vuelve ON.
7. Multi-línea (varios `partNumberPriceLineItems`) → exige que todas coincidan.

## Pendientes / Fase 2
- Guardar el factor de conversión desde el modal si el operador lo teclea y no estaba guardado
  (`Create/UpdateInventoryItemUnitConversion`).
- Leer el factor del DOM (Panel A/B de `unit-autoconvert`) si ese modal está abierto en paralelo.
- Persistir el toggle. Distinguir alta vs edición si se quisiera aplicar solo a cambios.
- Deploy a `gh-pages` con `tools/deploy.sh` tras validación.

## Safari/iPad (2026-07-09)
Integrado al bundle Safari/iPad (`safari/bundle.json` **v0.5.3**, `safari-bundle-sync`). **Corrección 2026-07-09:** al integrarlo asumí (por el índice desactualizado de `CLAUDE.md`, clavado en 0.1.0) que estaba "pendiente de validación en vivo + deploy". **Es falso:** está **vivo en gh-pages desde el 2026-07-01** (commit `9c8b411`; verificado 2026-07-09: en el config en vivo con `autoInject`, scripts sirviendo HTTP 200) e **iterado 4 veces sobre comportamiento REAL** (v0.1.4 suprime el `alert` nativo que SH dispara *tras* nuestro bloqueo — algo que solo se descubre corriéndolo). El usuario **confirma que la doble captura funciona en producción y sin problemas**. Es `autoInject:true` (intercepta `SaveManyPartNumberPrices` con el modal nativo abierto) y **fail-safe** (deja pasar el fetch al confirmar; `Response` sintético al cancelar). **Único auto-inyectado sin control en página** → se le cableó un **kill-switch en el popup** (`toggle-price-confirm-guard` → `PriceConfirmGuard.toggleFromPopup`, en `popup.js LAUNCHERS` + `sa-dispatcher.js LAUNCH_FN` + mapa del test `build-safari`) para poder apagarlo desde el iPad si hiciera falta. Rebuild `tools/build-safari.sh` (test 10/10, cadena de lanzadores verde). **Requiere recompilar en Xcode** (bundle estático). (La **preview multi-unidad** de v0.1.3 también quedó **validada en vivo** —operador 2026-07-17, confirmado 2026-07-22—; el candado core ya estaba validado desde antes.)
