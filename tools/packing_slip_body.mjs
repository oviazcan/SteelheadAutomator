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

import { KG_TO_LB, unitIsLb, convertWeight, groupWeights } from './packing_slip_weight.mjs'

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

const KGM_UNIT_ID = 3969
const LBR_UNIT_ID2 = 3972

// number_format(x, 0, ".", ",") → entero con separador de miles.
const formatInt = (n) => {
  const v = n == null || isNaN(Number(n)) ? 0 : Math.round(Number(n))
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// number_format(x, 2, ".", ",") → 2 decimales con separador de miles.
const format2 = (n) => {
  const v = n == null || isNaN(Number(n)) ? 0 : Number(n)
  const fixed = (Math.round(v * 100) / 100).toFixed(2)
  const neg = fixed.charAt(0) === '-'
  const abs = neg ? fixed.slice(1) : fixed
  const dot = abs.indexOf('.')
  const intPart = abs.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + intPart + abs.slice(dot)
}

// Primera conversión de PESO válida del PN (LBR o KGM) con su unidad de origen.
// Evita tomar [0] a ciegas (podría ser área u otra unidad) y permite convertir
// correctamente a la unidad destino del cliente (corrige doble conversión #1090).
const findWeightConversion = (convs) => {
  if (!Array.isArray(convs)) return null
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i]
    if (c == null || c.unit == null || c.factor == null || c.factor <= 0) continue
    const id = Number(c.unit.id)
    const n = c.unit.name != null ? String(c.unit.name).toLowerCase() : ''
    const isLbr = id === LBR_UNIT_ID2 || n.indexOf('lbr') >= 0 || n.indexOf('libra') >= 0
    const isKgm = id === KGM_UNIT_ID || n.indexOf('kgm') >= 0 || n.indexOf('kilo') >= 0 || n.indexOf('kg') >= 0
    if (isLbr) return { factor: c.factor, sourceIsLb: true }
    if (isKgm) return { factor: c.factor, sourceIsLb: false }
  }
  return null
}

