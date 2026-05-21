# Trabajo con UI / DOM de Steelhead

**ANTES de empezar a escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — perdimos varias rondas en `invoice-autofill` (0.5.16 → 0.5.25) asumiendo `<label for>` cuando el modal manual usaba `<p>Label:</p>` con el field como SIBLING. Una sola inspección del wrapper hubiera resuelto todo en un commit.

## Patrones de label en Steelhead vistos hasta ahora

- **Forms RJSF (página invoice editada):** `<label class="control-label">` con input/select como sibling cercano. ID típicamente `root_<field>`.
- **Modal "Create Invoice Manually":** `<p class="MuiTypography-body1">Ship Date:</p>` (no `<label>`) seguido por `<div>...input...</div>` SIBLING. Para wrapper-de-un-solo-hijo, sube hasta el labelRoot que sea sibling del field.
- **Comboboxes react-select:** `<input role="combobox" aria-autocomplete="list">` dentro de `<div class="...-control">`. NO usar `value` setter — abrir con click, escribir search, click en option.
- **MUI X DatePicker (masked):** ignora native `value` setter; requiere keystroke-by-keystroke con `beforeinput`/`input` events.
- **react-datepicker (plain `<input type="text">`):** sí responde a native value setter + InputEvent.

## Auto-fill que reacciona a cambios del usuario

Patrones de cancellation tokens (`runId` monotónico + `myRunId` local + `bailIfStale()`), idempotencia de acciones "create", lectura label-driven de campos vs walking-up desde singleValues, y pausar fill mientras el usuario interactúa con el upstream input — documentados en detalle en [`../applets/invoice-autofill.md`](../applets/invoice-autofill.md).

El mismo patrón de cancellation token se aplica en `bulk-upload`, `process-deep-audit` y `spec-params-bulk` — ver sus bitácoras para variaciones específicas (pool concurrente con semáforo + `runPool(items, worker, concurrency, onProgress, myRunId)`).
