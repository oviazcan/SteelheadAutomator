const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const transformedPartNumberSpecs: Inputs['partNumberProcessNodes'][number]['treatment']['specFieldParams'] = inputs.partNumberSpecs.flatMap(pns => pns.specFields.map(sf => {
    return {
      spec: {
        id: pns.id,
        customInputs: pns.customInputs
      },
      specField: {
        id: sf.id,
        name: sf.name,
        type: sf.type,
        isExternal: sf.isExternal,
        processNodes: [{ id: sf.processNodeId, name: sf.processNode }],
        sensorInformation: sf.sensorInformation,
      },
      specFieldParam: sf.specFieldParam
    }
  }))
  const allSpecFieldParams = inputs.partNumberProcessNodes.flatMap(pnpn => pnpn?.treatment?.specFieldParams).concat(transformedPartNumberSpecs)

  const orderedPartNumberProcessNodes =
    inputs.partNumberProcessNodes?.map((pnpn) => {
      const matchingSpecFieldParams = allSpecFieldParams.filter(sfp => sfp?.specField?.processNodes.some(node => node.id === pnpn.processNode.id))
      return {
        ...pnpn,
        treatment: pnpn.treatment
          ? {
              ...pnpn.treatment,
              specFieldParams: matchingSpecFieldParams,
              stations: Array.isArray(pnpn.treatment?.stations)
                ? pnpn.treatment.stations
                : pnpn.treatment?.stations
                  ? [pnpn.treatment.stations]
                  : []
            }
          : null,
      }
    }) ?? null

  return {
    additionalPayload: orderedPartNumberProcessNodes,
  }
}

type LowCodeResult = {
  additionalPayload?: any
}

interface Inputs {
  id: number | null
  name: string | null
  instructions: string | null
  priceMicroDollars: number | null
  customInputs: {
    [x: string]: any
  } | null
  customer: {
    domainId: number
    idInDomain: number | null
    name: string | null
    shortName: string | null
    avatarUrl: string | null
  } | null
  domain: {
    customInputs: {
      [x: string]: any
    } | null
  } | null
  certificationComment: string | null
  partNumberFiles:
  | {
    id: number | null
    name: string | null
    url: string | null
  }[]
  | null
  partNumberLabels:
  | {
    name: string
  }[]
  | null
  partNumberProcessNodes:
  | {
    station: {
      id: number | null
      name: string | null
    } | null
    treatment: {
      id: number | null
      name: string | null
      treatmentGroup: {
        id: number | null
        name: string | null
      } | null
      stations:
      | {
        id: number | null
        name: string | null
      }[]
      | null
      specFieldParams: ({
        spec: {
          id: number | null
          customInputs: {
            [x: string]: any
          } | null
        }
        specField: {
          id: number | null
          name: string | null
          type: string | null
          processNodes: {
            id: number
            name: string
          }[]
          sensorInformation: {
            sensorType: string | null
            sensorMeasurementType: string | null
            unit: {
              id: number | null
              name: string | null
            } | null
          } | null
        }
        specFieldParam: {
          id: number | null
          name: string | null
          minimumValue: number | null
          maximumValue: number | null
          samplingRate: number | null
          sampleCount: number | null
          sampleSet: {
            id: number
            name: string
            sampleRanges: {
              id: number
              minBatchCount: number
              maxBatchCount: number | null
              sampleCount: number | null
              samplingRate: number | null
            }[]
          } | null
          targetValue: number | null
          description: string | null
          unit: {
            id: number | null
            name: string | null
          } | null
        }
      } | null)[]
    } | null
    processNode: {
      id: number | null
      name: string | null
      instructions: string | null
      isAutoComplete: boolean | null
    } | null
    partNumberProcessNodeFiles:
    | {
      id: number | null
      name: string | null
      url: string | null
    }[]
    | null
    partNumberProcessNodeInstructions: string | null
  }[]
  | null
  partNumberUnitConversions:
  | {
    id: number | null
    conversionFactor: number | null
    unit: {
      id: number | null
      name: string | null
    } | null
  }[]
  | null
  partNumberSpecs:
  | ({
    id: number | null
    name: string | null
    revisionNumber: number
    revisionName: string | null
    description: string | null
    externalDescription: string | null
    customInputs: {
      [x: string]: any
    } | null
    specFields: ({
      id: number | null
      name: string | null
      isExternal: boolean | null
      type: string | null
      processNodeId: number | null
      processNode: string | null
      sensorInformation: {
        sensorType: string | null
        sensorMeasurementType: string | null
        unit: {
          id: number | null
          name: string | null
        } | null
      } | null
      specFieldParam: {
        id: number | null
        name: string | null
        minimumValue: number | null
        maximumValue: number | null
        samplingRate: number | null
        sampleCount: number | null
        sampleSet: {
          id: number
          name: string
          sampleRanges: {
            id: number
            minBatchCount: number
            maxBatchCount: number | null
            sampleCount: number | null
            samplingRate: number | null
          }[]
        } | null
        targetValue: number | null
        description: string | null
        unit: {
          id: number | null
          name: string | null
        } | null
      }

    } | null)[]
  } | null)[]
  | null
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
