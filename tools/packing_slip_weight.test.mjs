import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unitIsLb, convertWeight, groupWeights } from './packing_slip_weight.mjs'

// ── unitIsLb: detectar si la unidad de ORIGEN que entrega Steelhead es libras ──
// Steelhead entrega item.weight en la unidad de item.unit / packingSlip.unit.
// id 3972 = LBR (libras), 3969 = KGM (kilos).

test('unitIsLb: id 3972 (LBR Libra) → true', () => {
  assert.equal(unitIsLb({ id: 3972, name: 'LBR Libra' }), true)
})

test('unitIsLb: id 3969 (KGM Kilogramo) → false', () => {
  assert.equal(unitIsLb({ id: 3969, name: 'KGM Kilogramo' }), false)
})

test('unitIsLb: null/undefined → false (default KG)', () => {
  assert.equal(unitIsLb(null), false)
  assert.equal(unitIsLb(undefined), false)
})

test('unitIsLb: solo nombre "LBR" sin id → true', () => {
  assert.equal(unitIsLb({ name: 'LBR' }), true)
})

test('unitIsLb: solo nombre "Libra" sin id → true', () => {
  assert.equal(unitIsLb({ name: 'Libra' }), true)
})

// ── convertWeight: matriz origen × destino ──

test('BUG REPRODUCIDO: origen LBR + cliente LB → SIN conversión (no ×2.2046)', () => {
  // Antes del fix el hook asumía kg y multiplicaba ×2.2046 → duplicaba.
  assert.equal(convertWeight({ value: 923, sourceIsLb: true, displayInLb: true }), 923)
})

test('origen KGM + cliente LB → ×2.2046 (caso báscula 1054)', () => {
  // 6.803886 kg → 15.00 lb
  assert.equal(convertWeight({ value: 6.803886, sourceIsLb: false, displayInLb: true }), 15)
})

test('origen LBR + cliente KG → ÷2.2046', () => {
  // 15 lb → 6.80 kg
  assert.equal(convertWeight({ value: 15, sourceIsLb: true, displayInLb: false }), 6.8)
})

test('origen KGM + cliente KG → SIN conversión', () => {
  assert.equal(convertWeight({ value: 6.8, sourceIsLb: false, displayInLb: false }), 6.8)
})

test('convertWeight: null → null', () => {
  assert.equal(convertWeight({ value: null, sourceIsLb: true, displayInLb: true }), null)
})

test('convertWeight: redondea a 2 decimales', () => {
  // 100 kg → 220.462... → 220.46
  assert.equal(convertWeight({ value: 100, sourceIsLb: false, displayInLb: true }), 220.46)
})

// ── groupWeights: reparto por grupo + conversión, con los datos REALES de la
//    remisión #1090 (PN 921659). item.weight ya viene en LBR. ──

const ITEM_1090 = { gross: 948, net: 923, tare: 25 } // crudo, en LBR
const ITEM_PARTCOUNT = 95
const ITEM_GROUPS = 5 // 5 partsTransferAccounts en 1 item (flujo partGroup)

test('groupWeights #1090 grupo de 15 pzas: neto 145.74, tara 5.00, bruto 150.74', () => {
  const w = groupWeights({
    itemWeight: ITEM_1090,
    itemPartCount: ITEM_PARTCOUNT,
    groupPartCount: 15,
    itemGroups: ITEM_GROUPS,
    sourceIsLb: true, // item.unit = LBR
    displayInLb: true, // Wieland = cliente LB
  })
  assert.equal(w.netWeight, 145.74)
  assert.equal(w.tareWeight, 5.0)
  assert.equal(w.grossWeight, 150.74)
})

test('groupWeights #1090 grupo de 25 pzas: neto 242.89, tara 5.00, bruto 247.89', () => {
  const w = groupWeights({
    itemWeight: ITEM_1090,
    itemPartCount: ITEM_PARTCOUNT,
    groupPartCount: 25,
    itemGroups: ITEM_GROUPS,
    sourceIsLb: true,
    displayInLb: true,
  })
  assert.equal(w.netWeight, 242.89)
  assert.equal(w.tareWeight, 5.0)
  assert.equal(w.grossWeight, 247.89)
})

test('groupWeights: la suma de los 5 grupos reconstituye el total del item', () => {
  // grupos reales: 15 + 25 + ... = 95. Probamos que neto+tara suma al total.
  const groups = [15, 25, 20, 20, 15] // suma 95
  let net = 0
  let tare = 0
  for (const g of groups) {
    const w = groupWeights({
      itemWeight: ITEM_1090,
      itemPartCount: ITEM_PARTCOUNT,
      groupPartCount: g,
      itemGroups: ITEM_GROUPS,
      sourceIsLb: true,
      displayInLb: true,
    })
    net += w.netWeight
    tare += w.tareWeight
  }
  // tolerancia por redondeo a 2 dec en cada grupo
  assert.ok(Math.abs(net - 923) < 0.05, `neto sumado ${net} ≈ 923`)
  assert.ok(Math.abs(tare - 25) < 0.05, `tara sumada ${tare} ≈ 25`)
})

test('groupWeights contenedor físico (1 PTA/item, origen KGM): convierte kg→lb íntegro', () => {
  // wFrac=1, itemGroups=1. item.weight en kg → cliente LB → ×2.2046.
  const w = groupWeights({
    itemWeight: { gross: 6.8, net: 5.9, tare: 0.9 },
    itemPartCount: 1,
    groupPartCount: 1,
    itemGroups: 1,
    sourceIsLb: false,
    displayInLb: true,
  })
  assert.equal(w.netWeight, 13.01) // 5.9×2.2046 = 13.01
  assert.equal(w.tareWeight, 1.98) // 0.9×2.2046 = 1.98
})
