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
        name: string | null;
        logoUrl: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
        address: string | null;
        customInputs: {
            [x: string]: any;
        } | null;
    };
    createdAt: string | null;
    receivedAt: string | null;
    receivedBy: {
        name: string | null;
        avatarUrl: string | null;
    };
    receiverBomItems: {
        id: number;
        quantity: number | null;
        purchaseOrderBomItem: {
            name: string | null;
            quantity: number | null;
            unitPrice: string | null;
            totalPrice: string | null;
            purchaseOrderLines: {
                id: number;
                lineNumber: number | null;
            }[];
            purchaseOrder: {
                id: number | null;
                idInDomain: number | null;
                vendor: {
                    name: string | null;
                };
            };
        };
        inventoryBatches: {
            id: number;
            name: string;
            inventoryItem: {
                id: number;
                name: string;
                description: string | null;
            } | null;
            partNumber: {
                id: number;
                name: string;
                description: string | null;
            } | null;
        }[];
    }[] | null;
    receivedOrderLineItems: {
        description: string | null;
        totalLinePrice: string | null;
        totalLineItemPrice: string | null;
        receivedOrderLineByReceivedOrderLineId: {
            description: string | null;
            name: string | null;
            receivedOrderByReceivedOrderId: {
                salesOrderStatsTotalPrice: string | null;
                customerByCustomerId: {
                    name: string | null;
                    shortName: string | null;
                    phone: string | null;
                    avatarUrl: string | null;
                    customerAddressByDefaultBillToAddressId: {
                        address: string | null;
                    };
                    customerAddressByDefaultShipToAddressId: {
                        address: string | null;
                    };
                };
                receivedOrderPartTransformsByReceivedOrderId: {
                    partTransformByPartTransformId: {
                        name: string | null;
                    };
                };
                workOrdersByReceivedOrderId: {
                    recipeNodeByRecipeId: {
                        id: number | null;
                        name: string | null;
                        description: string | null;
                    };
                }[];
            };
        };
    }[];
    partsTransferAccounts: {
        partCount: number | null;
        receiverBomItemId: number | null;
        locationByLocationId: {
            path: string | null;
            address: string | null;
        };
        partNumberByPartNumberId: {
            id: number | null;
            name: string | null;
            description: string | null;
        };
        partGroupByPartGroupId: {
            name: string | null;
        };
    }[];
    receivedBatches: {
        id: number | null;
        name: string | null;
        customInputs: {
            [x: string]: any;
        } | null;
        inventoryAccountsByInventoryBatchId: {
            customer: {
                name: string | null;
            };
            salesOrder: {
                id: number | null;
                name: string | null;
            };
            receiverBomItemId: number | null;
            initialAmount: number | null;
            partNumber: {
                name: string | null;
                description: string | null;
            };
        }[];
    }[];
    signedBy: {
        id: number;
        name: string | null;
        avatarUrl: string | null;
    } | null;
    signedByName: string | null;
    signedByTitle: string | null;
    signedAt: string | null;
    signatureB64: string | null;
    receiverFiles: {
        name: string;
        url: string;
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