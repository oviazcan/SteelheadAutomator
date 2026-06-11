# Etiquetas `N:` / `O:` en la descripción CFDI — diseño (2026-06-10)

> **Estado: IMPLEMENTADO Y DESPLEGADO (2026-06-10).** `invoice` → **#5309** (2026-06-11 UTC).
> Lógica verificada en `tools/invoice_description.test.mjs` (20 verde); diff post-push
> local == server. Pendiente: validación con factura real en productivo (usuario).
> Continúa el trabajo de `2026-06-09-descripcion-np-facturacion-design.md`, que dejó la
> descripción del NP al inicio **sin label**. Aquí se reintroducen etiquetas con otra
> semántica.

## Contexto / problema

iMarz (timbrado SAT) remapea la descripción de cada línea al campo de **observaciones** del
CFDI. El requerimiento nuevo es que la descripción de cada línea distinga dos secciones
etiquetadas:

- **`N:`** — la descripción textual del Número de parte (la pieza).
- **`O:`** — todo lo demás (observaciones): Producto, Acabado, OC, Lote, OT, PS.

Afecta **un solo hook** del pipeline de facturación:

- `powertools/synced/invoice/invoice.ts` (`getInvoicePricing`) → la `description` que viaja al
  CFDI/SAT vía iMarz. **Único cambio.**

**NO se toca** el PDF visual (`powertools/synced/pdf/INVOICE_TEMPLATE.ts`).

## Decisiones cerradas (con el usuario, 2026-06-10)

| # | Decisión |
|---|---|
| 1 | Dos secciones etiquetadas: `N:` (descripción del NP) y `O:` (todo lo demás), en ese orden. |
| 2 | El `O:` es **un solo prefijo** que encabeza todo el resto; los sub-labels internos (Acabado, OC, Lote, OT, PS) **se conservan** dentro del bloque O:. |
| 3 | Separador **entre** el bloque `N:` y el `O:`: un **espacio**. Separador **interno** del bloque O:: `, ` (coma), igual que hoy. |
| 4 | **`N:` siempre presente** (estructural). Si `MostrarNP` está off, o no hay dato, o es consolidado → `N: N/A`. |
| 5 | Placeholder cuando no hay dato: **`N/A`** (no guión, no `S/D`). |
| 6 | **`O:` siempre presente.** Si el bloque queda vacío (todos sus flags off — muy raro) → `O: N/A`, por simetría. |
| 7 | **Lote mínimo**: el cargo va **dentro de O:**, preservando textual la subcadena `"Cargo de lote mínimo aplicado"` (iMarz la detecta). |
| 8 | **Consolidado** (Schneider Rojo Gómez): el path inline también se envuelve → `N: N/A O: <Producto>, Acabado…, OC…, …`. Sigue sin descNP ni lista de NPs (esos van en la sub-tabla del PDF). |
| 9 | Red de seguridad de **1000 chars** se mantiene (corte sobre el string final `N: … O: …`). |
| 10 | Orden y lógica internos del bloque O: **sin cambios** respecto a hoy (colapso de Lote == OC, `MultiplicadorLineaOC`, `(OV)` con `MostrarOV`, dedup de PS, etc.). |

## Formato

### Caso normal (por línea)

```
N: <descNP | N/A> O: <Producto>, Acabado <ac>, OC <oc>, Lote <lotes>, OT <ot>, PS <ps>
```

Ejemplo (caso base):

```
N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10, OT 5086, PS 1234
```

| Sección | Etiqueta | Contenido | Regla |
|---|---|---|---|
| 1 | `N:` | descripción del NP | `MostrarNP && descripcionNP` → texto; si no → `N/A` |
| 2 | `O:` | Producto · Acabado · OC · Lote · OT · PS | cada sub-bloque con su flag y label de hoy; si todo vacío → `N/A` |

### Casos especiales

| Caso | Resultado |
|---|---|
| Sin descNP (dato nulo) | `N: N/A O: Estañado, OC 4507414828-10, OT 5086, PS 1234` |
| `MostrarNP` = false | `N: N/A O: Estañado, OC 4507414828-10, OT 5086, PS 1234` |
| Consolidado (Schneider) | `N: N/A O: Estañado, Acabado Brillante, OC …` |
| Lote mínimo | `N: Tornillo hex M8x40 acero inox 316 O: Estañado, Cargo de lote mínimo aplicado` |
| Lote mínimo sin descNP | `N: N/A O: Estañado, Cargo de lote mínimo aplicado` |
| Bloque O: vacío (todos los flags O: off) | `N: Tornillo hex M8x40 acero inox 316 O: N/A` |
| N: y O: vacíos | `N: N/A O: N/A` |

