# Applet: `price-confirm-guard` — Candado de Confirmación de Precio

**Versión actual:** 0.1.4 (suprime el `alert` nativo "Error saving price" que SH dispara tras nuestro bloqueo —ventana corta post-bloqueo vía `window.__saPriceGuardSuppressUntil`, parche de `window.alert`, `isSaveErrorAlert` puro—; los errores de guardado legítimos siguen mostrándose. Core 27/27. **preview multi-unidad** (v0.1.3): precio convertido a todas las unidades disponibles del NP. Factor DOM-first (Panel A + tabla Units → API → manual). Pendiente validación en vivo)
**Archivos:** `remote/scripts/price-confirm-guard.js` (glue DOM/red) + `remote/scripts/price-confirm-core.js` (puro)
**Tests:** `tools/test/price-confirm-core.test.js` (16/16 verdes)
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

## Plan de validación en vivo (pendiente — usar "FAKE PART OMAR", PN 3235631)
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
