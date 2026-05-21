const getReceivedOrderCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = {
    stationRouting: [],
    treatmentTimes: [],
    partPrices: [],
    partsPerRack: [],
    partNumberUpdates: [],
    workOrderLabels: [],
  };

  // Disparador del lote mínimo: el PN tiene conversión a "LO Lote" (unit id
  // 5348). El factor en partNumber.unitConversions es "unidad objetivo por
  // PZ" (1 PZ = factor LO), entonces piezasPorLote = 1 / factor.
  // Se agrupa por (partNumber, workOrder); las piezas pedidas se suman
  // convirtiendo la cantidad de cada lineItem desde su unidad a PZ usando el
  // mismo set de unitConversions. Si piezasPedidas <= piezasPorLote, la
  // partida se factura como lote mínimo y se aplica la etiqueta "Lote" a la
  // OT para que viaje por toda la trazabilidad.
  const LOTE_UNIT_ID = 5348;
  const LOTE_LABEL_NAME = "Lote";

  const loteLabel = inputs.allLabels.find((l) => l.name === LOTE_LABEL_NAME);
  const divisa =
    (inputs.receivedOrder?.customInputs?.Divisa as string | undefined) ?? "USD";

  // Excepción de cliente: Schneider Electric México en Javier Rojo Gómez
  // requiere precio $0 obligatorio. Si el precio no es 0, se emite warning
  // específico en vez de "Sin precio default".
  const customerName = (inputs.customer?.name ?? "").toLowerCase();
  const shipToAddr = (
    inputs.receivedOrder?.shipToAddress?.address ?? ""
  ).toLowerCase();
  const isSchneiderJavierRojo =
    customerName.includes("schneider") &&
    customerName.includes("mexico") &&
    shipToAddr.includes("javier rojo");

  if (!inputs.rowData?.length) return result;

  const fmtQty = (n: number) => String(Math.round(n * 100) / 100);
  const fmtMoney = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

  type Group = {
    partNumber: any;
    workOrderId?: number;
    rowKey?: string; // handle alterno cuando la WO aún no nace
    piezasPorLote: number | null; // null si el PN no tiene conversión LO
    piezasPedidas: number;
    unitPrice: number | null;
    priceUnitName: string | null;
    priceUnitPerPiece: number | null; // 1 PZ = priceUnitPerPiece unidades-precio
  };

  const groupMap = new Map<string, Group>();
  const desconocidoSet = new Set<number>();
  const infoSet = new Set<number>();
  const rackSet = new Set<number>();

  // Buffers para consolidar mensajes por severidad: un solo addErrorMessage
  // por bucket al final (3 rows máximo en el panel de alertas).
  const errorChips: string[] = [];
  const sinPrecioChips: string[] = [];
  const schneiderChips: string[] = [];
  const sinRackChips: string[] = [];
  const loteChips: string[] = [];
  const infoChips: string[] = [];

  for (const row of inputs.rowData) {
    const partNumber = row.partNumber;
    if (!partNumber) continue;

    // ── NP Desconocido: PN sin proceso default o sin especificación ──
    // `row.process` se auto-rellena con el default del PN cuando existe;
    // `partNumber.partNumberTreatment` no es confiable aquí (a veces viene
    // vacío aunque el PN sí tenga proceso).
    const hasProcess = row.process != null;
    const hasSpec =
      (partNumber.specs?.length ?? 0) > 0 ||
      (partNumber.specFieldParams?.length ?? 0) > 0;
    if ((!hasProcess || !hasSpec) && !desconocidoSet.has(partNumber.id)) {
      desconocidoSet.add(partNumber.id);
      const faltas: string[] = [];
      if (!hasProcess) faltas.push("proceso default");
      if (!hasSpec) faltas.push("especificación");
      errorChips.push(`'${partNumber.name}' (sin ${faltas.join(" ni ")})`);
      // No hay canal en LowCodeResult para escribir partNumberLabels
      // (probado 2026-05-15 con varias formas casteadas, ninguna aplicó).
      // El operador etiqueta el PN manual; el mensaje de error lo guía.
    }

    // ── Info: nombre del Spec + rango de Espesor ──
    // Dedupea por PN. Busca un specFieldParam cuyo specField se llame
    // "Espesor" y construye el rango desde minimumValue/maximumValue (el
    // shape real en este endpoint, confirmado 2026-05-15). targetValue se
    // usa solo si los rangos vienen null.
    if (!infoSet.has(partNumber.id) && (partNumber.specs?.length ?? 0) > 0) {
      infoSet.add(partNumber.id);
      const specNames = (partNumber.specs ?? [])
        .map((s) => s?.name)
        .filter((n): n is string => !!n);

      let espesorRange: string | undefined;
      const params = partNumber.specFieldParams ?? [];
      for (const p of params) {
        const pa = p as any;
        const fieldName = (pa?.specField?.name ?? "").toString().toLowerCase();
        if (fieldName !== "espesor") continue;
        const min = pa?.minimumValue;
        const max = pa?.maximumValue;
        const tgt = pa?.targetValue;
        if (min != null && max != null) espesorRange = `${min}-${max}`;
        else if (min != null) espesorRange = `≥${min}`;
        else if (max != null) espesorRange = `≤${max}`;
        else if (tgt != null) espesorRange = `${tgt}`;
        break;
      }

      const partes: string[] = [];
      if (specNames.length > 0) partes.push(specNames.join(", "));
      partes.push(espesorRange ? `Espesor ${espesorRange}` : "sin Espesor");
      infoChips.push(`'${partNumber.name}': ${partes.join(", ")}`);
    }

    // ── Sin Tipo de Rack: PN sin partNumberRackTypes ──
    if (!rackSet.has(partNumber.id)) {
      rackSet.add(partNumber.id);
      if ((partNumber.partNumberRackTypes?.length ?? 0) === 0) {
        sinRackChips.push(`'${partNumber.name}'`);
      }
    }

    // ── Agrupación por (PN, WO) — siempre se crea el grupo para que las
    // validaciones de precio (Schneider, sinPrecio) corran incluso si el PN
    // no tiene conversión LO. piezasPorLote queda null en ese caso y solo
    // el disparo de "aplicaLoteMinimo" se inhibe.
    const workOrderId = row.workOrder?.id;
    // En "Add Parts to Sales Order" la WO aún no nace; el placeholder llega
    // como { name: "New WO#N", fromRowKey: <rowKey>, createdBy: {...} } sin
    // id propio. Capturamos el rowKey por si Steelhead acepta etiquetar la
    // WO por crear vía ese handle (mismo patrón que partNumberWorkOrdersToGroup).
    const rowKey = workOrderId ? undefined : row.rowKey;
    const loConversion = partNumber.unitConversions?.find(
      (c) => c.unit?.id === LOTE_UNIT_ID
    );
    const piezasPorLote =
      loConversion?.factor && loConversion.factor > 0
        ? 1 / loConversion.factor
        : null;
    const key = `${partNumber.id}:${workOrderId ?? rowKey ?? "no-wo"}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        partNumber,
        workOrderId,
        rowKey,
        piezasPorLote,
        piezasPedidas: 0,
        unitPrice: null,
        priceUnitName: null,
        priceUnitPerPiece: null,
      });
    }

    const group = groupMap.get(key)!;

    // Piezas pedidas: row.quantity (en selectedUnitConversion) + inventario.
    // row.lineItems no está poblado todavía en "Add Parts to Sales Order".
    const selFactor = row.selectedUnitConversion?.factor;
    const piezasFromRow =
      selFactor && selFactor > 0
        ? (row.quantity ?? 0) / selFactor
        : (row.quantity ?? 0);
    const piezasFromInventory = (row.inventory ?? []).reduce((sum, inv) => {
      const q = parseFloat(inv?.depleteQuantity ?? "0");
      return sum + (isNaN(q) ? 0 : q);
    }, 0);
    group.piezasPedidas += piezasFromRow + piezasFromInventory;

    // Captura precio: varias fuentes en orden de confianza. unitPrice puede
    // ser 0 (caso válido p.ej. Schneider/Javier Rojo Gómez), así que se
    // distingue "asignado" de "positivo" más adelante.
    // Fuente 1: row.lineItems[].unitPrice + li.unit. Si el lineItem no trae
    // unit (visto en "Add Parts to Sales Order"), se cae al selectedUnit.
    if (group.unitPrice == null) {
      for (const li of row.lineItems || []) {
        if (li.unitPrice == null) continue;
        const unitId = li.unit?.value ?? row.selectedUnitConversion?.unitByUnitId?.id;
        const unitName =
          li.unit?.label ?? row.selectedUnitConversion?.unitByUnitId?.name ?? null;
        const factor =
          partNumber.unitConversions?.find((c) => c.unit?.id === unitId)
            ?.factor ?? row.selectedUnitConversion?.factor ?? 1;
        group.unitPrice = li.unitPrice;
        group.priceUnitName = unitName;
        group.priceUnitPerPiece = factor;
        break;
      }
    }
    // Fuente 2: row.unitPrice (string del row, populado cuando hay precio
    // default activo). Sirve cuando lineItems viene vacío.
    if (group.unitPrice == null && row.unitPrice != null) {
      const parsed = parseFloat(row.unitPrice);
      if (!isNaN(parsed)) {
        group.unitPrice = parsed;
        group.priceUnitName =
          row.selectedUnitConversion?.unitByUnitId?.name ?? null;
        group.priceUnitPerPiece = row.selectedUnitConversion?.factor ?? 1;
      }
    }
    // Fuente 3: precio de la quote vinculada (fallback).
    if (group.unitPrice == null && row.quotePartNumber?.priceDollars != null) {
      group.unitPrice = row.quotePartNumber.priceDollars;
      group.priceUnitName =
        row.selectedUnitConversion?.unitByUnitId?.name ?? null;
      group.priceUnitPerPiece = row.selectedUnitConversion?.factor ?? 1;
    }
  }

  for (const group of groupMap.values()) {
    const pnName = group.partNumber?.name ?? "?";
    const priceAssigned = group.unitPrice != null;
    const hasPositivePrice =
      priceAssigned &&
      group.unitPrice! > 0 &&
      group.priceUnitPerPiece != null &&
      group.priceUnitName != null;
    const aplicaLoteMinimo =
      group.piezasPorLote != null &&
      group.piezasPedidas > 0 &&
      group.piezasPedidas <= group.piezasPorLote;

    if (isSchneiderJavierRojo) {
      // Excepción: el precio DEBE ser 0. No-asignado o cualquier valor
      // distinto de 0 dispara warning específico.
      if (!priceAssigned || group.unitPrice !== 0) {
        schneiderChips.push(`'${pnName}'`);
      }
    } else if (!priceAssigned) {
      // Sin precio default — independiente del lote mínimo.
      sinPrecioChips.push(`'${pnName}'`);
    }

    if (!aplicaLoteMinimo) continue;

    const piezasPorLote = group.piezasPorLote!;
    if (hasPositivePrice) {
      const loteEnPriceUnit = piezasPorLote * group.priceUnitPerPiece!;
      const monto = loteEnPriceUnit * group.unitPrice!;
      loteChips.push(
        `'${pnName}' (${fmtQty(loteEnPriceUnit)} ${group.priceUnitName} por $${fmtMoney(monto)} ${divisa})`
      );
    } else {
      loteChips.push(`'${pnName}' (${fmtQty(piezasPorLote)} piezas)`);
    }

    if (loteLabel?.id) {
      if (group.workOrderId) {
        result.workOrderLabels!.push({
          workOrderId: group.workOrderId,
          labelId: loteLabel.id,
        });
      } else if (group.rowKey) {
        // El runtime de Steelhead acepta `rowKey` como handle en
        // workOrderLabels aunque el typedef solo declare `workOrderId:
        // number` (mismo patrón que partNumberWorkOrdersToGroup). Etiqueta
        // la WO al momento de nacer en "Add Parts to Sales Order".
        result.workOrderLabels!.push({
          rowKey: group.rowKey,
          labelId: loteLabel.id,
        } as any);
      }
    }
  }

  // ── Emisión consolidada: una alerta por severidad ──
  if (errorChips.length > 0) {
    helpers.addErrorMessage({
      severity: "error",
      message: `NP Desconocido — ${errorChips.join(" · ")}. Cancela esta OV, etiqueta cada NP con 'NP Desconocido' y avisa a Ingeniería.`,
    });
  }
  const warningParts: string[] = [];
  if (sinPrecioChips.length > 0) {
    warningParts.push(`Sin precio default: ${sinPrecioChips.join(", ")}`);
  }
  if (schneiderChips.length > 0) {
    warningParts.push(
      `Schneider Electric México (Javier Rojo Gómez) requiere precio $0: ${schneiderChips.join(", ")}`
    );
  }
  if (sinRackChips.length > 0) {
    warningParts.push(
      `${sinRackChips.join(", ")} no tiene cantidad de piezas por carga asociadas a un Tipo de Rack`
    );
  }
  if (loteChips.length > 0) {
    let loteMsg = `Lote mínimo: ${loteChips.join(" · ")}`;
    if (!loteLabel) {
      loteMsg += `. Crea la etiqueta '${LOTE_LABEL_NAME}' en el dominio para que viaje a la OT`;
    }
    warningParts.push(loteMsg);
  }
  if (warningParts.length > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: warningParts.join(" | "),
    });
  }
  if (infoChips.length > 0) {
    helpers.addErrorMessage({
      severity: "info",
      message: `Spec — ${infoChips.join(" · ")}`,
    });
  }

  return result;
};

