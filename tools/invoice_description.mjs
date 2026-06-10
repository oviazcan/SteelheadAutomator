// Fuente verificable de la lógica de la descripción CFDI para el SAT.
// DEBE quedar idéntica a la copia inline en powertools/synced/invoice/invoice.ts.
// Nota: la limpieza de markdown de `descripcionNP` ocurre ANTES de llamar aquí
// (en el loop del hook); este espejo recibe `descripcionNP` ya en texto plano.
export const construirDescripcionCFDI = (p) => {
  const { flags } = p

  const partes = []

  // BLOQUE 1: Descripción del NP (valor directo, sin label).
  // Flag MostrarNP repurposed → "Mostrar Descripción del Número de parte".
  if (flags.MostrarNP && p.descripcionNP) {
    partes.push(p.descripcionNP)
  }

  // BLOQUE 2: Producto (valor directo, sin label)
  if (flags.MostrarProducto && p.nombreProducto) {
    partes.push(p.nombreProducto)
  }

  // Caso especial: lote mínimo. Se preserva intacta la subcadena
  // "Cargo de lote mínimo aplicado" (el integrador SAT la parsea).
  if (p.loteMinimoCargado) {
    partes.push('Cargo de lote mínimo aplicado')
    return partes.join(', ').trim()
  }

  // BLOQUE 3: Acabado (justo después de Producto)
  if (flags.MostrarAcabado && p.acabados.length > 0) {
    partes.push(`Acabado ${p.acabados.join(', ')}`)
  }

  // BLOQUE 4: OC
  if (flags.MostrarPO && p.salesOrderName) {
    let oc = `OC ${p.salesOrderName}`
    if (flags.MultiplicadorLineaOC > 0 && p.salesOrderLineNumber != null) {
      oc += `-${p.salesOrderLineNumber * flags.MultiplicadorLineaOC}`
    }
    if (flags.MostrarOV && p.salesOrderIdInDomain) {
      oc += ` (${p.salesOrderIdInDomain})`
    }
    partes.push(oc)
  }

  // BLOQUE 5: Lote — solo los nombres que difieran del OC (colapso de repetidos)
  if (flags.MostrarLote && p.nombresLotes.length > 0) {
    const lotesDistintos = p.nombresLotes.filter((l) => l !== p.salesOrderName)
    if (lotesDistintos.length > 0) {
      partes.push(`Lote ${lotesDistintos.join(', ')}`)
    }
  }

  // BLOQUE 6: OT
  if (flags.MostrarOT && p.workOrderIdInDomain) {
    partes.push(`OT ${p.workOrderIdInDomain}`)
  }

  // BLOQUE 7: PS del cliente (reincorporado con el flag MostrarPS)
  if (flags.MostrarPS && p.packingSlips.length > 0) {
    partes.push(`PS ${p.packingSlips.join(', ')}`)
  }

  const resultado = partes.join(', ').trim()
  // Red de seguridad: iMarz mapea la descripción a observaciones (1000 chars).
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
}
