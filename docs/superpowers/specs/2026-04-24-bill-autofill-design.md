# Bill Autofill — Spec de diseño

## Estado: Implementado (v0.4.83, 2026-04-24)

## Contexto

Los usuarios de Ecoplating crean facturas de proveedores (Bills) en Steelhead frecuentemente desde Purchase Orders. Actualmente deben seleccionar manualmente la cuenta AP, la cuenta de gastos por línea, la divisa y el tipo de cambio. Este applet automatiza ese llenado, ahorrando tiempo y reduciendo errores contables.

## Objetivo

Auto-llenar los campos contables de un Bill al seleccionar vendor:
- **Cuenta AP**: fuzzy match del nombre del vendor contra catálogo de cuentas payable, desambiguando por divisa
- **Divisa**: inferida de PO > vendor customInputs (DivisaMXN/DivisaUSD, preferencia USD) > default USD
- **Tipo de Cambio**: del array TipoCambio del dominio, por fecha de Invoice Date (o hoy). MXN = 1 siempre
- **Cuentas de Gasto por línea**: fuzzy match del nombre de línea contra cuentas expense, con aprendizaje en localStorage

## Arquitectura

### Script: `remote/scripts/bill-autofill.js` (1235 líneas)

Patrón: IIFE → `window.BillAutofill` con auto-init
Dependencia: `SteelheadAPI`
Auto-inject: `true`

### App en config.json

```json
{
  "id": "bill-autofill",
  "name": "Bill Autofill",
  "subtitle": "Llenado automático de cuentas contables en facturas de proveedores",
  "icon": "🧾",
  "category": "Facturación",
  "scripts": ["scripts/steelhead-api.js", "scripts/bill-autofill.js"],
  "autoInject": true
}
```

### Archivos modificados

| Archivo | Cambio |
|---|---|
| `remote/scripts/bill-autofill.js` | Nuevo — script principal |
| `remote/config.json` | Hashes GraphQL, app entry, version bump |
| `extension/background.js` | Global `BillAutofill`, toggle handlers |

## Flujo principal

```
init()
  ├── patchFetch() — interceptor de GraphQL para capturar POs y aprender de saves
  ├── setupUrlListener() — monkey-patch history.pushState/replaceState
  └── checkUrl()
        └── /Domains/N/Bills/ → setupPageObserver()
              └── MutationObserver (500ms debounce) → scanForBillPage()
                    ├── Heading "Create Bill" / "Edit Bill" detection
                    ├── installDivisaListener() — event listener en #root_DatosContables_Divisa
                    ├── Vendor detection → runAutofill()
                    ├── Divisa scan fallback
                    ├── Line count monitor
                    └── Invoice Date monitor → fillTCById()
```

### runAutofill() → _runAutofillInner()

```
_runAutofillInner()
  ├── Promise.all([fetchExchangeRate(), fetchAccounts(), loadExpenseMapping(), fetchVendorDivisas()])
  ├── Currency resolution: DOM (si scriptSetDivisa) > PO > vendor > default USD
  ├── TC resolution: MXN=1, else findRateForDate(invoiceDate || today)
  ├── findBestAPAccount(vendorName, currency, accounts)
  ├── Line accounts: learned (localStorage) > fuzzy match > none
  ├── fillAllFields() — visual fill de comboboxes y selects
  └── Sync lastDetectedDivisa con DOM post-fill
```

## Queries GraphQL usadas

| Operación | Uso |
|---|---|
| `GetDomain` | TipoCambio array, userId |
| `GetAccountDataForBill` | Catálogo completo de cuentas |
| `GetPurchaseOrder` | Divisa del PO (customInputs.DatosReferencia.Divisa) |
| `SearchVendors` | Buscar vendor por nombre |
| `GetVendor` | customInputs.DatosContablesProv (DivisaMXN/DivisaUSD) |
| `SearchPurchaseOrdersForBill` | Interceptar POs (líneas y divisa) |
| `GetBillByIdInDomain` | customInputs existentes en Edit Bill |
| `CreateUpdateBill` | Interceptar para inyectar divisa/TC faltantes + aprendizaje |

## Componentes RJSF (Entradas Personalizadas)

Los campos de "Datos Contables" viven dentro de un formulario RJSF (React JSON Schema Form) en la sección "Entradas Personalizadas". Esto tiene implicaciones importantes:

- **Divisa**: `<select id="root_DatosContables_Divisa">` — native select con `role="combobox"`, clase `form-control`
- **Tipo de Cambio**: `<input id="root_DatosContables_exchangeRate">` — input text con clase `form-control`

### Problema RJSF: re-render en cascada

Cuando el usuario cambia la divisa, RJSF re-renderiza **todos** los campos del fieldset `DatosContables`, incluyendo TC. Esto sobreescribe cualquier valor que hayamos seteado programáticamente en TC.

**Solución implementada**: Event listener nativo en el select de divisa (`installDivisaListener`) + fill directo por ID (`fillTCById`) con retries a 300ms, 800ms y 1500ms para sobrevivir los re-renders de RJSF.

## Llenado visual de controles

