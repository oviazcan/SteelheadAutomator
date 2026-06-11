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
    const pn = inputs.partNumber;
    const wo = inputs.workOrder;
    const ro = inputs.receivedOrder;
    const sel = inputs.selectedPartsTransferAccount;
    const pnwo = inputs.partNumberWorkOrder;

    // ── 1. Encabezado de la Orden de Trabajo ──────────────────────────────
    const workOrderInfo = {
      name: wo?.name ?? null,
      id: wo?.idInDomain ?? null,
      domainId: wo?.domainId ?? null,
      jobNumber: ro?.jobNumber ?? null,
      orderName: ro?.name ?? null,
      orderId: ro?.idInDomain ?? null,
      customerName: wo?.customer?.name ?? inputs.customer?.name ?? null,
      customerShortName: wo?.customer?.shortName ?? null,
      customerIdInDomain: wo?.customer?.idInDomain ?? null,
      deadline: fmtDate(wo?.deadline),
      createdAt: fmtDate(wo?.createdAt),
      notes: wo?.descriptionMarkdown ?? null,
      orderNotes: ro?.notesMarkdown ?? null,
      labels: (wo?.labels ?? []).map((l) => ({
        name: l?.name ?? null,
        color: l?.color ?? null,
      })),
      customInputs: wo?.customInputs ?? null,
      orderCustomInputs: ro?.customInputs ?? null,
    };

    // ── 2. Parte + material base ──────────────────────────────────────────
    const mat = pn?.partNumberInventoryItem?.material;
    const partInfo = {
      name: pn?.name ?? null,
      id: pn?.id ?? null,
      description: pn?.descriptionMarkdown ?? null,
      customerFacingNotes: pn?.customerFacingNotes ?? null,
      group: pn?.partNumberGroup?.name ?? null,
      imageUrl: pn?.displayImageUrl ?? null,
      customInputs: pn?.customInputs ?? null,
      material: mat
        ? {
            alloy: mat.alloy?.name ?? null,
            substrate: mat.substrate?.name ?? null,
            temper: mat.temper?.name ?? null,
          }
        : null,
      owners: (pn?.owners ?? []).map((o) => ({
        name: o?.name ?? null,
        color: o?.color ?? null,
      })),
      locations: (pn?.locations ?? []).map((l) => l?.path).filter(Boolean),
    };

    // ── Helpers de specs (reusados para PN y para todas las partes) ───────
    const mapFields = (fields: any[] | null | undefined) =>
      (fields ?? []).map((f) => ({
        name: f.name ?? null,
        paramName: f.paramName ?? null,
        description: f.description ?? null,
        type: f.type ?? null,
        specFieldType: f.specFieldType ?? null,
        min: f.minimumValue ?? null,
        max: f.maximumValue ?? null,
        target: f.targetValue ?? null,
        unit: f.unit ?? null,
        sensorUnit: f.sensorUnit ?? null,
        processNode: f.processNode?.name ?? null,
        sampleSet: f.sampleSet?.name ?? null,
      }));
    const mapSpec = (s: any) => ({
      name: s.name ?? null,
      type: s.type ?? null,
      revisionName: s.revisionName ?? null,
      revisionNumber: s.revisionNumber ?? null,
      descriptionMarkdown: s.descriptionMarkdown ?? null,
      descriptionExternal: s.descriptionExternal ?? null,
      fromPartNumber: s.fromPartNumber ?? null,
      labels: names(s.labels),
      classificationSet: s.classificationSet
        ? {
            string: s.classificationSet.classificationsInSetString ?? null,
            classifications: (
              s.classificationSet.classificationSetClassifications ?? []
            )
              .map((c: any) => c.classification?.name)
              .filter(Boolean),
          }
        : null,
      fields: mapFields(s.fields),
    });

    // ── 3. Specs completas del PN ─────────────────────────────────────────
    const partSpecs = (pn?.specs ?? []).map(mapSpec);

    // ── 4. Cantidades CONSOLIDADAS (sin multiplicar por contenedor) ───────
    const qty =
      inputs.partQty ?? inputs.selectedPartsTransferAccount?.quantity ?? 0;
    const unitConversions = pn?.unitConversions ?? [];
    const convertedQuantities = unitConversions
      .filter(
        (u) =>
          u &&
          u.unit &&
          u.factor != null &&
          (u.unit.id === 3969 ||
            u.unit.id === 3972 ||
            u.unit.id === 5150 ||
            u.unit.id === 4907)
      )
      .map((u) => `${nf1.format(qty * u.factor)}: ${u.unit.name}`);
    const factorOf = (name: string): number | null =>
      unitConversions.find((u) => u?.unit?.name === name && u.factor != null)
        ?.factor ?? null;
    const kg = factorOf("KGM");
    const cmk = factorOf("CMK");
    const lm = factorOf("LM");
    const quantities = {
      partQty: qty,
      partQtyInGroup: inputs.partQtyInGroup ?? null,
      convertedQuantities,
      weightKg: kg != null ? qty * kg : null,
      areaCmk: cmk != null ? qty * cmk : null,
      lengthLm: lm != null ? qty * lm : null,
      allConversions: unitConversions.map((u) => ({
        unit: u?.unit?.name ?? null,
        factor: u?.factor ?? null,
      })),
    };

    // ── 5. Progreso de la OT + tara / ubicación ───────────────────────────
    const progress = pnwo
      ? {
          billable: pnwo.billablePartCount ?? null,
          completed: pnwo.completedPartCount ?? null,
          shipped: pnwo.shippedPartCount ?? null,
          shippedFinalized: pnwo.shippedFinalizedPartCount ?? null,
          description: pnwo.descriptionMarkdown ?? null,
          partGroup: pnwo.partGroup?.name ?? null,
          accounts: (pnwo.currentPartsTransferAccounts ?? []).map((a) => ({
            group: a.partGroup?.name ?? null,
            location: a.location?.path ?? null,
            measurement: a.measurement?.measurement ?? null,
            tare: a.measurement?.tare ?? null,
            unit: a.measurement?.unit?.name ?? null,
          })),
        }
      : null;

    // ── 6. Lotes recibidos (con fecha de recibo REAL) ─────────────────────
    const lotes = (inputs.receivedBatches ?? []).map((b) => {
      const r = (b.receivers ?? [])[0];
      const ncRaw = b.customInputs?.DatosRecibo?.numeroContenedores;
      const nc = parseInt(ncRaw, 10);
      return {
        name: b.name ?? null,
        description: b.descriptionMarkdown ?? null,
        receivedDate: fmtDate(r?.receivedDate),
        receiverIdInDomain: r?.idInDomain ?? null,
        numeroContenedores: Number.isNaN(nc) ? null : nc,
        createdAt: fmtDate(b.createdAt),
        createdBy: b.createdBy?.name ?? null,
        customInputs: b.customInputs ?? null,
      };
    });

    // ── 7. Receta paso a paso — el núcleo "VERBOSE" ───────────────────────
    const recipe = {
      name: wo?.recipe?.name ?? inputs.recipe?.name ?? null,
      nodes: (wo?.recipe?.nodes ?? []).map((n) => ({
        name: n.name ?? null,
        treatment: n.treatment?.name ?? null,
        treatmentGroup: n.treatment?.treatmentGroup?.name ?? null,
        instructions: n.instructions ?? null,
        partNumberInstructions: n.partNumberInstructions ?? null,
        station: n.defaultStation?.name ?? null,
        leadTime: n.leadTimeSum ?? null,
        autoComplete: n.isAutoComplete ?? null,
        recipeInd: n.recipeInd ?? null,
        inventoryItems: names(n.treatment?.inventoryItems),
        files: [
          ...(n.recipeNodeFiles ?? []),
          ...(n.partNumberRecipeNodeFiles ?? []),
        ].map((f) => ({ name: f.name, url: f.url })),
      })),
    };

    // ── 8. Tratamientos con químicos + parámetros ─────────────────────────
    const treatmentsDetail = (inputs.treatmentsWithDetails ?? []).map((t) => ({
      name: t.name ?? null,
      group: t.treatmentGroup?.name ?? null,
      processNode: t.recipeNode?.processNode?.name ?? null,
      chemicals: (t.inventoryItems ?? []).map((ii) => ({
        name: ii.name ?? null,
        description: ii.descriptionMarkdown ?? null,
        params: (ii.inventoryItemSpecs ?? []).flatMap((s) =>
          (s.specFieldParams ?? []).map((p) => ({
            field: p.specField?.name ?? p.name ?? null,
            min: p.minimumValueAsString ?? p.minimumValue ?? null,
            max: p.maximumValueAsString ?? p.maximumValue ?? null,
            target: p.targetValueAsString ?? p.targetValue ?? null,
            unit: p.unit?.name ?? null,
          }))
        ),
      })),
    }));
    const treatmentsList = inputs.treatments ?? [];
    const treatmentOverrides = inputs.treatmentOverrides ?? [];

    // ── 9. Specs externas del PN (mismo criterio que el jobtag) ───────────
    const allExternalSpecs = (pn?.specs ?? []).filter(
      (s) => s.type === "EXTERNAL"
    );
    const allSpecNames = [
      ...new Set(allExternalSpecs.map((s) => s.name).filter(Boolean)),
    ];
    const fieldGroups: Record<string, Set<string>> = {};
    for (const spec of allExternalSpecs) {
      for (const field of spec.fields ?? []) {
        if (
          field.paramName === "Sí o No" ||
          field.paramName === "Cumple o No Cumple"
        )
          continue;
        const fieldName = (field.name ?? "").trim();
        const paramValue = (field.paramName ?? "").trim();
        if (!fieldName) continue;
        if (
          fieldName.includes("Primeras Piezas") ||
          fieldName.includes("Diagonal") ||
          fieldName.includes("Instrumento")
        )
          continue;
        if (!fieldGroups[fieldName]) fieldGroups[fieldName] = new Set();
        if (paramValue) fieldGroups[fieldName].add(paramValue);
      }
    }
    const externalSpecs = {
      specNames: allSpecNames,
      fieldGroups: Object.fromEntries(
        Object.entries(fieldGroups).map(([k, v]) => [k, Array.from(v)])
      ),
    };

    // ── 10. Precios / productos de la cotización ──────────────────────────
    const pricing = (ro?.quote?.partNumbers ?? []).map((p) => ({
      description: p.description ?? null,
      quoteTreatments: (p.quoteTreatments ?? []).map(
        (qt) => qt.customInputs ?? null
      ),
      products: (p.partProducts ?? []).map((pp) => ({
        product: pp.product?.name ?? null,
        accountingProduct: pp.accountingProduct?.name ?? null,
        priceName: pp.priceName ?? null,
        quantity: pp.quantity ?? null,
        workOrderPartQuantity: pp.workOrderPartQuantity ?? null,
        valueUnits: pp.valueUnits ?? null,
        rateUnits: pp.rateUnits ?? null,
        description: pp.description ?? null,
      })),
    }));

    // ── 11. Rack / contenedores ───────────────────────────────────────────
    const containers = {
      currentRack: sel?.rack
        ? { name: sel.rack.name ?? null, type: sel.rack.rackType?.name ?? null }
        : null,
      productionBatch: sel?.productionBatch
        ? {
            name: sel.productionBatch.name ?? null,
            idInDomain: sel.productionBatch.idInDomain ?? null,
          }
        : null,
      rackTypes: (pn?.rackTypes ?? []).map((rt) => ({
        type: rt.rackType?.name ?? null,
        partsPerRack: rt.partsPerRack ?? rt.rackType?.partsPerRackDefault ?? null,
        racks: names(rt.associatedRacks),
      })),
      partGroup: inputs.partGroup
        ? {
            name: inputs.partGroup.name ?? null,
            labels: (inputs.partGroup.labels ?? []).map((l) => ({
              name: l?.name ?? null,
              color: l?.color ?? null,
            })),
            containerWeight: inputs.partGroup.containerWeight ?? null,
            containerWeightUnit:
              inputs.partGroup.containerWeightUnit?.name ?? null,
          }
        : null,
    };

    // ── 12. Embarque / direcciones ────────────────────────────────────────
    const shipping = {
      shipVia: ro?.shipVia ?? null,
      shipToAddress: ro?.shipToAddress ?? null,
      shipToAddressObject: ro?.shipToAddressObject
        ? {
            address: ro.shipToAddressObject.address ?? null,
            customer: ro.shipToAddressObject.customer?.name ?? null,
          }
        : null,
    };

    // ── 13. Cliente / dominio (membrete) ──────────────────────────────────
    const customer = inputs.customer
      ? {
          name: inputs.customer.name ?? null,
          phone: inputs.customer.phone ?? null,
          email: inputs.customer.email ?? null,
          customInputs: inputs.customer.customInputs ?? null,
        }
      : null;
    const domain = inputs.domain
      ? {
          name: inputs.domain.name ?? null,
          address: inputs.domain.address ?? null,
          phone: inputs.domain.contactPhone ?? null,
          email: inputs.domain.contactEmail ?? null,
          logoUrl: inputs.domain.logoUrl ?? null,
          customInputs: inputs.domain.customInputs ?? null,
        }
      : null;

    // ── 14. Cotización del PTA seleccionado + retrabajos ──────────────────
    const selQuote = sel?.quote
      ? {
          notes: sel.quote.notesMarkdown ?? null,
          internalNotes: sel.quote.internalNotesMarkdown ?? null,
          customInputs: sel.quote.customInputs ?? null,
        }
      : null;
    const upstreamRework = names(sel?.upstreamReworkCategories);

    // ── 15. Retenciones de calidad (seleccionado + todas las partes) ──────
    const qualityHolds: any[] = [];
    const selQh = inputs.selectedPartsTransferAccount?.qualityHold;
    if (selQh) {
      qualityHolds.push({
        source: "selected",
        id: selQh.idInDomain ?? selQh.id,
        description: selQh.descriptionMarkdown ?? null,
        scrap: selQh.markForScrap ?? null,
        createdAt: fmtDate(selQh.createdAt),
        createdBy: selQh.createdBy?.name ?? null,
      });
    }

    // ── 16. Todas las partes de la OT (contexto completo) ─────────────────
    const allParts = (inputs.allPartsOnWorkOrder ?? []).map((p) => {
      if (p.qualityHold) {
        qualityHolds.push({
          source: "part",
          part: p.partNumber?.name ?? null,
          id: p.qualityHold.idInDomain ?? p.qualityHold.id,
          description: p.qualityHold.descriptionMarkdown ?? null,
          scrap: p.qualityHold.markForScrap ?? null,
        });
      }
      return {
        partName: p.partNumber?.name ?? null,
        partId: p.partNumber?.id ?? null,
        description: p.partNumber?.description ?? null,
        quantity: p.quantity ?? null,
        receivedBatch: p.receivedBatch?.name ?? null,
        partGroup: p.partGroup?.name ?? null,
        woDescription: p.partNumberWorkOrder?.description ?? null,
        specs: (p.partNumber?.specs ?? []).map(mapSpec),
      };
    });

    // ── Payload final: UN solo objeto (no array por contenedor) ───────────
    result.additionalPayload = {
      variant: "verbose",
      scope: "WORK_ORDER",
      workOrderInfo,
      partInfo,
      partSpecs,
      quantities,
      progress,
      lotes,
      recipe,
      treatmentsDetail,
      treatmentsList,
      treatmentOverrides,
      externalSpecs,
      pricing,
      containers,
      shipping,
      customer,
      domain,
      selQuote,
      upstreamRework,
      qualityHolds,
      allParts,
      currentUser: inputs.currentUser?.name ?? null,
      logoUrl: inputs.logoUrl ?? null,
      origin: inputs.origin ?? null,
      timezone: inputs.timezone ?? null,
    };

    helpers.log(
      `✅ Verbose OT ${workOrderInfo.id ?? "?"} — ${recipe.nodes.length} paso(s), ` +
        `${treatmentsDetail.length} tratamiento(s), ${partSpecs.length} spec(s), ` +
        `${allParts.length} parte(s), ${lotes.length} lote(s), ${pricing.length} cotización(es).`
    );
  } catch (err) {
    helpers.addErrorMessage({
      severity: "error",
      message: `❌ Error generando payload verbose: ${err}`,
    });
  }

  return result;
};

