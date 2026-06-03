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
