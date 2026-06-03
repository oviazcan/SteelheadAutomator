# Descripción CFDI compacta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comprimir la descripción de cada línea de factura para que la información esencial entre en los 60 chars que mide el SAT, y consolidar `PO/Lote/PS` en un solo label en el PDF.

**Architecture:** Dos cambios independientes. (A) `invoice.ts` (`getInvoicePricing`) genera la `description` del XML/SAT: sin NP (ya va en `Name`), labels comprimidos, colapso de `Lote==OC`, sin truncado pero con aviso al pasar de 60. (B) `INVOICE_TEMPLATE.ts` (`buildDescripcionHtml`) fusiona `PO/Lote/PS` cuando comparten valor base. La lógica pura de strings se prueba con un harness Node y se porta verbatim al `.ts` (que se valida en el sandbox de Steelhead).

**Tech Stack:** TypeScript (hooks Power Tools, sin build local), Node ≥18 (`node --test`) para los harness de verificación.

**Spec:** `docs/superpowers/specs/2026-06-03-descripcion-cfdi-compacta-design.md`

---

## Estructura de archivos

- **Crear** `tools/invoice_description.mjs` — función pura `construirDescripcionCFDI` (JS, fuente verificable de la lógica del SAT).
- **Crear** `tools/invoice_description.test.mjs` — tests de la función anterior.
- **Crear** `tools/pdf_description_fusion.mjs` — función pura `fusionarPoLotePs` (lógica de fusión del PDF).
- **Crear** `tools/pdf_description_fusion.test.mjs` — tests de la fusión.
- **Modificar** `powertools/synced/invoice/invoice.ts` — portar `construirDescripcionCFDI`, agregar constantes y aviso, reescribir descripción del path consolidado.
- **Modificar** `powertools/synced/pdf/INVOICE_TEMPLATE.ts` — integrar la fusión en `buildDescripcionHtml`.
- **Modificar** `docs/applets/powertools-facturacion.md` y `docs/applets/powertools-facturacion-pdf.md` — bitácoras.

> **Nota de sync:** `tools/*.mjs` es la copia *verificable* de la lógica pura. El `.ts` lleva la **misma** función inline (con tipos). Quien edite una, actualiza la otra. La función es pequeña a propósito para que el copy-paste sea trivial.

> **Nota de deploy:** los hooks de Power Tools NO se publican vía `gh-pages` ni `config.json`. El usuario los pega en el editor de Power Tools de Steelhead. No hay bump de versión de `config.json` en este plan.

---

## Task 1: Función pura `construirDescripcionCFDI` (harness Node, TDD)

**Files:**
- Create: `tools/invoice_description.mjs`
- Test: `tools/invoice_description.test.mjs`

- [ ] **Step 1: Escribir los tests que fallan**

