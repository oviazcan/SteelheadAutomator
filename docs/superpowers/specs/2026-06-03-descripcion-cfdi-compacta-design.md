# Diseño: descripción CFDI compacta para el SAT + consolidación de labels en el PDF

**Fecha:** 2026-06-03
**Applets afectados:** `invoice` (`facturacion.ts` / `getInvoicePricing`) y `pdf:INVOICE_TEMPLATE` (`facturacion-pdf.ts` / `getPdfCustomization`)
**Bitácoras:** `docs/applets/powertools-facturacion.md`, `docs/applets/powertools-facturacion-pdf.md`

## 1. Problema

La interfaz del SAT que recibe la **descripción de cada línea** de la factura tiene un límite de **60 caracteres**. Hoy `construirDescripcionCFDI` arma descripciones de ~100+ chars con mucho **overhead estructural** (labels `Producto: `, `OC: `, `OT: `, `Lote: `, `PS: ` y separadores `. `) y **datos redundantes** (NP duplicado, OC == Lote == PS base). El SAT corta a 60 y se pierde información relevante.

Ejemplo real (línea de factura, antes de que Steelhead anexe la remisión):

```
02104484. Producto: Estañado. OC: 4507414828-10. OT: 5086. Lote: 4507414828-10 PS: 4507414828-10 ZAPATA
└─ 103 chars ─┘
```

## 2. Hallazgos que fundamentan el diseño

1. **El NP ya viaja en el identificador.** Validado con un dump del payload del PDF: el `InvoiceLine.Name == "02104484"` (== `NoIdentificacion` del CFDI) y la `Description` lo **repite** al inicio. Quitar el NP de la descripción es seguro.
2. **El integrador del SAT solo parsea una subcadena:** `"Cargo de lote mínimo aplicado"` (la usa para reconvertir la unidad a Lote oficial). El resto de labels son puramente cosméticos → se pueden abreviar/quitar libremente.
3. **Steelhead anexa la remisión de embarque** (`, Packing Slip: <nnnn>`, ~20 chars) **al final** de la `description` de facturación, porque ese dato **no está expuesto** al hook `getInvoicePricing`. Esos ~20 chars **cuentan** dentro de los 60 del SAT.
4. **El SAT corta a 60 de forma silenciosa** (no rechaza). Decisión del negocio: **no truncar en el hook**, solo **avisar** cuando la descripción supere el presupuesto, para que el operador sepa que el XML la cortará.
5. **El PDF tiene su propia descripción rica e independiente** (`descripcionHtml` / `npHtml` en `INVOICE_TEMPLATE.ts`), construida desde datos crudos, no desde la `description` del hook de facturación. La remisión del PDF **ya funciona** (bloque "Remisión" desde `referencedPartAccounts` / `partAccounts[].packingSlip.idInDomain`). **No requiere arreglo.**

## 3. Decisiones (acordadas con el usuario)

| Tema | Decisión |
|---|---|
| Campos SAT vs PDF | **Independientes.** `invoice.ts` genera la del SAT/interfaz; `INVOICE_TEMPLATE.ts` la del PDF. |
| NP en descripción SAT | **Fuera** (ya va en `Name`). |
| PS del cliente en SAT | **Fuera** (redundante con OC; sufijo = descripción del NP, no prioritario). |
| Lote en SAT | Solo si **difiere** del OC (colapso de repetidos). |
| Producto/OC en SAT | **Siempre.** |
| OT en SAT | Se conserva pero es lo **menos prioritario** (lo primero que cae fuera de los 60). |
| Truncado SAT | **No truncar**; **warning** cuando la descripción + margen de remisión exceda 60. |
| Lote mínimo | Preservar intacta `"Cargo de lote mínimo aplicado"`. |
| PDF | Consolidar labels en un solo `PO/Lote/PS: {base} {sufijo}` cuando comparten valor base. |
| Remisión PDF | Sin cambios (ya funciona). |

## 4. Parte A — `invoice.ts` (`construirDescripcionCFDI`)

### 4.1 Constantes nuevas

```ts
const LIMITE_SAT = 60            // tope que mide el SAT sobre el texto final
const RESERVA_REMISION_SH = 20   // margen para ", Packing Slip: nnnn" que anexa Steelhead
const PRESUPUESTO_AVISO = LIMITE_SAT - RESERVA_REMISION_SH  // ≈ 40
```

Documentar el porqué de `RESERVA_REMISION_SH`: la remisión de embarque no está expuesta al hook y la agrega Steelhead al pie; por eso el aviso se dispara antes de los 60 "puros".

### 4.2 Estructura comprimida (caso normal)

Orden de bloques (prioridad descendente — lo de hasta arriba es lo que más merece caber en los primeros 60):

