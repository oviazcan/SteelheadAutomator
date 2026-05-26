const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult  => {

	return result;
}



type LowCodeResult = {
    additionalPayload?: any;
};

interface Inputs {
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
    car: {
        idInDomain: number | null;
        name: string | null;
        createdAt: string | null;
        creator: {
            id: number;
            name: string | null;
        } | null;
        completedAt: string | null;
        completedBy: {
            id: number;
            name: string | null;
        } | null;
        customInputs: {
            [x: string]: any;
        } | null;
        ncr: {
            idInDomain: number | null;
            name: string | null;
            customInputs: {
                [x: string]: any;
            } | null;
            createdAt: string | null;
            creator: {
                id: number;
                name: string | null;
            } | null;
            customer: ({
                domainId: number;
                idInDomain: number | null;
                name: string | null;
                shortName: string | null;
                avatarUrl: string | null;
            } & {
                addresses: {
                    id: number;
                    address: string | null;
                }[] | null;
            }) | null;
            partsIn: {
                index: number;
                partCount: number;
                transferType: string | null;
                comment: string | null;
                partNumber: {
                    id: number | null;
                    name: string | null;
                    descriptionMarkdown: string | null;
                    customInputs: {
                        [x: string]: any;
                    } | null;
                } | null;
                partGroup: {
                    id: number | null;
                    name: string | null;
                } | null;
                receivedOrder: {
                    idInDomain: number | null;
                    name: string | null;
                } | null;
                workOrder: {
                    idInDomain: number | null;
                    name: string | null;
                } | null;
            }[] | null;
            partsOut: {
                index: number;
                partCount: number | null;
                transferType: string | null;
                comment: string | null;
                partNumber: {
                    id: number | null;
                    name: string | null;
                    descriptionMarkdown: string | null;
                    customInputs: {
                        [x: string]: any;
                    } | null;
                } | null;
                partGroup: {
                    id: number | null;
                    name: string | null;
                } | null;
                fromWorkOrder: {
                    idInDomain: number | null;
                    name: string | null;
                } | null;
                toWorkOrder: {
                    idInDomain: number | null;
                    name: string | null;
                } | null;
            }[] | null;
        } | null;
        investigations: {
            index: number;
            id: number;
            name: string | null;
            createdAt: string | null;
            deadline: string | null;
            creator: {
                id: number;
                name: string | null;
            } | null;
            investigator: {
                id: number;
                name: string | null;
            } | null;
            completedAt: string | null;
            completedBy: {
                id: number;
                name: string | null;
            } | null;
            customInputs: {
                [x: string]: any;
            } | null;
            rootCauseAnalyses: {
                index: number;
                id: number;
                name: string | null;
                createdAt: string | null;
                creator: {
                    id: number;
                    name: string | null;
                } | null;
                customInputs: {
                    [x: string]: any;
                } | null;
                completedAt: string | null;
                completedBy: {
                    id: number;
                    name: string | null;
                } | null;
            }[] | null;
        }[] | null;
        actions: {
            index: number;
            id: number;
            name: string | null;
            createdAt: string | null;
            creator: {
                id: number;
                name: string | null;
            } | null;
            implementedAt: string | null;
            implementedBy: {
                id: number;
                name: string | null;
            } | null;
            verifications: {
                index: number;
                id: number;
                name: string | null;
                verifiedAt: string | null;
                verifiedBy: {
                    id: number;
                    name: string | null;
                } | null;
                customInputs: {
                    [x: string]: any;
                } | null;
            }[] | null;
            customInputs: {
                [x: string]: any;
            } | null;
        }[] | null;
        images: {
            url: string;
        }[] | null;
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