Create `tools/invoice_description.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { construirDescripcionCFDI } from './invoice_description.mjs'

const flagsDefault = {
  MostrarNP: true, MostrarAcabado: true, MostrarProducto: true,
  MostrarRemision: true, MostrarPO: true, MultiplicadorLineaOC: 0,
  MostrarOV: false, MostrarOT: true, MostrarLote: true, MostrarPS: true,
}

const base = {
  partNumberName: '02104484',
  acabados: [],
  nombreProducto: 'Estañado',
  salesOrderName: '4507414828-10',
  salesOrderIdInDomain: '12345',
  salesOrderLineNumber: 1,
  workOrderIdInDomain: '5086',
  nombresLotes: ['4507414828-10'],
  packingSlips: ['4507414828-10 ZAPATA'],
  loteMinimoCargado: false,
  piezasLoteMinimo: null,
  flags: flagsDefault,
}

test('caso ejemplo: sin NP, sin PS cliente, lote colapsado por == OC', () => {
  assert.equal(construirDescripcionCFDI(base), 'Estañado OC 4507414828-10 OT 5086')
})

test('lote distinto del OC se incluye con label corto', () => {
  const r = construirDescripcionCFDI({ ...base, nombresLotes: ['LOTE-9'] })
  assert.equal(r, 'Estañado OC 4507414828-10 L LOTE-9 OT 5086')
})

test('acabados presentes', () => {
  const r = construirDescripcionCFDI({ ...base, acabados: ['Brillante'] })
  assert.equal(r, 'Estañado OC 4507414828-10 Ac Brillante OT 5086')
})

test('lote mínimo preserva la subcadena exacta y antepone producto', () => {
  const r = construirDescripcionCFDI({ ...base, loteMinimoCargado: true, piezasLoteMinimo: 415 })
  assert.equal(r, 'Estañado Cargo de lote mínimo aplicado')
  assert.ok(r.includes('Cargo de lote mínimo aplicado'))
})

test('MostrarOV agrega el id interno entre paréntesis', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarOV: true } })
  assert.equal(r, 'Estañado OC 4507414828-10 (12345) OT 5086')
})

test('MultiplicadorLineaOC agrega sufijo a la OC', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MultiplicadorLineaOC: 10 } })
  assert.equal(r, 'Estañado OC 4507414828-10-10 OT 5086')
})

test('MostrarProducto false: arranca con OC', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarProducto: false } })
  assert.equal(r, 'OC 4507414828-10 OT 5086')
})

test('MostrarOT false omite la OT', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarOT: false } })
  assert.equal(r, 'Estañado OC 4507414828-10')
})
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test tools/invoice_description.test.mjs`
Expected: FAIL — `Cannot find module './invoice_description.mjs'`

- [ ] **Step 3: Implementar la función pura**

Create `tools/invoice_description.mjs`:

```js
// Fuente verificable de la lógica de la descripción CFDI para el SAT.
// DEBE quedar idéntica a la copia inline en powertools/synced/invoice/invoice.ts.
export const construirDescripcionCFDI = (p) => {
  const { flags } = p

  // Caso especial: lote mínimo. Se preserva intacta la subcadena
  // "Cargo de lote mínimo aplicado" (el integrador SAT la parsea).
  if (p.loteMinimoCargado) {
    const partesLM = []
    if (flags.MostrarProducto && p.nombreProducto) partesLM.push(p.nombreProducto)
    partesLM.push('Cargo de lote mínimo aplicado')
    return partesLM.join(' ').trim()
  }

  const partes = []

  // BLOQUE 1: Producto (valor directo, sin label)
  if (flags.MostrarProducto && p.nombreProducto) {
    partes.push(p.nombreProducto)
  }

  // BLOQUE 2: OC
  if (flags.MostrarPO && p.salesOrderName) {
    let oc = `OC ${p.salesOrderName}`
    if (flags.MultiplicadorLineaOC > 0 && p.salesOrderLineNumber != null) {
      oc += `-${p.salesOrderLineNumber * flags.MultiplicadorLineaOC}`
    }
    if (flags.MostrarOV && p.salesOrderIdInDomain) {
      oc += ` (${p.salesOrderIdInDomain})`
    }
    partes.push(oc)
  }

  // BLOQUE 3: Lote — solo los nombres que difieran del OC (colapso de repetidos)
  if (flags.MostrarLote && p.nombresLotes.length > 0) {
    const lotesDistintos = p.nombresLotes.filter((l) => l !== p.salesOrderName)
    if (lotesDistintos.length > 0) {
      partes.push(`L ${lotesDistintos.join(', ')}`)
    }
  }

  // BLOQUE 4: Acabado
  if (flags.MostrarAcabado && p.acabados.length > 0) {
    partes.push(`Ac ${p.acabados.join(', ')}`)
  }

  // BLOQUE 5: OT
  if (flags.MostrarOT && p.workOrderIdInDomain) {
    partes.push(`OT ${p.workOrderIdInDomain}`)
  }

  // PS del cliente: NO se incluye en la descripción del SAT (redundante con OC;
  // su sufijo es la descripción del NP, no prioritaria). Se conserva en el PDF.

  const resultado = partes.join(' ').trim()
  // Red de seguridad absoluta (el SAT permite hasta 1000). El aviso de 60 lo
  // emite el caller; aquí NO truncamos a 60 para no mutilar la interfaz.
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
}
```

