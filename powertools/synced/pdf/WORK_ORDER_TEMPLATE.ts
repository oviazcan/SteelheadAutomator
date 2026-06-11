const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = {};

  const nf1 = new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const fmtDate = (s: string | null | undefined): string | null => {
    if (!s) return null;
    try {
      return new Date(s).toLocaleDateString("en-GB");
    } catch (e) {
      return null;
    }
  };
  const names = (arr: any[] | null | undefined): string[] =>
    (arr ?? []).map((x) => x && x.name).filter(Boolean);

  try {
    // ── 1. Encabezado de la Orden de Trabajo ──────────────────────────────
    const workOrderInfo = {
      id: inputs.idInDomain ?? null,
      name: inputs.name || null,
      createdAt: fmtDate(inputs.createdAt),
      deadline: fmtDate(inputs.deadline),
      notes: inputs.notes ?? null,
      customInputs: inputs.customInputs ?? null,
      labels: (inputs.labels ?? []).map((l) => ({
        name: l?.name ?? null,
        color: l?.color ?? null,
      })),
      origin: inputs.origin ?? null,
      timezone: inputs.timezone ?? null,
    };

    // ── 2. Orden de venta (encabezado comercial) ──────────────────────────
    const ro = inputs.receivedOrder;
    const order = ro
      ? {
          id: ro.id ?? null,
          name: ro.name ?? null,
          idInDomain: ro.idInDomain ?? null,
          invoiceTerms: ro.invoiceTerms ?? null,
          createdAt: fmtDate(ro.createdAt),
          customInputs: ro.customInputs ?? null,
        }
      : null;

    // ── 3. Cliente (incluye facturación) ──────────────────────────────────
    const c = inputs.customer;
    const customer = c
      ? {
          name: c.name ?? null,
          shortName: c.shortName ?? null,
          idInDomain: c.idInDomain ?? null,
          addresses: (c.addresses ?? []).map((a) => a?.address).filter(Boolean),
          invoiceTerms: c.invoiceTermByDefaultInvoiceTermsId
            ? {
                terms: c.invoiceTermByDefaultInvoiceTermsId.terms ?? null,
                days: c.invoiceTermByDefaultInvoiceTermsId.days ?? null,
              }
            : null,
          salesTaxable: c.salesTaxable ?? null,
          customInputs: c.customInputs ?? null,
        }
      : null;

    // ── 4. Dominio (membrete) ─────────────────────────────────────────────
    const d = inputs.domain;
    const domain = d
      ? {
          name: d.name ?? null,
          address: d.address ?? null,
          phone: d.contactPhone ?? null,
          email: d.contactEmail ?? null,
          logoUrl: d.logoUrl ?? null,
          customInputs: d.customInputs ?? null,
        }
      : null;

    // ── 5. Receta / proceso seleccionado ──────────────────────────────────
    const recipe = inputs.recipe
      ? {
          name: inputs.recipe.name ?? null,
          selectedProcess: inputs.recipe.selectedProcess?.name ?? null,
          selectedProcessId: inputs.recipe.selectedProcess?.id ?? null,
        }
      : null;

    // ── 6. Usuario que genera + firma ─────────────────────────────────────
    const currentUser = inputs.currentUser
      ? {
          name: inputs.currentUser.name ?? null,
          signatureBase64: inputs.currentUser.signatureBase64 ?? null,
        }
      : null;

    // ── 7. Archivos adjuntos de la OT ─────────────────────────────────────
    const workOrderFiles = (inputs.workOrderFiles ?? []).map((f) => ({
      name: f.name,
      url: f.url,
    }));

    // ── 8. Partes (TODAS las de la OT) ────────────────────────────────────
    const UNIT_IDS = [3969, 3972, 5150, 4907]; // KGM, CMK, LM, otra (dominio TLC)
    let totalPieces = 0;
    let grandTotal = 0;
    const processSet = new Set<string>();
    const parts = (inputs.parts ?? []).map((p) => {
      const part = p.part;
      const count = p.count ?? 0;
      totalPieces += count;
      const price = p.unitPriceDollars;
      const lineTotal = price != null ? count * price : null;
      if (lineTotal != null) grandTotal += lineTotal;

      const uconv = part?.unitConversions ?? [];
      const convertedQuantities = uconv
        .filter(
          (u) =>
            u && u.unit && u.factor != null && UNIT_IDS.indexOf(u.unit.id) !== -1
        )
        .map((u) => `${nf1.format(count * u.factor)}: ${u.unit.name}`);

      const treatments = (p.treatments ?? []).map((t) => {
        const tn = t.treatment?.name ?? null;
        const proc = t.process?.name ?? null;
        if (proc) processSet.add(proc);
        else if (tn) processSet.add(tn);
        return {
          treatment: tn,
          treatmentGroup: t.treatment?.treatmentGroup?.name ?? null,
          process: proc,
          inventoryItems: names(t.treatment?.inventoryItems),
        };
      });

      return {
        index: p.index ?? null,
        name: part?.name ?? null,
        id: part?.id ?? null,
        description: part?.descriptionMarkdown ?? null,
        customInputs: part?.customInputs ?? null,
        imageUrl: part?.displayImageUrl ?? null,
        group: part?.partNumberGroup?.name ?? null,
        count,
        unitPriceDollars: price ?? null,
        lineTotal,
        convertedQuantities,
        files: (part?.partNumberFiles ?? []).map((f) => ({
          name: f.name,
          url: f.url,
        })),
        partGroup: p.partGroup
          ? {
              name: p.partGroup.name ?? null,
              labels: (p.partGroup.labels ?? []).map((l) => ({
                name: l?.name ?? null,
                color: l?.color ?? null,
              })),
              containerWeight: p.partGroup.containerWeight ?? null,
              containerWeightUnit: p.partGroup.containerWeightUnit?.name ?? null,
            }
          : null,
        treatments,
        specs: (p.specs ?? []).map((s) => ({
          name: s.name ?? null,
          customInputs: s.customInputs ?? null,
        })),
        partDescription: p.descriptionMarkdown ?? null,
      };
    });

    // ── 9. Totales / resumen de la OT ─────────────────────────────────────
    const totals = {
      partCount: parts.length,
      totalPieces,
      grandTotal,
      processes: Array.from(processSet),
    };

    result.additionalPayload = {
      variant: "work_order",
      scope: "WORK_ORDER",
      workOrderInfo,
      order,
      customer,
      domain,
      recipe,
      currentUser,
      workOrderFiles,
      parts,
      totals,
    };

    helpers.log(
      `✅ Orden de Trabajo ${workOrderInfo.id ?? "?"} — ${parts.length} parte(s), ` +
        `${totalPieces} pza(s), ${totals.processes.length} proceso(s).`
    );
  } catch (err) {
    helpers.addErrorMessage({
      severity: "error",
      message: `❌ Error generando payload de orden de trabajo: ${err}`,
    });
  }

  return result;
};

