# Applet: `price-confirm-guard` — Candado de Confirmación de Precio

**Versión actual:** 0.1.0 (código completo + golden tests; **pendiente validación en vivo + deploy**)
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
Solo si `unitId ≠ pieza`. Factor **unidad→pieza** (ej. kg/pza) por prioridad:
1. **API** `GetPartNumber {id: partNumberId}` → `partNumberById.inventoryItemByPartNumberId.id` →
   `GetAvailableUnits {inventoryItemId}` → `inventoryItemById.inventoryItemUnitConversionsByInventoryItemId
   .nodes[].{factor, unitByUnitId.id}` (mismo patrón que `weight-quick-entry`/`unit-autoconvert`).
2. Si no hay factor guardado → **input manual** editable.

El equivalente se calcula sobre el **valor reconfirmado** que teclea el operador (no sobre el original)
→ no revela el precio original y valida lo que el operador está capturando. `perPieceEquivalent = price × factor`.

## Decisiones de diseño
- **Disparo:** todo guardado del modal (alta y cambio), no solo cambios.
- **Divisa:** se muestra (solo lectura) y se exige; NO se re-selecciona (solo se re-teclea el precio).
- **Match de precio:** exacto tras normalizar (`1` == `1.00`; `1` ≠ `1.5`; vacío/`abc` nunca; coma decimal
  NO se interpreta — el input usa punto, como el modal nativo).
- **Toggle** popup default ON, no persistente (estado en `window.__saPriceGuardEnabled`; reload → ON).
- **Estado en `window`** (no closure) + latch idempotente `window.__saPriceGuardFetchPatched` +
  `window.__saPriceGuardInit`: sobrevive la re-evaluación del IIFE en cada acción del popup.

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