- [ ] **Step 4: Correr los tests para verlos pasar**

Run: `node --test tools/invoice_description.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/invoice_description.mjs tools/invoice_description.test.mjs
git commit -m "test(invoice): harness Node de construirDescripcionCFDI compacta"
```

---

## Task 2: Portar `construirDescripcionCFDI` a `invoice.ts` + constantes

**Files:**
- Modify: `powertools/synced/invoice/invoice.ts:27-110` (función) y `:14-25` (cerca de los tipos para constantes)

- [ ] **Step 1: Agregar las constantes de presupuesto**

En `invoice.ts`, justo antes de `const construirDescripcionCFDI` (línea 27), insertar:

```ts
// Presupuesto SAT. El XML corta la descripción a LIMITE_SAT. Steelhead anexa la
// remisión de embarque (", Packing Slip: nnnn") al final porque no está expuesta
// a este hook; por eso el aviso se dispara reservando ese margen.
const LIMITE_SAT = 60
const RESERVA_REMISION_SH = 20
const PRESUPUESTO_AVISO = LIMITE_SAT - RESERVA_REMISION_SH // ≈ 40
```

- [ ] **Step 2: Reemplazar el cuerpo de `construirDescripcionCFDI`**

Reemplazar TODO el cuerpo de la función (de la línea `const partes: string[] = []` hasta el `return` final, `invoice.ts:41-109`) por la lógica portada del harness (idéntica, con tipos TS):

```ts
  const { flags } = p

  // Caso especial: lote mínimo. Se preserva intacta la subcadena
  // "Cargo de lote mínimo aplicado" (el integrador SAT la parsea).
  if (p.loteMinimoCargado) {
    const partesLM: string[] = []
    if (flags.MostrarProducto && p.nombreProducto) partesLM.push(p.nombreProducto)
    partesLM.push('Cargo de lote mínimo aplicado')
    return partesLM.join(' ').trim()
  }

  const partes: string[] = []

  // BLOQUE 1: Producto (valor directo, sin label)
  if (flags.MostrarProducto && p.nombreProducto) {
    partes.push(p.nombreProducto)
  }

  // BLOQUE 2: OC
  if (flags.MostrarPO && p.salesOrderName) {
    let oc = `OC ${p.salesOrderName}`
    if (flags.MultiplicadorLineaOC > 0 && p.salesOrderLineNumber != null) {
      oc += `-${p.salesOrderLineNumber * flags.MultiplicadorLineaOC}`
    }
    if (flags.MostrarOV && p.salesOrderIdInDomain) {
      oc += ` (${p.salesOrderIdInDomain})`
    }
    partes.push(oc)
  }

  // BLOQUE 3: Lote — solo los nombres que difieran del OC (colapso de repetidos)
  if (flags.MostrarLote && p.nombresLotes.length > 0) {
    const lotesDistintos = p.nombresLotes.filter((l) => l !== p.salesOrderName)
    if (lotesDistintos.length > 0) {
      partes.push(`L ${lotesDistintos.join(', ')}`)
    }
  }

  // BLOQUE 4: Acabado
  if (flags.MostrarAcabado && p.acabados.length > 0) {
    partes.push(`Ac ${p.acabados.join(', ')}`)
  }

  // BLOQUE 5: OT
  if (flags.MostrarOT && p.workOrderIdInDomain) {
    partes.push(`OT ${p.workOrderIdInDomain}`)
  }

  // PS del cliente: NO se incluye en la descripción del SAT (redundante con OC;
  // su sufijo es la descripción del NP, no prioritaria). Se conserva en el PDF.

  const resultado = partes.join(' ').trim()
  // Red de seguridad absoluta (el SAT permite hasta 1000). El aviso de 60 lo
  // emite el caller; aquí NO truncamos a 60 para no mutilar la interfaz.
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
```

- [ ] **Step 3: Verificar visualmente la equivalencia con el harness**

