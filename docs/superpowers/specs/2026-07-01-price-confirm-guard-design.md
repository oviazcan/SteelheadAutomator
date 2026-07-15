# Diseño: `price-confirm-guard` — Candado de Confirmación de Precio

**Fecha:** 2026-07-01
**Estado:** aprobado (diseño). Pendiente implementación.
**Global:** `window.PriceConfirmGuard` · estado en `window.__saPriceGuard*`

## Problema

En el modal nativo de Steelhead **"Part Number Price"** (alta/edición de precios de un
Número de Parte), un operador puede teclear mal el precio o guardar sin divisa. No hay una
verificación de "doble captura" (tipo confirmación de contraseña) antes de persistir. Se busca:

1. Al **guardar** un precio en ese modal, exigir **re-teclear el precio** y solo permitir el
   guardado si la reconfirmación **coincide** con lo capturado (estilo password).
2. **Mostrar la divisa** seleccionada en la confirmación, y **bloquear el guardado si no hay
   divisa**.
3. **Mostrar la unidad** del precio (por pieza, por kg, etc.) para que se confirme visualmente.
4. Ofrecer una **calculadora de equivalente por pieza** en el modal de confirmación, como ayuda
   de validación adicional cuando el precio no es "por pieza".

## Alcance (decidido)

- **Disparo:** cualquier guardado del modal de precios — **alta y cambio** (todo `SaveManyPartNumberPrices`
  originado en el modal nativo).
- **Divisa:** en la confirmación se **muestra** (solo lectura) y se **exige que exista**; solo se
  re-teclea el **precio** (la divisa no se re-selecciona).
- Fuera de alcance (Fase 2): guardar el factor de conversión desde este modal; distinguir alta vs
  edición para tratarlas distinto; persistir el toggle.

## Hallazgos de la investigación (fuente de verdad)

### Mutación del guardado
El modal nativo guarda con `operationName: "SaveManyPartNumberPrices"` (mutation). Shape real
capturado (hash-scanner, 2026-07-01):

```jsonc
{ "input": {
  "quoteId": null,
  "partNumberPrices": [ {
    "partNumberId": 3235631,
    "processId": 213861,
    "customInputs": { "DatosPrecio": {} },   // divisa: customInputs.DatosPrecio.Divisa ("USD"/"MXN")
                                             // VACÍO ({}) = sin divisa seleccionada
    "partNumberPriceLineItems": [
      { "title": "Plateado - FAKE PART OMAR", "price": 1, "productId": 14506, "quoteInventoryItemId": null } ],
    "unitId": null,                          // null = por pieza; nº = por kg/lb/m/área
    "priceName": "",
    "isDefaultPartNumberPrice": true
  } ]
} }
```

- **Precio:** `input.partNumberPrices[i].partNumberPriceLineItems[j].price` (number). Puede haber
  varias líneas (varios items / tiers).
- **Divisa:** `input.partNumberPrices[i].customInputs.DatosPrecio.Divisa` (string). Si el operador
  no eligió divisa, `DatosPrecio` llega **vacío** (`{}`), sin la key `Divisa`.
- **Unidad:** `input.partNumberPrices[i].unitId` (null = pieza; id numérico = otra unidad).

### Divisa en el DOM del modal
`<select id="root_DatosPrecio_Divisa" name="root_DatosPrecio_Divisa" required>` con opciones
`""`, `USD - Dólar americano`, `MXN - Peso mexicano`. El `<select>` es `required` (validación nativa),
pero se refuerza a nivel de mutación por robustez.

### Factor de conversión unidad→pieza
Vive en las **unit conversions del inventory item** del PN. Se lee por API (patrón ya en uso en
`weight-quick-entry.js:726` y `unit-autoconvert`):

```js
const unitsData = await api().query('GetAvailableUnits', { inventoryItemId }, 'GetAvailableUnits');
const conv = unitsData?.inventoryItemById?.inventoryItemUnitConversionsByInventoryItemId
  ?.nodes?.find(c => Number(c.unitByUnitId?.id) === Number(unitId));
const factor = conv?.factor;   // "unidades por pieza" (ej. kg/pza)  ⇒  precioPorPieza = price × factor
```

- `inventoryItemId` se resuelve del `partNumberId` con `GetPartNumber → partNumberById.inventoryItemByPartNumberId.id`
  (patrón en `weight-quick-entry.js`).
- Si el factor **no está guardado**, se lee del DOM (Panel A/B de `unit-autoconvert`, si ese modal
  está abierto) o lo teclea el operador manualmente en el modal de confirmación.
- Selectores del factor (verificados en `unit-autoconvert`, reutilizables):
  - **Panel A** (*Edit Part Number* → "Per Part Count Unit Definitions"): input en `.MuiFormControl-root`
    con `<p>` hermano que termina en `"/ Part:"` → código = primer token del label.
  - **Panel B** (*Definir Unidades*): `tr.MuiTableRow-root`; input "Unidades/Parts" = el del `<td>`
    cuyo adorno **no** empieza con `"Parts /"`.

