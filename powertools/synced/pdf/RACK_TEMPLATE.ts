const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {

  const result: LowCodeResult = {
    additionalPayload: {}
  };

  const currentRack = inputs.rack;

  if (!currentRack) return result;

  // Get current work order ID (first one found).
  const currentWO =
    currentRack.workOrders?.[0]?.idInDomain ||
    currentRack.partLocations?.[0]?.workOrder?.idInDomain;

  // Combine parent + child racks
  const allRacks = [
    currentRack,
    ...(inputs.childRacks || [])
  ];

  // Filter racks:
  const filteredRacks = allRacks.filter(r => {
    const wo =
      r.workOrders?.[0]?.idInDomain ||
      r.partLocations?.[0]?.workOrder?.idInDomain;

    const sameWorkOrder = wo === currentWO;

    // Change this if your "type" logic differs
    const sameType = r.name === currentRack.name;

    return sameWorkOrder && sameType;
  });

  // Sort for consistent indexing (by rackId)
  const sortedRacks = filteredRacks.sort((a, b) => {
    return (a.rackId || 0) - (b.rackId || 0);
  });

  const total = sortedRacks.length;

  const index =
    sortedRacks.findIndex(r => r.rackId === currentRack.rackId) + 1;

  result.additionalPayload.rackIndexLabel = `${index} / ${total}`;

  return result;
};



type LowCodeResult = {
  additionalPayload?: any;
};

