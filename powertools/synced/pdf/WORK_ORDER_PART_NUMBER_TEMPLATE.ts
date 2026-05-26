const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = {};

  // Formateadores (se crean una vez). OK.
  const nf1 = new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  try {
    // Common Work Order Info
    const workOrderInfo = {
      workOrderName: inputs.workOrder?.name || null,
      workOrderId: inputs.workOrder?.idInDomain || null,
      customerName: inputs.workOrder?.customer?.name || inputs.customer?.name || null,
      recipeName: inputs.recipe?.name || null,
      deadline: inputs.workOrder?.deadline
        ? new Date(inputs.workOrder.deadline).toLocaleDateString("en-GB")
        : null,
      createdAt: inputs.workOrder?.createdAt || null,
      domain: inputs.domain?.name || null,
    };

    const pdfsToGenerate: any[] = [];

    (inputs.receivedBatches || []).forEach((batch, batchIndex) => {
      const numeroRaw = batch.customInputs?.DatosRecibo?.numeroContenedores;
      let numeroContenedores = parseInt(numeroRaw, 10);

      if (isNaN(numeroContenedores) || numeroContenedores <= 0) {
        helpers.addErrorMessage({
          severity: "warning",
          message: `⚠️ Batch ${batch.name || batch.id}: Number Of Containers Is Null - Defaulting To 1 Container`,
        });
        numeroContenedores = 1;
      }

      helpers.log(`📦 Batch ${batchIndex + 1}: ${numeroContenedores} Containers`);

      // 🔹 Get parts tied to this batch
      const partsForBatch =
        inputs.allPartsOnWorkOrder?.filter(
          (p) => p.receivedBatch?.id === batch.id
        ) || [];

      partsForBatch.forEach((partEntry) => {
        const part = partEntry.partNumber;

        const partInfo = {
          partName: part?.name || null,
          partId: part?.id || null,
          partDescription: part?.description || null,
          specs: part?.specs || [],
          quantity: partEntry.quantity ?? 0,
        };

        // Conversion Calcs
        const unitConversions = inputs.partNumber?.unitConversions || [];
        const qty = partEntry.quantity ?? 0;

        // Filter By Unit
        const convertedQuantities = unitConversions
          .filter(
            (u) =>
              u &&
              u.unit &&
              u.factor != null &&
              (u.unit.id === 3969 || u.unit.id === 3972 || u.unit.id === 5150 || u.unit.id === 4907)
          )
          .map((u) => `${nf1.format(qty * u.factor)}: ${u.unit.name}`);

        // Weight calculation
        const kgmConversion =
          part?.partNumberUnitConversions?.find(
            (u) => u?.unit?.name === "KGM" && u.factor != null
          )?.factor ??
          inputs.partNumber.unitConversions?.find(
            (u) => u?.unit?.name === "KGM" && u.factor != null
          )?.factor ??
          null;

        const partWeightKg =
          kgmConversion != null ? (partEntry.quantity ?? 0) * kgmConversion : null;

        // Area calculation
        const cmkConversion =
          part?.partNumberUnitConversions?.find(
            (u) => u?.unit?.name === "CMK" && u.factor != null
          )?.factor ??
          inputs.partNumber.unitConversions?.find(
            (u) => u?.unit?.name === "CMK" && u.factor != null
          )?.factor ??
          null;

          const partAreaCmk =
          cmkConversion != null ? (partEntry.quantity ?? 0) * cmkConversion : null;

        // Length calculation
        const lmConversion =
          part?.partNumberUnitConversions?.find(
            (u) => u?.unit?.name === "LM" && u.factor != null
          )?.factor ??
          inputs.partNumber.unitConversions?.find(
            (u) => u?.unit?.name === "LM" && u.factor != null
          )?.factor ??
          null;

          const partLengthLm =
          lmConversion != null ? (partEntry.quantity ?? 0) * lmConversion : null;

        // External specs logic
        const allExternalSpecs =
          part?.specs?.filter((s) => s.type === "EXTERNAL") || [];

        const allSpecNames = [...new Set(allExternalSpecs.map((s) => s.name).filter(Boolean))];

        const fieldGroups: Record<string, Set<string>> = {};
        for (const spec of allExternalSpecs) {
          for (const field of spec.fields || []) {
            if (field.paramName === "Sí o No" || field.paramName === "Cumple o No Cumple") continue;

            const fieldName = field.name?.trim() || "";
            const paramValue = field.paramName?.trim() || "";

            if (fieldName.includes("Primeras Piezas")) continue;
            if (fieldName.includes("Diagonal")) continue;
            if (fieldName.includes("Instrumento")) continue;
            if (!fieldName) continue;
            if (!fieldGroups[fieldName]) fieldGroups[fieldName] = new Set();
            if (paramValue) fieldGroups[fieldName].add(paramValue);
          }
        }

        const groupedFieldList = Object.entries(fieldGroups).map(([name, params]) => {
          const paramList = Array.from(params).join(", ");
          return paramList ? `${name}: ${paramList}` : `${name}`;
        });

        const markdownCombinedExternalSpecs =
          `${allSpecNames.join(", ")}\n` +
          groupedFieldList.join(", ");

        const combinedExternalSpecs = {
          specNamesJoined: allSpecNames.join(", "),
          fieldNamesJoined: groupedFieldList.join(", "),
          markdown: markdownCombinedExternalSpecs,
          specNames: allSpecNames,
          fieldGroups: Object.fromEntries(
            Object.entries(fieldGroups).map(([k, v]) => [k, Array.from(v)])
          ),
          fieldNames: groupedFieldList,
          count: allExternalSpecs.length,
        };

        // Generate PDFs for each container
        for (let i = 0; i < numeroContenedores; i++) {
          pdfsToGenerate.push({
            batchIndex: batchIndex + 1,
            batchId: batch.id,
            batchName: batch.name,
            containerIndex: i + 1,
            containerDisplay: `${i + 1}/${numeroContenedores}`,
            label: `Batch ${batchIndex + 1} - Container ${i + 1} of ${numeroContenedores} - Part ${partInfo.partName}`,
            numeroContenedores,
            partInfo,
            partQuantity: partEntry.quantity ?? 0,

            // Array Of Strings
            convertedQuantities,

            // Weight
            partWeightKg,

             // Area
            partAreaCmk,

             // Length
            partLengthLm,

            workOrderInfo,
            combinedExternalSpecs,
            datosRecibo: batch.customInputs?.DatosRecibo || {},
          });
        }
      });
    });

    result.additionalPayload = { pdfsToGenerate };

    helpers.log(
      `✅ Generated ${pdfsToGenerate.length} PDF entries across ${inputs.receivedBatches?.length || 0} batch(es).`
    );
  } catch (err) {
    helpers.addErrorMessage({
      severity: "error",
      message: `❌ Error generating PDFs: ${err}`,
    });
  }

  return result;
};
















