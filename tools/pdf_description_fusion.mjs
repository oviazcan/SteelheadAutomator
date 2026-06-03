// Decide si PO (nombre OV), Lote y PS comparten valor base y devuelve cómo
// renderizar el label combinado. DEBE quedar idéntica a la copia inline en
// powertools/synced/pdf/INVOICE_TEMPLATE.ts (helper de buildDescripcionHtml).
//
// Entrada:
//   po:         string|null  (salesOrder.name)
//   loteNames:  string[]     (nombres de lote de la línea)
//   psVals:     string[]     (packingSlips de la línea, ya como string)
// Salida:
//   { fusionado, label, valor, psRestantes }
export const fusionarPoLotePs = ({ po, loteNames, psVals }) => {
  const noFusion = { fusionado: false, label: '', valor: '', psRestantes: psVals }

  if (!po || loteNames.length === 0) return noFusion

  // Lote coincide si TODOS los nombres de lote == PO.
  const loteCoincide = loteNames.every((n) => n === po)
  if (!loteCoincide) return noFusion

  // PS coincide si TODOS los PS == PO o empiezan con "PO ". Extrae sufijos.
  const prefijo = po + ' '
  const psCoincide =
    psVals.length > 0 && psVals.every((ps) => ps === po || ps.startsWith(prefijo))

  if (psCoincide) {
    const sufijos = [
      ...new Set(psVals.map((ps) => (ps === po ? '' : ps.slice(prefijo.length))).filter(Boolean)),
    ]
    const valor = sufijos.length > 0 ? `${po} ${sufijos.join(', ')}` : po
    return { fusionado: true, label: 'PO/Lote/PS', valor, psRestantes: [] }
  }

  // Lote coincide pero PS no (o no hay PS): fusiona PO/Lote, deja PS aparte.
  return { fusionado: true, label: 'PO/Lote', valor: po, psRestantes: psVals }
}