type TreatmentTimes = ({
  partNumberId: number;
  treatmentId: number;
  cycleTime: {
    years?: (number | null) | undefined;
    months?: (number | null) | undefined;
    days?: (number | null) | undefined;
    hours?: (number | null) | undefined;
    minutes?: (number | null) | undefined;
    seconds?: (number | null) | undefined;
  };
  totalTime: {
    years?: (number | null) | undefined;
    months?: (number | null) | undefined;
    days?: (number | null) | undefined;
    hours?: (number | null) | undefined;
    minutes?: (number | null) | undefined;
    seconds?: (number | null) | undefined;
  };
  timeType: "PER_PART" | "BATCH";
} | null) | undefined;

type StationRouting = ({
  partNumberId: number;
  partGroupId?: number | undefined;
  workOrderId?: number | undefined;
  stationId: number;
  treatmentId: number;
  recipeNodeId?: number | undefined;
} | null) | undefined;

type LowCodeResult = {
  stationRouting: (({
    partNumberId: number;
    partGroupId?: number | undefined;
    workOrderId?: number | undefined;
    stationId: number;
    treatmentId: number;
    recipeNodeId?: number | undefined;
  } | null) | undefined)[];
  treatmentTimes: (({
    partNumberId: number;
    treatmentId: number;
    cycleTime: {
      years?: (number | null) | undefined;
      months?: (number | null) | undefined;
      days?: (number | null) | undefined;
      hours?: (number | null) | undefined;
      minutes?: (number | null) | undefined;
      seconds?: (number | null) | undefined;
    };
    totalTime: {
      years?: (number | null) | undefined;
      months?: (number | null) | undefined;
      days?: (number | null) | undefined;
      hours?: (number | null) | undefined;
      minutes?: (number | null) | undefined;
      seconds?: (number | null) | undefined;
    };
    timeType: "PER_PART" | "BATCH";
  } | null) | undefined)[];
  partPrices: (({
    rowKey: string;
    unitPrice: number;
  } | null) | undefined)[];
  partsPerRack: (({
    partNumberId: number;
    rackTypeId: number;
    partsPerRack: number;
  } | null) | undefined)[];
  partNumberUpdates: (({
    partNumberId: number;
    customInputs?: any;
  } | null) | undefined)[];
  workOrderLabels?: ((({
    workOrderId: number;
    labelId: number;
  } | null) | undefined)[] | null) | undefined;
  partNumberWorkOrdersToGroup?: ((({
    rowKey: string;
    partGroupsToCreate: {
      partGroupName: string;
      partGroupType: string;
      partCount: number;
    }[];
  } | null) | undefined)[] | null) | undefined;
  workOrderUpdates?: ((({
    workOrderId: number;
    descriptionMarkdown: string | null;
  } | null) | undefined)[] | null) | undefined;
};

