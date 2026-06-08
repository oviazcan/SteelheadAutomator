import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLabelsCurrent,
  buildLabelsConsolidated,
  countByBatch,
} from './wo_label_consolidation.mjs'

// Helper: arma un input mínimo con N partAccounts del MISMO PN sobre un solo lote.
function splitWorkOrder({ numeroContenedores, accounts }) {
  return {
    receivedBatches: [
      {
        id: 100,
        name: 'LOTE-1',
        customInputs: { DatosRecibo: { numeroContenedores: String(numeroContenedores) } },
      },
    ],
    allPartsOnWorkOrder: accounts.map((a, i) => ({
      partNumber: { id: 5, name: 'PN-ABC' },
      quantity: a.quantity,
      receivedBatch: { id: 100 },
      partGroup: { id: 900 + i, name: `Grupo ${i + 1}` },
    })),
  }
}

test('BUG: lote partido en 2 partAccounts del mismo PN duplica las etiquetas', () => {
  // 10 contenedores físicos, repartidos 6 + 4 entre dos partes.
  const inputs = splitWorkOrder({
    numeroContenedores: 10,
    accounts: [{ quantity: 600 }, { quantity: 400 }],
  })
  const current = buildLabelsCurrent(inputs)
  // Comportamiento actual: 10 × 2 = 20 etiquetas (duplicado).
  assert.equal(current.length, 20)
  assert.equal(countByBatch(current).get(100), 20)
})

test('FIX: consolidado produce exactamente numeroContenedores del lote (10), no 20', () => {
  const inputs = splitWorkOrder({
    numeroContenedores: 10,
    accounts: [{ quantity: 600 }, { quantity: 400 }],
  })
  const fixed = buildLabelsConsolidated(inputs)
  assert.equal(fixed.length, 10)
  assert.equal(countByBatch(fixed).get(100), 10)
  // Numeración de contenedores 1..10 (un set limpio del lote).
  assert.deepEqual(
    fixed.map((l) => l.containerIndex),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  )
  // Cantidad consolidada = suma de las partes (600 + 400).
  assert.ok(fixed.every((l) => l.partQuantity === 1000))
  // Conserva traza de las partAccounts consolidadas.
  assert.deepEqual(fixed[0].partGroupIds, [900, 901])
})

test('FIX: lote partido en 3 partAccounts sigue dando numeroContenedores (no ×3)', () => {
  const inputs = splitWorkOrder({
    numeroContenedores: 7,
    accounts: [{ quantity: 3 }, { quantity: 2 }, { quantity: 2 }],
  })
  assert.equal(buildLabelsCurrent(inputs).length, 21) // 7 × 3 (bug)
  assert.equal(buildLabelsConsolidated(inputs).length, 7) // consolidado
})

test('SIN SPLIT: una sola partAccount no cambia — sigue dando numeroContenedores', () => {
  const inputs = splitWorkOrder({ numeroContenedores: 5, accounts: [{ quantity: 1000 }] })
  assert.equal(buildLabelsCurrent(inputs).length, 5)
  assert.equal(buildLabelsConsolidated(inputs).length, 5)
})

test('MULTI-PN REAL: dos PNs distintos en un lote NO se colapsan (no es un split)', () => {
  const inputs = {
    receivedBatches: [
      {
        id: 100,
        name: 'LOTE-MIXTO',
        customInputs: { DatosRecibo: { numeroContenedores: '4' } },
      },
    ],
    allPartsOnWorkOrder: [
      { partNumber: { id: 5, name: 'PN-A' }, quantity: 100, receivedBatch: { id: 100 }, partGroup: { id: 900 } },
      { partNumber: { id: 9, name: 'PN-B' }, quantity: 200, receivedBatch: { id: 100 }, partGroup: { id: 901 } },
    ],
  }
  // PNs realmente distintos → 4 etiquetas por cada PN = 8 (se preservan ambos).
  const fixed = buildLabelsConsolidated(inputs)
  assert.equal(fixed.length, 8)
  assert.deepEqual([...new Set(fixed.map((l) => l.partNumberId))].sort(), [5, 9])
})

test('REAL OT 5103 (snapshot TLC): nc=12, 2 partGroups del mismo PN → 12, no 24', () => {
  const inputs = splitWorkOrder({
    numeroContenedores: 12,
    accounts: [{ quantity: 500 }, { quantity: 300 }],
  })
  assert.equal(buildLabelsCurrent(inputs).length, 24) // bug observado en prod
  assert.equal(buildLabelsConsolidated(inputs).length, 12) // fix
})

test('REAL OT 262 (snapshot TLC): nc=8, 35 partGroups del mismo PN → 8, no 280', () => {
  const accounts = Array.from({ length: 35 }, (_, i) => ({ quantity: i + 1 }))
  const inputs = splitWorkOrder({ numeroContenedores: 8, accounts })
  assert.equal(buildLabelsCurrent(inputs).length, 280) // 8 × 35 (bug)
  assert.equal(buildLabelsConsolidated(inputs).length, 8) // fix
})

test('MULTI-LOTE: cada lote conserva su propio numeroContenedores', () => {
  const inputs = {
    receivedBatches: [
      { id: 100, name: 'L1', customInputs: { DatosRecibo: { numeroContenedores: '3' } } },
      { id: 200, name: 'L2', customInputs: { DatosRecibo: { numeroContenedores: '5' } } },
    ],
    allPartsOnWorkOrder: [
      // L1 partido en 2 accounts del mismo PN
      { partNumber: { id: 5, name: 'PN-A' }, quantity: 30, receivedBatch: { id: 100 }, partGroup: { id: 900 } },
      { partNumber: { id: 5, name: 'PN-A' }, quantity: 20, receivedBatch: { id: 100 }, partGroup: { id: 901 } },
      // L2 sin partir
      { partNumber: { id: 5, name: 'PN-A' }, quantity: 80, receivedBatch: { id: 200 }, partGroup: { id: 902 } },
    ],
  }
  assert.equal(buildLabelsCurrent(inputs).length, 3 * 2 + 5) // 11 (L1 duplicado)
  const fixed = buildLabelsConsolidated(inputs)
  assert.equal(fixed.length, 3 + 5) // 8 consolidado
  assert.equal(countByBatch(fixed).get(100), 3)
  assert.equal(countByBatch(fixed).get(200), 5)
})
