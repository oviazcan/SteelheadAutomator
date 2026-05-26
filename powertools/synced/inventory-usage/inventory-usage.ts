const getInventoryItemPredictedUsageCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult  => {

	return result;
}

type LowCodeResult = {
    partNumberId: number;
    inventoryItemId: number;
    quantityPerPart: number;
    treatmentId?: (number | null) | undefined;
    processNodeId?: (number | null) | undefined;
    processNodeOccurrence?: (number | null) | undefined;
    costPerUnit?: (number | null) | undefined;
    productId?: (number | null) | undefined;
}[];

interface Inputs {
    inventoryItemPartNumberData: {
        partNumber: {
            name: string;
            id: number;
            defaultPrice: {
                priceMicrodollars?: (number | null) | undefined;
                unitByUnitId: {
                    id: number;
                    name?: (string | null) | undefined;
                } | null;
            } | null;
            latestWorkOrderMicrodollarsPerPart?: (number | null) | undefined;
            customInputs: {
                DatosFacturacion?: {
                    CodigoSAT?: ("73181106 - Servicios de enchapado" | "73181109 - Servicios de niquelado" | "73181119 - Servicio de recubrimiento con pintura en polvo" | "73151500 - Servicios de ensamble" | "73151506 - Servicio de subensamble o ensamble definitivo" | "11191500 - Cuerpos s\u00F3lidos de metal" | "30262200 - Barras de cobre" | "31281500 - Componentes estampados" | "31281813 - Componentes de cobre perforados" | "39121400 - Leng\u00FCetas de conexi\u00F3n, conectadores y terminales") | undefined;
                } | undefined;
                NotasAdicionales?: string | undefined;
                DatosAdicionalesNP?: {
                    Plano?: string | undefined;
                    BaseMetal?: ("Cobre" | "Aluminio" | "Fierro" | "Lat\u00F3n" | "Acero Inoxidable" | "Bronce" | "Bimet\u00E1lica" | "Varios") | undefined;
                    QuoteIBMS?: string | undefined;
                    EstacionIBMS?: string | undefined;
                    NumeroParteAlterno?: string[] | undefined;
                } | undefined;
                DatosPlanificacion?: {
                    CargasHora?: string | undefined;
                    PiezasCarga?: number | undefined;
                    montoMinimo?: number | undefined;
                    TiempoEntrega?: number | undefined;
                } | undefined;
            };
            unitConversions: {
                factor: number;
                unit: {
                    id: number;
                    name: string;
                };
            }[];
            partNumberSpecFields: {
                id: number;
                maximumValue?: (number | null) | undefined;
                minimumValue?: (number | null) | undefined;
                samplingRate?: (number | null) | undefined;
                targetValue?: (number | null) | undefined;
                specFieldBySpecFieldId?: ({
                    name: string;
                    id: number;
                    specBySpecId?: ({
                        id: number;
                        name: string;
                    } | null) | undefined;
                } | null) | undefined;
            }[];
            latestQuoteData: {
                quotePartNumberCustomInputs: null;
                partNumberPriceTreatments: {
                    quotePartNumberTreatmentCustomInputs: null;
                }[];
            }[];
        };
        selectedTreatments: {
            id: number;
            name: string;
            partsToWhole: number;
        }[];
        inventoryItem: {
            id: number;
            name: string;
            customInputs: {
                Densidad: number;
                DatosFiscales?: {
                    CodigoSAT?: ("12352117 - Cianuros o isocianuros" | "12352121 - Hidr\u00F3xidos org\u00E1nicos" | "23281500 - M\u00E1quinas para recubrir o platear" | "23281800 - Accesorios y herramientas para el tratamiento de metal" | "24101602 - Montacargas" | "24112100 - Toneles, cubas y bidones" | "24112800 - Contenedores de carga" | "25111714 - Embarcaci\u00F3n de desembarque de uso general" | "41111621 - Calibradores" | "43211500 - Computadores (computadoras)" | "72121000 - Servicios de construcci\u00F3n de edificios industriales y bodegas nuevas" | "73152100 - Servicios de mantenimiento y reparaci\u00F3n de equipo de manufactura" | "78101800 - Transporte de carga por carretera" | "78121603 - Tarifa de los fletes" | "84111506 - Servicios de facturaci\u00F3n") | undefined;
                } | undefined;
                "Cuenta Contable": string;
            };
            unit?: ({
                id: number;
                name: string;
            } | null) | undefined;
            inventoryType: {
                id: number;
                name: string;
            };
            inventoryTransforms: {
                id: number;
                quantity: number | null;
                unitByUnitId: {
                    id: number;
                    name: string;
                } | null;
                inputs: {
                    id: number;
                    quantity: number | null;
                    unitByUnitId: {
                        id: number;
                        name: string;
                    } | null;
                    inventoryItemByInventoryItemId: {
                        id: number;
                        name: string;
                    } | null;
                }[];
            }[] | null;
        };
    }[];
    unitConversions: {
        fromId: number;
        toId: number;
        factor: number;
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