type LowCodeResult = {
    additionalPayload?: any;
};

interface Inputs {
    partNumber: {
        id: number | null;
        name: string | null;
        descriptionMarkdown: string | null;
        customerFacingNotes: string | null;
        customInputs: {
            [x: string]: any;
        } | null;
        partNumberInventoryItem: {
            id: number;
            material: {
                id: number;
                alloy: {
                    id: number;
                    name: string;
                } | null;
                substrate: {
                    id: number;
                    name: string;
                } | null;
                temper: {
                    id: number;
                    name: string;
                } | null;
            } | null;
        } | null;
        displayImageUrl: string | null;
        rackTypes: {
            rackType: {
                id: number;
                name: string;
                partsPerRackDefault: number | null;
            } | null;
            partsPerRack: number;
            associatedRacks: {
                id: number;
                name: string;
            }[];
        }[] | null;
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
        specs: {
            name: string;
            id: number | null;
            revisionName: string | null;
            revisionNumber: number;
            type: string;
            customInputs: {
                [x: string]: any;
            } | null;
            descriptionMarkdown: string | null;
            descriptionExternal: string | null;
            fromPartNumber: boolean | null;
            treatmentId: number | null;
            classificationSet: {
                id: number;
                classificationsInSetString: string;
                classificationSetClassifications: {
                    id: number;
                    classification: {
                        id: number;
                        name: string;
                    } | null;
                }[];
            } | null;
            labels: {
                name: string;
            }[] | null;
            fields: {
                id: number;
                name: string;
                paramName: string;
                description: string | null;
                type: string;
                specFieldType: string;
                minimumValue: number | null;
                maximumValue: number | null;
                targetValue: number | null;
                unit: string | null;
                sensorUnit: string | null;
                samplingIntervalMinutes: number | null;
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
                recipeInd: number | null;
                processNode: {
                    id: number | null;
                    name: string | null;
                } | null;
            }[];
        }[];
        owners: {
            id: number;
            name: string;
            color: string;
            avatarUrl: string | null;
        }[];
        locations: {
            id: number;
            path: string;
        }[];
    } | null;
    selectedPartsTransferAccount: {
        id: number;
        quantity: number;
        rack: {
            id: number;
            name: string;
            rackType: {
                id: number;
                name: string;
            } | null;
        } | null;
        productionBatch: {
            id: number;
            idInDomain: number | null;
            name: string | null;
            descriptionMarkdown: string | null;
        } | null;
        quote: {
            id: number;
            customInputs: {
                [x: string]: any;
            } | null;
            notesMarkdown: string | null;
            internalNotesMarkdown: string | null;
        } | null;
        qualityHold: {
            id: number;
            idInDomain: number | null;
            descriptionMarkdown: string | null;
            markForScrap: boolean | null;
            createdAt: string;
            createdBy: {
                id: number;
                name: string | null;
                avatarUrl: string | null;
            };
            customInputs: {
                [x: string]: any;
            } | null;
        } | null;
        upstreamReworkCategories: {
            id: number;
            name: string;
        }[];
    } | null;
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
    receivedBatches: {
        id: number;
        name: string | null;
        descriptionMarkdown: string | null;
        createdAt: string;
        receivers: {
            receivedDate: string | null;
            customInputs: {
                [x: string]: any;
            } | null;
            idInDomain: number;
        }[];
        createdBy: {
            id: number;
            name: string | null;
            avatarUrl: string | null;
        };
        customInputs: {
            [x: string]: any;
        } | null;
    }[];
    partQty: number;
    partQtyInGroup: number;
    treatments: string[];
    treatmentOverrides: string[];
    treatmentsWithDetails: {
        id: number;
        name: string;
        treatmentGroupId: number | null;
        treatmentGroup: {
            id: number;
            name: string;
        } | null;
        inventoryItems: {
            id: number | null;
            name: string | null;
            customInputs: {
                [x: string]: any;
            } | null;
            descriptionMarkdown: string | null;
            inventoryItemSpecs: {
                id: number;
                name: string;
                specFieldParams: {
                    id: number;
                    name: string;
                    minimumValue: number | null;
                    maximumValue: number | null;
                    targetValue: number | null;
                    minimumValueAsString: string | null;
                    maximumValueAsString: string | null;
                    targetValueAsString: string | null;
                    unit: {
                        id: number | null;
                        name: string | null;
                    } | null;
                    specField: {
                        id: number;
                        name: string;
                        type: string;
                    };
                }[];
            }[];
        }[];
        recipeNode: {
            id: number;
            name: string;
            processNode: {
                id: number;
                name: string;
            } | null;
        };
    }[];
    receivedOrder: {
        name: string | null;
        idInDomain: number | null;
        jobNumber: string | null;
        shipVia: string | null;
        notesMarkdown: string | null;
        createdAt: string | null;
        quote: {
            partNumbers: {
                description: string | null;
                quoteTreatments: {
                    customInputs: {
                        [x: string]: any;
                    } | null;
                }[];
                partProducts: {
                    workOrderPartQuantity: number | null;
                    priceName: string | null;
                    quantity: number;
                    valueUnits: string | null;
                    rateUnits: string | null;
                    description: string | null;
                    product: {
                        name: string | null;
                    } | null;
                    accountingProduct: {
                        name: string | null;
                    } | null;
                }[];
            }[];
        } | null;
        shipToAddress: string | null;
        shipToAddressObject: {
            address: string;
            customInputs: {
                [x: string]: any;
            } | null;
            customer: {
                id: number;
                name: string;
            };
        } | null;
        customInputs: {
            [x: string]: any;
        } | null;
    } | null;
    workOrder: {
        name: string | null;
        idInDomain: number | null;
        domainId: number | null;
        descriptionMarkdown: string | null;
        createdAt: string | null;
        deadline: string | null;
        labels: {
            name: string | null;
            color: string | null;
        }[];
        customer: {
            domainId: number;
            idInDomain: number | null;
            name: string | null;
            shortName: string | null;
            avatarUrl: string | null;
        } | null;
        customInputs: {
            [x: string]: any;
        } | null;
        recipe: {
            name: string | null;
            nodes: {
                name: string;
                treatment: {
                    name: string;
                    treatmentGroupId: number | null;
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
                instructions: string | null;
                partNumberInstructions: string | null;
                leadTimeSum: number | null;
                recipeInd: number | null;
                isAutoComplete: boolean | null;
                defaultStation: {
                    id: number;
                    name: string;
                } | null;
                recipeNodeFiles: {
                    name: string;
                    url: string;
                }[];
                partNumberRecipeNodeFiles: {
                    name: string;
                    url: string;
                }[];
            }[];
        };
    } | null;
    partNumberWorkOrder: ({
        partGroup: {
            id: number;
            name: string;
        } | null;
        billablePartCount: number;
        completedPartCount: number;
        shippedPartCount: number;
        shippedFinalizedPartCount: number;
        descriptionMarkdown: string | null;
    } & {
        currentPartsTransferAccounts: {
            id: number;
            measurement: {
                id: number;
                measurement: string;
                tare: string;
                unit: {
                    id: number;
                    name: string;
                };
            } | null;
            partGroup: {
                id: number;
                name: string;
            } | null;
            location: {
                id: number;
                path: string;
            } | null;
        }[];
    }) | null;
    otherPartGroups: {
        id: number | null;
        name: string | null;
        partNumberId: number | null;
        createdAt: string | null;
    }[];
    allPartsOnWorkOrder: {
        partNumber: {
            id: number | null;
            name: string | null;
            description: string | null;
            specs: {
                name: string;
                id: number | null;
                revisionName: string | null;
                revisionNumber: number;
                type: string;
                customInputs: {
                    [x: string]: any;
                } | null;
                descriptionMarkdown: string | null;
                descriptionExternal: string | null;
                fromPartNumber: boolean | null;
                treatmentId: number | null;
                classificationSet: {
                    id: number;
                    classificationsInSetString: string;
                    classificationSetClassifications: {
                        id: number;
                        classification: {
                            id: number;
                            name: string;
                        } | null;
                    }[];
                } | null;
                labels: {
                    name: string;
                }[] | null;
                fields: {
                    id: number;
                    name: string;
                    paramName: string;
                    description: string | null;
                    type: string;
                    specFieldType: string;
                    minimumValue: number | null;
                    maximumValue: number | null;
                    targetValue: number | null;
                    unit: string | null;
                    sensorUnit: string | null;
                    samplingIntervalMinutes: number | null;
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
                    recipeInd: number | null;
                    processNode: {
                        id: number | null;
                        name: string | null;
                    } | null;
                }[];
            }[];
            partNumberUnitConversions: {
                factor: number | null;
                unit: {
                    id: number | null;
                    name: string | null;
                } | null;
            }[] | null;
        } | null;
        quantity: number | null;
        receivedBatch: {
            id: number;
            idInDomain: number | null;
            name: string;
            descriptionMarkdown: string | null;
            customInputs: {
                [x: string]: any;
            } | null;
        } | null;
        partGroup: {
            id: number | null;
            name: string | null;
        } | null;
        partNumberWorkOrder: {
            description: string | null;
        } | null;
        qualityHold: {
            id: number;
            idInDomain: number | null;
            descriptionMarkdown: string | null;
            markForScrap: boolean | null;
            createdAt: string;
            customInputs: {
                [x: string]: any;
            } | null;
        } | null;
    }[] | null;
    logoUrl: string;
    origin: string;
    customer: {
        name: string | null;
        phone: string | null;
        email: string | null;
        customInputs: {
            [x: string]: any;
        } | null;
    } | null;
    recipe: {
        name: string | null;
    } | null;
    timezone: string;
    domain: {
        id: number;
        logoUrl: string | null;
        name: string | null;
        address: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
    } & {
        customInputs: {
            [x: string]: any;
        } | null;
    };
    currentUser: {
        id: number;
        name: string | null;
        avatarUrl: string | null;
    };
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
