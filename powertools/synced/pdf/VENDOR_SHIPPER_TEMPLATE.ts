const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult  => {

	return result;
}



type LowCodeResult = {
    additionalPayload?: any;
};

interface Inputs {
    idInDomain: number | null;
    domain: {
        id: number;
        logoUrl: string | null;
        name: string | null;
        address: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
    } | null;
    createdAt: string | null;
    shipVia: string | null;
    vendor: {
        idInDomain: number | null;
        name: string;
        address: string | null;
    } | null;
    origin: string;
    timezone: string;
    items: {
        index: number;
        quantity: number;
        casts: {
            id: number;
            idInDomain: number | null;
        }[];
        partNumber: {
            id: number;
            name: string;
            descriptionMarkdown: string | null;
            partNumberGroup: {
                id: number;
                name: string | null;
            } | null;
            displayImageUrl: string | null;
        } | null;
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
        purchaseOrderItem: {
            name: string | null;
            unitPriceDollars: string;
            quantity: number;
            subtotal: string | null;
            taxTotal: string | null;
            surchargeTotal: string | null;
            total: string | null;
            recipeNode: {
                id: number;
                name: string;
                treatment: {
                    id: number;
                    name: string;
                } | null;
                partNumberTreatment: {
                    id: number;
                    name: string;
                } | null;
            } | null;
            partNumber: {
                id: number;
                name: string;
            } | null;
        };
        purchaseOrder: {
            idInDomain: number | null;
        };
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