type LowCodeResult = {
    additionalPayload?: any;
};

interface Inputs {
    receivedOrder: {
        id: number | null;
        name: string | null;
        idInDomain: number | null;
        customInputs: {
            [x: string]: any;
        } | null;
        invoiceTerms: string | null;
        createdAt: string | null;
    };
    idInDomain: number | null;
    domain: {
        id: number;
        logoUrl: string | null;
        name: string | null;
        address: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
        customInputs: {
            [x: string]: any;
        } | null;
    } | null;
    name: string;
    createdAt: string | null;
    customInputs: {
        [x: string]: any;
    } | null;
    deadline: string | null;
    notes: string | null;
    workOrderFiles: {
        name: string;
        url: string;
    }[];
    customer: ({
        domainId: number;
        idInDomain: number | null;
        name: string | null;
        shortName: string | null;
        avatarUrl: string | null;
    } & {
        defaultBillToAddressId: number | null;
        defaultShipToAddressId: number | null;
        addresses: {
            id: number;
            address: string | null;
        }[] | null;
        invoiceTermByDefaultInvoiceTermsId: {
            id: number;
            terms: string;
            days: number | null;
        } | null;
        salesTaxable: boolean | null;
        customInputs: {
            [x: string]: any;
        } | null;
    }) | null;
    recipe: {
        name: string;
        selectedProcess: {
            name: string | null;
            id: number | null;
        } | null;
    } | null;
    parts: {
        index: number;
        part: {
            id: number;
            name: string;
            descriptionMarkdown: string | null;
            customInputs: {
                [x: string]: any;
            } | null;
            displayImageUrl: string | null;
            partNumberFiles: {
                name: string;
                url: string;
            }[];
            unitConversions: {
                unit: {
                    id: number | null;
                    name: string | null;
                };
                factor: number | null;
            }[];
            partNumberGroup: {
                id: number;
                name: string | null;
            } | null;
            receivedOrderLineItems: {
                id: number;
            }[];
        };
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
        count: number;
        unitPriceDollars: number | null;
        treatments: {
            treatment: {
                name: string;
                treatmentGroupCustomInputs: {
                    [x: string]: any;
                } | null;
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
        specs: {
            name: string;
            customInputs: {
                [x: string]: any;
            } | null;
        }[] | null;
        descriptionMarkdown: string | null;
    }[];
    currentUser: {
        id: number;
        name: string | null;
        avatarUrl: string | null;
    } & {
        signatureBase64: string | null;
    };
    origin: string;
    labels: {
        name: string | null;
        color: string | null;
    }[];
    timezone: string;
}

type Severity = 'warning' | 'error' | 'info' | 'success'
type ErrorMessage = string | { severity: Severity, message: string }

interface Helpers {
    log: (message: any) => void
    addErrorMessage: (message: ErrorMessage) => void
    addInformationalPrice: (value: { title: string, note?: string, price: number, category?: string }) => void
    addQuotePartPricingTier: (value: { title: string, quantity: number, price: number}) => void
    parseCSV: (value: string) => {data: any[][], errors: [], meta: any}

}