## Arquitectura

Mismo patrón que `surtido-guard`: **interceptor de `window.fetch`** que actúa como *gate* asíncrono
sobre la mutación de guardado.

```
Operador da "Save" en modal nativo
        │
        ▼
window.fetch(SaveManyPartNumberPrices)  ← interceptado
        │
        ├── ¿modal nativo "Part Number Price" abierto?  ── no ──▶ pasa de largo (no toca carga masiva)
        │                                                        (origFetch)
        └── sí ─▶ extractLines(vars) ─▶ abre modal de confirmación (Promise)
                        │
             ┌──────────┴───────────┐
        confirmar               cancelar / Esc / error
        (todas coinciden          (fail-closed)
         + divisa presente)             │
             │                          ▼
             ▼                 Response sintético { errors:[…] }
        origFetch(args)        (SH no guarda; modal de SH sigue abierto)
        (SH guarda normal)
```

**Gate anti-falso-positivo:** `bulk-upload` también dispara `SaveManyPartNumberPrices`. El
interceptor **solo** actúa si el modal nativo **"Part Number Price"** está presente en el DOM
(`[role="dialog"]` cuyo texto contenga ese título). La carga masiva no abre ese modal → pasa de
largo. **Sin tocar `bulk-upload`.**

### Componentes / archivos

| Archivo | Responsabilidad |
|---|---|
| `remote/scripts/price-confirm-core.js` | **Lógica pura** (sin DOM/red). Extracción + validaciones. `window.PriceConfirmCore`. |
| `remote/scripts/price-confirm-guard.js` | Interceptor de `fetch` + modal dark-mode + toast + toggle popup. `window.PriceConfirmGuard`. |
| `tools/test/price-confirm-core.test.js` | Golden tests del core (node, sin red). |
| `remote/config.json` | Nueva app `price-confirm-guard`. |
| `docs/applets/price-confirm-guard.md` | Bitácora del applet. |

Reúsa: `steelhead-api.js` (`api().query` para `GetPartNumber` + `GetAvailableUnits`). Los
selectores DOM del factor de `unit-autoconvert` (Panel A/B) quedan disponibles para la Fase 2
(hoy el MVP resuelve el factor por API o manual).

### `price-confirm-core.js` — interfaz pública (pura)

```js
window.PriceConfirmCore = {
  // Aplana el payload a líneas de precio a confirmar.
  // -> [{ ppIndex, liIndex, partNumberId, title, price, divisa, unitId, priceName }]
  extractLines(variables),

  hasDivisa(line),                       // -> boolean (línea.divisa truthy y ≠ '')

  // Normaliza (trim, Number) y compara exacto. '1' == '1.00' ; '1' != '1.5'.
  // Cadena vacía nunca hace match.
  pricesMatch(original, reconfirmRaw),   // -> boolean

  perPieceEquivalent(price, factor),     // -> number | null  (price × factor; null si factor inválido)

  UNIT_BY_ID,                            // { 3969:'KGM', 3972:'LBR', 5150:'LM', 4907:'CMK', 4797:'FTK', 5348:'LO' }
  unitLabel(unitId),                     // -> 'pieza' si null; código si conocido; 'unidad #id' si no
  isPerPiece(unitId),                    // -> unitId == null
};
```

### `price-confirm-guard.js` — comportamiento

- **Latch idempotente:** `window.__saPriceGuardFetchPatched` para no doble-parchear.
- **Estado en `window`** (no en closure, por la re-evaluación del IIFE en cada acción del popup,
  lección de `surtido-guard`): `window.__saPriceGuardEnabled` (default `true`).
- **Modal de confirmación (dark-mode)**, una fila por línea con precio:
  - Contexto: `title` del precio (ej. "Plateado - FAKE PART OMAR") + `partNumberId`.
  - **Divisa** (solo lectura, prominente). Si `!hasDivisa` → banner rojo "Sin divisa: cancela,
    selecciónala en Steelhead y vuelve a guardar"; botón Confirmar deshabilitado.
  - **Unidad** (solo lectura; label del react-select del modal nativo si se puede leer, si no
    `unitLabel(unitId)`).
  - **Re-teclea el precio** → validación en vivo: ✔ verde si `pricesMatch`, ✖ rojo "no coincide".
  - Si `!isPerPiece(unitId)`: **calculadora por pieza** → factor por prioridad
    (1) API `GetAvailableUnits` (vía `inventoryItemId` de `GetPartNumber`); (2) input manual
    editable. La calculadora opera sobre el **valor reconfirmado** (no revela el original) →
    muestra **"= $X.XX por pieza (divisa)"**. Solo informativo; **no** escribe a SH.
    (Lectura DOM del factor desde Panel A/B de `unit-autoconvert` → Fase 2.)
  - Footer: **Confirmar y guardar** (habilitado solo si **todas** las líneas coinciden y todas
    tienen divisa) · **Cancelar**.
