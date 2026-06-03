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