Run: `diff <(sed -n '/Caso especial: lote mínimo/,/slice(0, 997)/p' tools/invoice_description.mjs) <(sed -n '/Caso especial: lote mínimo/,/slice(0, 997)/p' powertools/synced/invoice/invoice.ts)`
Expected: solo diferencias de tipos (`: string[]`) y nada de lógica. Revisar a ojo que los bloques coinciden.

- [ ] **Step 4: Commit**

```bash
git add powertools/synced/invoice/invoice.ts
git commit -m "feat(invoice): descripción CFDI compacta para el SAT (sin NP, labels cortos, colapso Lote==OC)"
```

---

## Task 3: Aviso (warning) cuando la descripción excede el presupuesto

**Files:**
- Modify: `powertools/synced/invoice/invoice.ts` — dentro de `getInvoicePricing`, en el loop principal y el reporte final.

- [ ] **Step 1: Contar líneas que exceden, dentro del loop**

En `invoice.ts`, después de asignar `uiLine.description = construirDescripcionCFDI({...})` (línea ~388-401), NO emitir por línea. Antes del loop (junto a `let lineasConLoteMinimo = 0`, línea ~242) declarar el contador:

```ts
  let lineasQueExcedenSat = 0
```

Y justo después de armar `uiLine.description` (después de la llamada a `construirDescripcionCFDI`, antes del push al resultado en la línea ~403), agregar:

```ts
    if ((uiLine.description?.length ?? 0) > PRESUPUESTO_AVISO) {
      lineasQueExcedenSat++
    }
```

- [ ] **Step 2: Emitir un solo aviso resumido**

Después del bloque que avisa de lote mínimo (`invoice.ts:430-436`), agregar:

```ts
  if (lineasQueExcedenSat > 0) {
    helpers.addErrorMessage({
      severity: 'warning',
      message: `${lineasQueExcedenSat} línea(s) con descripción larga (+ remisión de Steelhead) — el XML del SAT las cortará a ${LIMITE_SAT} caracteres.`,
    })
  }
```

- [ ] **Step 3: Commit**

```bash
git add powertools/synced/invoice/invoice.ts
git commit -m "feat(invoice): aviso cuando la descripción excede el límite de 60 del SAT"
```

---

## Task 4: Reescribir la descripción del path consolidado (Schneider)

**Files:**
- Modify: `powertools/synced/invoice/invoice.ts:496-522` (armado de `descConsolidada`)

- [ ] **Step 1: Reemplazar el armado de bloques consolidados**

Reemplazar el bloque que arma `partes`/`descConsolidada` (`invoice.ts:496-522`) por la versión comprimida (mismos labels y separador que el path normal; el listado de NPs se conserva porque el `Name` solo lleva uno):

```ts
      const partes: string[] = []
      if (flags.MostrarProducto && productName) {
        partes.push(productName)
      }
      if (flags.MostrarNP && allPNs.length > 0) {
        partes.push(`NPs(${allPNs.length}) ${allPNs.join(', ')}`)
      }
      if (flags.MostrarPO && allOVs.length > 0) {
        partes.push(`OC ${allOVs.join(', ')}`)
      }
      if (flags.MostrarLote && allLotes.length > 0) {
        const lotesDistintos = allLotes.filter((l) => !allOVs.includes(l))
        if (lotesDistintos.length > 0) partes.push(`L ${lotesDistintos.join(', ')}`)
      }
      if (flags.MostrarAcabado && allAcabados.length > 0) {
        partes.push(`Ac ${allAcabados.join(', ')}`)
      }
      if (flags.MostrarOT && allOTs.length > 0) {
        partes.push(`OT ${allOTs.join(', ')}`)
      }
      let descConsolidada = partes.join(' ').trim()
      if (descConsolidada.length > 1000) descConsolidada = descConsolidada.slice(0, 997) + '...'
      if (descConsolidada.length > PRESUPUESTO_AVISO) lineasQueExcedenSat++
```

> Nota: el PS del cliente se omite igual que en el path normal. El listado `NPs(N) …` se conserva porque esos NPs no caben en el `Name` único de la línea consolidada (puede exceder 60 → lo cubre el aviso del Task 3).

- [ ] **Step 2: Commit**