- **Resolución de la Promise:** confirmar → `proceed` (deja pasar `origFetch`); cancelar / Esc /
  cierre / cualquier error interno → `block` (Response sintético con `errors`), **fail-closed**.
- **Toast** (reusa estilo `surtido-guard`): verde al confirmar, rojo al bloquear.
- **Toggle popup:** acción `toggle-price-confirm-guard` → `PriceConfirmGuard.toggleFromPopup`
  (default ON; no persistente).

### Seguridad / robustez

- Todo texto proveniente del payload va por `textContent` / escape (no `innerHTML` con datos) —
  no reintroduce el XSS pendiente del audit.
- `removeOverlay()` al cerrar; sin listeners acumulados; el interceptor es liviano (no procesa
  listas largas → no requiere el mem-monitor completo de `memory-hardening-applets`, pero sí latch
  idempotente + cleanup del modal).
- **Fail-closed** ante cualquier error de extracción/red: si no se puede validar, se bloquea el
  guardado (nunca se deja pasar sin confirmar). Excepción: si el modal nativo no está abierto,
  se pasa de largo (no es nuestro caso de uso).

## Flujo de datos

1. `fetch` interceptado → parse `body` → `{ operationName, variables }`.
2. Si `operationName !== 'SaveManyPartNumberPrices'` **o** modal nativo ausente → `origFetch`.
3. `lines = Core.extractLines(variables)`.
4. `await openModal(lines)`:
   - Para cada línea con `unitId ≠ pieza`, resolver factor (API/DOM/manual) para la calculadora.
   - El operador re-teclea precios; el modal habilita Confirmar cuando `pricesMatch` en todas y
     todas tienen divisa.
5. Confirmar → `origFetch(args)` (guardado real). Cancelar → Response sintético con `errors`.

## Casos borde

- **Sin divisa** (`DatosPrecio` vacío): banner rojo, no se puede confirmar → solo Cancelar.
- **Múltiples `partNumberPrices` / múltiples `partNumberPriceLineItems`:** una fila por línea;
  Confirmar exige que **todas** coincidan.
- **Precio 0 / vacío:** se trata como valor a reconfirmar igual que cualquiera (0 == 0 hace match).
- **`unitId` desconocido:** `unitLabel` → "unidad #id"; la calculadora cae a input manual.
- **Factor no guardado y sin Panel A/B abierto:** input manual del factor; si el operador no lo
  llena, la calculadora no muestra equivalente (no bloquea el guardado — es ayuda opcional).
- **Carga masiva de `bulk-upload`:** modal nativo ausente → no se intercepta.
- **Re-inyección del IIFE (popup):** estado en `window.*`, latch idempotente → sin doble parche ni
  toggle fantasma.
- **Error de red al resolver el factor:** la calculadora degrada a manual; **no** bloquea la
  reconfirmación del precio (que es la validación central).

## Testing

**Golden (`tools/test/price-confirm-core.test.js`, node puro):**
- `extractLines`: payload de 1 línea (fixture real), multi-línea, `DatosPrecio` vacío, `unitId` null vs nº.
- `hasDivisa`: `''`, ausente, `'USD'`, `'MXN'`.
- `pricesMatch`: `1`/`'1'`/`'1.00'` → match; `1`/`'1.5'`, `1`/`''`, `''`/`''` → no match; espacios.
- `perPieceEquivalent`: `10 × 0.5 = 5`; factor 0/NaN/negativo → null.
- `unitLabel` / `isPerPiece`: null→pieza; 3969→KGM; desconocido→"unidad #id".

**En vivo (con "FAKE PART OMAR"):** interceptar guardado, reconfirmar match/mismatch, sin divisa,
unidad ≠ pieza con y sin factor guardado, verificar que la carga masiva no se intercepta, toggle OFF/ON.

## Deploy

`tools/deploy.sh "feat(price-confirm-guard): …" --check price-confirm-guard` tras validación en vivo.
Registrar en `config.apps`, indexar en `CLAUDE.md`, bitácora en `docs/applets/`.

## Pendientes / Fase 2

- Guardar el factor de conversión (Create/Update InventoryItemUnitConversion) desde el modal si el
  operador lo teclea y no estaba guardado.
- Leer el factor del DOM (Panel A/B de `unit-autoconvert`) si ese modal está abierto en paralelo,
  antes de caer a input manual.
- Persistir el toggle (hoy default ON no persistente).
- Distinguir alta vs edición si se quiere aplicar solo a cambios.
