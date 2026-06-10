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

// ── Task 4: Descripción ──────────────────────────────────────────────────────

const spec = (specName, type, fieldName, value, id) => ({
  id: id, name: value,
  specField: { id: id, name: fieldName, spec: { id: id, type: type, name: specName } },
})

test('Descripción: name(bold) + descriptionMarkdown(md) + grupo', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, pnName: 'NP-A', desc: '**Hi**', group: 'GRP-1', woId: 1, billable: 1,
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.descripcionHtml, /^<b>NP-A<\/b> <b>Hi<\/b> GRP-1/)
})

test('Descripción: Acabados union dedup', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 1, billable: 1,
    labels: [{ id: 1, name: 'Brillante' }, { id: 2, name: 'Estañado' }, { id: 1, name: 'Brillante' }],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.descripcionHtml, /<b>Acabados: <\/b>Brillante, Estañado/)
})

test('Descripción: Especificación solo EXTERNAL; null spec.name no produce "null"', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 1, billable: 1,
    specs: [
      spec('Zinc Alcalino', 'EXTERNAL', 'Baño', 'x', 1),
      spec('Interno', 'INTERNAL', 'Y', 'y', 2),
      spec(null, 'EXTERNAL', 'Z', 'z', 3),
    ],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.descripcionHtml, /Especificación: <\/b>Zinc Alcalino/)
  assert.doesNotMatch(r.descripcionHtml, /Interno/)
  assert.doesNotMatch(r.descripcionHtml, /null/)
})

test('Descripción: bloque Espesor/Grano = campo (valor)', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 1, billable: 1,
    specs: [spec('S', 'EXTERNAL', 'Espesor', '5 um', 1), spec('G', 'EXTERNAL', 'Grano', 'fino', 2)],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.descripcionHtml, /Espesor \(5 um\)/)
  assert.match(r.descripcionHtml, /Grano \(fino\)/)
})

test('Descripción: labels null + specs null → sin Acabados/Especificación colgantes', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({ id: 1, partCount: 1, pnId: 100, pnName: 'NP-A', woId: 1, billable: 1 })] })])
  const r = buildBodyRows(inp)[0]
  assert.doesNotMatch(r.descripcionHtml, /Acabados|Especificación/)
  assert.equal(r.descripcionHtml, '<b>NP-A</b>')
})

// ── Task 5: Referencias + rojo OV pendiente ──────────────────────────────────

const batchPS = (id, name, ps) => ({ id: id, name: name, customInputs: { DatosRecibo: { PackingSlip: ps } } })

test('Referencias: OV pendiente ("Pending") → rojo 14pt + anyPending="1"', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 5001, billable: 1,
    ro: { idInDomain: 9001, name: 'Pending' },
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.referenciasHtml, /<span style="color:red; font-size:14pt;"><b>OC \(OV\): <\/b>Pending \(9001\)<\/span>/)
  assert.equal(r.anyPending, '1')
})

test('Referencias: OV normal → SIN rojo + anyPending="0"', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 5001, billable: 1,
    ro: { idInDomain: 9001, name: '4507421079' },
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.doesNotMatch(r.referenciasHtml, /color:red/)
  assert.match(r.referenciasHtml, /<b>OC \(OV\): <\/b>4507421079 \(9001\)/)
  assert.equal(r.anyPending, '0')
})

test('Referencias: OVs múltiples dedup + una "." pendiente → rojo, ambas mostradas', () => {
  const inp = mkInputs([mkItem({ ptas: [
    mkPta({ id: 1, partCount: 1, pnId: 100, woId: 5001, billable: 1, ro: { idInDomain: 9001, name: 'OC-A' } }),
    mkPta({ id: 2, partCount: 1, pnId: 100, woId: 5002, billable: 1, ro: { idInDomain: 9002, name: '.' } }),
    mkPta({ id: 3, partCount: 1, pnId: 100, woId: 5003, billable: 1, ro: { idInDomain: 9001, name: 'OC-A' } }),
  ] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.referenciasHtml, /color:red/)
  assert.match(r.referenciasHtml, /OC-A \(9001\)/)
  assert.match(r.referenciasHtml, /\. \(9002\)/)
  // dedup: "OC-A (9001)" aparece una sola vez
  assert.equal((r.referenciasHtml.match(/OC-A \(9001\)/g) || []).length, 1)
})

test('Referencias: receivedOrder null → sin línea OC', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({ id: 1, partCount: 1, pnId: 100, woId: 5001, billable: 1, ro: null })] })])
  const r = buildBodyRows(inp)[0]
  assert.doesNotMatch(r.referenciasHtml, /OC \(OV\)/)
})

test('Referencias: OT única con nombre → " - nombre"; Cotización quoteId=0 se muestra', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 5001, woName: 'Lote especial', billable: 1, quoteId: 0,
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.referenciasHtml, /<b>OT: <\/b>5001 - Lote especial/)
  assert.match(r.referenciasHtml, /<b>Cotización: <\/b>0/)
})

