// Lógica pura del CUERPO de la remisión (packing slip): construye
// additionalPayload.bodyRows[] (una fila por número de parte consolidado) con
// las 4 columnas en HTML: Cantidad Recibida, Descripción, Referencias (con el
// rojo de OV pendiente), Cantidad Embarcada.
//
// DEBE quedar IDÉNTICA a la copia inline en
// powertools/synced/pdf/PACKING_SLIP_TEMPLATE.ts (el hook low-code no admite
// imports, así que se mantiene un espejo manual; misma convención que
// packing_slip_weight.mjs). Por eso TODO aquí es ES2017-safe: NADA de `?.`
// ni `??` — solo `!= null` y ternarios.
//
// Spec: docs/superpowers/specs/2026-06-10-remision-cuerpo-ts-migracion-design.md

import { KG_TO_LB, unitIsLb, convertWeight } from './packing_slip_weight.mjs'

// ── Helpers de string ────────────────────────────────────────────────────────

// Escapa los 3 caracteres que romperían el HTML de la celda.
export const escapeHtml = (s) => {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Markdown básico → HTML, con escape previo. **negrita**, _cursiva_ (solo en
// borde de palabra, para no romper identificadores como part_number_id), \n→<br>.
export const mdToHtml = (s) => {
  if (s == null) return ''
  let out = escapeHtml(s)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/(^|[\s(>])_([^_\s][^_]*?)_(?=[\s).,;:<]|$)/g, '$1<i>$2</i>')
  out = out.replace(/\n/g, '<br>')
  return out
}

// ¿El nombre de la OV indica "pendiente"? Espejo de INVOICE_TEMPLATE.ts:
// match /pen/i o el literal "." (Steelhead usa "." como OV provisional).
export const isPendingName = (name) => {
  if (name == null) return false
  const t = String(name).trim()
  return /pen/i.test(t) || t === '.'
}

// Pluraliza "contenedor" por número (se llama solo con n >= 1).
export const pluralContenedor = (n) => (Number(n) === 1 ? 'contenedor' : 'contenedores')

// number_format(x, 0, ".", ",") → entero con separador de miles.
const formatInt = (n) => {
  const v = n == null || isNaN(Number(n)) ? 0 : Math.round(Number(n))
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Detección recursiva de cliente que captura en libras (UnidadMedidaPeso).
// Espejo de PACKING_SLIP_TEMPLATE.ts isLbCustomer.
export const isLbCustomer = (obj) => {
  if (!obj || typeof obj !== 'object') return false
  const keys = Object.keys(obj)
  for (let i = 0; i < keys.length; i++) {
    const k = String(keys[i]).toLowerCase()
    const val = obj[keys[i]]
    if (k.indexOf('lbs') >= 0 || k === 'unidadmedidapeso' ||
        (k.indexOf('usar') >= 0 && k.indexOf('lb') >= 0)) {
      if (val === true || val === 'true') return true
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (isLbCustomer(val)) return true
    }
  }
  return false
}

// Lotes únicos del grupo (dedup por batch.id) — se usan para PS/Lote/contenedores
// e initialAmount sin doble-contar batches referenciados por varios PTAs.
const collectUniqueBatches = (entries) => {
  const out = []
  const seen = {}
  entries.forEach((e) => {
    const batches = e.pta.receivedBatches != null ? e.pta.receivedBatches : []
    batches.forEach((b) => {
      if (b == null) return
      if (b.id != null) {
        if (seen[b.id]) return
        seen[b.id] = true
      }
      out.push(b)
    })
  })
  return out
}

// Σ initialAmount de las cuentas de inventario de los lotes (COALESCE primario).
// Hoy ausente en el query del packing slip → has=false → se cae a billable.
const sumInitialAmounts = (uniqueBatches) => {
  let sum = 0
  let has = false
  uniqueBatches.forEach((b) => {
    const accs = b.inventoryAccountsByInventoryBatchId != null
      ? b.inventoryAccountsByInventoryBatchId : null
    if (accs == null) return
    accs.forEach((a) => {
      if (a == null || a.initialAmount == null) return
      has = true
      sum += Number(a.initialAmount)
    })
  })
  return { has: has, sum: sum }
}

// Cantidad Recibida = Σ initialAmount (si hay) si no Σ billablePartCount por WO
// distinto (billable es por PN×WO; NO sumar PTAs del mismo WO).
const computeRecibida = (entries, uniqueBatches) => {
  const init = sumInitialAmounts(uniqueBatches)
  if (init.has) return init.sum
  const byWo = {}
  entries.forEach((e) => {
    const wo = e.pta.workOrder
    const woKey = wo != null && wo.idInDomain != null ? 'wo-' + wo.idInDomain : 'pta-' + e.pta.id
    const pnwo = e.pta.partNumberWorkOrder
    if (pnwo != null && pnwo.billablePartCount != null) byWo[woKey] = pnwo.billablePartCount
  })
  let total = 0
  Object.keys(byWo).forEach((k) => { total += byWo[k] })
  return total
}

const computeEmbarcada = (entries) => {
  let total = 0
  entries.forEach((e) => { if (e.pta.partCount != null) total += e.pta.partCount })
  return total
}

// Construye UNA fila del cuerpo por grupo PN. (Se enriquece columna por columna
// en las tareas siguientes.)
const buildRow = (g, ctx) => {
  const pn = g.pn
  const entries = g.entries
  const uniqueBatches = collectUniqueBatches(entries)

  const recibida = computeRecibida(entries, uniqueBatches)
  const embarcada = computeEmbarcada(entries)

  const row = {
    pnId: g.pnId,
    partNumber: pn.name != null ? pn.name : '',
    cantidadRecibidaHtml: formatInt(recibida) + ' PZA',
    descripcionHtml: '',
    referenciasHtml: '',
    cantidadEmbarcadaHtml: formatInt(embarcada) + ' PZA',
    anyPending: '0',
    _placeholder: '',
  }
  return row
}

// Punto de entrada: arma additionalPayload.bodyRows[] (una fila por pn.id).
export const buildBodyRows = (inputs) => {
  const ps = inputs != null ? inputs.packingSlip : null
  if (!ps || !Array.isArray(ps.items)) return []

  const customerCI = ps.customer != null && ps.customer.customInputs != null
    ? ps.customer.customInputs : null
  const displayInLb = isLbCustomer(customerCI)
  const weightUnit = displayInLb ? 'LB' : 'KG'
  const psUnitIsLb = unitIsLb(ps.unit)
  const customerName = ps.customer != null && ps.customer.name != null ? ps.customer.name : ''
  const isSchneider = customerName.substring(0, 3) === 'SCH'
  const ctx = { displayInLb: displayInLb, weightUnit: weightUnit, psUnitIsLb: psUnitIsLb, isSchneider: isSchneider }

  const groups = new Map()
  ps.items.forEach((item) => {
    const ptas = item.partsTransferAccounts != null ? item.partsTransferAccounts : []
    ptas.forEach((pta) => {
      const pn = pta.partNumber
      if (pn == null || pn.id == null) return
      let g = groups.get(pn.id)
      if (g == null) {
        g = { pnId: pn.id, pn: pn, entries: [] }
        groups.set(pn.id, g)
      }
      g.entries.push({ item: item, pta: pta })
    })
  })

  const rows = []
  groups.forEach((g) => { rows.push(buildRow(g, ctx)) })
  return rows
}

export { KG_TO_LB, unitIsLb, convertWeight }
