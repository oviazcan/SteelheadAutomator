const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult  => {

	return result;
}



type LowCodeResult = {
    additionalPayload?: any;
};

interface Inputs {
    name: string | null;
    idInDomain: number | null;
    totalPrice: number | null;
    revisionNumber: number | null;
    revisionName: string | null;
    createdAt: string;
    validUntil: string;
    timezone: string;
    followUpDate: string | null;
    origin: string;
    notes: string;
    customInputs: {
        [x: string]: any;
    } | null;
    currentUser: {
        name: string;
    } & {
        email: string | null;
        signatureB64: string | null;
    };
    creator: {
        name: string | null;
        email: string | null;
    };
    assignee: {
        name: string | null;
        email: string | null;
        phone: string | null;
        signatureB64: string | null;
        role: string | null;
    } | null;
    salesOrders: {
        id: number;
        idInDomain: number | null;
        name: string | null;
    }[];
    invoiceTerms: string | null;
    requoteReason: string;
    domain: {
        name: string | null;
        address: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
        logoUrl?: (string | undefined) | null;
        customInputs: {
            [x: string]: any;
        } | null;
    } | null;
    customer: {
        name: string;
        shortName: string | null;
        salesTaxable: boolean | null;
        logoUrl?: (string | undefined) | null;
        salesTax: {
            id: number;
            name: string | null;
            description: string | null;
        } | null;
        customInputs: {
            [x: string]: any;
        } | null;
    } | null;
    customerAddress: {
        id: number;
        address: string;
    } | null;
    shipToAddress: string | null;
    signatureReceivedB64: string | null;
    signatureReceivedPrintedName: string | null;
    signatureReceivedSignedAt: string | null;
    signingKey: string;
    customerContact: {
        name: string | null;
        email: string | null;
        phone: string | null;
        address: string | null;
        isQuotingContact: boolean | null;
    } | null;
    partLineItems: {
        index: number;
        lineNumber: number | null;
        id: number;
        description: string | null;
        priceCents: number | null;
        priceMicrodollars: number | null;
        customInputs: null | {
            [x: string]: any;
        };
        quantity: number | null;
        usePartNumberDescription?: boolean | undefined;
        parentQuotePartNumberPriceId: number | null;
        quoteLineId: number | null;
        selectedUnitConversion: {
            id: number;
            name: string;
            factor: number;
        } | null;
        quoteTieredPricing: {
            title: string | null;
            price: number | null;
            quantity: number | null;
        }[] | null;
        partNumber: {
            id: number;
            name: string;
            descriptionMarkdown: string | null;
            customerFacingNotes: string | null;
            customInputs: null | {
                [x: string]: any;
            };
            displayImageUrl: string | null;
            partNumberGroup: {
                id: number;
                name: string | null;
            } | null;
            certificationDescription: string | null;
            partNumberInventoryItem: {
                id: number;
                material: {
                    id: number;
                    alloy: {
                        id: number;
                        name: string;
                    } | null;
                    substrate: {
                        id: number;
                        name: string;
                    } | null;
                    temper: {
                        id: number;
                        name: string;
                    } | null;
                } | null;
            } | null;
            specs: {
                id: number;
                name: string;
                type: string | null;
                classificationSet: {
                    id: number;
                    classificationsInSetString: string;
                    classificationSetClassifications: {
                        id: number;
                        classification: {
                            id: number;
                            name: string;
                        } | null;
                    }[];
                } | null;
            }[] | null;
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
            partNumberUnitConversions: {
                factor: number | null;
                unitByUnitId: {
                    id: number | null;
                    name: string | null;
                    mustBeInteger: boolean | null;
                } | null;
            }[] | null;
        } | null;
        process: {
            id: number;
            name: string;
            description: string;
        } | null;
        treatmentSelections: {
            treatment: {
                id: number;
                name: string;
                accountingProduct: {
                    id: number | null;
                    name: string | null;
                    glAccount: {
                        accountNumber: string | null;
                        description: string | null;
                        type: string | null;
                    } | null;
                } | null;
                treatmentGroupCustomInputs: {
                    [x: string]: any;
                } | null;
                treatmentGroup: {
                    id: number;
                    name: string;
                    accountingProduct: {
                        id: number | null;
                        name: string | null;
                        glAccount: {
                            accountNumber: string | null;
                            description: string | null;
                            type: string | null;
                        } | null;
                    } | null;
                } | null;
                prices: {
                    id: number;
                    name: string;
                    type: string | null;
                    price: number | null;
                    unit: {
                        id: number;
                        name: string;
                    } | null;
                    valueUnit: {
                        id: number;
                        name: string;
                    } | null;
                }[];
                inventoryItems: {
                    id: number;
                    name: string;
                    customInputs: {
                        [x: string]: any;
                    } | null;
                    descriptionMarkdown: string | null;
                    inventoryItemVendors: {
                        vendorItemName: string | null;
                        vendor: {
                            id: number | null;
                            name: string | null;
                        };
                    }[] | null;
                }[];
            } | null;
            process: {
                id: number;
                name: string;
                type: string;
                product: {
                    id: number;
                    name: string;
                } | null;
                leadTimeDays: number | null;
                instructions: string | null;
            } | null;
        }[];
        treatmentSelectionsWithDefaults: {
            treatment: {
                id: number;
                name: string;
                accountingProduct: {
                    id: number | null;
                    name: string | null;
                    glAccount: {
                        accountNumber: string | null;
                        description: string | null;
                        type: string | null;
                    } | null;
                } | null;
                treatmentGroupCustomInputs: {
                    [x: string]: any;
                } | null;
                treatmentGroup: {
                    id: number;
                    name: string;
                    accountingProduct: {
                        id: number | null;
                        name: string | null;
                        glAccount: {
                            accountNumber: string | null;
                            description: string | null;
                            type: string | null;
                        } | null;
                    } | null;
                } | null;
                prices: {
                    id: number;
                    name: string;
                    type: string | null;
                    price: number | null;
                    unit: {
                        id: number;
                        name: string;
                    } | null;
                    valueUnit: {
                        id: number;
                        name: string;
                    } | null;
                }[];
                inventoryItems: {
                    id: number;
                    name: string;
                    customInputs: {
                        [x: string]: any;
                    } | null;
                    descriptionMarkdown: string | null;
                    inventoryItemVendors: {
                        vendorItemName: string | null;
                        vendor: {
                            id: number | null;
                            name: string | null;
                        };
                    }[] | null;
                }[];
            } | null;
            process: {
                id: number;
                name: string;
                type: string;
                product: {
                    id: number;
                    name: string;
                } | null;
                leadTimeDays: number | null;
                instructions: string | null;
            } | null;
        }[];
        additionalLineItems: {
            title: string | null;
            price: {
                amount: number | null;
                currency: string;
            };
            category: string | null;
        }[];
        priceBuilderItems: {
            productId: number | null;
            productName: string | null;
            priceName: string | null;
            priceType: string | null;
            price: number | null;
            qty: number | null;
            operation: string | null;
            lineTotal: number | null;
            treatmentId: number | null;
            productTab: {
                productId: number | null;
                name: string | null;
                glAccountId: number | null;
            };
        }[];
    }[];
    quoteLines: {
        id: number;
        lineNumber: number;
        title: string | null;
        description: string | null;
        unitPrice: number | null;
        quantity: number | null;
        unit: string | null;
        category?: ({
            name: string;
            displayOrder: number;
            hidePriceOnPdf: boolean;
        } | null) | undefined;
        quoteLineItems: {
            productByProductId: {
                id: number;
                name: string;
            } | null;
            title: string | null;
            description: string | null;
            quantity: number | null;
            price: number | null;
            unit: {
                id: number;
                name: string;
            } | null;
            total: number | null;
            linkedPartNumberPrices: {
                index: number;
                lineNumber: number | null;
                id: number;
                description: string | null;
                priceCents: number | null;
                priceMicrodollars: number | null;
                customInputs: null | {
                    [x: string]: any;
                };
                quantity: number | null;
                usePartNumberDescription?: boolean | undefined;
                parentQuotePartNumberPriceId: number | null;
                quoteLineId: number | null;
                selectedUnitConversion: {
                    id: number;
                    name: string;
                    factor: number;
                } | null;
                quoteTieredPricing: {
                    title: string | null;
                    price: number | null;
                    quantity: number | null;
                }[] | null;
                partNumber: {
                    id: number;
                    name: string;
                    descriptionMarkdown: string | null;
                    customerFacingNotes: string | null;
                    customInputs: null | {
                        [x: string]: any;
                    };
                    displayImageUrl: string | null;
                    partNumberGroup: {
                        id: number;
                        name: string | null;
                    } | null;
                    certificationDescription: string | null;
                    partNumberInventoryItem: {
                        id: number;
                        material: {
                            id: number;
                            alloy: {
                                id: number;
                                name: string;
                            } | null;
                            substrate: {
                                id: number;
                                name: string;
                            } | null;
                            temper: {
                                id: number;
                                name: string;
                            } | null;
                        } | null;
                    } | null;
                    specs: {
                        id: number;
                        name: string;
                        type: string | null;
                        classificationSet: {
                            id: number;
                            classificationsInSetString: string;
                            classificationSetClassifications: {
                                id: number;
                                classification: {
                                    id: number;
                                    name: string;
                                } | null;
                            }[];
                        } | null;
                    }[] | null;
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
                    partNumberUnitConversions: {
                        factor: number | null;
                        unitByUnitId: {
                            id: number | null;
                            name: string | null;
                            mustBeInteger: boolean | null;
                        } | null;
                    }[] | null;
                } | null;
                process: {
                    id: number;
                    name: string;
                    description: string;
                } | null;
                treatmentSelections: {
                    treatment: {
                        id: number;
                        name: string;
                        accountingProduct: {
                            id: number | null;
                            name: string | null;
                            glAccount: {
                                accountNumber: string | null;
                                description: string | null;
                                type: string | null;
                            } | null;
                        } | null;
                        treatmentGroupCustomInputs: {
                            [x: string]: any;
                        } | null;
                        treatmentGroup: {
                            id: number;
                            name: string;
                            accountingProduct: {
                                id: number | null;
                                name: string | null;
                                glAccount: {
                                    accountNumber: string | null;
                                    description: string | null;
                                    type: string | null;
                                } | null;
                            } | null;
                        } | null;
                        prices: {
                            id: number;
                            name: string;
                            type: string | null;
                            price: number | null;
                            unit: {
                                id: number;
                                name: string;
                            } | null;
                            valueUnit: {
                                id: number;
                                name: string;
                            } | null;
                        }[];
                        inventoryItems: {
                            id: number;
                            name: string;
                            customInputs: {
                                [x: string]: any;
                            } | null;
                            descriptionMarkdown: string | null;
                            inventoryItemVendors: {
                                vendorItemName: string | null;
                                vendor: {
                                    id: number | null;
                                    name: string | null;
                                };
                            }[] | null;
                        }[];
                    } | null;
                    process: {
                        id: number;
                        name: string;
                        type: string;
                        product: {
                            id: number;
                            name: string;
                        } | null;
                        leadTimeDays: number | null;
                        instructions: string | null;
                    } | null;
                }[];
                treatmentSelectionsWithDefaults: {
                    treatment: {
                        id: number;
                        name: string;
                        accountingProduct: {
                            id: number | null;
                            name: string | null;
                            glAccount: {
                                accountNumber: string | null;
                                description: string | null;
                                type: string | null;
                            } | null;
                        } | null;
                        treatmentGroupCustomInputs: {
                            [x: string]: any;
                        } | null;
                        treatmentGroup: {
                            id: number;
                            name: string;
                            accountingProduct: {
                                id: number | null;
                                name: string | null;
                                glAccount: {
                                    accountNumber: string | null;
                                    description: string | null;
                                    type: string | null;
                                } | null;
                            } | null;
                        } | null;
                        prices: {
                            id: number;
                            name: string;
                            type: string | null;
                            price: number | null;
                            unit: {
                                id: number;
                                name: string;
                            } | null;
                            valueUnit: {
                                id: number;
                                name: string;
                            } | null;
                        }[];
                        inventoryItems: {
                            id: number;
                            name: string;
                            customInputs: {
                                [x: string]: any;
                            } | null;
                            descriptionMarkdown: string | null;
                            inventoryItemVendors: {
                                vendorItemName: string | null;
                                vendor: {
                                    id: number | null;
                                    name: string | null;
                                };
                            }[] | null;
                        }[];
                    } | null;
                    process: {
                        id: number;
                        name: string;
                        type: string;
                        product: {
                            id: number;
                            name: string;
                        } | null;
                        leadTimeDays: number | null;
                        instructions: string | null;
                    } | null;
                }[];
                additionalLineItems: {
                    title: string | null;
                    price: {
                        amount: number | null;
                        currency: string;
                    };
                    category: string | null;
                }[];
                priceBuilderItems: {
                    productId: number | null;
                    productName: string | null;
                    priceName: string | null;
                    priceType: string | null;
                    price: number | null;
                    qty: number | null;
                    operation: string | null;
                    lineTotal: number | null;
                    treatmentId: number | null;
                    productTab: {
                        productId: number | null;
                        name: string | null;
                        glAccountId: number | null;
                    };
                }[];
            }[];
        }[];
        priceTiers: {
            minQty: number | null;
            maxQty: number | null;
            price: number;
            unitPriceAfterMin: number;
            tierItems: {
                title: string | null;
                quantity: number;
                unitPrice: number;
                totalPrice: number;
            }[];
        }[];
    }[];
    quoteLineGroups?: {
        category: {
            name: string;
            hidePriceOnPdf: boolean;
        } | null;
        totalAmount: number;
        quoteLines: {
            id: number;
            lineNumber: number;
            title: string | null;
            description: string | null;
            unitPrice: number | null;
            quantity: number | null;
            unit: string | null;
            quoteLineItems: {
                productByProductId: {
                    id: number;
                    name: string;
                } | null;
                title: string | null;
                description: string | null;
                quantity: number | null;
                price: number | null;
                unit: {
                    id: number;
                    name: string;
                } | null;
                total: number | null;
                linkedPartNumberPrices: {
                    index: number;
                    lineNumber: number | null;
                    id: number;
                    description: string | null;
                    priceCents: number | null;
                    priceMicrodollars: number | null;
                    customInputs: null | {
                        [x: string]: any;
                    };
                    quantity: number | null;
                    usePartNumberDescription?: boolean | undefined;
                    parentQuotePartNumberPriceId: number | null;
                    quoteLineId: number | null;
                    selectedUnitConversion: {
                        id: number;
                        name: string;
                        factor: number;
                    } | null;
                    quoteTieredPricing: {
                        title: string | null;
                        price: number | null;
                        quantity: number | null;
                    }[] | null;
                    partNumber: {
                        id: number;
                        name: string;
                        descriptionMarkdown: string | null;
                        customerFacingNotes: string | null;
                        customInputs: null | {
                            [x: string]: any;
                        };
                        displayImageUrl: string | null;
                        partNumberGroup: {
                            id: number;
                            name: string | null;
                        } | null;
                        certificationDescription: string | null;
                        partNumberInventoryItem: {
                            id: number;
                            material: {
                                id: number;
                                alloy: {
                                    id: number;
                                    name: string;
                                } | null;
                                substrate: {
                                    id: number;
                                    name: string;
                                } | null;
                                temper: {
                                    id: number;
                                    name: string;
                                } | null;
                            } | null;
                        } | null;
                        specs: {
                            id: number;
                            name: string;
                            type: string | null;
                            classificationSet: {
                                id: number;
                                classificationsInSetString: string;
                                classificationSetClassifications: {
                                    id: number;
                                    classification: {
                                        id: number;
                                        name: string;
                                    } | null;
                                }[];
                            } | null;
                        }[] | null;
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
                        partNumberUnitConversions: {
                            factor: number | null;
                            unitByUnitId: {
                                id: number | null;
                                name: string | null;
                                mustBeInteger: boolean | null;
                            } | null;
                        }[] | null;
                    } | null;
                    process: {
                        id: number;
                        name: string;
                        description: string;
                    } | null;
                    treatmentSelections: {
                        treatment: {
                            id: number;
                            name: string;
                            accountingProduct: {
                                id: number | null;
                                name: string | null;
                                glAccount: {
                                    accountNumber: string | null;
                                    description: string | null;
                                    type: string | null;
                                } | null;
                            } | null;
                            treatmentGroupCustomInputs: {
                                [x: string]: any;
                            } | null;
                            treatmentGroup: {
                                id: number;
                                name: string;
                                accountingProduct: {
                                    id: number | null;
                                    name: string | null;
                                    glAccount: {
                                        accountNumber: string | null;
                                        description: string | null;
                                        type: string | null;
                                    } | null;
                                } | null;
                            } | null;
                            prices: {
                                id: number;
                                name: string;
                                type: string | null;
                                price: number | null;
                                unit: {
                                    id: number;
                                    name: string;
                                } | null;
                                valueUnit: {
                                    id: number;
                                    name: string;
                                } | null;
                            }[];
                            inventoryItems: {
                                id: number;
                                name: string;
                                customInputs: {
                                    [x: string]: any;
                                } | null;
                                descriptionMarkdown: string | null;
                                inventoryItemVendors: {
                                    vendorItemName: string | null;
                                    vendor: {
                                        id: number | null;
                                        name: string | null;
                                    };
                                }[] | null;
                            }[];
                        } | null;
                        process: {
                            id: number;
                            name: string;
                            type: string;
                            product: {
                                id: number;
                                name: string;
                            } | null;
                            leadTimeDays: number | null;
                            instructions: string | null;
                        } | null;
                    }[];
                    treatmentSelectionsWithDefaults: {
                        treatment: {
                            id: number;
                            name: string;
                            accountingProduct: {
                                id: number | null;
                                name: string | null;
                                glAccount: {
                                    accountNumber: string | null;
                                    description: string | null;
                                    type: string | null;
                                } | null;
                            } | null;
                            treatmentGroupCustomInputs: {
                                [x: string]: any;
                            } | null;
                            treatmentGroup: {
                                id: number;
                                name: string;
                                accountingProduct: {
                                    id: number | null;
                                    name: string | null;
                                    glAccount: {
                                        accountNumber: string | null;
                                        description: string | null;
                                        type: string | null;
                                    } | null;
                                } | null;
                            } | null;
                            prices: {
                                id: number;
                                name: string;
                                type: string | null;
                                price: number | null;
                                unit: {
                                    id: number;
                                    name: string;
                                } | null;
                                valueUnit: {
                                    id: number;
                                    name: string;
                                } | null;
                            }[];
                            inventoryItems: {
                                id: number;
                                name: string;
                                customInputs: {
                                    [x: string]: any;
                                } | null;
                                descriptionMarkdown: string | null;
                                inventoryItemVendors: {
                                    vendorItemName: string | null;
                                    vendor: {
                                        id: number | null;
                                        name: string | null;
                                    };
                                }[] | null;
                            }[];
                        } | null;
                        process: {
                            id: number;
                            name: string;
                            type: string;
                            product: {
                                id: number;
                                name: string;
                            } | null;
                            leadTimeDays: number | null;
                            instructions: string | null;
                        } | null;
                    }[];
                    additionalLineItems: {
                        title: string | null;
                        price: {
                            amount: number | null;
                            currency: string;
                        };
                        category: string | null;
                    }[];
                    priceBuilderItems: {
                        productId: number | null;
                        productName: string | null;
                        priceName: string | null;
                        priceType: string | null;
                        price: number | null;
                        qty: number | null;
                        operation: string | null;
                        lineTotal: number | null;
                        treatmentId: number | null;
                        productTab: {
                            productId: number | null;
                            name: string | null;
                            glAccountId: number | null;
                        };
                    }[];
                }[];
            }[];
            priceTiers: {
                minQty: number | null;
                maxQty: number | null;
                price: number;
                unitPriceAfterMin: number;
                tierItems: {
                    title: string | null;
                    quantity: number;
                    unitPrice: number;
                    totalPrice: number;
                }[];
            }[];
        }[];
    }[] | undefined;
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