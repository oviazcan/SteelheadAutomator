# Descripción del Número de Parte en la factura — diseño (2026-06-09)

> **Estado: IMPLEMENTADO Y DESPLEGADO (2026-06-09).** `invoice` → #5307, `pdf:INVOICE_TEMPLATE`
> → #10685. Lógica verificada en `tools/invoice_description.test.mjs` (12 verde); `diff` post-push
> local == server. Pendiente: validación con factura real en productivo (usuario).

## Contexto / problema

iMarz (proveedor de timbrado SAT) va a **remapear la descripción de cada línea al campo
de observaciones del CFDI (1000 chars)**, eliminando la limitante de 60 caracteres que
motivó el refactor compacto del 2026-06-03. Con ese espacio:

1. Queremos **anteponer la descripción textual de la pieza** (`partNumber.description`) al
   inicio de la descripción de cada línea de factura.
2. Reincorporar datos que se habían quitado por los 60 (PS del cliente) **respetando los
   flags `DatosFactura` del cliente**.
3. Usar labels un poco menos crípticos.

Afecta **dos hooks** del pipeline de facturación:
- `powertools/synced/invoice/invoice.ts` (`getInvoicePricing`) → la `description` que viaja al
  CFDI/SAT vía iMarz. **Cambio principal.**
- `powertools/synced/pdf/INVOICE_TEMPLATE.ts` (`getPdfCustomization`) → el PDF visual.
  **Ajuste de consistencia**, preservando el HTML que pinta de rojo la OC pendiente.

## Decisiones cerradas (con el usuario, 2026-06-09)

| # | Decisión |
|---|---|
| 1 | `MostrarNP` se **repurposa**: la *key* del customInput NO cambia; el usuario ajusta la etiqueta visible en Steelhead a "Mostrar Descripción del Número de parte". En el hook, cuando es `true` (default), antepone `partNumber.description`. |
| 2 | El **nombre/clave del NP** (ej. `02104484`) **NO va** en la descripción: ya viaja en `NoIdentificacion` del CFDI. |
| 3 | **PS del cliente reincorporado** con el flag `MostrarPS`. |
| 4 | **iMarz ya está activo** (1000 chars) → se despliega sin riesgo de corte a 60. |
| 5 | **Lote mínimo** intacto: se preserva la subcadena `"Cargo de lote mínimo aplicado"` (iMarz la detecta). |
| 6 | Se **quita el warning de >60** y la red de seguridad sube a 1000. |
| 7 | **Acabado** se mueve a **justo después de Producto** (si `MostrarAcabado`). |
| 8 | **Labels**: descNP y Producto sin etiqueta; `OC`, `Lote`, `Acabado`, `OT`, `PS` con etiqueta. Bloques separados por coma. |
| 9 | **Consolidado** (Schneider): sin descNP ni `NPs(N)` — los NPs ya salen en la lista adjunta del PDF (`lineasConsolidadasPorProducto`). El usuario lo valida en productivo. |
| 10 | **PDF**: alinear la 2ª celda al orden del CFDI (Lote antes de OT) + homologar labels, **preservando el rojo de pendiente**. |

## Diseño A — CFDI (`invoice.ts` → `construirDescripcionCFDI`)

### Formato (caso normal, por línea)

Bloques en orden, separados por `, `, cada uno condicionado a su flag; se omite limpio si el
flag está off o no hay dato (sin comas colgantes):

```
<descripción del NP>, <Producto>, Acabado <ac>, OC <oc>, Lote <lotes>, OT <ot>, PS <ps>
```

Ejemplo:
```
Tornillo hex M8x40 acero inox 316, Estañado, Acabado Brillante, OC 4507414828-10, Lote A23, OT 5086, PS 1234
```

| Orden | Bloque | Etiqueta | Flag | Fuente |
|---|---|---|---|---|
| 1 | Descripción del NP | *(sin)* | `MostrarNP` (repurposed) | `partNumber.description` (fallback `descriptionMarkdown` limpio) |
| 2 | Producto | *(sin)* | `MostrarProducto` | `product.name` |
| 3 | Acabado | `Acabado` | `MostrarAcabado` | labels del WO |
| 4 | OC | `OC` | `MostrarPO` (+`MultiplicadorLineaOC`, +`MostrarOV`) | `salesOrderName` |
| 5 | Lote | `Lote` | `MostrarLote` | lotes ≠ OC |
| 6 | OT | `OT` | `MostrarOT` | `workOrderIdInDomain` |
| 7 | PS | `PS` | `MostrarPS` | `packingSlips` (del cliente) |

