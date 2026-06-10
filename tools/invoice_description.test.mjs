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

test('caso base: descNP + Producto + OC + OT + PS (lote colapsado por == OC)', () => {
  assert.equal(
    construirDescripcionCFDI(base),
    'Tornillo hex M8x40 acero inox 316, Estañado, OC 4507414828-10, OT 5086, PS 1234'
  )
})

test('lote distinto del OC se incluye con label "Lote", entre OC y OT', () => {
  const r = construirDescripcionCFDI({ ...base, nombresLotes: ['LOTE-9'] })
  assert.equal(
    r,
    'Tornillo hex M8x40 acero inox 316, Estañado, OC 4507414828-10, Lote LOTE-9, OT 5086, PS 1234'
  )
})

test('acabado va justo después del producto', () => {
  const r = construirDescripcionCFDI({ ...base, acabados: ['Brillante'] })
  assert.equal(
    r,
    'Tornillo hex M8x40 acero inox 316, Estañado, Acabado Brillante, OC 4507414828-10, OT 5086, PS 1234'
  )
})

test('lote mínimo preserva la subcadena exacta y antepone descNP + producto', () => {
  const r = construirDescripcionCFDI({ ...base, loteMinimoCargado: true, piezasLoteMinimo: 415 })
  assert.equal(r, 'Tornillo hex M8x40 acero inox 316, Estañado, Cargo de lote mínimo aplicado')
  assert.ok(r.includes('Cargo de lote mínimo aplicado'))
})

test('MostrarOV agrega el id interno entre paréntesis', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarOV: true } })
  assert.equal(
    r,
    'Tornillo hex M8x40 acero inox 316, Estañado, OC 4507414828-10 (12345), OT 5086, PS 1234'
  )
})

test('MultiplicadorLineaOC agrega sufijo a la OC', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MultiplicadorLineaOC: 10 } })
  assert.equal(
    r,
    'Tornillo hex M8x40 acero inox 316, Estañado, OC 4507414828-10-10, OT 5086, PS 1234'
  )
})

test('MostrarNP false omite la descripción del NP', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarNP: false } })
  assert.equal(r, 'Estañado, OC 4507414828-10, OT 5086, PS 1234')
})

test('descripcionNP null omite el bloque aunque MostrarNP sea true', () => {
  const r = construirDescripcionCFDI({ ...base, descripcionNP: null })
  assert.equal(r, 'Estañado, OC 4507414828-10, OT 5086, PS 1234')
})

test('MostrarPS false omite el PS del cliente', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarPS: false } })
  assert.equal(r, 'Tornillo hex M8x40 acero inox 316, Estañado, OC 4507414828-10, OT 5086')
})

test('MostrarProducto false: arranca con la descripción del NP', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarProducto: false } })
  assert.equal(r, 'Tornillo hex M8x40 acero inox 316, OC 4507414828-10, OT 5086, PS 1234')
})

test('MostrarOT false omite la OT', () => {
  const r = construirDescripcionCFDI({ ...base, flags: { ...flagsDefault, MostrarOT: false } })
  assert.equal(r, 'Tornillo hex M8x40 acero inox 316, Estañado, OC 4507414828-10, PS 1234')
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
    'Tornillo hex M8x40 acero inox 316, Estañado, Acabado Brillante, OC 4507414828-10 (12345), Lote LOTE-9, OT 5086, PS 1234, 5678'
  )
})
