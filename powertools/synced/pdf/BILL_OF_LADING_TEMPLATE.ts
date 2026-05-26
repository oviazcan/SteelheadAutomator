const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult  => {

	return result;
}



type LowCodeResult = {
    additionalPayload?: any;
};

interface Inputs {
    timezone: string;
    origin: string;
    createdAt: string;
    carrier: {
        name: string;
        number: string | null;
        address: string | null;
    };
    domain: {
        name: string | null;
        address: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
        logoUrl?: (string | undefined) | null;
    } | null;
    carrierBillToAddress: string | null;
    customerBillToAddress: string | null;
    customerBillToName: string | null;
    consignerSignatureSection7Base64: string | null;
    shipperSignatureBase64: string | null;
    carrierSignatureBase64: string | null;
    codFeePriceUSD: number | null;
    signedAt: string | null;
    feeType: string | null;
    codFeeType: string | null;
    codRemitAddress: string | null;
    declaredValuePerSignatureBase64: string | null;
    declaredValueUSD: number | null;
    route: string | null;
    vehicleNumber: string | null;
    totalChargesUSD: number | null;
    idInDomain: number;
    customInputs: {
        [x: string]: any;
    } | null;
    customer: {
        name: string;
        shortName: string | null;
        address: string;
    };
    unit: {
        id: number;
        name: string;
    } | null;
    totalWeight: number | null;
    billOfLadingItems: {
        chargesUSD: number | null;
        description: string | null;
        hazardousMaterials: boolean;
        numberOfUnits: number | null;
        rateUSD: number | null;
        weightLbs: number | null;
    }[];
    packingSlipsIncluded: {
        idInDomain: number;
        billToAddress: string;
        shipToAddress: string;
        customInputs: {
            [x: string]: any;
        } | null;
        customerContact: {
            name: string | null;
            phone: string | null;
            email: string | null;
            address: string | null;
            isInvoiceContact: boolean | null;
            isShippingContact: boolean | null;
        } | null;
        trackingNumber: string | null;
        purchaseOrdersIncluded: {
            idInDomain: number;
            name: string;
        }[];
        items: {
            partCount: number;
            comment: string | null;
            partsTransferAccounts: {
                partNumber: {
                    id: number;
                    name: string;
                    descriptionMarkdown: string | null;
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
                    customInputs: {
                        [x: string]: any;
                    } | null;
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
                workOrder: {
                    idInDomain: number;
                    name: string;
                    receivedOrder: {
                        idInDomain: number;
                        name: string;
                        customInputs: {
                            [x: string]: any;
                        } | null;
                    };
                    recipe: {
                        name: string | null;
                        description: string | null;
                    };
                };
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
                } | null;
                receivedBatches: {
                    id: number;
                    name: string | null;
                    descriptionMarkdown: string | null;
                    customInputs: {
                        [x: string]: any;
                    } | null;
                    createdBy: {
                        id: number;
                        name: string | null;
                        avatarUrl: string | null;
                    };
                    partNumberOnBatch: {
                        id: number;
                        name: string;
                    } | null;
                }[];
                location: {
                    id: number;
                    path: string | null;
                } | null;
            }[];
        }[];
    }[];
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