## Implementación

### Helper compartido `formatearNO`

Extraer un helper que arme las dos secciones + el corte a 1000, usado por **ambos** paths
(caso normal y consolidado):

```js
// descripcionNP: string ya resuelto por el caller (null si MostrarNP off o sin dato)
// observaciones: string[] ya armado por el caller (Producto, Acabado, OC, Lote, OT, PS)
const formatearNO = (descripcionNP, observaciones) => {
  const seccionN = `N: ${descripcionNP && descripcionNP.trim() ? descripcionNP : 'N/A'}`
  const seccionO = `O: ${observaciones.length > 0 ? observaciones.join(', ') : 'N/A'}`
  const resultado = `${seccionN} ${seccionO}`
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
}
```

- En `invoice.ts` el helper lleva tipos (`descripcionNP: string | null`, `observaciones: string[]`).
- El placeholder `N/A` se decide **solo** dentro del helper; los callers solo deciden si pasan
  `descripcionNP` o `null`.

### `construirDescripcionCFDI` (caso normal)

Misma recolección y misma lógica por bloque que hoy, pero:

1. `const descNP = flags.MostrarNP && p.descripcionNP ? p.descripcionNP : null`.
2. Acumular Producto/Acabado/OC/Lote/OT/PS en un array `observaciones` (en vez de `partes`).
3. Lote mínimo: empuja `'Cargo de lote mínimo aplicado'` a `observaciones` y retorna
   `formatearNO(descNP, observaciones)` (el Producto ya entró antes si su flag está on).
4. Retorno final: `return formatearNO(descNP, observaciones)`. Se elimina el corte a 1000
   manual del final (ahora vive en `formatearNO`).

### Path consolidado inline (`invoice.ts`, ~líneas 511-536)

El bloque arma `partes` (Producto, Acabado, OC, Lote, OT, PS) y hoy hace
`partes.join(', ')` + corte a 1000. Se reemplaza por:

```js
descConsolidada = formatearNO(null, partes) // null → "N: N/A"
```

Se elimina el corte manual a 1000 (lo hace `formatearNO`).

### Espejo y tests

- `tools/invoice_description.mjs`: espejar `formatearNO` + `construirDescripcionCFDI`.
  Exportar ambos (el helper para poder testear el caso O: vacío de forma directa).
- `tools/invoice_description.test.mjs`:
  - **Actualizar los 12 casos** existentes a los strings nuevos `N: … O: …`.
  - **Agregar** casos: `MostrarNP` off → `N: N/A …`; `descripcionNP` null → `N: N/A …`;
    lote mínimo sin descNP → `N: N/A O: Estañado, Cargo de lote mínimo aplicado`;
    bloque O: vacío → `… O: N/A`; N: y O: vacíos → `N: N/A O: N/A`.
  - Mantener el assert de que `"Cargo de lote mínimo aplicado"` sigue como subcadena exacta.

### TDD

1. Reescribir los expected de los 12 tests + agregar los nuevos. Verlos fallar (rojo).
2. Implementar `formatearNO` + ajustar `construirDescripcionCFDI` y el path consolidado en el
   espejo `.mjs` hasta verde.
3. Portar idéntico a `invoice.ts` (inline + tipos). Dry-run de compilación.

## Riesgos / validación

- **Parseo de iMarz**: confirmar que iMarz acepta el prefijo `N: … O: …` y que sigue
  detectando `"Cargo de lote mínimo aplicado"` como subcadena. Validar con factura real.
- **`N/A` en consolidado**: confirmar en productivo que el consolidado timbra `N: N/A O: …`
  sin romper la sub-tabla de NPs del PDF (que no se toca).
- **Despliegue**: `lowcode_sync.py push` solo para `invoice`. La versión anterior queda en el
  historial de Steelhead para rollback.

## Plan

1. Tests primero (espejo `.mjs`) — rojo.
2. Implementar `formatearNO` + `construirDescripcionCFDI` + path consolidado en el espejo — verde.
3. Portar a `invoice.ts` (inline + tipos) y dry-run de compilación.
4. `diff` espejo `.mjs` ↔ inline `invoice.ts` (deben quedar idénticos en lógica).
5. Push a productivo (`invoice`) y verificar `diff` post-push (local == server).
6. Usuario valida con factura real. Actualizar `docs/applets/powertools-facturacion.md`.
