// Fuente verificable de la lógica de la descripción CFDI para el SAT.
// DEBE quedar idéntica a la copia inline en powertools/synced/invoice/invoice.ts.
export const construirDescripcionCFDI = (p) => {
  const { flags } = p

  // Caso especial: lote mínimo. Se preserva intacta la subcadena
  // "Cargo de lote mínimo aplicado" (el integrador SAT la parsea).
  if (p.loteMinimoCargado) {
    const partesLM = []
    if (flags.MostrarProducto && p.nombreProducto) partesLM.push(p.nombreProducto)
    partesLM.push('Cargo de lote mínimo aplicado')
    return partesLM.join(' ').trim()
  }

  const partes = []

  // BLOQUE 1: Producto (valor directo, sin label)
  if (flags.MostrarProducto && p.nombreProducto) {
    partes.push(p.nombreProducto)
  }

  // BLOQUE 2: OC
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

  // BLOQUE 3: Lote — solo los nombres que difieran del OC (colapso de repetidos)
  if (flags.MostrarLote && p.nombresLotes.length > 0) {
    const lotesDistintos = p.nombresLotes.filter((l) => l !== p.salesOrderName)
    if (lotesDistintos.length > 0) {
      partes.push(`L ${lotesDistintos.join(', ')}`)
    }
  }

  // BLOQUE 4: Acabado
  if (flags.MostrarAcabado && p.acabados.length > 0) {
    partes.push(`Ac ${p.acabados.join(', ')}`)
  }

  // BLOQUE 5: OT
  if (flags.MostrarOT && p.workOrderIdInDomain) {
    partes.push(`OT ${p.workOrderIdInDomain}`)
  }

  // PS del cliente: NO se incluye en la descripción del SAT (redundante con OC;
  // su sufijo es la descripción del NP, no prioritaria). Se conserva en el PDF.

  const resultado = partes.join(' ').trim()
  // Red de seguridad absoluta (el SAT permite hasta 1000). El aviso de 60 lo
  // emite el caller; aquí NO truncamos a 60 para no mutilar la interfaz.
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
}