1. **Producto** — valor directo, **sin** label (`Estañado`), si `MostrarProducto && nombreProducto`.
2. **OC** — `OC {salesOrderName}` (+ `-{lineNumber*Multiplicador}` si `MultiplicadorLineaOC>0`; + ` (${salesOrderIdInDomain})` si `MostrarOV`), si `MostrarPO && salesOrderName`.
3. **Lote** — `L {lotes}`, **solo los nombres de lote que difieran del `salesOrderName`** (colapso). Si tras filtrar no queda ninguno, se omite el bloque. Aplica si `MostrarLote`.
4. **Acabado** — `Ac {acabados}`, si `MostrarAcabado && acabados.length`.
5. **OT** — `OT {workOrderIdInDomain}`, si `MostrarOT && workOrderIdInDomain`.

**PS del cliente:** **no** se incluye en la descripción del SAT (se conserva en el PDF).

**Separador entre bloques:** un espacio (` `).

Resultado para el ejemplo: `Estañado OC 4507414828-10 OT 5086` (33 chars) → con remisión SH `+20 = 53` ✅.

> Los textos exactos de labels (`OC `/`OT `/`Ac `/`L `) y el separador son **afinables**; lo invariante es: sin `Producto: `, sin `. `, sin NP, sin PS cliente, con colapso de Lote==OC.

### 4.3 Nota sobre flags

- `MostrarNP` **deja de afectar** la descripción del SAT (el NP va en `Name`). El flag sigue vivo para el PDF.
- `MostrarRemision` ya estaba bloqueado en este hook (PS de embarque no expuesto); sin cambios.

### 4.4 Caso lote mínimo

La rama de lote mínimo se mantiene, sin NP y preservando la subcadena exacta:

```
{Producto} Cargo de lote mínimo aplicado
```

- Se antepone el Producto (si `MostrarProducto`) para identidad; la frase sagrada va inmediatamente después (el integrador la busca como subcadena, no requiere posición fija).
- El sufijo `(X piezas)` **se omite** (no lo necesita el integrador y ayuda a caber en 60).
- `"Cargo de lote mínimo aplicado"` (29 chars) + remisión SH (~20) = ~49 < 60 ✅.

### 4.5 Aviso (warning)

Después de construir la descripción final del hook (sin la remisión SH, que no se controla):

```ts
if (descripcion.length > PRESUPUESTO_AVISO) {
  helpers.addErrorMessage({
    severity: 'warning',
    message: `Descripción de ${descripcion.length} chars (+ remisión de Steelhead) — el XML del SAT la cortará a ${LIMITE_SAT}.`,
  })
}
```

No se trunca el string (se mantiene la red de seguridad existente de 1000 chars para no romper la interfaz).

### 4.6 Path consolidado (Schneider Rojo Gómez)

El bloque de consolidación por Producto+Unidad (`invoice.ts:444-553`) usa el **mismo criterio de compresión**: labels cortos, separador de un espacio, sin label `Producto: `, colapso de repetidos, y el mismo `warning` de >60.

- Diferencia inherente: la línea consolidada agrupa **N NPs**; el `Name` solo lleva uno, así que el listado `NPs (N): …` **sí aporta** y se conserva (comprimido). Puede exceder 60 y el SAT lo cortará → se emite el warning. Documentar como limitación conocida (pendiente de validación piloto del consolidado).

### 4.7 Helper compartido

Extraer un helper puro `ensamblarDescripcion(bloques: string[], sep = ' ')` y `avisarSiExcede(desc, helpers)` para que ambos paths (normal y consolidado) compartan el ensamblado, el separador y el aviso. Mantiene la lógica de truncado/colapso en un solo lugar.

## 5. Parte B — `INVOICE_TEMPLATE.ts` (`buildDescripcionHtml`)

### 5.1 Objetivo

Cuando `PO` (nombre de la OV), `Lote` y `PS` comparten el mismo **valor base**, fusionarlos en un solo renglón con label combinado en vez de tres bloques separados.

Antes:
```
Producto: Estañado
OC (OV): 4507414828-10
Orden de Trabajo: 5086
Lote: 4507414828-10 PS: 4507414828-10 ZAPATA
```
Después:
```
Producto: Estañado
PO/Lote/PS: 4507414828-10 ZAPATA
Orden de Trabajo: 5086
```

### 5.2 Definiciones

- `PO = salesOrder.name` (soName).
- `Lote = lotesDeLinea[].name`.
- `PS = lotesDeLinea[].packingSlip`.
- **"valor base"**: cuando `PS` es de la forma `"{PO} {sufijo}"`, su valor base es `PO` y el `{sufijo}` (ej. `ZAPATA`) se extrae aparte.

### 5.3 Regla de fusión

Aplica solo si `MostrarPO` está activo (y `MostrarLote` para considerar Lote, `MostrarPS` para considerar PS).

