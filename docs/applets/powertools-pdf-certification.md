# Power Tools `getPdfCustomization` — Certificación (`pdf/CERTIFICATION_TEMPLATE.ts`, slot `pdfType=CERTIFICATION_TEMPLATE`)

Hook low-code que NO genera el PDF. Solo enriquece `partsTransferAccounts[]` con un campo `quantityWithConversion` formateado en es-MX para que la plantilla de PDFGeneratorAPI lo imprima tal cual.

## Lo que hace

```ts
result.additionalPayload = inputs.partsTransferAccounts.map(pta => ({
  ...pta,
  quantityWithConversion: <string formateado>
}))
```

`quantityWithConversion` se construye con la **primera** conversión válida del PN:

- `pta.partNumber.unitConversions.filter(c => c && c.factor != null && c.unit?.name).shift()`

Casos:

| Caso | Output |
|---|---|
| Hay conversión válida y qty > 0 | `"Cantidad: {qty} Peso: {qty × factor} {unitName}"` |
| Hay conversión pero `unitName` contiene "Kilogramo" | El literal `\bKilogramo\b` se reemplaza por `""` (case-insensitive) — queda solo lo que sigue ej. "KGM" |
| No hay conversión | `"Cantidad: {qty} sin peso"` |

Formateador: `new Intl.NumberFormat("es-MX", {minimumFractionDigits: 0, maximumFractionDigits: 2})`.

## Gotchas

- **Primera conversión = la que toma**: si el PN tiene varias conversiones (m², kg, lb), gana la primera en orden del shape. NO es determinístico sin ordenamiento explícito.
- **`Kilogramo` literal**: si el nombre de la unidad es "Kilogramo Métrico", queda " Métrico" con espacio inicial. Aceptable visualmente pero frágil si Steelhead cambia el nombre canónico.
- **Sin error blocker**: si el map truena, se atrapa con `try/catch` y se loguea, pero el PDF se genera igual (con `additionalPayload` ausente). La plantilla debe defender contra `undefined`.

## Plan de validación pendiente

1. Generar certificación para un PN con conversión a KGM válida — verificar que aparece "Cantidad: X Peso: Y KGM".
2. Generar para un PN sin conversiones — verificar "Cantidad: X sin peso".
3. Generar para un PN con unidad literal "Kilogramo" — verificar que NO aparece la palabra "Kilogramo" en el output.

## Oportunidades

- Permitir elegir la conversión preferida (KGM > LB > otras) en lugar de `.shift()` arbitrario.
- Exponer también el valor numérico crudo (`convertedValue`) para que la plantilla pueda usarlo en sumas / cálculos, no solo el string preformateado.
