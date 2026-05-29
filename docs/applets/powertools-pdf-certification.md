# Power Tools `getPdfCustomization` — Certificación (`pdf/CERTIFICATION_TEMPLATE.ts`, slot `pdfType=CERTIFICATION_TEMPLATE`)

**Versión activa:** `id=10542` (2026-05-29, fix anti-blanqueo `value=null`). Anterior: `id=10490`.

Hook low-code que NO genera el PDF. Hace dos cosas: (1) enriquece `partsTransferAccounts[]` con un campo `quantityWithConversion` formateado en es-MX para que la plantilla de PDFGeneratorAPI lo imprima tal cual; (2) **sanea las mediciones con `value === null`** (parámetros sin medir) que de otro modo blanquean el cuerpo completo del certificado — ver §Bug del blanqueo.

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

## Bug del blanqueo — certificado en blanco (root cause 2026-05-29)

**Síntoma reportado:** certificados 38 y 39 salían "en blanco"; 35 y 37 se veían bien.

**Qué significaba "en blanco":** los PDFs NO eran de 0 bytes. Tenían encabezado (logo, datos de Ecoplating, cliente, leyenda de certificación) y pie ("Certificado por", "Powered by PDF Generator API"), pero **les faltaba el CUERPO completo**: el bloque "Documentos Relacionados", "Datos de Producción" (Número de Parte, Cantidad, Peso) y la tabla de mediciones.

**Hipótesis descartadas (con evidencia):**
- *No era el hook.* El hook producía su `additionalPayload` correctamente. Confirmado: cert 39 mandaba `partsTransferAccounts: list(1)` con `quantityWithConversion: "Cantidad: 550 Peso: 16.56 KGM "`.
- *No era `partsTransferAccounts` vacío/null.* El cert 38 sí tiene 0 partes (vacío legítimo — piezas que no se midieron a propósito), pero el cert 39 tenía **9 mediciones ligadas a partes** y aun así salía blanco.
- *El cuerpo del `.map` es null-safe.* El optional chaining (`pta.partNumber?.unitConversions?.filter(...).shift()`) hace short-circuit completo; PN/unitConversions nulos NO truenan. El único punto que tronaría es `inputs.partsTransferAccounts` nullish (de ahí el guard `?? []` agregado por defensa).

**Causa raíz real:** la plantilla de **PDFGeneratorAPI** (no nuestro hook) itera `specs[].specFields[].valuesAndParams[]` y accede a campos del objeto `value` (ej. `value.recordedValueAsString`, `value.passed`). Cuando un parámetro está **definido pero nunca se midió**, llega con `value: null`. El acceso a propiedades de `null` truena el render, y como TODO el cuerpo por-parte se arma dentro de ese mismo bloque, **se cae el bloque entero → cuerpo en blanco**. Encabezado y pie sobreviven porque viven fuera del bloque.

| cert | parámetros con `value=null` | render |
|---|---|---|
| 35, 37 (OK) | 0 | cuerpo completo |
| 39 (blanco) | 5 en `specs` (ej. "Aspecto Visual" 0/2 medidos) | cuerpo desaparece |
| 38 (blanco) | n/a — 0 partes | vacío legítimo (data, no bug) |

**Verificación (sin tocar el cert):** se replicó `GetPdfTemplateOutputToUserFile` con la data real del cert 39: control (tal cual) → 1 pág, cuerpo vacío; saneado (quitando los `value=null`) → **3 págs con cuerpo completo** (Peso 16.56 KGM + tabla de mediciones). Luego se corrió el JS compilado del hook nuevo sobre la data real → `value=null` restantes = 0, `quantityWithConversion` intacto.

**Fix (en el hook, no podemos editar la plantilla de PDFGeneratorAPI directo):** dentro del `.map`, antes de devolver cada `pta`, filtrar las entradas con `value === null` en `specs[].specFields[].valuesAndParams`, `couponValueAndParams` y `partAccountAncestors[].specValuePartsTransferAccounts`. Helper `hasValue = (e) => !!e && e.value != null`.

**Trade-off:** los parámetros sin medición dejan de imprimirse en el PDF (mismo comportamiento que un cert sano, que solo muestra lo medido). No se inventa nada; solo se evita el blanqueo total.

**Pendiente del lado Steelhead:** lo ideal es que Steelhead endurezca la plantilla PDFGeneratorAPI del `CERTIFICATION_TEMPLATE` para defender contra `value: null` (guard en cada acceso). El saneo en el hook es un workaround nuestro; la fragilidad de fondo vive en la plantilla. Reporte en inglés generado para Steelhead (`/tmp/steelhead-coc-blank-report.html`).

## Oportunidades

- Permitir elegir la conversión preferida (KGM > LB > otras) en lugar de `.shift()` arbitrario.
- Exponer también el valor numérico crudo (`convertedValue`) para que la plantilla pueda usarlo en sumas / cálculos, no solo el string preformateado.
- Considerar `helpers.addErrorMessage` cuando `partsTransferAccounts` llega vacío, para que el operador sepa por qué un cert sale sin cuerpo (hoy el `try/catch` traga el error en silencio).