```bash
git add powertools/synced/invoice/invoice.ts
git commit -m "feat(invoice): descripción consolidada (Schneider) con el mismo estilo compacto"
```

---

## Task 5: Función pura `fusionarPoLotePs` (harness Node, TDD)

**Files:**
- Create: `tools/pdf_description_fusion.mjs`
- Test: `tools/pdf_description_fusion.test.mjs`

- [ ] **Step 1: Escribir los tests que fallan**

Create `tools/pdf_description_fusion.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fusionarPoLotePs } from './pdf_description_fusion.mjs'

test('PO=Lote, PS con prefijo+sufijo → PO/Lote/PS junto con sufijo', () => {
  const r = fusionarPoLotePs({
    po: '4507414828-10',
    loteNames: ['4507414828-10'],
    psVals: ['4507414828-10 ZAPATA'],
  })
  assert.equal(r.fusionado, true)
  assert.equal(r.label, 'PO/Lote/PS')
  assert.equal(r.valor, '4507414828-10 ZAPATA')
  assert.equal(r.psRestantes.length, 0)
})

test('PO=Lote=PS exacto sin sufijo', () => {
  const r = fusionarPoLotePs({
    po: '4507414828-10',
    loteNames: ['4507414828-10'],
    psVals: ['4507414828-10'],
  })
  assert.equal(r.label, 'PO/Lote/PS')
  assert.equal(r.valor, '4507414828-10')
})

test('PO=Lote pero PS distinto → PO/Lote + PS aparte', () => {
  const r = fusionarPoLotePs({
    po: '4507414828-10',
    loteNames: ['4507414828-10'],
    psVals: ['OTRA-COSA'],
  })
  assert.equal(r.label, 'PO/Lote')
  assert.equal(r.valor, '4507414828-10')
  assert.deepEqual(r.psRestantes, ['OTRA-COSA'])
})

test('Lote distinto del PO → no fusiona', () => {
  const r = fusionarPoLotePs({
    po: '4507414828-10',
    loteNames: ['LOTE-9'],
    psVals: ['4507414828-10 ZAPATA'],
  })
  assert.equal(r.fusionado, false)
})

test('sin lote → no fusiona', () => {
  const r = fusionarPoLotePs({ po: '4507414828-10', loteNames: [], psVals: [] })
  assert.equal(r.fusionado, false)
})

test('múltiples lotes mezclados → no fusiona', () => {
  const r = fusionarPoLotePs({
    po: '4507414828-10',
    loteNames: ['4507414828-10', 'OTRO'],
    psVals: ['4507414828-10'],
  })
  assert.equal(r.fusionado, false)
})

test('sufijos múltiples deduplicados', () => {
  const r = fusionarPoLotePs({
    po: 'PO1',
    loteNames: ['PO1'],
    psVals: ['PO1 A', 'PO1 A', 'PO1 B'],
  })
  assert.equal(r.label, 'PO/Lote/PS')
  assert.equal(r.valor, 'PO1 A, B')
})
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `node --test tools/pdf_description_fusion.test.mjs`
Expected: FAIL — `Cannot find module './pdf_description_fusion.mjs'`

- [ ] **Step 3: Implementar la fusión**

Create `tools/pdf_description_fusion.mjs`:

```js
// Decide si PO (nombre OV), Lote y PS comparten valor base y devuelve cómo
// renderizar el label combinado. DEBE quedar idéntica a la copia inline en
// powertools/synced/pdf/INVOICE_TEMPLATE.ts (helper de buildDescripcionHtml).
//
// Entrada:
//   po:         string|null  (salesOrder.name)
//   loteNames:  string[]     (nombres de lote de la línea)
//   psVals:     string[]     (packingSlips de la línea, ya como string)
// Salida:
//   { fusionado, label, valor, psRestantes }
export const fusionarPoLotePs = ({ po, loteNames, psVals }) => {
  const noFusion = { fusionado: false, label: '', valor: '', psRestantes: psVals }

  if (!po || loteNames.length === 0) return noFusion

  // Lote coincide si TODOS los nombres de lote == PO.
  const loteCoincide = loteNames.every((n) => n === po)
  if (!loteCoincide) return noFusion

  // PS coincide si TODOS los PS == PO o empiezan con "PO ". Extrae sufijos.
  const prefijo = po + ' '
  const psCoincide =
    psVals.length > 0 && psVals.every((ps) => ps === po || ps.startsWith(prefijo))

  if (psCoincide) {
    const sufijos = [
      ...new Set(psVals.map((ps) => (ps === po ? '' : ps.slice(prefijo.length))).filter(Boolean)),
    ]
    const valor = sufijos.length > 0 ? `${po} ${sufijos.join(', ')}` : po
    return { fusionado: true, label: 'PO/Lote/PS', valor, psRestantes: [] }
  }

  // Lote coincide pero PS no (o no hay PS): fusiona PO/Lote, deja PS aparte.
  return { fusionado: true, label: 'PO/Lote', valor: po, psRestantes: psVals }
}
```

- [ ] **Step 4: Correr los tests para verlos pasar**

Run: `node --test tools/pdf_description_fusion.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/pdf_description_fusion.mjs tools/pdf_description_fusion.test.mjs
git commit -m "test(pdf): harness Node de fusión PO/Lote/PS"
```

---

## Task 6: Integrar la fusión en `INVOICE_TEMPLATE.ts`

**Files:**
- Modify: `powertools/synced/pdf/INVOICE_TEMPLATE.ts` — `buildDescripcionHtml`, bloques 3 (OC) y 5 (Lote+PS).

- [ ] **Step 1: Calcular la fusión al inicio de `buildDescripcionHtml`**

Dentro de `buildDescripcionHtml`, después de `const item0 = items[0]` y `const partes: string[] = []` (línea ~282-284), insertar el helper inline + el cálculo:

```ts
      // Helper de fusión PO/Lote/PS (espejo de tools/pdf_description_fusion.mjs).
      const fusionarPoLotePs = (po: string | null, loteNames: string[], psVals: string[]) => {
        const noFusion = { fusionado: false, label: '', valor: '', psRestantes: psVals }
        if (!po || loteNames.length === 0) return noFusion
        if (!loteNames.every((n) => n === po)) return noFusion
        const prefijo = po + ' '
        const psCoincide =
          psVals.length > 0 && psVals.every((ps) => ps === po || ps.startsWith(prefijo))
        if (psCoincide) {
          const sufijos = [
            ...new Set(psVals.map((ps) => (ps === po ? '' : ps.slice(prefijo.length))).filter(Boolean)),
          ]
          const valor = sufijos.length > 0 ? `${po} ${sufijos.join(', ')}` : po
          return { fusionado: true, label: 'PO/Lote/PS', valor, psRestantes: [] as string[] }
        }
        return { fusionado: true, label: 'PO/Lote', valor: po, psRestantes: psVals }
      }

      const poName = item0?.salesOrderLineItem?.salesOrder?.name ?? null
      const loteNamesLinea = lotesDeLinea
        .map((l) => l.name)
        .filter((n): n is string => !!n)
      const psValsLinea = lotesDeLinea
        .map((l) => (l.packingSlip != null && l.packingSlip !== '' ? String(l.packingSlip) : null))
        .filter((p): p is string => !!p)
      const fusion =
        flags.MostrarPO && flags.MostrarLote
          ? fusionarPoLotePs(poName, loteNamesLinea, flags.MostrarPS ? psValsLinea : [])
          : { fusionado: false, label: '', valor: '', psRestantes: psValsLinea }
