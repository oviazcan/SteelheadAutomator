const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = {};

  // Formateadores de números
  const nf2 = new Intl.NumberFormat("es-MX", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  try {
    result.additionalPayload = inputs.partsTransferAccounts.map((pta) => {
      const qty = pta.quantity ?? 0;

      // Safely get the first valid conversion.
      const conversion = pta.partNumber?.unitConversions
        ?.filter(c => c && c.factor != null && c.unit?.name)
        .shift();

      let quantityWithConversion = `Cantidad: ${qty} sin peso`;

      if (conversion) {
        // Ensure qty and factor are numbers
        const convertedValue = Number(qty) * Number(conversion.factor!);
        const unitName = conversion.unit!.name!.replace(/\bKilogramo\b/gi, "");
        quantityWithConversion = `Cantidad: ${nf2.format(qty)} Peso: ${nf2.format(convertedValue)} ${unitName}`;
      }

      return {
        ...pta,
        quantityWithConversion,
      };
    });
  } catch (err) {
    helpers.log("Error in PDF customization: " + err);
  }

  return result;
};






type LowCodeResult = {
  additionalPayload?: any;
};

interface Inputs {
  partsTransferAccounts: {
    id: number;
    partAccountAncestors: {
      id: number | null;
      partsTransfers: {
        id: number;
        quantity: number;
        operatorInput: {
          [x: string]: any;
        } | null;
        createdBy: {
          id: number | null;
          name: string | null;
        } | null;
      }[];
      createdBy: {
        id: number | null;
        name: string | null;
      } | null;
      qualityHold: {
        id: number;
        descriptionMarkdown: string | null;
        customInputs: {
          [x: string]: any;
        } | null;
        markForScrap: boolean | null;
      } | null;
      contractReviewSignOffs: {
        id: number;
        user: {
          id: number;
          name: string | null;
          avatarUrl: string | null;
        };
        createdAt: string;
        passed: boolean;
      }[] | null;
      partGroup: {
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
      } | null;
      createdAt: string;
      billOfLadingNumber?: (number | undefined) | null;
      productionBatch: {
        id: number;
        idInDomain: number | null;
        name: string | null;
        descriptionMarkdown: string | null;
      } | null;
      packingSlipId: number | null;
      exitedAt: string | null;
      stationByStationId: {
        id: number;
        name: string;
      } | null;
      rackByRackId: {
        id: number;
        name: string;
      } | null;
      partNumberByPartNumberId: {
        id: number;
        name: string;
      } | null;
      workOrderByWorkOrderId: {
        id: number;
        name: string;
        idInDomain: number;
      } | null;
      locationByLocationId: {
        id: number;
        path: string;
      } | null;
      recipeNodeByRecipeNodeId: {
        id: number;
        name: string;
        recipeInd: number | null;
        specId: number | null;
        partNumberInstructions: string | null;
        processNodeByDerivedFrom: {
          id: number;
          name: string;
          descriptionMarkdown: string | null;
        } | null;
      } | null;
      inventoryAccountByInventoryAccountId: {
        inventoryBatch: {
          id: number;
          name: string | null;
          idInDomain: number | null;
          descriptionMarkdown: string | null;
          createdAt: string | null;
          createdBy: {
            id: number;
            name: string | null;
            avatarUrl: string | null;
          };
          customInputs: {
            [x: string]: any;
          } | null;
        };
      } | null;
      specValuePartsTransferAccounts: {
        id: number;
        quantity: number | null;
        value: {
          numberValue: number | null;
          booleanValue: boolean | null;
          effectiveAt: string | null;
          comment: string | null;
          dropdownString: string | null;
          numberValueMinimum: number | null;
          numberValueMaximum: number | null;
          id: number | null;
          files: {
            name: string;
            url: string;
          }[] | null;
          recordedValueAsString: string | null;
          passed: boolean | null;
          referencedSpecFieldParamValueId: number | null;
          operatingReferencedSpecFieldParamValueId: number | null;
          createdBy: {
            id: number;
            name: string | null;
            avatarUrl: string | null;
          } & {
            customInputs: {
              [x: string]: any;
            } | null;
          };
          rack: {
            id: number | null;
            name: string | null;
          } | null;
          sensorMeasurementBySensorMeasurementId: {
            measuredValue: number | null;
            measuredBooleanValue: boolean | null;
            measuredTextValue: string | null;
            effectiveAt: string | null;
            sensorBySensorId: {
              id: number;
              name: string;
              sensorType: {
                unit: {
                  id: number | null;
                  name: string | null;
                } | null;
              } | null;
            } | null;
          } | null;
          textValue: string | null;
          specFieldParamValueResolutions: {
            id: number | null;
            comment: string | null;
            createdAt: string | null;
            userByCreatorId: {
              id: number | null;
              name: string | null;
              avatarUrl: string | null;
            } | null;
          }[];
        };
        parameter: {
          id: number;
          name: string;
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
          specId: number | null;
          minimumValueAsString: string | null;
          maximumValueAsString: string | null;
          targetValueAsString: string | null;
          minimumValue: number | null;
          maximumValue: number | null;
          targetValue: number | null;
          description: string | null;
          geometryTypeSpecField: {
            id: number;
            geometryTypeSpecFieldProperty: {
              id: number;
              name: string;
            } | null;
            geometryType: {
              id: number;
              name: string;
            } | null;
          } | null;
          specField: {
            id: number | null;
            name: string | null;
            type: string | null;
          } | null;
          recipeNode: {
            id: number | null;
            name: string | null;
            recipeNodeInd: number | null;
            processNode: {
              id: number | null;
              name: string | null;
            } | null;
          } | null;
          unit: {
            id: number | null;
            name: string | null;
          } | null;
        };
      }[];
    }[];
    partGroup: {
      id: number;
      name: string;
    } | null;
    quantity: number;
    packingSlipId: number | null;
    packingSlipCreatedAt: string | null;
    shippingDate: string | null;
    shippedAt: string | null;
    billOfLadingNumber: number | null;
    productionBatch: {
      id: number;
      idInDomain: number | null;
      name: string | null;
      descriptionMarkdown: string | null;
    } | null;
    inventoryBatchesRelatedToPartTransferAccount: {
      inventoryBatch: {
        id: number;
        name: string;
        inventoryItem: {
          id: number;
          name: string;
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
              specValuesByBatchAndItem: {
                id: number;
                numberValue: number | null;
                booleanValue: boolean | null;
                effectiveAt: string | null;
                comment: string | null;
                dropdownString: string | null;
                isFailing: boolean | null;
                valueAsString: string | null;
                createdBy: {
                  id: number;
                  name: string | null;
                  avatarUrl: string | null;
                };
                numberValueMinimum: number | null;
                numberValueMaximum: number | null;
              }[];
            }[];
          }[];
        };
      };
    }[];
    inventoryAccountByInventoryAccountId: {
      inventoryBatch: {
        id: number;
        name: string | null;
        idInDomain: number | null;
        descriptionMarkdown: string | null;
        createdAt: string | null;
        createdBy: {
          id: number;
          name: string | null;
          avatarUrl: string | null;
        };
        customInputs: {
          [x: string]: any;
        } | null;
      };
    } | null;
    partNumber: {
      customInputs: {
        [x: string]: any;
      } | null;
      descriptionMarkdown: string | null;
      certificationComment: string | null;
      customerFacingNotes: string | null;
      unitConversions: ({
        unit: {
          id: number | null;
          name: string | null;
        };
        factor: number | null;
      } | null)[];
      id: number;
      name: string;
      files: {
        name: string;
        url: string;
      }[];
      partNumberGroup: {
        id: number | null;
        name: string | null;
      } | null;
    };
    descriptionMarkdown: string | null;
    specs: {
      name: string;
      id: number;
      type: string;
      descriptionMarkdown: string | null;
      descriptionExternal: string | null;
      fromPartNumber: boolean | null;
      treatmentId: number | null;
      treatment: {
        name: string;
        treatmentGroup: {
          id: number;
          name: string;
        } | null;
      } | null;
      customInputs: {
        [x: string]: any;
      } | null;
      revisionName: string | null;
      revisionNumber: number | null;
      specFields: {
        name: string;
        description: string | null;
        type: string | null;
        id: number | null;
        valuesAndParams: {
          measuredQuantity: number | null;
          value: {
            numberValue: number | null;
            booleanValue: boolean | null;
            effectiveAt: string | null;
            recordedValueAsString: string | null;
            passed: boolean | null;
            comment: string | null;
            referencedSpecFieldParamValueId: number | null;
            operatingReferencedSpecFieldParamValueId: number | null;
            id: number | null;
            files: {
              name: string;
              url: string;
            }[] | null;
            createdBy: {
              id: number;
              name: string | null;
              avatarUrl: string | null;
            } & {
              customInputs: {
                [x: string]: any;
              } | null;
            };
            rack: {
              id: number | null;
              name: string | null;
            } | null;
            station: {
              id: number | null;
              name: string | null;
            } | null;
            sensorMeasurementBySensorMeasurementId: {
              measuredValue: number | null;
              measuredBooleanValue: boolean | null;
              measuredTextValue: string | null;
              effectiveAt: string | null;
              sensorBySensorId: {
                id: number;
                name: string;
                sensorType: {
                  unit: {
                    id: number | null;
                    name: string | null;
                  } | null;
                } | null;
              } | null;
            } | null;
            textValue: string | null;
            specFieldParamValueResolutions: {
              id: number | null;
              comment: string | null;
              createdAt: string | null;
              userByCreatorId: {
                id: number | null;
                name: string | null;
                avatarUrl: string | null;
              } | null;
            }[];
          } | null;
          parameter: {
            id: number;
            name: string;
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
            minimumValueAsString: string | null;
            maximumValueAsString: string | null;
            targetValueAsString: string | null;
            minimumValue: number | null;
            maximumValue: number | null;
            targetValue: number | null;
            description: string | null;
            recipeNode: {
              id: number | null;
              name: string | null;
              recipeNodeInd: number | null;
              processNode: {
                id: number | null;
                name: string | null;
                processNodeDescription: string | null;
              } | null;
            } | null;
            geometryTypeSpecField: {
              id: number;
              geometryTypeSpecFieldProperty: {
                id: number;
                name: string;
              };
              geometryType: {
                id: number;
                name: string;
              };
            } | null;
            unit: {
              id: number | null;
              name: string | null;
            } | null;
          };
        }[];
        couponValueAndParams: {
          measuredQuantity: number | null;
          value: {
            numberValue: number | null;
            booleanValue: boolean | null;
            effectiveAt: string | null;
            recordedValueAsString: string | null;
            passed: boolean | null;
            comment: string | null;
            referencedSpecFieldParamValueId: number | null;
            operatingReferencedSpecFieldParamValueId: number | null;
            id: number | null;
            files: {
              name: string;
              url: string;
            }[] | null;
            createdBy: {
              id: number;
              name: string | null;
              avatarUrl: string | null;
            } & {
              customInputs: {
                [x: string]: any;
              } | null;
            };
            rack: {
              id: number | null;
              name: string | null;
            } | null;
            station: {
              id: number | null;
              name: string | null;
            } | null;
            sensorMeasurementBySensorMeasurementId: {
              measuredValue: number | null;
              measuredBooleanValue: boolean | null;
              measuredTextValue: string | null;
              effectiveAt: string | null;
              sensorBySensorId: {
                id: number;
                name: string;
                sensorType: {
                  unit: {
                    id: number | null;
                    name: string | null;
                  } | null;
                } | null;
              } | null;
            } | null;
            textValue: string | null;
            specFieldParamValueResolutions: {
              id: number | null;
              comment: string | null;
              createdAt: string | null;
              userByCreatorId: {
                id: number | null;
                name: string | null;
                avatarUrl: string | null;
              } | null;
            }[];
          } | null;
          parameter: {
            id: number;
            name: string;
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
            minimumValueAsString: string | null;
            maximumValueAsString: string | null;
            targetValueAsString: string | null;
            minimumValue: number | null;
            maximumValue: number | null;
            targetValue: number | null;
            description: string | null;
            recipeNode: {
              id: number | null;
              name: string | null;
              recipeNodeInd: number | null;
              processNode: {
                id: number | null;
                name: string | null;
                processNodeDescription: string | null;
              } | null;
            } | null;
            geometryTypeSpecField: {
              id: number;
              geometryTypeSpecFieldProperty: {
                id: number;
                name: string;
              };
              geometryType: {
                id: number;
                name: string;
              };
            } | null;
            unit: {
              id: number | null;
              name: string | null;
            } | null;
          };
        }[];
      }[];
      labels: {
        id: number;
        name: string;
      }[] | null;
      optIns: {
        id: number;
        name: string;
      }[] | null;
    }[];
    optInNodes: {
      id: number | null;
      name: string | null;
    }[];
    treatments: {
      name: string;
      treatmentGroup: {
        id: number;
        name: string;
        customInputs: {
          [x: string]: any;
        } | null;
      } | null;
      processNode: {
        id: number;
        name: string;
      } | null;
      recipeNodeInd: number | null;
      inventoryItems: {
        id: number;
        name: string;
        inventoryType: {
          id: number;
          name: string;
        } | null;
        customInputs: {
          [x: string]: any;
        } | null;
        batches: {
          id: number;
          name: string;
          expirationDate: string | null;
          vendor: {
            id: number;
            name: string;
          } | null;
          receivers: {
            id: number;
            notes: string;
            vendor: {
              id: number;
              name: string;
            };
          }[];
          customInputs: {
            [x: string]: any;
          } | null;
        }[];
      }[];
    }[];
    workOrder: {
      name: string | null;
      id: number | null;
      idInDomain: number | null;
      deadline: string | null;
      recipe: {
        name: string | null;
        process: {
          name: string;
          description: string;
        } | null;
      } | null;
      customInputs: {
        [x: string]: any;
      } | null;
      createdAt: string;
      descriptionMarkdown: string | null;
      receivedOrder: {
        name: string;
        idInDomain: number;
        customInputs: {
          [x: string]: any;
        } | null;
        billTo: string | null;
        shipTo: string | null;
        shipVia: string | null;
        relatedQuotes: {
          idInDomain: number | null;
        }[] | null;
        receivedOrderLines: {
          id: number | null;
          name: string | null;
          description: string | null;
          lineNumber: number | null;
          receivedOrderLineItems: {
            id: number | null;
            description: string | null;
            product: {
              id: number | null;
              name: string | null;
            } | null;
          }[];
        }[] | null;
      } | null;
    };
  }[];
  signedAt: string | null;
  customer: (({
    domainId: number;
    idInDomain: number | null;
    name: string | null;
    shortName: string | null;
    avatarUrl: string | null;
  } | null) & {
    customInputs: {
      [x: string]: any;
    } | null;
    customerContact: {
      name: string | null;
      email: string | null;
      phone: string | null;
    } | null;
  }) | null;
  origin: string;
  timezone: string;
  domain: ({
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
  }) | null;
  createdAt: string | null;
  createdBy: ({
    id: number;
    name: string | null;
    avatarUrl: string | null;
  } & {
    customInputs: {
      [x: string]: any;
    } | null;
  }) | null;
  signatureB64: string | null;
  signedBy: {
    id: number;
    name: string | null;
    avatarUrl: string | null;
  } | null;
  signedByTitle: string | null;
  dropShipToAddress: {
    customer: {
      id: number;
      name: string;
    };
    address: string;
  } | null;
  customerAddress: string | null;
  certificationStatment: string | null;
  comments: string | null;
  idInDomain: number | null;
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