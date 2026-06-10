import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeHtml, mdToHtml, isPendingName, pluralContenedor, buildBodyRows,
} from './packing_slip_body.mjs'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const mkPta = (o) => ({
  id: o.id,
  partCount: o.partCount != null ? o.partCount : 0,
  partNumber: {
    id: o.pnId, name: o.pnName != null ? o.pnName : 'NP',
    descriptionMarkdown: o.desc != null ? o.desc : null,
    partNumberGroup: o.group != null ? { id: 1, name: o.group } : null,
    unitConversions: o.conv != null ? o.conv : [],
    specFieldParameters: o.specs != null ? o.specs : null,
    labels: o.labels != null ? o.labels : null,
  },
  workOrder: {
    idInDomain: o.woId != null ? o.woId : null,
    name: o.woName != null ? o.woName : null,
    receivedOrder: o.ro !== undefined ? o.ro : null,
  },
  partNumberWorkOrder: o.billable != null ? { billablePartCount: o.billable } : null,
  quote: o.quoteId != null ? { quoteId: o.quoteId } : null,
  receivedBatches: o.batches != null ? o.batches : [],
})

const mkItem = (o) => ({
  partCount: o.partCount != null ? o.partCount : 0,
  comment: o.comment != null ? o.comment : null,
  weight: o.weight != null ? o.weight : null,
  unit: o.unit != null ? o.unit : null,
  partsTransferAccounts: o.ptas != null ? o.ptas : [],
})

const mkInputs = (items, opts) => ({
  packingSlip: {
    customer: {
      name: opts && opts.customer != null ? opts.customer : 'ACME',
      customInputs: opts && opts.customerCI != null ? opts.customerCI : null,
    },
    unit: opts && opts.unit != null ? opts.unit : null,
    items,
  },
})

// ── Task 2: agrupación por PN + cantidades ───────────────────────────────────

test('grupo: 1 PN en 2 items → 1 fila, embarcada sumada', () => {
  const inp = mkInputs([
    mkItem({ partCount: 30, ptas: [mkPta({ id: 1, partCount: 30, pnId: 100, woId: 5001, billable: 60 })] }),
    mkItem({ partCount: 30, ptas: [mkPta({ id: 2, partCount: 30, pnId: 100, woId: 5001, billable: 60 })] }),
  ])
  const rows = buildBodyRows(inp)
  assert.equal(rows.length, 1)
  assert.match(rows[0].cantidadEmbarcadaHtml, /60 PZA/)
})

test('grupo: 2 PTAs mismo WO NO duplican billable (50 y 0 → recibida 50)', () => {
  const inp = mkInputs([
    mkItem({ partCount: 50, ptas: [
      mkPta({ id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50 }),
      mkPta({ id: 2, partCount: 0, pnId: 100, woId: 5001, billable: 50 }),
    ] }),
  ])
  const rows = buildBodyRows(inp)
  assert.equal(rows.length, 1)
  assert.match(rows[0].cantidadEmbarcadaHtml, /50 PZA/)
  assert.match(rows[0].cantidadRecibidaHtml, /50 PZA/)  // no 100
})

test('grupo: 2 WOs distintas SUMAN billable (50 + 30 → recibida 80)', () => {
  const inp = mkInputs([
    mkItem({ partCount: 50, ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50 })] }),
    mkItem({ partCount: 30, ptas: [mkPta({ id: 2, partCount: 30, pnId: 100, woId: 5002, billable: 30 })] }),
  ])
  const rows = buildBodyRows(inp)
  assert.match(rows[0].cantidadRecibidaHtml, /80 PZA/)
  assert.match(rows[0].cantidadEmbarcadaHtml, /80 PZA/)
})

test('buildBodyRows: inputs vacío/sin items → []', () => {
  assert.deepEqual(buildBodyRows(null), [])
  assert.deepEqual(buildBodyRows({ packingSlip: { items: null } }), [])
})

// ── Task 3: Cantidad Recibida (peso teórico + contenedores) ──────────────────

const CI_LB = { DatosLogisticos: { UnidadMedidaPeso: true } }
const batchCont = (id, n) => ({ id: id, name: 'L' + id, customInputs: { DatosRecibo: { numeroContenedores: n } } })

test('Cant. Recibida: cliente KG, factor KGM → peso teórico KGM', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50,
    conv: [{ unit: { id: 3969, name: 'KGM Kilogramo' }, factor: 0.5 }],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadRecibidaHtml, /50 PZA/)
  assert.match(r.cantidadRecibidaHtml, /\(25\.00 KGM\)/)
})

test('Cant. Recibida: cliente LB con factor KGM → convierte (no duplica) 25kg→55.12 LBS', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50,
    conv: [{ unit: { id: 3969, name: 'KGM Kilogramo' }, factor: 0.5 }],
  })] })], { customerCI: CI_LB })
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadRecibidaHtml, /\(55\.12 LBS\)/)
})

test('Cant. Recibida: cliente LB con factor LBR → usa LBR directo (no ×2.2046)', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50,
    conv: [{ unit: { id: 3972, name: 'LBR Libra' }, factor: 1.1 }],
  })] })], { customerCI: CI_LB })
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadRecibidaHtml, /\(55\.00 LBS\)/)
})

test('Cant. Recibida: sin conversión → sin bloque de peso (no "Sin factor")', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50, conv: [] })] })])
  const r = buildBodyRows(inp)[0]
  assert.doesNotMatch(r.cantidadRecibidaHtml, /Sin factor|KGM|LBS/)
})

test('Cant. Recibida: contenedores sumados de lotes únicos (2+3 → 5 contenedores)', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50,
    batches: [batchCont(11, 2), batchCont(12, 3)],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadRecibidaHtml, /5 contenedores/)
})

test('Cant. Recibida: numeroContenedores null → sin bloque de contenedores', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 50, pnId: 100, woId: 5001, billable: 50,
    batches: [{ id: 11, name: 'L11', customInputs: { DatosRecibo: {} } }],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.doesNotMatch(r.cantidadRecibidaHtml, /contenedor/)
})

// ── Task 1: helpers de string ────────────────────────────────────────────────

test('escapeHtml: < > & se escapan', () => {
  assert.equal(escapeHtml('Acero <1040> & Co'), 'Acero &lt;1040&gt; &amp; Co')
})

test('escapeHtml: null/undefined → ""', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('mdToHtml: **negrita** y _cursiva_ y \\n', () => {
  assert.equal(mdToHtml('**Hola** _mundo_\nfin'), '<b>Hola</b> <i>mundo</i><br>fin')
})

test('mdToHtml: NO crea cursiva en part_number_id (underscore intra-palabra)', () => {
  assert.equal(mdToHtml('part_number_id'), 'part_number_id')
})

test('mdToHtml: escapa HTML antes de formatear', () => {
  assert.equal(mdToHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;')
})

test('mdToHtml: null → ""', () => {
  assert.equal(mdToHtml(null), '')
})

test('isPendingName: "Pending"/"PEN"/"." → true; trim; null/normal → false', () => {
  assert.equal(isPendingName('Pending'), true)
  assert.equal(isPendingName('PEN'), true)
  assert.equal(isPendingName('  .  '), true)
  assert.equal(isPendingName('4507421079'), false)
  assert.equal(isPendingName(null), false)
  assert.equal(isPendingName(''), false)
})

test('pluralContenedor: 1 → contenedor; 2 → contenedores', () => {
  assert.equal(pluralContenedor(1), 'contenedor')
  assert.equal(pluralContenedor(2), 'contenedores')
})