### Casos especiales

- **Lote mínimo**: `<descNP>, <Producto>, Cargo de lote mínimo aplicado` (descNP/Producto según
  flags). Se preserva la subcadena exacta para iMarz.
- **Consolidado** (Schneider Rojo Gómez): mismos bloques **menos descNP y menos `NPs(N)`**.
  Queda: `<Producto>, Acabado <ac>, OC <oc>, Lote <lotes>, OT <ot>, PS <ps>`. Los NPs van en la
  sub-tabla del PDF.
- **Notas de crédito** (total negativo): sin cambio respecto a hoy.

### Implementación

- Reescribir `construirDescripcionCFDI`: separador `, `, nuevo orden, labels nuevos, bloque PS,
  descNP al inicio.
- Fuente de la descripción del NP: el typedef del hook de factura solo declara
  `partNumber.descriptionMarkdown`. Leer `(partNumber as any).description ?? descriptionMarkdown`
  y limpiar markdown ligero (quitar `**`/`*`/`_`/`#`, saltos de línea → espacio, colapsar
  espacios). **Punto a validar en productivo**: confirmar que `description` plano llega al hook.
- Agregar `description` al recolectar datos en el loop principal (junto a `partNumberName`).
- Quitar `LIMITE_SAT`/`RESERVA_REMISION_SH`/`PRESUPUESTO_AVISO` y el warning de descripción larga
  (>60). Mantener la red de seguridad a 1000.
- Path consolidado: quitar el bloque `NPs(N)`; aplicar el mismo orden/labels nuevos.

## Diseño B — PDF (`INVOICE_TEMPLATE.ts`)

El PDF ya tiene **dos celdas** que coinciden con la estructura deseada:

- **1ª celda `npHtml`** (`:472-535`): `name` + descripción del NP + Acabado. **Sin cambios
  sustantivos** (ya cumple). Respeta `MostrarNP` y `MostrarAcabado`.
- **2ª celda `descripcionHtml`** (`:262-461`): Producto · Remisión · OC(OV) · OT · Lote+PS.

### Cambios en la 2ª celda

1. **Reordenar** para alinear al CFDI: `Producto · Remisión · OC · Lote+PS · OT`
   (mover el bloque Lote+PS antes del bloque OT). Es solo cambiar el orden de los `partes.push`;
   la lógica de cada bloque no cambia.
2. **Homologar labels** a los del CFDI donde aplique: `Orden de Trabajo:` → `OT:`.
   `OC (OV):` → `OC:` (el `(OV)` se sigue agregando condicional con `MostrarOV`). `Lote:`/`PS:`/
   `Remisión:` se mantienen.

### Preservar el rojo de pendiente (NO romper)

El rojo vive **solo** en el Bloque 3 (OC) de `descripcionHtml`, en dos ramas:
- Fusión PO/Lote/PS (`:352-357`)
- OC normal (`:363-380`)

Regla: `isPending = /pen/i.test(poName) || poName === "."` → envuelve el cuerpo en
`<span style="color:red; font-size:14pt;">…</span>`. Al cambiar el label `OC (OV):` → `OC:`
hay que editarlo en **las 4 ubicaciones** (2 ramas × pending/no-pending) **sin alterar** el
`<span>` rojo ni la condición `isPending`. El reordenamiento de Lote/OT no toca este bloque.

## Riesgos / validación

- **`partNumber.description` disponible en el hook de factura**: no garantizado por el typedef.
  Fallback a `descriptionMarkdown` limpio. Validar en productivo con una factura real.
- **El rojo de pendiente**: validar en productivo una factura con OC pendiente (`poName` con
  "pen" o ".") → la OC debe seguir en rojo 14pt.
- **Consolidado**: validar en productivo que la descripción consolidada ya no trae `NPs(N)` y que
  los NPs siguen en la sub-tabla del PDF.
- **Despliegue**: `lowcode_sync.py push` para `invoice` y `pdf:INVOICE_TEMPLATE`. Cada versión
  anterior queda en el historial de Steelhead para rollback.

## Plan

1. Implementar `invoice.ts` (CFDI) — cambio principal.
2. Implementar `INVOICE_TEMPLATE.ts` (PDF) — reorden + labels, preservando el rojo.
3. Dry-run de compilación de ambos.
4. Push a productivo (invoice + pdf:INVOICE_TEMPLATE).
5. Verificar `diff` post-push (local == server) y el usuario valida con facturas reales.
6. Actualizar `docs/applets/powertools-facturacion.md` y `powertools-facturacion-pdf.md`.