type LowCodeResult = {
  additionalPayload?: any;
};

interface Inputs {
  partNumber: {
    id: number;
    name: string;
    descriptionMarkdown: string | null;
    customerFacingNotes: string | null;
    customInputs: {
      [x: string]: any;
    } | null;
    templateDerivedFrom: {
      id: number;
      name: string;
    } | null;
    displayImageUrl: string | null;
    unitConversions: {
      unit: {
        id: number;
        name: string;
      };
      factor: number;
    }[];
    rackTypes: {
      id: number;
      name: string;
      partsPerRack: number;
      associatedRacks: {
        id: number;
        name: string;
      }[];
    }[];
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
    partNumberGroup: {
      id: number;
      name: string | null;
    } | null;
    labels: {
      name: string | null;
      color: string | null;
    }[];
    defaultTreatmentStations: {
      treatmentId: number | null;
      stationByStationId: {
        stationId: number | null;
        stationName: string | null;
      };
    }[];
    routedTreatmentStations: {
      treatmentId: number | null;
      stationByStationId: {
        stationId: number | null;
        stationName: string | null;
      };
      workOrderId: number | null;
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
  } | null;
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
  }[] | null;
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
    createdBy: {
      id: number;
      name: string | null;
      avatarUrl: string | null;
    };
    customInputs: {
      [x: string]: any;
    } | null;
  }[];
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
  partQty: number;
  partQtyInGroup: number;
  receivedOrder: {
    name: string;
    idInDomain: number | null;
    shipVia: string | null;
    notesMarkdown: string | null;
    createdAt: string | null;
    customInputs: {
      [x: string]: any;
    } | null;
    shipToAddress: {
      address: string;
      customInputs: {
        [x: string]: any;
      } | null;
      customer: {
        id: number;
        name: string;
      };
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
    }[];
  }) | null;
  customer: {
    name: string | null;
  } | null;
  recipe: {
    name: string | null;
  } | null;
  logoUrl: string;
  origin: string;
  timezone: string;
  domain: {
    id: number;
    logoUrl: string | null;
    name: string | null;
    address: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
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
  addQuotePartPricingTier: (value: { title: string, quantity: number, price: number }) => void
  parseCSV: (value: string) => { data: any[][], errors: [], meta: any }
}