// Σ numeroContenedores (DatosRecibo) de los lotes únicos; null si no hay dato.
const sumContenedores = (uniqueBatches) => {
  let total = 0
  let has = false
  uniqueBatches.forEach((b) => {
    const ci = b.customInputs
    if (ci == null) return
    const dr = ci.DatosRecibo
    if (dr == null) return
    const n = dr.numeroContenedores
    if (n == null || isNaN(Number(n))) return
    total += Number(n)
    has = true
  })
  return has && total >= 1 ? total : null
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

// Columna Cantidad Recibida: "N PZA<br><small>(peso unidad)<br>M contenedor(es)</small>".
// Cada sub-bloque se omite limpio si falta el dato (sin "(Sin factor)" colgante).
const buildCantidadRecibidaHtml = (recibida, pn, uniqueBatches, ctx) => {
  const parts = []
  const conv = findWeightConversion(pn.unitConversions)
  if (conv != null) {
    const peso = convertWeight({ value: recibida * conv.factor, sourceIsLb: conv.sourceIsLb, displayInLb: ctx.displayInLb })
    if (peso != null) parts.push('(' + format2(peso) + (ctx.displayInLb ? ' LBS)' : ' KGM)'))
  }
  const cont = sumContenedores(uniqueBatches)
  if (cont != null) parts.push(formatInt(cont) + ' ' + pluralContenedor(cont))
  const small = parts.length > 0 ? '<br><small>' + parts.join('<br>') + '</small>' : ''
  return formatInt(recibida) + ' PZA' + small
}

// Acabados (labels) union de todos los PTAs del grupo, dedup por id||name.
const collectLabels = (entries) => {
  const out = []
  const seen = {}
  entries.forEach((e) => {
    const labels = e.pta.partNumber != null ? e.pta.partNumber.labels : null
    if (!Array.isArray(labels)) return
    labels.forEach((l) => {
      if (l == null || l.name == null) return
      const key = l.id != null ? 'id-' + l.id : 'n-' + l.name
      if (seen[key]) return
      seen[key] = true
      out.push(l.name)
    })
  })
  return out
}

// specFieldParameters union de todos los PTAs del grupo, dedup por sp.id.
const collectSpecParams = (entries) => {
  const out = []
  const seen = {}
  entries.forEach((e) => {
    const sps = e.pta.partNumber != null ? e.pta.partNumber.specFieldParameters : null
    if (!Array.isArray(sps)) return
    sps.forEach((sp) => {
      if (sp == null) return
      if (sp.id != null) { if (seen[sp.id]) return; seen[sp.id] = true }
      out.push(sp)
    })
  })
  return out
}

const isExternalSpec = (sp) => {
  const sf = sp.specField
  const spec = sf != null ? sf.spec : null
  return spec != null && spec.type != null && String(spec.type).toUpperCase() === 'EXTERNAL'
}

// Columna Descripción: PN(bold) + descripción(md) + grupo + Acabados(union) +
// Especificación(EXTERNAL) + Espesor/Grano. Cada bloque se omite si está vacío.
const buildDescripcionHtml = (pn, entries) => {
  let html = '<b>' + escapeHtml(pn.name != null ? pn.name : '') + '</b>'
  const desc = mdToHtml(pn.descriptionMarkdown)
  if (desc !== '') html += ' ' + desc
  const grupo = pn.partNumberGroup != null && pn.partNumberGroup.name != null ? pn.partNumberGroup.name : ''
  if (grupo !== '') html += ' ' + escapeHtml(grupo)

  const labels = collectLabels(entries)
  if (labels.length > 0) {
    html += '<br><b>Acabados: </b>' + labels.map(escapeHtml).join(', ')
  }

  const specs = collectSpecParams(entries)

  const specNames = []
  const seenSpec = {}
  specs.forEach((sp) => {
    if (!isExternalSpec(sp)) return
    const name = sp.specField.spec.name
    if (name == null) return
    const key = String(name).trim().toLowerCase()
    if (seenSpec[key]) return
    seenSpec[key] = true
    specNames.push(name)
  })
  if (specNames.length > 0) {
    html += '<br><b>Especificación: </b>' + specNames.map((n) => escapeHtml(n) + ': ').join(', ')
  }

  const egItems = []
  const seenEg = {}
  specs.forEach((sp) => {
    if (!isExternalSpec(sp)) return
    const fname = sp.specField.name != null ? String(sp.specField.name) : ''
    if (fname.indexOf('Espesor') < 0 && fname.indexOf('Grano') < 0) return
    const value = sp.name != null ? sp.name : ''
    const text = escapeHtml(fname) + ' (' + escapeHtml(value) + ')'
    const key = text.toLowerCase()
    if (seenEg[key]) return
    seenEg[key] = true
    egItems.push(text)
  })
  if (egItems.length > 0) {
    html += '<br>' + egItems.join(', <br>')
  }

  return html
}

// Lee el PS del cliente del customInputs del batch (espejo de readPS del .ts):
// DatosRecibo.PackingSlip anidado, con fallbacks plano y key /^(ps|packingslip)$/i.
const readPS = (ci) => {
  if (ci == null) return null
  const dr = ci.DatosRecibo
  if (dr != null && dr.PackingSlip != null && dr.PackingSlip !== '') return dr.PackingSlip
  if (ci.PackingSlip != null && ci.PackingSlip !== '') return ci.PackingSlip
  const keys = Object.keys(ci)
  for (let i = 0; i < keys.length; i++) {
    if (/^(ps|packingslip)$/i.test(String(keys[i]).trim())) {
      if (ci[keys[i]] !== '') return ci[keys[i]]
    }
  }
  return null
}

// OC (OV): OVs únicas del grupo (dedup por idInDomain, fallback name), rojo 14pt
// si CUALQUIERA es pendiente. Devuelve null si no hay ninguna OV.
const buildOcOv = (entries) => {
  const ovs = []
  const seen = {}
  let anyPending = false
  entries.forEach((e) => {
    const wo = e.pta.workOrder
    const ro = wo != null ? wo.receivedOrder : null
    if (ro == null) return
    const key = ro.idInDomain != null ? 'id-' + ro.idInDomain : (ro.name != null ? 'n-' + ro.name : null)
    if (key == null || seen[key]) return
    seen[key] = true
    const name = ro.name != null ? ro.name : ''
    const id = ro.idInDomain != null ? ro.idInDomain : ''
    let disp
    if (name !== '' && id !== '') disp = escapeHtml(name) + ' (' + id + ')'
    else if (name !== '') disp = escapeHtml(name)
    else if (id !== '') disp = '#' + id
    else return
    ovs.push(disp)
    if (isPendingName(ro.name)) anyPending = true
  })
  if (ovs.length === 0) return null
  const inner = '<b>OC (OV): </b>' + ovs.join(', ')
  const html = anyPending ? '<span style="color:red; font-size:14pt;">' + inner + '</span>' : inner
  return { html: html, anyPending: anyPending }
}

const buildOt = (entries) => {
  const ots = []
  const seen = {}
  entries.forEach((e) => {
    const wo = e.pta.workOrder
    if (wo == null || wo.idInDomain == null || seen[wo.idInDomain]) return
    seen[wo.idInDomain] = true
    ots.push({ id: wo.idInDomain, name: wo.name })
  })
  if (ots.length === 0) return null
  if (ots.length === 1) {
    const o = ots[0]
    const suf = o.name != null && String(o.name).trim() !== '' ? ' - ' + escapeHtml(o.name) : ''
    return '<b>OT: </b>' + o.id + suf
  }
  return '<b>OT: </b>' + ots.map((o) => String(o.id)).join(', ')
}

const buildLote = (uniqueBatches) => {
  const names = []
  const seen = {}
  uniqueBatches.forEach((b) => {
    if (b.name == null || seen[String(b.name)]) return
    seen[String(b.name)] = true
    names.push(b.name)
  })
  if (names.length === 0) return null
  return '<b>Lote: </b>' + names.map(escapeHtml).join(', ')
}

const buildPsCliente = (uniqueBatches, isSchneider) => {
  const items = []
  const seen = {}
  uniqueBatches.forEach((b) => {
    const ps = readPS(b.customInputs)
    if (ps == null || ps === '') return
    let suf = ''
    if (isSchneider) {
      const bn = b.name != null ? String(b.name).trim() : ''
      suf = ' ' + (bn.substring(0, 4) === 'RG-M' ? 'VM' : 'VE')
    }
    const text = escapeHtml(String(ps)) + suf
    if (seen[text]) return
    seen[text] = true
    items.push(text)
  })
  if (items.length === 0) return null
  return '<b>PS Cliente: </b>' + items.join(', ')
}

const buildCotizacion = (entries) => {
  const ids = []
  const seen = {}
  entries.forEach((e) => {
    const q = e.pta.quote
    if (q == null || q.quoteId == null || seen[q.quoteId]) return
    seen[q.quoteId] = true
    ids.push(q.quoteId)
  })
  if (ids.length === 0) return null
  return '<b>Cotización: </b>' + ids.join(', ')
}

// Columna Referencias: cada línea se omite si no hay dato. Devuelve {html, anyPending}.
const buildReferenciasHtml = (entries, uniqueBatches, ctx) => {
  const lines = []
  let anyPending = false
  const oc = buildOcOv(entries)
  if (oc != null) { lines.push(oc.html); anyPending = oc.anyPending }
  const ot = buildOt(entries); if (ot != null) lines.push(ot)
  const lote = buildLote(uniqueBatches); if (lote != null) lines.push(lote)
  const ps = buildPsCliente(uniqueBatches, ctx.isSchneider); if (ps != null) lines.push(ps)
  const cot = buildCotizacion(entries); if (cot != null) lines.push(cot)
  return { html: lines.join('<br>'), anyPending: anyPending }
}

// Items físicos únicos del grupo (un item = un contenedor/bulto).
const collectUniqueItems = (entries) => {
  const out = []
  const seen = new Set()
  entries.forEach((e) => {
    if (seen.has(e.item)) return
    seen.add(e.item)
    out.push(e.item)
  })
  return out
}

// Σ contenedores embarcados: primer token numérico del comment de cada item (default 1).
const sumContenedoresEmbarcados = (uniqueItems) => {
  let total = 0
  uniqueItems.forEach((it) => {
    let n = 1
    if (it.comment != null) {
      const tok = String(it.comment).trim().split(/\s+/)[0]
      const parsed = parseInt(tok, 10)
      if (!isNaN(parsed)) n = parsed
    }
    total += n
  })
  return total
}

// Σ peso NETO del grupo, repartido por wFrac y convertido desde la unidad de
// ORIGEN del item (item.unit/ps.unit, fix #1090). null si ningún item trae peso.
const computeNetWeight = (entries, ctx) => {
  let total = 0
  let hasAny = false
  entries.forEach((e) => {
    const item = e.item
    const sourceIsLb = unitIsLb(item.unit) || ctx.psUnitIsLb
    const w = groupWeights({
      itemWeight: item.weight,
      itemPartCount: item.partCount,
      groupPartCount: e.pta.partCount,
      itemGroups: 1,
      sourceIsLb: sourceIsLb,
      displayInLb: ctx.displayInLb,
    })
    if (w.netWeight != null) { total += w.netWeight; hasAny = true }
  })
  return hasAny ? total : null
}

// Columna Cantidad Embarcada: "N PZA<br><small>(peso unidad)<br>M contenedor(es)
// <br><b>Estatus: </b>…</small>". Estatus mide embarcada vs recibida.
const buildCantidadEmbarcadaHtml = (embarcada, recibida, entries, uniqueItems, ctx) => {
  const small = []
  const net = computeNetWeight(entries, ctx)
  if (net != null) small.push('(' + format2(net) + (ctx.displayInLb ? ' LBS)' : ' KGM)'))
  else small.push('Sin peso')
  const cont = sumContenedoresEmbarcados(uniqueItems)
  small.push(formatInt(cont) + ' ' + pluralContenedor(cont))
  let estatus
  if (embarcada === recibida) {
    estatus = '<b>Estatus: </b>Completa'
  } else if (embarcada < recibida) {
    estatus = '<b>Estatus: </b>Parcial<br><b>Balance: </b>' + formatInt(recibida - embarcada) + ' PZA'
  } else {
    estatus = '<b>Estatus: </b>Excedente<br><b>Balance: </b>+' + formatInt(embarcada - recibida) + ' PZA'
  }
  small.push(estatus)
  return formatInt(embarcada) + ' PZA<br><small>' + small.join('<br>') + '</small>'
}

// Construye UNA fila del cuerpo por grupo PN. (Se enriquece columna por columna
// en las tareas siguientes.)
const buildRow = (g, ctx) => {
  const pn = g.pn
  const entries = g.entries
  const uniqueBatches = collectUniqueBatches(entries)

  const uniqueItems = collectUniqueItems(entries)
  const recibida = computeRecibida(entries, uniqueBatches)
  const embarcada = computeEmbarcada(entries)
  const refs = buildReferenciasHtml(entries, uniqueBatches, ctx)

  const row = {
    pnId: g.pnId,
    partNumber: pn.name != null ? pn.name : '',
    cantidadRecibidaHtml: buildCantidadRecibidaHtml(recibida, pn, uniqueBatches, ctx),
    descripcionHtml: buildDescripcionHtml(pn, entries),
    referenciasHtml: refs.html,
    cantidadEmbarcadaHtml: buildCantidadEmbarcadaHtml(embarcada, recibida, entries, uniqueItems, ctx),
    anyPending: refs.anyPending ? '1' : '0',
    _placeholder: '',
  }
  // Coerción defensiva: ningún campo null/undefined (PDFGeneratorAPI no crea
  // nodo para null en toda la muestra). Booleanos ya salen como '1'/'0'.
  Object.keys(row).forEach((k) => { if (row[k] == null) row[k] = '' })
  return row
}

// Fila vacía para que PDFGeneratorAPI cree los nodos del cuerpo aunque el
// embarque no produzca filas reales (ID-18).
const placeholderRow = () => ({
  pnId: 0,
  partNumber: '',
  cantidadRecibidaHtml: '',
  descripcionHtml: '',
  referenciasHtml: '',
  cantidadEmbarcadaHtml: '',
  anyPending: '0',
  _placeholder: '1',
})

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
  if (rows.length === 0) return [placeholderRow()]
  return rows
}

export { KG_TO_LB, unitIsLb, convertWeight }
