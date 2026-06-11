// Fuente verificable de la lógica de la descripción CFDI para el SAT.
// DEBE quedar idéntica a la copia inline en powertools/synced/invoice/invoice.ts.
// Nota: la limpieza de markdown de `descripcionNP` ocurre ANTES de llamar aquí
// (en el loop del hook); este espejo recibe `descripcionNP` ya en texto plano.

// Arma las dos secciones etiquetadas de la descripción CFDI:
//   N: <descripción de la pieza>   O: <observaciones (Producto, Acabado, OC, …)>
// Ambas etiquetas van SIEMPRE; si no hay dato, "N/A". Separador entre secciones:
// un espacio; dentro de O: las observaciones se unen con ", ".
// Red de seguridad: iMarz mapea la descripción a observaciones (1000 chars).
export const formatearNO = (descripcionNP, observaciones) => {
  const seccionN = `N: ${descripcionNP && descripcionNP.trim() ? descripcionNP : 'N/A'}`
  const seccionO = `O: ${observaciones.length > 0 ? observaciones.join(', ') : 'N/A'}`
  const resultado = `${seccionN} ${seccionO}`
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
}

export const construirDescripcionCFDI = (p) => {
  const { flags } = p

  // Sección N: descripción de la pieza (null si el flag está off o no hay dato).
  const descNP = flags.MostrarNP && p.descripcionNP ? p.descripcionNP : null

  // Sección O: observaciones.
  const observaciones = []

  // Producto (valor directo, sin sub-label)
  if (flags.MostrarProducto && p.nombreProducto) {
    observaciones.push(p.nombreProducto)
  }

  // Caso especial: lote mínimo. Se preserva intacta la subcadena
  // "Cargo de lote mínimo aplicado" (el integrador SAT la parsea).
  if (p.loteMinimoCargado) {
    observaciones.push('Cargo de lote mínimo aplicado')
    return formatearNO(descNP, observaciones)
  }

  // Acabado (justo después de Producto)
  if (flags.MostrarAcabado && p.acabados.length > 0) {
    observaciones.push(`Acabado ${p.acabados.join(', ')}`)
  }

  // OC
  if (flags.MostrarPO && p.salesOrderName) {
    let oc = `OC ${p.salesOrderName}`
    if (flags.MultiplicadorLineaOC > 0 && p.salesOrderLineNumber != null) {
      oc += `-${p.salesOrderLineNumber * flags.MultiplicadorLineaOC}`
    }
    if (flags.MostrarOV && p.salesOrderIdInDomain) {
      oc += ` (${p.salesOrderIdInDomain})`
    }
    observaciones.push(oc)
  }

  // Lote — solo los nombres que difieran del OC (colapso de repetidos)
  if (flags.MostrarLote && p.nombresLotes.length > 0) {
    const lotesDistintos = p.nombresLotes.filter((l) => l !== p.salesOrderName)
    if (lotesDistintos.length > 0) {
      observaciones.push(`Lote ${lotesDistintos.join(', ')}`)
    }
  }

  // OT
  if (flags.MostrarOT && p.workOrderIdInDomain) {
    observaciones.push(`OT ${p.workOrderIdInDomain}`)
  }

  // PS del cliente (reincorporado con el flag MostrarPS)
  if (flags.MostrarPS && p.packingSlips.length > 0) {
    observaciones.push(`PS ${p.packingSlips.join(', ')}`)
  }

  return formatearNO(descNP, observaciones)
}