### React Select (AP Account, Expense Account)

```
tryFillCombobox(labelText, searchText, targetAccountName)
  └── Walk up from label → find input[role="combobox"]
        └── clickAndSelectOption(control, container, searchText, target)
              ├── Click control to open
              ├── Type search text via nativeInputValueSetter
              ├── Wait for menu options (up to 10 × 200ms)
              └── pickBestOption() — token overlap scoring
```

### Native Select (Divisa)

```
tryFillNativeSelect(sel, searchText, targetName)
  ├── Reset _valueTracker (React)
  ├── nativeSelectSetter.call(sel, opt.value)
  └── Dispatch 'change' event
```

### Text Input (Tipo de Cambio)

```
tryFillTextInput(labelText, value) — para label-walking genérico
fillTCById(rate) — fill directo por ID (preferido para TC)
  ├── Reset _valueTracker
  ├── nativeInputSetter.call(inp, String(value))
  └── Dispatch 'input' + 'change' events
```

### Expense Account en línea

```
tryFillExpenseInLine(lineName, searchText, targetAccountName)
  ├── Find Name input by value match
  ├── Walk up to find ancestor with sub-table containing "Expense Account"
  ├── Find column index of "Expense Account" header
  └── Find combobox in data row at that column → clickAndSelectOption()
```

## Gestión de estado

### Divisa: prioridad de fuentes

1. DOM (solo si `scriptSetDivisa` está seteado — es decir, después del primer fill)
2. PO interceptada (`state.poDivisa`)
3. Vendor customInputs (`DivisaUSD` preferido sobre `DivisaMXN`)
4. Default: `USD`

### Tipo de Cambio

- MXN → siempre 1
- USD → `findRateForDate(invoiceDate || today)` del array `TipoCambio` del dominio
- Actualización automática al cambiar Invoice Date (scan loop monitor)
- Actualización automática al cambiar Divisa (event listener directo)
- Panel muestra la fecha del TC usado

### React heading flicker

React puede destruir brevemente el heading "Create Bill" durante re-renders. Para distinguir flicker de navegación real:
- `headingLostAt` guarda timestamp cuando heading desaparece
- Si heading reaparece en <3 segundos → preservar estado (flicker)
- Si >3 segundos → reset total (navegación real)

### Aprendizaje de cuentas de gasto

Al guardar un Bill exitosamente (interceptor de `CreateUpdateBill`), se guarda en `localStorage` el mapeo `lineName → { accountId, accountName, count, lastUsed }`. En bills futuros, las líneas con el mismo nombre usan la cuenta aprendida.

## Panel UI

Panel `position:fixed` centrado abajo, colapsable, fondo oscuro (#1e293b). Muestra:
- Divisa (con fuente: form/po/vendor/default)
- Tipo de Cambio (con fecha del TC usado)
- Cuenta AP
- Gastos por línea (si hay)

Estados: ✓ verde (resuelto), ~ amarillo (ambiguo), ✗ rojo (no resuelto), ★ azul (aprendido), … gris (buscando).

## Bugs resueltos durante desarrollo

| Versión | Bug | Causa raíz | Solución |
|---|---|---|---|
| 0.4.71 | AP Account se llenaba con Divisa | `tryFillCombobox` buscaba `<select>` antes de React Select | Buscar `input[role="combobox"]` primero en cada nivel |
| 0.4.71 | Divisa matcheaba opción vacía | `"usd".includes("")` = true | Skip opciones con texto normalizado vacío |
| 0.4.71 | Expense Account no se llenaba | Name input no está dentro del `<table>` de Expense | Walk up desde Name input hasta ancestro con sub-tabla |
| 0.4.73 | Quimetal mostraba MXN (default form) | `extractDivisaFromDOM()` leía default de Steelhead | `scriptSetDivisa` tracking: antes de primer fill → inferir |
| 0.4.77 | React flicker reseteaba estado | Heading desaparece brevemente → `lastDetectedVendor = null` | No resetear vendor state en heading flicker |
| 0.4.80 | Panel persistía en lista de Bills | `removePanel()` removido del not-found path | Agregar `removePanel()` + `headingLostAt` timestamp |
| 0.4.80-82 | Cambiar divisa no actualizaba TC | RJSF re-renderiza todos los custom inputs al cambiar divisa | Event listener directo + `fillTCById` con retries |
| 0.4.83 | Estado persistía entre sesiones de Create Bill | Sin reset al cerrar/reabrir form | `headingLostAt` >3s → `resetBillState()` |

## Interceptor de fetch

Monkey-patch de `window.fetch` con sentinel `__saBillAutofillFetchPatched`:

- **Outgoing `CreateUpdateBill`**: inyecta `customInputs.DatosContables.Divisa` y `exchangeRate` si faltan
- **Incoming `SearchPurchaseOrdersForBill`/`GetPurchaseOrdersDataForBill`**: captura líneas de PO y dispara `fetchPODivisa`
- **Incoming `GetBillByIdInDomain`**: captura customInputs existentes
- **Incoming `CreateUpdateBill` exitoso**: aprendizaje de cuentas de gasto
