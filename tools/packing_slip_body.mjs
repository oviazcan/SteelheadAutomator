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

export { KG_TO_LB, unitIsLb, convertWeight }
