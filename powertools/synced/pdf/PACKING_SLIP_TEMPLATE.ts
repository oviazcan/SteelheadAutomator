const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = { additionalPayload: {} };

  // Step 1: Group items by partNumber.id + receivedBatch.id
  const groups: Record<string, typeof inputs.packingSlip.items> = {};

  inputs.packingSlip.items.forEach(item => {
    item.partsTransferAccounts.forEach((part) => {
      if (!part.partNumber?.id || !part.receivedBatches?.length) return;

      part.receivedBatches.forEach(batch => {
        if (!batch.id) return;

        const key = `${part.partNumber.id}-${batch.id}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      });
    })
  });

  // Step 2: Sort each group by original item index and assign container index.
  Object.values(groups).forEach(group => {
    const total = group.length;
    group.sort((a, b) => a.index - b.index); // Sort by original item index
    group.forEach((item, idx) => {
      (item as any).containerIndex = `${idx + 1}/${total}`;
    });
  });

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