interface Inputs {
  origin: string | null;
  rack: ({
    rackId: number | null;
    name: string | null;
    parentRack: {
      name: string | null;
      id: number | null;
    } | null;
    workOrders: {
      name: string | null;
      idInDomain: number | null;
      partNumberWorkOrderSpecs: {
        spec: {
          id: number;
          name: string;
          specFields: {
            id: number;
            name: string;
            specFieldParams: {
              id: number;
              name: string;
              minimumValue: number | null;
              targetValue: number | null;
              maximumValue: number | null;
              samplingRate: number | null;
              sampleCount: number | null;
              recipeNode: {
                id: number;
                name: string;
                processNode: {
                  id: number;
                  name: string;
                } | null;
              };
              location: {
                id: number;
                path: string;
              } | null;
            }[];
          }[];
        };
      }[] | null;
    }[] | null;
    receivedOrders: {
      name: string | null;
      idInDomain: number | null;
      customInputs: {
        [x: string]: any;
      } | null;
    }[] | null;
    customers: {
      idInDomain: number | null;
      name: string | null;
      avatarUrl: string | null;
    }[] | null;
    partNumbers: {
      image: string | null;
      name: string | null;
      id: number | null;
      quantity: number | null;
      description: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      labels: {
        name: string | null;
        color: string | null;
      }[];
    }[] | null;
    recipes: {
      name: string;
      id: number;
    }[] | null;
    batches: {
      name: string | null;
      creator: string | null;
    }[] | null;
    treatments: {
      name: string;
      id: number;
    }[] | null;
    partGroups: {
      name: string | null;
      id: number | null;
      weight: number | null;
      weightUnit: string | null;
    }[] | null;
    partQuantity: number | null;
    partLocations: {
      location: {
        name: string | null;
        id: number | null;
      };
      partCount: number | null;
      partNumber: {
        name: string | null;
        id: number | null;
        displayImage: string | null;
        partGroupWeight: {
          tare: number | null;
          net: number | null;
          gross: number | null;
        };
      };
      station: {
        name: string | null;
        id: number | null;
      };
      partGroup: {
        name: string | null;
        id: number | null;
        weight: number | null;
        unit: {
          name: string | null;
          id: number | null;
          mustBeInteger: boolean | null;
        };
      };
      productionBatch: {
        id: number;
        idInDomain: number | null;
        name: string | null;
        descriptionMarkdown: string | null;
      } | null;
      workOrder: {
        idInDomain: number | null;
        id: number | null;
        name: string | null;
        receivedOrder: {
          id: number | null;
          idInDomain: number | null;
          name: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
        };
        treatment: {
          id: number | null;
          name: string | null;
        };
        batches: {
          name: string | null;
          creator: string | null;
        }[];
        recipe: {
          name: string | null;
          type: string | null;
          id: number | null;
          description: string | null;
          descriptions: {
            partNumberId: number | null;
            description: string | null;
          }[];
          derivedFrom: {
            name: string | null;
            id: number | null;
            type: string | null;
          } | null;
        };
      };
    }[] | null;
    weight: number | null;
  } & {
    equipment: {
      id: number;
      name: string;
      cycleCount: number | null;
      cyclesBeforeMaintenance: number | null;
    } | null;
  }) | null;
  logoUrl: string | null;
  childRacks: {
    rackId: number | null;
    name: string | null;
    parentRack: {
      name: string | null;
      id: number | null;
    } | null;
    workOrders: {
      name: string | null;
      idInDomain: number | null;
      partNumberWorkOrderSpecs: {
        spec: {
          id: number;
          name: string;
          specFields: {
            id: number;
            name: string;
            specFieldParams: {
              id: number;
              name: string;
              minimumValue: number | null;
              targetValue: number | null;
              maximumValue: number | null;
              samplingRate: number | null;
              sampleCount: number | null;
              recipeNode: {
                id: number;
                name: string;
                processNode: {
                  id: number;
                  name: string;
                } | null;
              };
              location: {
                id: number;
                path: string;
              } | null;
            }[];
          }[];
        };
      }[] | null;
    }[] | null;
    receivedOrders: {
      name: string | null;
      idInDomain: number | null;
      customInputs: {
        [x: string]: any;
      } | null;
    }[] | null;
    customers: {
      idInDomain: number | null;
      name: string | null;
      avatarUrl: string | null;
    }[] | null;
    partNumbers: {
      image: string | null;
      name: string | null;
      id: number | null;
      quantity: number | null;
      description: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      labels: {
        name: string | null;
        color: string | null;
      }[];
    }[] | null;
    recipes: {
      name: string;
      id: number;
    }[] | null;
    batches: {
      name: string | null;
      creator: string | null;
    }[] | null;
    treatments: {
      name: string;
      id: number;
    }[] | null;
    partGroups: {
      name: string | null;
      id: number | null;
      weight: number | null;
      weightUnit: string | null;
    }[] | null;
    partQuantity: number | null;
    partLocations: {
      location: {
        name: string | null;
        id: number | null;
      };
      partCount: number | null;
      partNumber: {
        name: string | null;
        id: number | null;
        displayImage: string | null;
        partGroupWeight: {
          tare: number | null;
          net: number | null;
          gross: number | null;
        };
      };
      station: {
        name: string | null;
        id: number | null;
      };
      partGroup: {
        name: string | null;
        id: number | null;
        weight: number | null;
        unit: {
          name: string | null;
          id: number | null;
          mustBeInteger: boolean | null;
        };
      };
      productionBatch: {
        id: number;
        idInDomain: number | null;
        name: string | null;
        descriptionMarkdown: string | null;
      } | null;
      workOrder: {
        idInDomain: number | null;
        id: number | null;
        name: string | null;
        receivedOrder: {
          id: number | null;
          idInDomain: number | null;
          name: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
        };
        treatment: {
          id: number | null;
          name: string | null;
        };
        batches: {
          name: string | null;
          creator: string | null;
        }[];
        recipe: {
          name: string | null;
          type: string | null;
          id: number | null;
          description: string | null;
          descriptions: {
            partNumberId: number | null;
            description: string | null;
          }[];
          derivedFrom: {
            name: string | null;
            id: number | null;
            type: string | null;
          } | null;
        };
      };
    }[] | null;
    weight: number | null;
  }[] | null;
  allWorkOrders: {
    name: string | null;
    idInDomain: number | null;
  }[] | null;
  allReceivedOrders: {
    name: string | null;
    idInDomain: number | null;
    customInputs: {
      [x: string]: any;
    } | null;
  }[] | null;
  allCustomers: {
    idInDomain: number | null;
    name: string | null;
    avatarUrl: string | null;
  }[] | null;
  allPartNumbers: {
    image: string | null;
    name: string | null;
    id: number | null;
    quantity: number | null;
  }[] | null;
  allRecipes: {
    name: string;
    id: number;
  }[];
  allBatches: {
    name: string | null;
    creator: string | null;
  }[] | null;
  allTreatments: {
    name: string;
    id: number;
  }[] | null;
  allPartGroups: {
    name: string | null;
    id: number | null;
    weight: number | null;
    weightUnit: string | null;
  }[] | null;
  allPartLocations: {
    location: {
      name: string | null;
      id: number | null;
    };
    partCount: number | null;
    partNumber: {
      name: string | null;
      id: number | null;
      displayImage: string | null;
      partGroupWeight: {
        tare: number | null;
        net: number | null;
        gross: number | null;
      };
    };
    station: {
      name: string | null;
      id: number | null;
    };
    partGroup: {
      name: string | null;
      id: number | null;
      weight: number | null;
      unit: {
        name: string | null;
        id: number | null;
        mustBeInteger: boolean | null;
      };
    };
    productionBatch: {
      id: number;
      idInDomain: number | null;
      name: string | null;
      descriptionMarkdown: string | null;
    } | null;
    workOrder: {
      idInDomain: number | null;
      id: number | null;
      name: string | null;
      receivedOrder: {
        id: number | null;
        idInDomain: number | null;
        name: string | null;
        customInputs: {
          [x: string]: any;
        } | null;
      };
      treatment: {
        id: number | null;
        name: string | null;
      };
      batches: {
        name: string | null;
        creator: string | null;
      }[];
      recipe: {
        name: string | null;
        type: string | null;
        id: number | null;
        description: string | null;
        descriptions: {
          partNumberId: number | null;
          description: string | null;
        }[];
        derivedFrom: {
          name: string | null;
          id: number | null;
          type: string | null;
        } | null;
      };
    };
  }[] | null;
  allPartQuantity: number | null;
  allWeight: number | null;
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