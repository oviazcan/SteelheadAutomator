type PartNumberWorkOrder = Inputs['salesOrders'][number]['salesOrderLines'][number]['salesOrderLineItems'][number]['productionDetails']['partNumberWorkOrders'][number]

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS: Parsing de la descripción original de Steelhead
// ─────────────────────────────────────────────────────────────────────────────

// Parsers de string eliminados: lotes y PS se leen directo de partAccounts[].receivedBatch

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR DE DESCRIPCIÓN CFDI
// Implementa la lógica de ConstruirDescripcionCFDI del spec v2.
// ─────────────────────────────────────────────────────────────────────────────

type DatosFacturaFlags = {
  MostrarNP: boolean
  MostrarAcabado: boolean
  MostrarProducto: boolean
  MostrarRemision: boolean
  MostrarPO: boolean
  MultiplicadorLineaOC: number
  MostrarOV: boolean
  MostrarOT: boolean
  MostrarLote: boolean
  MostrarPS: boolean
}

const construirDescripcionCFDI = (p: {
  partNumberName: string | null
  notasAdicionales: string | null
  acabados: string[]
  nombreProducto: string | null
  salesOrderName: string
  salesOrderIdInDomain: string | null
  salesOrderLineNumber: number | null
  workOrderIdInDomain: string | null
  nombresLotes: string[]      // leídos de partAccounts[].receivedBatch
  packingSlips: string[]      // leídos de partAccounts[].receivedBatch.customInputs.DatosRecibo.PackingSlip
  loteMinimoCargado: boolean
  piezasLoteMinimo: number | null   // tamaño del lote en piezas (para sufijo de la cadena corta)
  flags: DatosFacturaFlags
}): string => {
  const partes: string[] = []
  const { flags } = p

  // ── BLOQUE 1: NP + descripción de parte + acabados ──
  if (flags.MostrarNP && p.partNumberName) {
    let bloque = p.partNumberName
    if (p.notasAdicionales) bloque += ` - ${p.notasAdicionales}`
    if (flags.MostrarAcabado && p.acabados.length > 0) {
      bloque += `, Acabado: ${p.acabados.join(', ')}`
    }
    partes.push(bloque)
  }

  // Caso especial: cargo de lote mínimo aplicado — descripción corta.
  // El integrador SAT identifica la subcadena "Cargo de lote mínimo aplicado"
  // para reconvertir la unidad a Lote oficial del SAT.
  if (p.loteMinimoCargado) {
    const piezasFmt =
      p.piezasLoteMinimo != null && p.piezasLoteMinimo > 0
        ? String(Math.round(p.piezasLoteMinimo * 100) / 100)
        : null
    partes.push(
      piezasFmt
        ? `Cargo de lote mínimo aplicado (${piezasFmt} piezas)`
        : 'Cargo de lote mínimo aplicado'
    )
    return partes.join('. ').trim()
  }

  // ── BLOQUE 2: Producto ──
  if (flags.MostrarProducto && p.nombreProducto) {
    partes.push(`Producto: ${p.nombreProducto}`)
  }

  // ── BLOQUE 3: Remisión ──
  // El PS de embarque de Steelhead no está expuesto en el schema del Power Invoicing.
  // Steelhead lo agrega automáticamente al pie de la descripción en la UI.
  // Pendiente: feature request a Steelhead para exponer packing_slip_id en partAccounts.
  // if (flags.MostrarRemision && p.packingSlips.length > 0) { ... }

  // ── BLOQUE 4: OC (OV) ──
  if (flags.MostrarPO && p.salesOrderName) {
    let bloqueOC = `OC: ${p.salesOrderName}`
    if (flags.MultiplicadorLineaOC > 0 && p.salesOrderLineNumber != null) {
      bloqueOC += `-${p.salesOrderLineNumber * flags.MultiplicadorLineaOC}`
    }
    if (flags.MostrarOV && p.salesOrderIdInDomain) {
      bloqueOC += ` (${p.salesOrderIdInDomain})`
    }
    partes.push(bloqueOC)
  }

  // ── BLOQUE 5: Orden de Trabajo ──
  if (flags.MostrarOT && p.workOrderIdInDomain) {
    partes.push(`OT: ${p.workOrderIdInDomain}`)
  }

  // ── BLOQUE 6: Lotes + PS — leídos de partAccounts[].receivedBatch ──
  if (flags.MostrarLote && p.nombresLotes.length > 0) {
    const label = p.nombresLotes.length === 1 ? 'Lote' : 'Lotes'
    let bloqueLote = `${label}: ${p.nombresLotes.join(', ')}`
    if (flags.MostrarPS && p.packingSlips.length > 0) {
      bloqueLote += ` PS: ${p.packingSlips.join(', ')}`
    }
    partes.push(bloqueLote)
  }

  const resultado = partes.join('. ').trim()
  // SAT: máximo 1,000 caracteres en Descripcion
  return resultado.length > 1000 ? resultado.slice(0, 997) + '...' : resultado
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

const getInvoicePricing = (
  inputs: Inputs,
  helpers: Helpers
): LowCodeResult & { customInputs?: Record<string, unknown> | null } => {
  const result: LowCodeResult = {
    lowCodeDefaultInvoiceLineItems: [],
    newSalesOrderLines: [],
  }

  // --- Tipo de cambio ---
  // Si la divisa de la OV es MXN, el tipo de cambio es 1 (operación en pesos).
  // Si es USD o no está definida, se busca en la tabla de dominio TipoCambio.
  // Si hay OVs con divisas distintas en la misma factura, se bloquea el cálculo.
  const divisas = [
    ...new Set(
      inputs.salesOrders
        .map(so => (so.customInputs?.Divisa as string | undefined)?.toUpperCase() ?? 'USD')
    ),
  ]
  const divisasMixtas = divisas.length > 1

  const invoiceDateISO = inputs.invoiceMetaData?.invoiceDate?.split('T')[0] ?? null
  const tipoCambioArray = inputs.domainCustomInputs?.TipoCambio as
    | { TipoCambio: number; FechaTipoCambio: string }[]
    | undefined

  let customInputs: Record<string, unknown> | null = null
  if (divisasMixtas) {
    helpers.addErrorMessage({
      severity: 'error',
      message: `Divisas mixtas en la factura (${divisas.join(', ')}) — no se puede determinar el Tipo de Cambio. Separa las órdenes de venta por divisa.`,
    })
  } else {
    const divisa = divisas[0]
    const esMXN = divisa === 'MXN'
    const matchingRate = esMXN ? null : tipoCambioArray?.find(rate => rate.FechaTipoCambio === invoiceDateISO)

    if (esMXN) {
      customInputs = { exchangeRate: '1' }
      helpers.addErrorMessage({
        severity: 'info',
        message: 'Factura en MXN — Tipo de Cambio: 1',
      })
    } else if (matchingRate) {
      // El pill "Tipo de Cambio" lo genera Steelhead automáticamente desde customInputs.exchangeRate
      customInputs = { exchangeRate: String(matchingRate.TipoCambio) }
      const [tcY, tcM, tcD] = matchingRate.FechaTipoCambio.split('-')
      helpers.addErrorMessage({
        severity: 'info',
        message: `Fecha del Tipo de Cambio: ${tcD}/${tcM}/${tcY}`,
      })
    } else {
      helpers.addErrorMessage({
        severity: 'warning',
        message: `No se encontró Tipo de Cambio para la fecha ${invoiceDateISO}`,
      })
    }
  }

  // --- Flags de visibilidad del cliente ---
  const datosFactura = (inputs.customerCustomInputs as any)?.DatosFactura ?? {}
  const flags: DatosFacturaFlags = {
    MostrarNP:            datosFactura.MostrarNP            ?? true,
    MostrarAcabado:       datosFactura.MostrarAcabado       ?? true,
    MostrarProducto:      datosFactura.MostrarProducto      ?? true,
    MostrarRemision:      datosFactura.MostrarRemision      ?? true,
    MostrarPO:            datosFactura.MostrarPO            ?? true,
    MultiplicadorLineaOC: datosFactura.MultiplicadorLineaOC ?? 0,
    MostrarOV:            datosFactura.MostrarOV            ?? false,
    MostrarOT:            datosFactura.MostrarOT            ?? true,
    MostrarLote:          datosFactura.MostrarLote          ?? true,
    MostrarPS:            datosFactura.MostrarPS            ?? true,
  }

  // --- Validación: ninguna línea marcada ---
  if (inputs.uiInvoiceLineItems.length === 0) {
    helpers.addErrorMessage({
      severity: 'error',
      message: '⚠ Factura sin líneas marcadas — verificar piezas listas antes de guardar',
    })
  }

  // --- Loop principal sobre líneas de factura ---
  let lineasConLoteMinimo = 0
  inputs.uiInvoiceLineItems.forEach(uiLine => {
    if (!uiLine.salesOrderLineItemId || !uiLine.productId) return

    // --- 1️⃣ Precio desde producto ---
    const product = inputs.allProducts.find(p => p.id === uiLine.productId)
    if (product) {
      const priceNode = product.pricesByProductId.nodes.find(p => p.price != null)
      if (priceNode) uiLine.rate = priceNode.price
    }

    // --- 2️⃣ Datos del sales order y pnwos ---
    let lineUnit: number | undefined = undefined
    let partNumbersOnThisLine: PartNumberWorkOrder[] = []
    let salesOrderName = ''
    let salesOrderIdInDomain: string | null = null
    let salesOrderLineNumber: number | null = null
    outer: for (const so of inputs.salesOrders) {
      for (const sol of so.salesOrderLines) {
        const match = sol.salesOrderLineItems.find(i => i.id === uiLine.salesOrderLineItemId)
        if (match) {
          lineUnit = match.unit?.id
          partNumbersOnThisLine = match.productionDetails?.partNumberWorkOrders?.map(pnwo => pnwo) ?? []
          salesOrderName = so.name
          salesOrderIdInDomain = so.idInDomain != null ? String(so.idInDomain) : null
          salesOrderLineNumber = sol.lineNumber
          break outer
        }
      }
    }

    // --- 3️⃣ Cantidad desde partAccounts × conversión de unidad ---
    if (lineUnit && partNumbersOnThisLine.length > 0) {
      let totalQuantity = 0
      for (const pnwo of partNumbersOnThisLine) {
        const conversionFactor =
          pnwo.partNumber?.partNumberUnitConversions?.find(c => c.unit?.id === lineUnit)?.factor ?? 1
        const partAccountSum =
          pnwo.partAccounts?.reduce(
            (sum, pa) => sum + ((pa?.quantity ?? 0) * conversionFactor),
            0
          ) ?? 0
        totalQuantity += partAccountSum
      }
      if (totalQuantity > 0) uiLine.quantity = totalQuantity
    }


    // --- 4️⃣ Cargo de lote mínimo ---
    // Disparador: el PN tiene una conversión de unidades a "LO Lote" (id 5348).
    // El factor en partNumberUnitConversions es "lineUnit por unidad base"
    // (1 PZ = factor LO), entonces piezasPorLote = 1 / factor.
    // Si las piezas pedidas (suma directa de partAccounts.quantity en piezas)
    // son <= piezasPorLote, se cobra como 1 lote: quantity = 1 y rate se
    // re-escala a (piezasPorLote × rateUnitario) para que el total represente
    // un lote completo. La unidad de la línea no se toca aquí (no modificable
    // en este contexto); el integrador SAT la reconvierte detectando la
    // cadena "Cargo de lote mínimo aplicado" en la descripción.
    const LOTE_UNIT_ID = 5348
    const yaTeníaLoteMinimo =
      /cargo de lote m[íi]nimo aplicado/i.test(uiLine.description ?? '')
      || (uiLine.description ?? '').toLowerCase().includes('cargo de lote mínimo')
    let loteMinimoCargado = false
    let piezasLoteMinimo: number | null = null
    for (const pnwo of partNumbersOnThisLine) {
      const loConversion = pnwo.partNumber?.partNumberUnitConversions?.find(
        c => c.unit?.id === LOTE_UNIT_ID
      )
      const loFactor = loConversion?.factor
      if (loFactor == null || loFactor <= 0) continue

      const piezasPorLote = 1 / loFactor

      const piezasPedidas = pnwo.partAccounts?.reduce(
        (sum, pa) => sum + (pa?.quantity ?? 0),
        0
      ) ?? 0

      if (
        piezasPedidas > 0 &&
        piezasPedidas <= piezasPorLote &&
        uiLine.rate != null
      ) {
        uiLine.rate = piezasPorLote * uiLine.rate
        uiLine.quantity = 1
        loteMinimoCargado = true
        piezasLoteMinimo = piezasPorLote
        lineasConLoteMinimo++
        break
      }
    }
    // Failsafe: contar líneas donde el cargo ya venía pre-poblado y nuestro
    // cálculo no lo re-disparó.
    if (!loteMinimoCargado && yaTeníaLoteMinimo) {
      loteMinimoCargado = true
      lineasConLoteMinimo++
    }

    // --- 4.5️⃣ Recopilar datos para descripción CFDI ---
    const firstPnwo = partNumbersOnThisLine[0]
    const partNumberName = firstPnwo?.partNumber?.name ?? null
    const notasAdicionales =
      (firstPnwo?.partNumber?.customInputs?.NotasAdicionales as string | undefined) ?? null

    // Acabados: labels del work order (no treatments — esos son pasos de proceso)
    const acabados = [
      ...new Set(
        partNumbersOnThisLine.flatMap(
          pnwo =>
            pnwo.workOrder?.workOrderLabelsByWorkOrderId?.nodes
              ?.map(n => n.labelByLabelId?.name)
              .filter((n): n is string => n != null) ?? []
        )
      ),
    ]

    const workOrderIdInDomain = partNumbersOnThisLine
      .map(pnwo => pnwo.workOrder?.idInDomain)
      .find(id => id != null)
    const workOrderStr = workOrderIdInDomain != null ? String(workOrderIdInDomain) : null

    const nombreProducto = product?.name ?? null

    // --- 5️⃣ Lotes y PS directo de partAccounts[].receivedBatch ---
    // Steelhead construye el string "Batch: X Y, Packing Slip: Z" dinámicamente para display
    // pero los datos reales viven en estos nodos del JSON
    const todosLosPartAccounts = partNumbersOnThisLine.flatMap(pnwo => pnwo.partAccounts ?? [])

    const nombresLotes = [
      ...new Set(
        todosLosPartAccounts
          .map(pa => pa?.receivedBatch?.name)
          .filter((n): n is string => n != null && n.trim() !== '')
      ),
    ]

    const packingSlips = [
      ...new Set(
        todosLosPartAccounts
          .map(pa => {
            const ps = pa?.receivedBatch?.customInputs?.DatosRecibo?.PackingSlip
            return ps != null ? String(ps) : null
          })
          .filter((ps): ps is string => ps != null && ps.trim() !== '')
      ),
    ]

    // --- 6️⃣ Construir descripción CFDI ---
    uiLine.description = construirDescripcionCFDI({
      partNumberName,
      notasAdicionales,
      acabados,
      nombreProducto,
      salesOrderName,
      salesOrderIdInDomain,
      salesOrderLineNumber,
      workOrderIdInDomain: workOrderStr,
      nombresLotes,
      packingSlips,
      loteMinimoCargado,
      piezasLoteMinimo,
      flags,
    })

    // --- 7️⃣ Push línea al resultado ---
    result.lowCodeDefaultInvoiceLineItems.push({
      salesOrderLineItemId: uiLine.salesOrderLineItemId,
      taxCodeId: uiLine.taxCodeId ?? null,
      quantity: uiLine.quantity,
      rate: uiLine.rate,
      productId: uiLine.productId,
      description: uiLine.description,
    })
  })

  // --- Aviso: líneas con cargo de lote mínimo aplicado ---
  if (lineasConLoteMinimo > 0) {
    helpers.addErrorMessage({
      severity: 'warning',
      message: `${lineasConLoteMinimo} línea(s) con cargo de lote mínimo aplicado`,
    })
  }

  // --- Validación: líneas con cantidad o precio cero ---
  const lineasConProblema = result.lowCodeDefaultInvoiceLineItems.filter(
    line => (line.quantity == null || line.quantity === 0) || (line.rate == null || line.rate === 0)
  )
  if (lineasConProblema.length > 0) {
    helpers.addErrorMessage({
      severity: 'error',
      message: `${lineasConProblema.length} línea(s) con cantidad o precio en cero — revisar antes de guardar`,
    })
  }

  return { ...result, customInputs }
}

// ─── Tipos requeridos por Steelhead (sin cambios) ───────────────────────────

type LowCodeDefaultInvoiceLineItems = {
  salesOrderLineItemId: number
  taxCodeId: number | null
  quantity: number | null
  rate: number | null
  productId: number | null
  description: string | null
}[]

type NewSalesOrderLines = {
  salesOrderId: number
  name: string | null
  description: string | null
  lineNumber: number | null
  salesOrderLineItems: {
    defaultChecked: boolean
    productId: number
    description: string
    price: number
    quantity: number
  }[]
}[]

type LowCodeResult = {
  lowCodeDefaultInvoiceLineItems: {
    salesOrderLineItemId: number
    taxCodeId: number | null
    quantity: number | null
    rate: number | null
    productId: number | null
    description: string | null
  }[]
  newSalesOrderLines: {
    salesOrderId: number
    name: string | null
    description: string | null
    lineNumber: number | null
    salesOrderLineItems: {
      defaultChecked: boolean
      productId: number
      description: string
      price: number
      quantity: number
    }[]
  }[]
  customInputs?: ({ [x: string]: any } | null) | undefined
}

interface Inputs {
  currentMetalExchangeRates: {
    id: number
    metal: {
      code: string
      unit: string
      description: string
      currentExchangeHomeCurrency: {
        currency: string | null
        currencyDescription: string | null
        exchangeRate: number | null
      } | null
    } | null
  }[]
  invoiceMetaData: {
    customer: {
      id: number | null
      name: string | null
      idInDomain: number | null
      customInputs: { [x: string]: any } | null
    } | null
    invoiceShipMethod: { id: number | null; name: string | null } | null
    invoiceNumber: number | null
    invoicesTotal: string | null
    invoiceDate: string | null
  } | null
  domainCustomInputs?: any
  customerCustomInputs?: any
  salesOrders: {
    id: number
    name: string
    idInDomain: number | null
    shipVia: { id: number; name: string | null } | null
    customInputs: { [x: string]: any } | null
    salesOrderLines: {
      id: number | null
      name: string | null
      description: string | null
      lineNumber: number | null
      salesOrderLineItems: {
        id: number | null
        description: string
        price: number | null
        productId: number | null
        quantity: number | null
        unit: { id: number | null; name: string | null } | null
        productionDetails: {
          partNumberWorkOrders: {
            quoteId: number | null
            partGroup: { id: number | null; name: string | null } | null
            uniqueCertCount: number | null
            descriptionMarkdown: string | null
            partsTransfers: {
              createdAt: string
              at: string
              partCount: number
              partNumberId: number | null
              fromStation: { id: number | null } | null
              toStation: { id: number | null } | null
              fromLocation: { id: number | null } | null
              toLocation: { id: number | null } | null
              fromPartGroup: { id: number | null } | null
              toPartGroup: { id: number | null } | null
            }[] | null
            partAccounts: ({
              certReport: { id: number; idInDomain: number | null; templateId: number | null; revision: number } | null
              locationId: number | null
              locationPath: string | null
              quantity: number | null
              recipeNode: { id: number | null; name: string | null } | null
              partGroup: { id: number | null; name: string | null } | null
              rack: { id: number; name: string | null; rackType: { id: number; name: string } | null } | null
              receivedBatch: { id: number; name: string; customInputs: { [x: string]: any } | null; descriptionMarkdown: string | null } | null
              measurement: { unit: string; measurement: number; tare: number } | null
            } | null)[] | null
            partNumber: {
              id: number
              name: string | null
              descriptionMarkdown: string | null
              glAccount: { id: number; products: { id: number; name: string }[] | null } | null
              partNumberUnitConversions: { factor: number | null; unit: { id: number | null; name: string | null } | null }[] | null
              customInputs: { [x: string]: any } | null
              prices: {
                id: number
                name: string | null
                isDefaultPrice: boolean
                unit: { id: number; name: string } | null
                lineItems: { id: number; title: string | null; price: number | null; product: { id: number; name: string } | null }[]
              }[]
              specFieldParamsByPartNumberId: ({
                maximumValue: number | null
                minimumValue: number | null
                name: string | null
                samplingRate: number | null
                targetValue: number | null
                specFieldBySpecFieldId: { name: string | null; id: number | null } | null
              } | null)[]
            } | null
            workOrder: {
              id: number | null
              idInDomain: number | null
              workOrderLabelsByWorkOrderId: { nodes: { labelByLabelId: { id: number | null; name: string | null; color: string | null } | null }[] } | null
              recipeNodeByRecipeId: { processNodeByDerivedFrom: { id: number | null; name: string | null; productId: number | null } }
              treatments: {
                id: number | null
                name: string | null
                treatmentGroup: { id: number | null; name: string | null; productId: number | null } | null
                pricesByTreatmentId: { nodes: { id: number; name?: string | null; priceMicrodollars?: string | null; customerId?: number | null; partNumberId?: number | null }[] } | null
                recipeNodeName: string | null
                recipeNodeId: number | null
              }[] | null
            } | null
          }[] | null
        } | null
      }[]
    }[]
  }[]
  uiInvoiceLineItems: {
    salesOrderLineItemId: number
    salesOrderId: number | null
    taxCodeId: number | null
    quantity: number | null
    rate: number | null
    productId: number | null
    description: string | null
    partNumberId: number | null
  }[]
  newSalesOrderLines: {
    salesOrderId: number
    name: string | null
    description: string | null
    lineNumber: number | null
    salesOrderLineItems: {
      productId: number
      description: string
      price: number
      quantity: number
      includedOnInvoice: boolean
    }[]
  }[]
  allProducts: {
    id: number
    name: string | null
    pricesByProductId: {
      nodes: { id: number; name: string; price: number | null; customerByCustomerId: { id: number; name: string | null } | null }[]
    }
  }[]
}

type Severity = 'warning' | 'error' | 'info' | 'success'
type ErrorMessage = string | { severity: Severity; message: string }

interface Helpers {
  log: (message: any) => void
  addErrorMessage: (message: ErrorMessage) => void
  addInformationalPrice: (value: { title: string; note?: string; price: number; category?: string }) => void
  addQuotePartPricingTier: (value: { title: string; quantity: number; price: number }) => void
  parseCSV: (value: string) => { data: any[][]; errors: []; meta: any }
}
