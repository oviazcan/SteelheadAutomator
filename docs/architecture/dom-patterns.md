# Trabajo con UI / DOM de Steelhead

**ANTES de empezar a escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — perdimos varias rondas en `invoice-autofill` (0.5.16 → 0.5.25) asumiendo `<label for>` cuando el modal manual usaba `<p>Label:</p>` con el field como SIBLING. Una sola inspección del wrapper hubiera resuelto todo en un commit.

## Regla: anclar por ESTRUCTURA idioma-indep; el texto es último recurso (estándar 2026-07-17)

Todo anclaje al UI de Steelhead debe ser **idioma-independiente** siempre que sea posible. La
UI de SH cambia de idioma por usuario/config y a veces es **mixta** en el mismo modal, así que
cualquier dependencia de texto visible es frágil por diseño — **incluso el texto bilingüe** (no
cubre un tercer idioma ni un cambio de wording de SH). El objetivo es **blindar a futuro**, no
solo tapar el locale de hoy.

### Jerarquía de anclaje (usa el primero disponible; nunca bajes de nivel sin necesidad)

1. **Handles semánticos estables** — lo mejor:
   - `data-steelhead-component-id="…"` (contenedores; ej. `CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS`, `PART_NUMBER_PAGE_UNITS`).
   - `data-testid="…"` (iconos MUI: `SendIcon`, `TodayIcon`, `CheckBoxIcon`, `DeleteIcon`…).
   - ids RJSF `root_<field>` (`root_DatosContables_Divisa`, `root_DatosPrecio_*`), `id="form-dialog-title"`.
   - `aria-label`, `role` (`dialog`, `tab`, `combobox`), `input[type=…]`, `href`/patrón de URL.
   - **Datos idioma-indep**: códigos de unidad (KGM/LBR/DMK…), IDs, `option[value]` (`USD`/`MXN`).
2. **Posición estructural relativa a (1)** — cuando (1) acota el bloque: "el `input[type=number]`
   dentro del panel", "el `<p>` cuyo 1er token es un código de unidad", "la última `<th>`",
   "el 2º input de la fila = recíproco" (patrón por POSICIÓN de `unit-autoconvert` Panel B).
3. **Texto bilingüe ES+EN** — **solo** donde SH no expone ningún handle estable. Con **ambos**
   strings confirmados (nunca adivinar la traducción). Marca la deuda si solo tienes uno.
4. ❌ **NUNCA** clases CSS hasheadas (`css-q6y9ln`, `css-4w3ppi`, emotion/MUI) — regeneran en
   cada build de SH; son **más** frágiles que el texto.

### Realidad a aceptar

- **No todo elemento tiene handle estable.** Ej.: la columna "Income Account" (invoice-autofill)
  solo tiene texto + clase hasheada + react-select de id dinámico. Ahí "volverlo HTML" = anclar
  por **posición** (frágil) o texto bilingüe. No inventes estructura que SH no da.
- **Evidencia primero (regla dura):** antes de reanclar, pide/consigue el **wrapper HTML** del
  bloque. No adivines ni la estructura ni la traducción.
- Hallazgo 2026-07-17: los **modales contables** de SH (Bill, líneas de factura, unit
  definitions) renderizan sus **etiquetas en inglés** aun con la instancia en español (solo los
  datos salen en ES). No urge traducir esos anclajes, pero **sí** conviene migrarlos a
  estructura cuando el handle existe (ej. bill-gate → `#root_DatosContables_Divisa`).

Patrón bueno de referencia: `proceso-calculator.findProcessControl()` (component-id primario +
texto fallback), `report-regen`/`sensor-graph-hide-all` (por `data-testid`), `bill-autofill`
gate (fallback `[role=dialog] #root_DatosContables_Divisa`). Inventario y estado de migración
en [`bilingual-anchoring-debt.md`](bilingual-anchoring-debt.md).

## Patrones de label en Steelhead vistos hasta ahora

- **Forms RJSF (página invoice editada):** `<label class="control-label">` con input/select como sibling cercano. ID típicamente `root_<field>`.
- **Modal "Create Invoice Manually":** `<p class="MuiTypography-body1">Ship Date:</p>` (no `<label>`) seguido por `<div>...input...</div>` SIBLING. Para wrapper-de-un-solo-hijo, sube hasta el labelRoot que sea sibling del field.
- **Comboboxes react-select:** `<input role="combobox" aria-autocomplete="list">` dentro de `<div class="...-control">`. NO usar `value` setter — abrir con click, escribir search, click en option.
- **MUI X DatePicker (masked):** ignora native `value` setter; requiere keystroke-by-keystroke con `beforeinput`/`input` events.
- **react-datepicker (plain `<input type="text">`):** sí responde a native value setter + InputEvent.

## Auto-fill que reacciona a cambios del usuario

Patrones de cancellation tokens (`runId` monotónico + `myRunId` local + `bailIfStale()`), idempotencia de acciones "create", lectura label-driven de campos vs walking-up desde singleValues, y pausar fill mientras el usuario interactúa con el upstream input — documentados en detalle en [`../applets/invoice-autofill.md`](../applets/invoice-autofill.md).

El mismo patrón de cancellation token se aplica en `bulk-upload`, `process-deep-audit` y `spec-params-bulk` — ver sus bitácoras para variaciones específicas (pool concurrente con semáforo + `runPool(items, worker, concurrency, onProgress, myRunId)`).