interface Inputs {
  rowData: {
    rowKey: string;
    lineItems: {
      description: string | null;
      unitPrice: number | null;
      product: {
        label: string;
        value: number;
      } | null;
      quantity: number | null;
      unit: {
        label: string;
        value: number;
      } | null;
    }[] | null;
    partNumber: {
      name: string;
      id: number;
      specs?: ({
        id: number;
        name: string;
        description: string | null;
      }[] | null) | undefined;
      unitConversions: {
        unit: {
          id: number;
          name: string;
        };
        factor: number;
      }[];
      customInputs: {
        DatosFacturacion?: {
          CodigoSAT?: ("73181106 - Servicios de enchapado" | "73181109 - Servicios de niquelado" | "73181119 - Servicio de recubrimiento con pintura en polvo" | "73151500 - Servicios de ensamble" | "73151506 - Servicio de subensamble o ensamble definitivo" | "11191500 - Cuerpos s\u00F3lidos de metal" | "30262200 - Barras de cobre" | "31281500 - Componentes estampados" | "31281813 - Componentes de cobre perforados" | "39121400 - Leng\u00FCetas de conexi\u00F3n, conectadores y terminales") | undefined;
          MinLotCharge?: string | undefined;
        } | undefined;
        NotasAdicionales?: string | undefined;
        DatosAdicionalesNP?: {
          Plano?: string | undefined;
          BaseMetal?: ("Cobre" | "Aluminio" | "Fierro" | "Lat\u00F3n" | "Acero Inoxidable" | "Bronce" | "Bimet\u00E1lica" | "Varios") | undefined;
          QuoteIBMS?: string | undefined;
          EstacionIBMS?: string | undefined;
          NumeroParteAlterno?: string[] | undefined;
        } | undefined;
        DatosPlanificacion?: {
          CargasHora?: string | undefined;
          MontoMinimo?: number | undefined;
          PiezasCarga?: number | undefined;
          TiempoEntrega?: number | undefined;
        } | undefined;
      };
      partNumberTreatment?: ({
        treatment?: ({
          name: string;
          id: number;
        } | null) | undefined;
        batchTimeMinutes?: (number | null) | undefined;
        singleProcessTimeMinutes?: (number | null) | undefined;
        totalTimeMinutes?: (number | null) | undefined;
      }[] | null) | undefined;
      specFieldParams?: ({
        specField?: ({
          name: string;
          id: number;
        } | null) | undefined;
        minimumValue?: (number | null) | undefined;
        targetValue?: (number | null) | undefined;
        maximumValue?: (number | null) | undefined;
      }[] | null) | undefined;
      partNumberRackTypes?: ({
        id: number;
        partsPerRack: number;
        rackType?: ({
          id: number;
          name: string;
        } | null) | undefined;
      }[] | null) | undefined;
      partNumberLabels?: ({
        id: number;
        name: string;
        color: string;
      }[] | null) | undefined;
    };
    isOneOffPartNumber: boolean;
    quantity: number;
    process?: ({
      name: string;
      id: number;
    } | null) | undefined;
    productId?: (number | null) | undefined;
    recipeNode?: ({
      name: string;
      id: number;
    } | null) | undefined;
    workOrder?: ({
      name: string;
      id: number;
      createdBy: {
        id: number;
        name: string;
      } | null;
    } | null) | undefined;
    unitPrice?: (string | null) | undefined;
    selectedUnitConversion: {
      id: number;
      factor: number;
      unitByUnitId: {
        id: number;
        name: string;
      };
    } | null;
    description?: (string | null) | undefined;
    treatments?: ({
      recipeNodeIndex: number;
      recipeNodeId: number;
      treatment?: ({
        name: string;
        id: number;
        treatmentGroup?: ({
          id: number;
          name: string;
        } | null) | undefined;
        treatmentGroupCustomInputs: {
          [x: string]: any;
        } | null;
      } | null) | undefined;
      processNodeId: number;
    }[] | null) | undefined;
    treatmentOverrides?: ((({
      id: number;
      name: string;
    } | null) | undefined)[] | null) | undefined;
    updateDefaults: boolean;
    partNumberPriceId?: (number | null) | undefined;
    quotePartNumber?: ({
      quotePartNumberTiers: {
        title: string;
        quantity?: (number | null) | undefined;
        unitPrice: number;
      }[];
      priceDollars: number;
      quantity: number;
      customInputs: {
        DatosFacturacion?: {
          CodigoSAT?: ("73181106 - Servicios de enchapado" | "73181109 - Servicios de niquelado" | "73181119 - Servicio de recubrimiento con pintura en polvo" | "73151500 - Servicios de ensamble" | "73151506 - Servicio de subensamble o ensamble definitivo" | "11191500 - Cuerpos s\u00F3lidos de metal" | "30262200 - Barras de cobre" | "31281500 - Componentes estampados" | "31281813 - Componentes de cobre perforados" | "39121400 - Leng\u00FCetas de conexi\u00F3n, conectadores y terminales") | undefined;
          MinLotCharge?: string | undefined;
        } | undefined;
        NotasAdicionales?: string | undefined;
        DatosAdicionalesNP?: {
          Plano?: string | undefined;
          BaseMetal?: ("Cobre" | "Aluminio" | "Fierro" | "Lat\u00F3n" | "Acero Inoxidable" | "Bronce" | "Bimet\u00E1lica" | "Varios") | undefined;
          QuoteIBMS?: string | undefined;
          EstacionIBMS?: string | undefined;
          NumeroParteAlterno?: string[] | undefined;
        } | undefined;
        DatosPlanificacion?: {
          CargasHora?: string | undefined;
          MontoMinimo?: number | undefined;
          PiezasCarga?: number | undefined;
          TiempoEntrega?: number | undefined;
        } | undefined;
      };
      quotePartProducts: {
        quantity: number;
        priceDollars: number;
        priceType?: (string | null) | undefined;
        rateUnits?: (string | null) | undefined;
        valueUnits?: (string | null) | undefined;
        operation?: (string | null) | undefined;
        treatmentId?: (number | null) | undefined;
        accountingProduct?: ({
          name: string;
          id: number;
        } | null) | undefined;
        product?: ({
          name: string;
          id: number;
        } | null) | undefined;
      }[];
    } | null) | undefined;
    location?: ({
      id: number;
      name: string;
    } | null) | undefined;
    viewingInventory: boolean;
    inventory: {
      id: number;
      name: string;
      customInputs: {
        [x: string]: any;
      } | null;
      inventoryItemId: number;
      depleteQuantity: string;
      recipeNode?: ({
        name: string;
        id: number;
      } | null) | undefined;
      location?: ({
        id: number;
        name: string;
      } | null) | undefined;
      outGoingPartNumber?: ({
        name: string;
        id: number;
      } | null) | undefined;
      partGroup?: ({
        name: string;
        id: number;
      } | null) | undefined;
    }[];
    partDeadline?: any | null;
  }[];
  customer: {
    domainId: number;
    idInDomain: number | null;
    name: string | null;
    default_ship_method: {
      id: number;
      name: string | null;
    } | null;
    invoiceTermByDefaultInvoiceTermsId: {
      id: number;
      terms: string;
      days: number | null;
    } | null;
    salesTaxable: boolean | null;
  } | null;
  receivedOrder: {
    id: number;
    name: string;
    domainId: number;
    idInDomain: number | null;
    customInputs: {
      Divisa: "USD" | "MXN";
      RazonSocialVenta: "ECO030618BR4 - ECOPLATING SA DE CV, 1 de Mayo 1803, Zona Industrial, Toluca, Estado de M\u00E9xico, 50071, M\u00E9xico" | "PRO800417TDA - PROQUIPA SA DE CV, 1 de Mayo 1801, Zona Industrial, Toluca, Estado de M\u00E9xico, 50070, M\u00E9xico" | "EMO2104135V0 - ECOPLATING MONTERREY SA DE CV, 5ta Avenida 203, Parque Industrial General Escobedo, Nuevo Le\u00F3n, 66062, M\u00E9xico";
    };
    deadline?: any | null;
    createdAt?: any;
    createdBy: {
      id: number;
      name: string;
    } | null;
    shipVia: string | null;
    shipToAddress: {
      customer: {
        id: number;
        name: string;
        customerLabels: {
          id: number;
          name: string;
        }[] | null;
      };
      address: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
    } | null;
  } | null;
  domainCustomInputs: {
    /** Average Price Paid In Last 30 Days */
    tinPrice?: number | undefined;
    /** Average Price Paid In Last 30 Days */
    zincPrice?: number | undefined;
    TipoCambio?: {
      TipoCambio?: number | undefined;
      FechaTipoCambio?: string | undefined;
    }[] | undefined;
    /** Average Price Paid In Last 30 Days */
    copperPrice?: number | undefined;
    /** Average Price Paid In Last 30 Days */
    nickelPrice?: number | undefined;
    /** Average Price Paid In Last 30 Days */
    silverPrice?: number | undefined;
    exchangeRateMXN?: string | undefined;
  };
  customerCustomInputs: {
    DatosCobranza?: {
      "DiasPago "?: ("2" | "3" | "4" | "5" | "6" | "0") | undefined;
      "D\u00EDas de revisi\u00F3n"?: ("2" | "3" | "4" | "5" | "6" | "0") | undefined;
      CuentasBancariasMexicanas?: {
        /** Cuenta CLABE */
        CuentaCLABE?: string | undefined;
        /** RFC Banco Mexicano */
        RFCBancoMexicano?: ("BNM840515VB1" | "BBM9702162P6" | "SME9407075LA" | "HMI950125KG8" | "BDJ921026JE3" | "BNA840519I67" | "SCO931211D78" | "BRC931207KS3" | "BAZ0707071R4" | "BVM970223GP8" | "CIB930125P99" | "INB951215U33" | "AIF920419QX1" | "IBO860103PD4" | "AEM930615HL1" | "BBA830831LJ2" | "BMF940506PP2" | "STP060210KH8") | undefined;
        /** Divisa Cuenta Mexicana */
        DivisaCuentaMexicana?: ("MXN" | "USD" | "EUR") | undefined;
      }[] | undefined;
      CuentasBancariasExtranjeras?: {
        /** IBAN */
        IBAN?: string | undefined;
        /** ABA / Routing Number */
        AbaRTN?: string | undefined;
        /** SWIFT / BIC */
        SwiftBIC?: string | undefined;
        /** Región del Banco */
        RegionBanco?: ("Estados Unidos (ABA/RTN)" | "Uni\u00F3n Europea (IBAN)" | "Resto del Mundo") | undefined;
        /** Banco Extranjero */
        BancoExtranjero?: string | undefined;
        /** Cuenta Extranjera */
        CuentaExtranjera?: string | undefined;
        /** Divisa Cuenta Extranjera */
        DivisaCuentaExtranjera?: ("USD" | "EUR") | undefined;
      }[] | undefined;
    } | undefined;
    DatosFiscales?: {
      RFC: string;
      Addenda?: ("Schneider" | "Sanmina") | undefined;
      UsoCFDI: "G01 - Adquisici\u00F3n de mercanc\u00EDas" | "G03 - Gastos en general" | "I01 - Construcciones" | "I02 - Mobiliario y equipo de oficina por inversiones" | "I08 - Otra maquinaria y equipo" | "S01 - Sin efectos fiscales";
      FormaPago: "01" | "02" | "03" | "04" | "29" | "99";
      MetodoPago: "PUE" | "PPD";
      TipoSociedad: "601" | "603" | "604" | "605" | "608" | "610" | "612" | "614" | "616" | "619" | "621" | "622" | "623" | "626" | "INC" | "CORP" | "LLC" | "LTD" | "LP" | "LLP" | "PC";
      RegimenFiscal: "601" | "603" | "605" | "606" | "608" | "612" | "616" | "621" | "626";
    } | undefined;
    DatosContables?: {
      DivisaMXN?: boolean;
      DivisaUSD?: boolean | undefined;
      CuentasContables?: {
        /** Cuenta Contable */
        CuentaContable?: string | undefined;
        /** Divisa Contable */
        DivisaContable?: ("MXN" | "USD") | undefined;
        /** Empresa Emisora */
        EmpresaEmisora?: ("ECO030618BR4" | "PRO800417TDA" | "EMO2104135V0") | undefined;
      }[] | undefined;
    } | undefined;
    DatosLogisticos?: {
      AceptaEnviosParciales?: boolean;
      NormasEmpaqueEmbarque?: string | undefined;
      ObligatorioPesarRecibo?: boolean;
      ObligatorioContarRecibo?: boolean;
    } | undefined;
    DatosComerciales?: {
      Categoria?: ("Industrial" | "Automotriz" | "Ambas") | undefined;
      CodigoIMMEX?: string | undefined;
      TipoCliente?: (" Nacional" | " Extranjero") | undefined;
      IDClienteIBMS?: {
        /** ID Cliente IBMS */
        IDClienteIBMS?: string | undefined;
        /** Divisa ID Cliente IBMS */
        DivisaIDClienteIBMS?: ("USD" | "MXN") | undefined;
        /** Empresa ID Cliente IBMS */
        EmpresaIDClienteIBMS?: ("Ecoplating Toluca" | "Proquipa" | "Ecoplating MTY") | undefined;
      }[] | undefined;
      CodigoProveedor?: string | undefined;
      EjecutivoCuenta?: ("Celeste Almanza" | "Jes\u00FAs \u00C1ngeles" | "Roberto Orozco" | "Sergio Hern\u00E1ndez" | "Anuhar Silva" | "H\u00E9ctor V\u00E1zquez" | "C\u00E9sar Michaus") | undefined;
      CodigoProveedorUSD?: string | undefined;
      PoliticaActualizacionPrecios?: ("Inflaci\u00F3n Anual" | "Ajuste Mensual" | "Ajuste Bimestral" | "Ajuste Trimestral") | undefined;
    } | undefined;
    NotasAdicionales?: string | undefined;
  };
  allLabels: {
    id: number;
    name: string;
  }[];
}

type Severity = 'warning' | 'error' | 'info' | 'success'
type ErrorMessage = string | { severity: Severity, message: string }

interface Helpers {
  log: (message: any) => void
  addErrorMessage: (message: ErrorMessage) => void
  addInformationalPrice: (value: { title: string, note?: string, price: number, category?: string }) => void
  addQuotePartPricingTier: (value: { title: string, quantity: number, price: number }) => void
  parseCSV: (value: string) => { data: any[][], errors: [], meta: any }
}