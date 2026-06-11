import { test } from 'node:test'
import assert from 'node:assert/strict'
import { construirDescripcionCFDI, formatearNO } from './invoice_description.mjs'

const flagsDefault = {
  MostrarNP: true, MostrarAcabado: true, MostrarProducto: true,
  MostrarRemision: true, MostrarPO: true, MultiplicadorLineaOC: 0,
  MostrarOV: false, MostrarOT: true, MostrarLote: true, MostrarPS: true,
}

const base = {
  partNumberName: '02104484',
  descripcionNP: 'Tornillo hex M8x40 acero inox 316',
  acabados: [],
  nombreProducto: 'Estañado',
  salesOrderName: '4507414828-10',
  salesOrderIdInDomain: '12345',
  salesOrderLineNumber: 1,
  workOrderIdInDomain: '5086',
  nombresLotes: ['4507414828-10'],
  packingSlips: ['1234'],
  loteMinimoCargado: false,
  piezasLoteMinimo: null,
  flags: flagsDefault,
}

// ── construirDescripcionCFDI: secciones N: / O: ──────────────────────────────

test('caso base: N: descNP + O: Producto, OC, OT, PS (lote colapsado por == OC)', () => {
  assert.equal(
    construirDescripcionCFDI(base),
    'N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10, OT 5086, PS 1234'
  )
})

test('lote distinto del OC se incluye con label "Lote", entre OC y OT', () => {
  const r = construirDescripcionCFDI({ ...base, nombresLotes: ['LOTE-9'] })
  assert.equal(
    r,
    'N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10, Lote LOTE-9, OT 5086, PS 1234'
  )
})

test('acabado va justo después del producto, dentro de O:', () => {
  const r = construirDescripcionCFDI({ ...base, acabados: ['Brillante'] })
  assert.equal(
    r,
    'N: Tornillo hex M8x40 acero inox 316 O: Estañado, Acabado Brillante, OC 4507414828-10, OT 5086, PS 1234'
  )
})

test('lote mínimo: dentro de O:, subcadena exacta intacta, con N: descNP', () => {
  const r = construirDescripcionCFDI({ ...base, loteMinimoCargado: true, piezasLoteMinimo: 415 })
  assert.equal(r, 'N: Tornillo hex M8x40 acero inox 316 O: Estañado, Cargo de lote mínimo aplicado')
  assert.ok(r.includes('Cargo de lote mínimo aplicado'))
})

test('lote mínimo sin descNP: N: N/A, subcadena intacta', () => {
  const r = construirDescripcionCFDI({ ...base, descripcionNP: null, loteMinimoCargado: true, piezasLoteMinimo: 415 })
  assert.equal(r, 'N: N/A O: Estañado, Cargo de lote mínimo aplicado')
  assert.ok(r.includes('Cargo de lote mínimo aplicado'))
})

test('MostrarOV agrega el id interno entre paréntesis', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarOV: true } })
  assert.equal(
    r,
    'N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10 (12345), OT 5086, PS 1234'
  )
})

test('MultiplicadorLineaOC agrega sufijo a la OC', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MultiplicadorLineaOC: 10 } })
  assert.equal(
    r,
    'N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10-10, OT 5086, PS 1234'
  )
})

test('MostrarNP false: N: N/A, O: con el resto', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarNP: false } })
  assert.equal(r, 'N: N/A O: Estañado, OC 4507414828-10, OT 5086, PS 1234')
})

test('descripcionNP null: N: N/A aunque MostrarNP sea true', () => {
  const r = construirDescripcionCFDI({ ...base, descripcionNP: null })
  assert.equal(r, 'N: N/A O: Estañado, OC 4507414828-10, OT 5086, PS 1234')
})

test('MostrarPS false omite el PS del cliente', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarPS: false } })
  assert.equal(r, 'N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10, OT 5086')
})

test('MostrarProducto false: O: arranca con la OC', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarProducto: false } })
  assert.equal(r, 'N: Tornillo hex M8x40 acero inox 316 O: OC 4507414828-10, OT 5086, PS 1234')
})

test('MostrarOT false omite la OT', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarOT: false } })
  assert.equal(r, 'N: Tornillo hex M8x40 acero inox 316 O: Estañado, OC 4507414828-10, PS 1234')
})

test('bloque O: vacío (todos los flags de O: off) → O: N/A', () => {
  const r = construirDescripcionCFDI({
    ...base,
    flags: {
      ...flagsDefault,
      MostrarProducto: false, MostrarAcabado: false, MostrarPO: false,
      MostrarLote: false, MostrarOT: false, MostrarPS: false,
    },
  })
  assert.equal(r, 'N: Tornillo hex M8x40 acero inox 316 O: N/A')
})

test('N: y O: vacíos → N: N/A O: N/A', () => {
  const r = construirDescripcionCFDI({
    ...base,
    flags: {
      ...flagsDefault,
      MostrarNP: false, MostrarProducto: false, MostrarAcabado: false,
      MostrarPO: false, MostrarLote: false, MostrarOT: false, MostrarPS: false,
    },
  })
  assert.equal(r, 'N: N/A O: N/A')
})

test('todos los bloques juntos en orden correcto', () => {
  const r = construirDescripcionCFDI({
    ...base,
    acabados: ['Brillante'],
    nombresLotes: ['LOTE-9'],
    packingSlips: ['1234', '5678'],
    flags: { ...flagsDefault, MostrarOV: true },
  })
  assert.equal(
    r,
    'N: Tornillo hex M8x40 acero inox 316 O: Estañado, Acabado Brillante, OC 4507414828-10 (12345), Lote LOTE-9, OT 5086, PS 1234, 5678'
  )
})

test('red de seguridad: corta a 1000 chars con elipsis', () => {
  const r = construirDescripcionCFDI({ ...base, descripcionNP: 'X'.repeat(1100) })
  assert.equal(r.length, 1000)
  assert.ok(r.endsWith('...'))
})

// ── formatearNO: helper de las dos secciones ─────────────────────────────────

test('formatearNO: descNP + observaciones', () => {
  assert.equal(formatearNO('Pieza X', ['Estañado', 'OC 123']), 'N: Pieza X O: Estañado, OC 123')
})

test('formatearNO: sin descNP → N: N/A', () => {
  assert.equal(formatearNO(null, ['Estañado']), 'N: N/A O: Estañado')
})

test('formatearNO: observaciones vacías → O: N/A', () => {
  assert.equal(formatearNO('Pieza X', []), 'N: Pieza X O: N/A')
})

test('formatearNO: ambos vacíos → N: N/A O: N/A', () => {
  assert.equal(formatearNO(null, []), 'N: N/A O: N/A')
})