1. **Lote coincide con PO** si todos los nombres de lote de la línea son `== PO` (conjunto `{PO}`).
2. **PS coincide con PO** si todo PS es `== PO` o empieza con `"{PO} "` (prefijo); se recolectan los sufijos.
3. Construir el label combinado **listando solo los campos que coinciden**, en orden `PO/Lote/PS`:
   - PO + Lote + PS coinciden → `PO/Lote/PS: {PO}{lineaPO}{ (OV)} {sufijos}`
   - PO + Lote coinciden, PS difiere/ausente → `PO/Lote: {PO}{lineaPO}{ (OV)}` y el bloque **PS se mantiene aparte** (regla actual).
   - Solo Lote coincide con PO (sin PS) → `PO/Lote: {PO}…`
   - **Nada coincide** → comportamiento **actual** (bloques `OC (OV)` y `Lote+PS` separados).
4. Cuando hay fusión, los bloques `OC (OV)` (bloque 3) y la parte fusionada de `Lote+PS` (bloque 5) se **reemplazan** por el bloque combinado, evitando repetir el valor.
5. El número interno de OV `(idInDomain)` **no** participa en la comparación de coincidencia; solo se anexa al render si `MostrarOV` (igual que hoy).
6. El **sufijo Schneider VM/VE** (líneas 393-400) se conserva al final del bloque, igual que hoy.

### 5.4 Casos límite

- **Múltiples lotes con valores distintos** en la misma línea: si no todos coinciden con PO, **no se fusiona** (se evita perder o mezclar datos) → comportamiento actual.
- **Mezcla de PS** (algunos coinciden, otros no): se fusionan los que coinciden; los PS no coincidentes se muestran en el bloque PS normal.
- **PS == Lote == PO** exactamente (sin sufijo): `PO/Lote/PS: {PO}` (sin sufijo colgante).

## 6. Antes / después (resumen)

**SAT (`invoice.ts`)**
```
ANTES:  02104484. Producto: Estañado. OC: 4507414828-10. OT: 5086. Lote: 4507414828-10 PS: 4507414828-10 ZAPATA   (103 + 20 = 123) ❌
DESPUÉS: Estañado OC 4507414828-10 OT 5086                                                                          (33 + 20 = 53) ✅
```

**PDF (`INVOICE_TEMPLATE.ts`)**
```
ANTES:  OC (OV): 4507414828-10 / Lote: 4507414828-10 PS: 4507414828-10 ZAPATA  (3 renglones)
DESPUÉS: PO/Lote/PS: 4507414828-10 ZAPATA                                       (1 renglón)
```

## 7. Fuera de alcance / lo que NO cambia

- La remisión del PDF (ya funciona).
- El cálculo de tipo de cambio, cantidad, lote mínimo (rate/quantity) en `invoice.ts`.
- El shape de salida (`lowCodeDefaultInvoiceLineItems`) y la lógica de consolidación por Producto+Unidad (solo cambia el texto de su descripción).
- El mapeo del integrador SAT (`Name`/`NoIdentificacion`) — no lo controla este repo.

## 8. Plan de validación (sandbox de Power Tools — no hay runner local)

`invoice.ts`:
1. Pegar el hook en el editor de Power Tools, correr Test con la factura del ejemplo (NP `02104484`, OC `4507414828-10`).
2. Verificar `description == "Estañado OC 4507414828-10 OT 5086"` (≤ presupuesto).
3. Caso con Lote ≠ OC → el bloque `L …` aparece.
4. Caso lote mínimo → la subcadena `"Cargo de lote mínimo aplicado"` está presente y completa.
5. Caso descripción larga → se emite el `warning` de >60 y **no** se trunca el string.
6. Path consolidado (si aplica a un cliente con flag) → labels comprimidos + warning.

`INVOICE_TEMPLATE.ts`:
7. Test con la factura del ejemplo → `descripcionHtml` muestra `PO/Lote/PS: 4507414828-10 ZAPATA` en un renglón.
8. Caso PS distinto del PO → `PO/Lote:` fusionado + `PS:` aparte.
9. Caso sin coincidencias → bloques separados (sin regresión).
10. Cliente Schneider → sufijo VM/VE intacto.

## 9. Riesgos

- **Aviso conservador:** `RESERVA_REMISION_SH` es un estimado (la longitud real de la remisión varía). Si sobre/sub-avisa, ajustar la constante.
- **Path consolidado:** listar N NPs puede exceder 60; el SAT corta. Es intrínseco al caso consolidado (pendiente de validación piloto previa).
- **Fusión PDF con datos heterogéneos:** ante múltiples lotes/PS mezclados se prefiere **no fusionar** para no perder datos; revisar si algún cliente espera fusión parcial agresiva.
