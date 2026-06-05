const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = { additionalPayload: {} };

  const ps = inputs.packingSlip;
  if (!ps || !Array.isArray(ps.items)) return result;

  // ──────────────────────────────────────────────────────────────
  // Config
  // ──────────────────────────────────────────────────────────────
  // El "PS" del cliente vive ANIDADO en el batch como
  // customInputs.DatosRecibo.PackingSlip (confirmado en scans 2026-05;
  // el mismo objeto DatosRecibo trae PesoCliente y numeroContenedores).
  // Fallbacks por si el schema cambia: PackingSlip plano, o key /^(ps|packingslip)$/i.
  const readPS = (ci: { [x: string]: any } | null | undefined): any => {
    if (!ci) return null;
    const dr = ci.DatosRecibo;
    if (dr && dr.PackingSlip != null && dr.PackingSlip !== "") return dr.PackingSlip;
    if (ci.PackingSlip != null && ci.PackingSlip !== "") return ci.PackingSlip;
    const hit = Object.keys(ci).find(k => /^(ps|packingslip)$/i.test(String(k).trim()));
    return (hit && ci[hit] !== "") ? ci[hit] : null;
  };

  // Fecha de embarque: ideal la que se coloca en el packing slip
  // (shippingDate); fallback shippedAt. NOTA: el Input NO expone un
  // createdAt del packing slip, así que el fallback disponible es shippedAt.
  const shippingDate = ps.shippingDate != null ? ps.shippingDate
    : (ps.shippedAt != null ? ps.shippedAt : null);
  const shippingDateSource = ps.shippingDate != null ? "shippingDate"
    : (ps.shippedAt != null ? "shippedAt" : null);

  // Empacador = usuario actual que genera el PDF/etiqueta. Es constante para
  // todo el embarque (no depende del contenedor), así que se calcula una vez.
  const packedBy = (inputs.currentUser && inputs.currentUser.name != null)
    ? inputs.currentUser.name : null;

  // Fecha de embarque ya formateada (d/m/Y H:i, 24 h) en la zona horaria del
  // Input. Se entrega lista para que la plantilla imprima `{shippingDateFmt}`
  // directo, SIN la función date() de Twig (que truena con "array given" al
  // recibir el binding del label). Constante para todo el embarque.
  const fmtDate = (iso: string | null, tz: string | null): string => {
    if (iso == null || iso === "") return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      const parts = new Intl.DateTimeFormat("es-MX", {
        timeZone: (tz != null && tz !== "") ? tz : "America/Mexico_City",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const get = (t: string): string => {
        const p = parts.find(x => x.type === t);
        return p ? p.value : "";
      };
      const hh = get("hour") === "24" ? "00" : get("hour"); // ICU a veces da 24
      return `${get("day")}/${get("month")}/${get("year")} ${hh}:${get("minute")}`;
    } catch (e) {
      // Fallback sin zona horaria: reformatea la parte de fecha/hora del ISO.
      const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "";
    }
  };
  const shippingDateFmt = fmtDate(shippingDate, inputs.timezone);

  // ──────────────────────────────────────────────────────────────
  // Paso 1: aplanar a filas de etiqueta (item × partTransferAccount × batch).
  // Cada `item` del packing slip es un contenedor/bulto físico.
  // ──────────────────────────────────────────────────────────────
  const rows: any[] = [];
  ps.items.forEach(item => {
    (item.partsTransferAccounts || []).forEach((part: any) => {
      const pn = part.partNumber;
      if (!pn || pn.id == null) return;
      const batches = (part.receivedBatches && part.receivedBatches.length)
        ? part.receivedBatches
        : [null];
      batches.forEach((batch: any) => {
        rows.push({ item, part, pn, batch });
      });
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Paso 2: "Contenedor x de y" — agrupar por PN + batch, contar
  // contenedores (items) distintos y ordenar por item.index.
  // Se preserva la mutación item.containerIndex que la plantilla de
  // remisión ya leía (compatibilidad hacia atrás).
  // ──────────────────────────────────────────────────────────────
  const groups: Record<string, any[]> = {};
  rows.forEach(r => {
    const batchKey = (r.batch && r.batch.id != null) ? r.batch.id : "nobatch";
    const key = `${r.pn.id}-${batchKey}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  Object.keys(groups).forEach(key => {
    const group = groups[key];
    group.sort((a, b) => (a.item.index || 0) - (b.item.index || 0));
    const total = group.length;
    group.forEach((r, idx) => {
      r.containerNum = idx + 1;
      r.containerTotal = total;
      (r.item as any).containerIndex = `${idx + 1}/${total}`;
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Paso 3: construir las etiquetas + diagnóstico.
  // ──────────────────────────────────────────────────────────────
  let missingPS = 0, missingName = 0, missingWeight = 0, multiPart = 0, missingSO = 0;

  const labels = rows.map(r => {
    const item = r.item, part = r.part, pn = r.pn, batch = r.batch;
    const weight = item.weight || null;

    // Nombre del contenedor: contenarización (rack) o agrupación de
    // partes (partGroup). El usuario confirmó que pueden usarse ambos,
    // así que se prioriza rack y se cae a partGroup.
    const rackName = (part.rack && part.rack.name) ? part.rack.name : null;
    const groupName = (part.partGroup && part.partGroup.name) ? part.partGroup.name : null;
    const containerName = rackName != null ? rackName : (groupName != null ? groupName : null);
    const containerNameSource = rackName != null ? "rack"
      : (groupName != null ? "partGroup" : null);

    // Unidad declarada en partGroup (aplica al peso del contenedor/tara).
    // El item.weight viene numérico sin unidad explícita en el Input.
    const containerWeightUnit = (part.partGroup && part.partGroup.containerWeightUnit && part.partGroup.containerWeightUnit.name)
      ? part.partGroup.containerWeightUnit.name : null;

    const psValue = readPS(batch ? batch.customInputs : null);

    // Orden de venta (received_order = OV en Steelhead) de la OT de esta parte.
    const receivedOrder = (part.workOrder && part.workOrder.receivedOrder)
      ? part.workOrder.receivedOrder : null;
    const salesOrder = (receivedOrder && receivedOrder.name != null) ? receivedOrder.name : null;
    const salesOrderId = (receivedOrder && receivedOrder.idInDomain != null) ? receivedOrder.idInDomain : null;

    // Diagnóstico
    if (psValue == null) missingPS++;
    if (containerName == null) missingName++;
    if (!weight || (weight.gross == null && weight.net == null)) missingWeight++;
    if ((item.partsTransferAccounts || []).length > 1) multiPart++;
    if (salesOrder == null && salesOrderId == null) missingSO++;

    const label: any = {
      // — Etiqueta base (8 campos) —
      partNumber: pn.name != null ? pn.name : null,
      description: pn.descriptionMarkdown != null ? pn.descriptionMarkdown : null,
      piecesPerContainer: item.partCount != null ? item.partCount
        : (part.partCount != null ? part.partCount : null),
      ps: psValue,
      batchName: (batch && batch.name != null) ? batch.name : null,
      workOrder: (part.workOrder && part.workOrder.name != null) ? part.workOrder.name : null,
      workOrderId: (part.workOrder && part.workOrder.idInDomain != null) ? part.workOrder.idInDomain : null,
      // — Orden de venta (received_order) de la OT de esta parte —
      salesOrder,
      salesOrderId,
      // — Empacador: usuario actual que genera la remisión/etiqueta —
      packedBy,
      shippingDate,
      shippingDateSource,
      shippingDateFmt,
      containerIndex: `${r.containerNum}/${r.containerTotal}`,
      containerNum: r.containerNum,
      containerTotal: r.containerTotal,

      // — Etiqueta 2 (extras): peso bruto/neto + nombre de contenedor —
      grossWeight: (weight && weight.gross != null) ? weight.gross : null,
      netWeight: (weight && weight.net != null) ? weight.net : null,
      tareWeight: (weight && weight.tare != null) ? weight.tare : null,
      containerWeightUnit,
      containerName,
      containerNameSource,
    };
    // Toda rama debe EXISTIR en el árbol de PDFGeneratorAPI aunque el dato
    // falte en todas las etiquetas de la muestra (ej. nombre de contenedor
    // antes de contenarizar): null/undefined → "" para que el campo siempre
    // tenga un nodo colocable en la plantilla.
    Object.keys(label).forEach(k => { if (label[k] == null) label[k] = ""; });
    return label;
  });

  result.additionalPayload = {
    labels,
    totalLabels: labels.length,
    shippingDate: shippingDate != null ? shippingDate : "",
    shippingDateSource: shippingDateSource != null ? shippingDateSource : "",
    shippingDateFmt,
    packedBy: packedBy != null ? packedBy : "",
  };

  helpers.log(
    `🏷️ ${labels.length} etiqueta(s)` +
    (packedBy != null ? ` · empacador: ${packedBy}` : ` · sin empacador`) + `. ` +
    `Sin PS: ${missingPS} · sin nombre contenedor: ${missingName} · ` +
    `sin peso: ${missingWeight} · sin OV: ${missingSO} · items multi-parte: ${multiPart}.`
  );

  if (missingSO > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: `⚠️ ${missingSO} etiqueta(s) sin orden de venta (la OT no trae receivedOrder).`,
    });
  }

  if (missingPS > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: `⚠️ ${missingPS} etiqueta(s) sin customInput "PS" en el batch — revisa la key (PS_KEYS) o captura el dato.`,
    });
  }
  if (missingName > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: `⚠️ ${missingName} etiqueta(s) sin nombre de contenedor (ni rack ni partGroup).`,
    });
  }
  if (multiPart > 0) {
    helpers.addErrorMessage({
      severity: "info",
      message: `ℹ️ ${multiPart} contenedor(es) con más de una parte: el peso bruto/neto es del bulto completo, no por parte.`,
    });
  }

  return result;
};

type LowCodeResult = {
  additionalPayload?: any;
};

interface Inputs {
  origin: string;
  signUrl: string;
  timezone: string;
  packingSlip: {
    idInDomain: number;
    shipVia: string | null;
    shippingDate: string | null;
    trackingNumber: string | null;
    signatureReceivedB64: string | null;
    signatureReceivedPrintedName: string | null;
    signatureReceivedSignedAt: string | null;
    signingKey: string;
    shippedAt: string;
    customerContact: {
      name: string | null;
      phone: string | null;
      email: string | null;
      address: string | null;
      isInvoiceContact: boolean | null;
      isShippingContact: boolean | null;
    } | null;
    customer: {
      domainId: number;
      idInDomain: number | null;
      name: string | null;
      shortName: string | null;
      avatarUrl: string | null;
    } & {
      defaultTerms: string | null;
      phoneNumber: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
    };
    domain: {
      id: number;
      logoUrl: string | null;
      name: string | null;
      address: string | null;
      contactPhone: string | null;
      contactEmail: string | null;
    };
    billToAddress: string;
    shipToAddress: string;
    shipToAddressDescription: string | null;
    dropShipToAddress: {
      customerName: string | null;
      address: string | null;
    };
    customInputs: {
      [x: string]: any;
    } | null;
    unit: {
      id: number;
      name: string;
    } | null;
    totalWeight: {
      gross: number;
      net: number;
    } | null;
    items: {
      id: number;
      index: number;
      partCount: number;
      comment: string | null;
      weight: {
        gross: number;
        tare: number;
        net: number;
      } | null;
      partsTransferAccounts: {
        id: number;
        partCount: number;
        partNumber: {
          id: number | null;
          name: string | null;
          descriptionMarkdown: string | null;
          customerFacingNotes: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
          treatments: {
            treatment: {
              name: string;
              treatmentGroup: {
                id: number;
                name: string;
              } | null;
              inventoryItems: {
                id: number;
                name: string;
                customInputs: {
                  [x: string]: any;
                } | null;
                descriptionMarkdown: string | null;
              }[];
            } | null;
            process: {
              name: string;
              id: number | null;
            } | null;
          }[];
          unitConversions: {
            unit: {
              id: number;
              name: string;
            };
            factor: number;
          }[];
          partNumberGroup: {
            id: number;
            name: string | null;
          } | null;
          specFieldParameters: {
            id: number | null;
            name: string | null;
            minimumValue: number | null;
            maximumValue: number | null;
            targetValue: number | null;
            samplingRate: number | null;
            sampleCount: number | null;
            sampleSet: {
              id: number;
              name: string;
              sampleRanges: {
                id: number;
                minBatchCount: number;
                maxBatchCount: number | null;
                sampleCount: number | null;
                samplingRate: number | null;
              }[];
            } | null;
            specField: {
              id: number | null;
              name: string | null;
              spec: {
                id: number | null;
                revisionNumber: number;
                name: string | null;
                revisionName: string | null;
                externalDescription: string | null;
                type: string | null;
                customInputs: {
                  [x: string]: any;
                } | null;
              } | null;
            } | null;
          }[] | null;
        };
        location: {
          id: number;
          path: string;
        } | null;
        materialConversion: {
          id: number;
          assembly: {
            id: number;
            idInDomain: number | null;
            castComponents: {
              id: number;
              idInDomain: number | null;
            }[];
          } | null;
        } | null;
        rack?: ({
          name?: (string | null) | undefined;
          id?: (number | undefined) | null;
          rackType: {
            isContainer?: (boolean | undefined) | null;
            name?: (string | undefined) | null;
          };
        } | undefined) | null;
        partGroup: ({
          id: number | null;
          name: string | null;
          labels: {
            name: string | null;
            color: string | null;
          }[];
          containerWeight: number | null;
          containerWeightUnit: {
            id: number | null;
            name: string | null;
            mustBeInteger: boolean | null;
          } | null;
        } | null) | null;
        workOrder: {
          idInDomain: number | null;
          name: string | null;
          recipeName: string | null;
          recipe: {
            name: string | null;
            description: string | null;
          };
          deadline: string | null;
          labels: {
            name: string | null;
            color: string | null;
          }[];
          customInputs: {
            [x: string]: any;
          } | null;
          receivedOrder: {
            idInDomain: number | null;
            name: string | null;
            createdAt: string | null;
            customInputs: {
              [x: string]: any;
            } | null;
            invoiceTerms: {
              id: number;
              terms: string;
            } | null;
            receivedOrderLines: {
              id: number;
              name: string | null;
              receivedOrderLineItems: {
                id: number;
                price: number | null;
                quantity: number | null;
                unit: {
                  id: number;
                  name: string;
                } | null;
                receivedOrderLineItemPartTransforms: {
                  receivedOrderPartTransform: {
                    id: number;
                    partNumber: {
                      id: number;
                      name: string;
                    };
                    count: number | null;
                  } | null;
                }[];
              }[];
            }[];
          };
          treatments: {
            treatment: {
              name: string;
              isOverride: boolean;
            } | null;
            process: {
              name: string;
            } | null;
          }[];
          treatmentDisplays: {
            treatment: {
              name: string;
              isOverride: boolean;
            } | null;
            process: {
              name: string;
            } | null;
          }[];
        };
        qualityHold: {
          id: number;
          descriptionMarkdown: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
          markForScrap: boolean | null;
        } | null;
        returnMerchandiseAuthorization: {
          id: number;
          name: string | null;
          idInDomain: number | null;
          customInputs: {
            [x: string]: any;
          } | null;
        } | null;
        nonConformanceReport: {
          id: number;
          name: string | null;
          idInDomain: number | null;
          customInputs: {
            [x: string]: any;
          } | null;
        } | null;
        partNumberWorkOrder: {
          partGroup: {
            id: number;
            name: string;
          } | null;
          billablePartCount: number;
          completedPartCount: number;
          shippedPartCount: number;
          shippedFinalizedPartCount: number;
          descriptionMarkdown: string | null;
        } | null;
        quote: {
          quoteId: number | null;
          partNumbers: {
            partNumber: {
              id: number;
              name: string;
              description: string | null;
              partNumberGroup: {
                id: number;
                name: string | null;
              } | null;
            } | null;
            description: string | null;
          }[];
        };
        receivedBatches: {
          id: number;
          name: string | null;
          descriptionMarkdown: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
          partNumberOnBatch: {
            id: number;
            name: string;
          } | null;
        }[];
      }[];
    }[];
    images: {
      url: string;
    }[];
    receivedOrdersIncluded: {
      idInDomain: number;
      name: string | null;
      workOrders: {
        idInDomain: number;
        name: string | null;
      }[];
    }[];
  };
  currentUser: {
    id: number;
    name: string | null;
    avatarUrl: string | null;
  } & {
    signatureBase64: string;
  };
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