test('Referencias: Lote dedup + PS Cliente con sufijo Schneider por lote (RG-M→VM, otro→VE)', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 5001, billable: 1,
    batches: [batchPS(11, 'RG-M001', 'PS-1'), batchPS(12, 'TLC-002', 'PS-2')],
  })] })], { customer: 'SCHNEIDER ELECTRIC' })
  const r = buildBodyRows(inp)[0]
  assert.match(r.referenciasHtml, /<b>Lote: <\/b>RG-M001, TLC-002/)
  assert.match(r.referenciasHtml, /<b>PS Cliente: <\/b>PS-1 VM, PS-2 VE/)
})

test('Referencias: cliente NO Schneider → PS sin sufijo VM/VE', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({
    id: 1, partCount: 1, pnId: 100, woId: 5001, billable: 1,
    batches: [batchPS(11, 'RG-M001', 'PS-1')],
  })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.referenciasHtml, /<b>PS Cliente: <\/b>PS-1/)
  assert.doesNotMatch(r.referenciasHtml, /VM|VE/)
})

// ── Task 6: Cantidad Embarcada + Estatus/Balance ─────────────────────────────

test('Cant. Embarcada: Estatus Completa (emb == recibida)', () => {
  const inp = mkInputs([mkItem({ partCount: 50, ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /^50 PZA<br><small>/)
  assert.match(r.cantidadEmbarcadaHtml, /<b>Estatus: <\/b>Completa/)
})

test('Cant. Embarcada: Parcial + Balance positivo (emb 30 < recibida 50)', () => {
  const inp = mkInputs([mkItem({ partCount: 30, ptas: [mkPta({ id: 1, partCount: 30, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /<b>Estatus: <\/b>Parcial<br><b>Balance: <\/b>20 PZA/)
})

test('Cant. Embarcada: Excedente + Balance "+N" (emb 60 > recibida 50)', () => {
  const inp = mkInputs([mkItem({ partCount: 60, ptas: [mkPta({ id: 1, partCount: 60, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /<b>Estatus: <\/b>Excedente<br><b>Balance: <\/b>\+10 PZA/)
})

test('Cant. Embarcada: peso neto KG (cliente KG, origen KGM)', () => {
  const inp = mkInputs([mkItem({
    partCount: 50, weight: { net: 10, tare: 1, gross: 11 }, unit: { id: 3969, name: 'KGM' },
    ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })],
  })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /\(10\.00 KGM\)/)
})

test('Cant. Embarcada: origen LBR + cliente LB → NO duplica (20→20.00 LBS)', () => {
  const inp = mkInputs([mkItem({
    partCount: 50, weight: { net: 20, tare: 2, gross: 22 }, unit: { id: 3972, name: 'LBR Libra' },
    ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })],
  })], { customerCI: CI_LB })
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /\(20\.00 LBS\)/)
})

test('Cant. Embarcada: weight null → "Sin peso"', () => {
  const inp = mkInputs([mkItem({ partCount: 50, ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /Sin peso/)
})

test('Cant. Embarcada: contenedores del comment ("3 cajas" → 3 contenedores)', () => {
  const inp = mkInputs([mkItem({ partCount: 50, comment: '3 cajas', ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /3 contenedores/)
})

test('Cant. Embarcada: comment no numérico → default 1 contenedor', () => {
  const inp = mkInputs([mkItem({ partCount: 50, comment: 'paleta', ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  assert.match(r.cantidadEmbarcadaHtml, /1 contenedor(?!es)/)
})

// ── Task 7: orquestación (placeholder + coerción + shape) ────────────────────

const BODY_KEYS = [
  'pnId', 'partNumber', 'cantidadRecibidaHtml', 'descripcionHtml',
  'referenciasHtml', 'cantidadEmbarcadaHtml', 'anyPending', '_placeholder',
]

test('placeholder: items presentes pero sin PN válido → 1 fila placeholder', () => {
  const inp = mkInputs([mkItem({ ptas: [mkPta({ id: 1, partCount: 1, pnId: null, woId: 1, billable: 1 })] })])
  const rows = buildBodyRows(inp)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]._placeholder, '1')
  assert.equal(rows[0].partNumber, '')
  assert.equal(rows[0].anyPending, '0')
})

test('shape: cada fila trae las 8 keys definidas (ningún undefined); _placeholder="" en filas reales', () => {
  const inp = mkInputs([mkItem({ partCount: 50, ptas: [mkPta({ id: 1, partCount: 50, pnId: 100, woId: 1, billable: 50 })] })])
  const r = buildBodyRows(inp)[0]
  BODY_KEYS.forEach((k) => assert.ok(r[k] !== undefined, 'falta ' + k))
  assert.equal(r._placeholder, '')
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