```

- [ ] **Step 2: Emitir el bloque combinado en lugar del bloque OC cuando hay fusión**

Reemplazar el bloque OC (`INVOICE_TEMPLATE.ts:316-338`) para que, si `fusion.fusionado`, emita el label combinado; si no, mantenga el render actual. Sustituir el `if (flags.MostrarPO) {` de apertura por:

```ts
      // ── Bloque 3: OC (OV) — o fusión PO/Lote/PS ──────────────────────
      if (fusion.fusionado) {
        const so = item0?.salesOrderLineItem?.salesOrder
        const lineaPO = flags.MostrarLineaPO
          ? `-${Number(line.salesOrderLineNumber ?? 0) * flags.MultiplicadorLineaOC}`
          : ''
        const ov = flags.MostrarOV ? ` (${so?.idInDomain ?? ''})` : ''
        const isPending = /pen/i.test(poName ?? '') || poName === '.'
        const cuerpo = `<b>${fusion.label}: </b>${fusion.valor}${lineaPO}${ov}`
        partes.push(
          isPending
            ? `<span style="color:red; font-size:14pt;">${cuerpo}</span><br>`
            : `${cuerpo}<br>`
        )
      } else if (flags.MostrarPO) {
        const so = item0?.salesOrderLineItem?.salesOrder;
        const soName = so?.name ?? null;
        if (soName) {
          const isPending = /pen/i.test(soName) || soName === ".";
          const lineaPO = flags.MostrarLineaPO
            ? `-${Number(line.salesOrderLineNumber ?? 0) *
                flags.MultiplicadorLineaOC}`
            : "";
          const ov = flags.MostrarOV
            ? ` (${so?.idInDomain ?? ""})`
            : "";

          if (isPending) {
            partes.push(
              `<span style="color:red; font-size:14pt;"><b> OC (OV): ${soName}${lineaPO}${
                flags.MostrarOV ? ov + "</b>" : "</b>"
              }</span><br>`
            );
          } else {
            partes.push(`<b> OC (OV): </b>${soName}${lineaPO}${ov}<br>`);
          }
        }
      }
```

- [ ] **Step 3: Ajustar el bloque Lote+PS para no repetir lo ya fusionado**

En el bloque Lote+PS (`INVOICE_TEMPLATE.ts:357-409`), envolver la lógica para que, cuando `fusion.fusionado === true`, se omita la parte Lote (ya está en el label combinado) y solo se rendericen los PS restantes + sufijo Schneider. Reemplazar la condición de apertura `if (flags.MostrarLote && lotesDeLinea.length > 0) {` por:

```ts
      // ── Bloque 5: Lote + PS (omite lo ya fusionado en el bloque 3) ─────
      const fusionConsumioLote = fusion.fusionado
      const psParaMostrar = fusion.fusionado ? fusion.psRestantes : psValsLinea
      if (flags.MostrarLote && lotesDeLinea.length > 0 && !fusionConsumioLote) {
```

Y dentro de ese bloque, reemplazar el cálculo de `psDistintos` (`INVOICE_TEMPLATE.ts:377-388`) para que use `psParaMostrar` en lugar de recalcular desde `lotesDeLinea`:

```ts
            const psDistintos = Array.from(
              new Set(
                psParaMostrar.filter(
                  (ps) => ps !== (nombresLote[0] ?? '')
                )
              )
            );
```

> Si `fusion.fusionado` es true, el bloque Lote+PS completo se salta (la condición `!fusionConsumioLote`), por lo que el PS restante (cuando la fusión fue solo `PO/Lote`) se pierde aquí. Para cubrir ese caso, agregar inmediatamente después del bloque Lote+PS un render de PS restantes:

```ts
      } else if (fusionConsumioLote && psParaMostrar.length > 0) {
        partes.push(`<b>PS: </b>${Array.from(new Set(psParaMostrar)).join(', ')}`)
      }
```

- [ ] **Step 4: Validar en el sandbox de Steelhead**

Pegar `INVOICE_TEMPLATE.ts` en el editor de Power Tools (hook `getPdfCustomization`), correr Test con la factura del ejemplo (PO `4507414828-10`, Lote `4507414828-10`, PS `4507414828-10 ZAPATA`).
Expected: `descripcionHtml` muestra una sola línea `<b>PO/Lote/PS: </b>4507414828-10 ZAPATA` y ya no las líneas separadas de OC + Lote.

- [ ] **Step 5: Commit**

```bash
git add powertools/synced/pdf/INVOICE_TEMPLATE.ts
git commit -m "feat(pdf): fusionar PO/Lote/PS en un label cuando comparten valor base"
```

---

## Task 7: Actualizar bitácoras

**Files:**
- Modify: `docs/applets/powertools-facturacion.md`
- Modify: `docs/applets/powertools-facturacion-pdf.md`

- [ ] **Step 1: Documentar el cambio en `powertools-facturacion.md`**

En la sección "Descripción CFDI" (donde hoy habla de `construirDescripcionCFDI` y el truncado a 1000), agregar una entrada con fecha 2026-06-03:

```markdown
**2026-06-03 — Descripción compacta para el SAT (≤60).** `construirDescripcionCFDI`
se reescribió para el límite de 60 chars del SAT: se quitó el NP (ya viaja en
`Name`/`NoIdentificacion`), labels comprimidos (`OC `/`OT `/`Ac `/`L `, sin
`Producto: `), separador de un espacio, colapso de `Lote==OC`, y el PS del cliente
ya NO va en la descripción del SAT. No se trunca a 60 (la interfaz comparte el
campo); en su lugar se emite un warning resumido cuando alguna línea supera
`PRESUPUESTO_AVISO` (≈40, reservando la remisión que Steelhead anexa). El caso
"Cargo de lote mínimo aplicado" preserva esa subcadena intacta. El path
consolidado (Schneider) usa el mismo estilo; el listado `NPs(N) …` se conserva.
Lógica pura verificada en `tools/invoice_description.{mjs,test.mjs}`.
```

- [ ] **Step 2: Documentar el cambio en `powertools-facturacion-pdf.md`**

En la sección "Descripción HTML", agregar:

```markdown
**2026-06-03 — Fusión PO/Lote/PS.** Cuando `salesOrder.name` (PO), los nombres de
lote y los packing slips de la línea comparten el mismo valor base, los bloques
"OC (OV)" y "Lote+PS" se fusionan en un solo `<b>PO/Lote/PS: </b>{base} {sufijo}`.
El sufijo del PS (ej. la descripción del NP, "ZAPATA") se anexa. Si solo coinciden
PO y Lote, se emite `PO/Lote: {base}` y el PS se muestra aparte. Si no hay
coincidencia, render separado como antes. El `(OV)` interno no participa en la
comparación. Lógica pura en `tools/pdf_description_fusion.{mjs,test.mjs}`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/applets/powertools-facturacion.md docs/applets/powertools-facturacion-pdf.md
git commit -m "docs(invoice): bitácoras de descripción compacta SAT + fusión PO/Lote/PS"
```

---

## Validación final (sandbox de Steelhead)

Tras implementar, validar manualmente (no hay runner local del `.ts`):

1. `invoice.ts` en el editor de Power Tools → factura ejemplo → `description == "Estañado OC 4507414828-10 OT 5086"`.
2. Lote ≠ OC → aparece `L …`.
3. Lote mínimo → la subcadena `"Cargo de lote mínimo aplicado"` está completa.
4. Factura con líneas largas → aparece el warning de >60; el string NO sale truncado a 60.
5. `INVOICE_TEMPLATE.ts` → `PO/Lote/PS: 4507414828-10 ZAPATA` en un renglón.
6. PS distinto del PO → `PO/Lote:` fusionado + `PS:` aparte.
7. Sin coincidencias → bloques separados (sin regresión).
8. Cliente Schneider → sufijo VM/VE intacto.

---

## Self-review (cobertura del spec)

- Spec §4.1 constantes → Task 2 Step 1. ✓
- Spec §4.2 estructura comprimida + colapso → Task 1/2. ✓
- Spec §4.3 flags (NP fuera) → Task 1/2 (función no usa partNumberName). ✓
- Spec §4.4 lote mínimo → Task 1 test + Task 2. ✓
- Spec §4.5 aviso sin truncar → Task 3. ✓
- Spec §4.6 path consolidado → Task 4. ✓
- Spec §4.7 helper compartido → la función pura centraliza el armado; el aviso vive en el caller. ✓
- Spec §5 fusión PDF (casos parciales, sufijo, sin coincidencia) → Task 5/6. ✓
- Spec §8 validación sandbox → "Validación final". ✓
