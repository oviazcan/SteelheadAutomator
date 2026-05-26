const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult  => {

	return result;
}



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