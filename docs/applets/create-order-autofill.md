# `create-order-autofill` — bitácora

Auto-llena las Entradas Personalizadas (`Razón Social de la Venta`, `Divisa`, `Consolidar por Producto`) del modal de creación de OV. Sustituye al canal write de OV customInputs que no existe en `ordendeventa.ts` (ver bitácoras `powertools-ordendeventa.md` y `powertools-facturacion.md`, ahora en el repo **SteelheadPowerTools**).

**Dos pantallas cubiertas** (mismos IDs RJSF debajo → mismo autofill):
1. `/Receiving/CustomerParts → RECEIVE → +/Create` — título **"Crear Orden de Venta"** (ES). Cliente pre-cargado; expone **"Enviar a:"** (ship-to) → maneja Consolidar.
2. `/Domains/<id>/SalesOrders → "New Sales Order"` — título **"Create Sales Order"** (EN). Cliente **vacío** al abrir (el operador lo elige a mano); **sin ship-to** → Consolidar no aplica.

## Add 2026-07-09 (v0.1.3) — segunda pantalla: lista de Órdenes de Venta ("New Sales Order")

Cerrado el pendiente "Segunda vista de creación de OV". El usuario indicó la pantalla `https://app.gosteelhead.com/Domains/344/SalesOrders?receivedOrderStatusFilter=OPEN` con el botón **"New Sales Order"** que abre el modal **"Create Sales Order"** (mismos IDs RJSF `root_RazonSocialVenta`/`root_Divisa`/`root_VerificadaPor`/`root_ConsolidarPorProducto`).

**Diferencias del modal nuevo vs. el de Receiving (confirmadas con el HTML real que pasó el usuario):**
- **Título en inglés** ("Create Sales Order") vs. español ("Crear Orden de Venta"). El heading vive en un `<h2 …MuiDialogTitle-root…>` con `<div>Create Sales Order</div>` adentro; el paper del diálogo trae `role="dialog"` → `getModalRoot()` ancla sin cambios.
- **Cliente vacío al abrir** (react-select con placeholder "Select..."). No hay `singleValue` con `(#N)` hasta que el operador elige → el applet **espera en silencio** (antes mostraba panel "✗ sin idInDomain"); cuando llega la selección el `MutationObserver` (childList) dispara el re-scan, la firma cambia y corre el autofill.
- **Sin "Enviar a:"** → Consolidar se marca como **omitido** (gris "no aplica (sin destino en esta pantalla)"), no como fallo rojo. Misma consecuencia neta que en Receiving cuando el destino no es Rojo Gómez (checkbox queda en el default RJSF=false).
- Campo extra `root_VerificadaPor` (select "Anhuar Silva / Roberto Orozco / Sergio Hernández"): **no se autollena** (no hay fuente en `DatosFactura`; es quién verificó la venta). No rompe la firma del modal (esta exige presencia de los 3 IDs, no ausencia de otros).

**Cambios (todos mínimos, mismos selectores):**
1. `matchesCreateOrderUrl(pathname)` (core, nuevo): gatea `/Receiving/CustomerParts(/|$)` **o** `/Domains/<id>/SalesOrders/?$` (anclado al final → solo la LISTA, no páginas de detalle `/SalesOrders/<n>`; el modal abre sobre la lista sin cambiar la URL, la query vive en `location.search`).
2. `isCreateOrderModalHeading(text)` (core, nuevo): acepta ES **y** EN.
3. El glue usa esos helpers vía `urlMatches()`/`headingMatches()` (fallback a regex local si el core no cargara). Las constantes `URL_RE`/`MODAL_HEADING_RE` quedan solo como fallback, en sync con el core.
4. Panel silencioso mientras no haya cliente elegido; Consolidar omitido sin ship-to.

**Validación:** core **14/14 verde** (2 tests nuevos: heading ES/EN + gate de URL incl. rechazo de `/SalesOrders/9876` y dominio no-numérico). **Pendiente:** run real en la pantalla SalesOrders (que el operador confirme Razón Social + Divisa al elegir un cliente con `DatosFactura` configurado).

## Fix 2026-07-03 (v0.1.2) — `getModalRoot()` devolvía el TÍTULO (substring `MuiDialog`)

**Síntoma:** tras el fix v0.1.1, el panel SEGUÍA mostrando `(sin cliente) → (sin shipTo)` y `✗ sin idInDomain` para todos los clientes (reproducido en vivo con HUBBELL PRODUCTS MEXICO (#20)). El `singleValue` del cliente estaba presente en pantalla con su badge `(#20)`.

**Root cause (confirmado con diagnóstico en vivo, no adivinado):** `getModalRoot()` arrancaba el ascenso **en el heading mismo** (`let cur = h`) y aceptaba como root cualquier `[class*="MuiDialog"]`. Pero el heading es un `<h2 class="MuiTypography-root MuiTypography-h6 MuiDialogTitle-root css-…">`, y **`MuiDialogTitle-root` contiene el substring `"MuiDialog"`** → matcheaba el TÍTULO (vacío) en la iteración 0 y lo devolvía como root. Diagnóstico:
- `getModalRoot()` → `H2.MuiDialogTitle-root` (¡el título!), `svInRoot: 0`.
- Los 7 `singleValue` del modal (incluido `HUBBELL PRODUCTS MEXICO (#20)`) vivían en el `MuiDialog-paper`, un nivel arriba del título. Por eso `collectSingleValueTexts(root)=[]` → `pickCustomerFromSingleValues([])=null` → `null` → "sin idInDomain". Como `extractShipToFromModal` también depende de `getModalRoot()`, el shipTo salía vacío igual.
- Referencia que sí funcionaba: `weight-quick-entry` ancla al wizard **externo** ("Recibir piezas del cliente") y por eso resolvió `idInDomain=20` en el mismo modal (log `[WQE] usarLBS=false (via Customer idInDomain=20)`).

**Fix:**
1. `getModalRoot()` ahora arranca el ascenso **en `h.parentElement`** (nunca evalúa el heading, que es el cebo) y acepta como root **solo el paper/contenedor del diálogo** vía el nuevo `Core.isDialogRootClass` — que exige `"MuiDialog"` en la clase PERO excluye `MuiDialog{Title,Content,Actions,ContentText}` y el `MuiPaper` genérico (evita quedarse en el panel chico del accordion RJSF).
2. El fallback desde el campo RJSF sube igual (past el paper del accordion y el `DialogContent`) hasta el `MuiDialog-paper`.
3. Nuevo `Core.isDialogRootClass(className)` (puro, testeable) + 3 tests de regresión, incluida la clase EXACTA del bug (`…MuiDialogTitle-root…` → `false`).

**Validación:** core **12/12 verde**. Dry-run del `getModalRoot` NUEVO contra el DOM real del modal → `rootFound:true` (clase `MuiDialog-paper`), `svInRoot:7`, `picked.idInDomain:20`, `rootHasEnviarA:true`. **Pendiente:** confirmar el autofill real de Razón Social + Divisa una vez deployado (depende de que el cliente tenga `DatosFactura.{RazonSocialVenta,Divisa}` configurado; HUBBELL puede no tenerlo aún).

## Fix 2026-07-03 (v0.1.1) — "sin idInDomain" para TODOS los clientes

**Síntoma reportado:** el autofill de Razón Social y Divisa no funcionaba para ningún cliente. El panel mostraba `(sin cliente) → (sin shipTo)` y ambos campos `✗ sin idInDomain`.

**Root cause (confirmado en vivo, no adivinado):**
- El fetch `Customer` NO estaba roto (hash `12d69cd…` vigente; devuelve `DatosFactura` completo). El match de `<option>` tampoco (Divisa `"USD"` matchea `"USD - Dólar americano"` por substring, score 60; Razón string-largo matchea exacto, score 100). Todo eso se validó con lecturas en vivo.
- El bug estaba **100% en la extracción del cliente del modal**. `findSingleValueByLabel` caminaba los hermanos del label "Cliente:" y hacía **`return null` al toparse un `input[role="combobox"]`** — pero el react-select SIEMPRE monta el combobox junto al singleValue, así que bailaba antes de leer el nombre. Resultado: `extractCustomerNameFromModal()` → `null` → sin `(#N)` que parsear → `sin idInDomain`. Como el layout del modal es idéntico para todo cliente, fallaba para **todos**.
- Dato clave: el `(#N)` **sí está presente** en ese modal — `sv = "C" (avatar) + "CONTROLES Y MEDIDORES ESPECIALIZADOS (#10)"` = idInDomain 10. El avatar MUI pega su letra al nombre; `extractCustomerNameFromModal` ya lo quita con `[class*="Avatar"]`.

**Fix:**
1. **Extracción del cliente robusta y label-independiente**: se juntan los textos de TODOS los `[class*="singleValue"]` del modal (quitando avatar/svg/img) y se elige el ÚNICO que trae el badge `(#N)` (`Core.pickCustomerFromSingleValues`). Los demás singleValues del modal (Contacto, Facturar a, Enviar vía, Términos) no traen `(#N)`.
2. `findSingleValueByLabel` (que aún usa el shipTo): se **quitó el bail del combobox** y ahora prefiere la ÚLTIMA etiqueta que matchea (la del modal, no la del wizard padre).
3. `getModalRoot` con **fallback** ascendiendo desde un campo RJSF (garantiza root aunque el heading cambie de tag).
4. **Fallback de `idInDomain` por nombre** vía `CustomerSearchByName` (`resolveIdInDomainByName`, cacheado) por si algún cliente/modal no mostrara el badge — cierra el pendiente "Cliente con `(#N)` no parseado".

**Módulo puro nuevo** `create-order-autofill-core.js` (`window.CreateOrderAutofillCore` / `module.exports`): `normalizeForMatch`, `cleanCustomerName`, `extractCustomerIdInDomain`, `pickCustomerFromSingleValues`, `scoreOptionMatch`. Golden test `tools/test/create-order-autofill-core.test.js` (9 casos, incluye el caso Divisa `"USD"` vs `"USD - Dólar americano"`). El core va en `config.apps[].scripts` ANTES del applet.

**Validación:** core 9/9 verde + réplica del singleValue real del modal → `pickCustomerFromSingleValues` saca `idInDomain: 10`. Deployado a gh-pages (config **1.7.59**, verificado en vivo byte-a-byte + `create-order-autofill-core.js` publicado HTTP 200). **✅ Corrida real end-to-end VALIDADA** (operador 2026-07-17, confirmado 2026-07-22): se llenan Razón Social + Divisa.

**Safari/iPad:** el applet ya estaba en el bundle; el rebuild tomó el core nuevo (`tools/build-safari.sh`, bundle `0.5.0 → 0.5.1`, build-safari test 10/10). **Requiere recompilar en Xcode** para que llegue al iPad (el bundle es estático). **2026-07-09 (bundle 0.5.3):** el rebuild tomó también el cambio de la 2ª pantalla SalesOrders (gate URL + heading bilingüe); mismo requisito de recompilar en Xcode.

## Por qué DOM en lugar de hook
Probamos 4 casts experimentales (`workOrderUpdates` paralelo, `customInputs` top-level, `receivedOrderCustomInputs` singular, `shipToAddress.customInputs`) en el hook low-code `getReceivedOrderCustomization` de Power Tools. Test Run pasaba en todos (la shape se generaba bien), pero **el backend nunca aplicó el customInput a la OV** — mismo failure mode documentado para `partNumberLabels` en `powertools-ordendeventa.md` (2026-05-15; repo SteelheadPowerTools). Steelhead solo respeta las claves declaradas explícitamente en su shape de backend; lo demás se silencia.

Conclusión: el canal viable es DOM-fill desde la extensión.

## Reglas por campo

| Campo (id RJSF) | Fuente | Cómo se aplica |
|---|---|---|
| `root_RazonSocialVenta` (`<select>`) | `customer.customInputs.DatosFactura.RazonSocialVenta` (string tipo `"ECO030618BR4 - ECOPLATING SA DE CV..."`) | Match exacto (≥100) o substring (≥60) contra `option.text` normalizado; `select.value = opt.value` + `dispatchEvent('change')` (RJSF lee value tracker). |
| `root_Divisa` (`<select>`) | `customer.customInputs.DatosFactura.Divisa` (string tipo `"USD - Dólar americano"`) | Mismo flujo. |
| `root_ConsolidarPorProducto` (`<input checkbox>`) | **ship-to-driven**: regex `/javier\s*rojo/i` contra `Enviar a:` del modal | `chk.click()` si target=true y `chk.checked=false` (RJSF acepta click nativo). |

**Por qué Consolidar es ship-to-driven y no customer-flag**: el cliente Schneider Electric México tiene varias plantas (Rojo Gómez requiere consolidar; otras no). Leer el flag del cliente sobre-dispara para todas las plantas. El modal sí expone `Enviar a:` con la dirección completa, lo que permite distinguir destino sin depender del cliente. Si en el futuro otras plantas de otros clientes requieren consolidación, se agregan al regex (o se mueve a una lista en `config.json`).

## Detección del modal

- **URL gate** (`core.matchesCreateOrderUrl`): `/Receiving/CustomerParts(/|$)` (flujo Receiving; la URL no cambia lista → modal full-screen "Recibir piezas del cliente" → modal anidado "Crear Orden de Venta") **o** `/Domains/<id>/SalesOrders/?$` (lista de OVs → "New Sales Order"; anclado al final para no gatear detalle `/SalesOrders/<n>`).
- **MutationObserver** en `document.body` (debounce 350ms) ejecuta `scanForModal`. En la pantalla SalesOrders el cliente se elige DENTRO del modal → el childList del `singleValue` que monta el react-select dispara el re-scan.
- **Firma única del modal**: presencia simultánea de `#root_RazonSocialVenta`, `#root_Divisa`, `#root_ConsolidarPorProducto` (los tres IDs del RJSF de Entradas Personalizadas). Más doble check con `core.isCreateOrderModalHeading` (acepta "Crear Orden de Venta" ES y "Create Sales Order" EN; filtra falsos positivos si Steelhead reusa los mismos IDs en otra pantalla).
- **`getModalRoot()`** sube del heading "Crear Orden de Venta" al `[role="dialog"]` / `[class*="MuiPaper"]` para anclar las búsquedas de `Cliente:` y `Enviar a:` SOLO dentro del modal. Sin esto, el `<p>Cliente:</p>` del wizard padre (gris atrás) compite y el extractor podía elegir el equivocado.

## idInDomain por parseo de `(#N)`

El singleValue del react-select de Cliente trae el sufijo `(#1)` con el `idInDomain` (confirmado por el usuario, no es un index local). Regex: `/\(#(\d+)\)/`. Eso evita interceptar la query `AllCustomers` o leer `__reactProps$xxx` del DOM node (ambos frágiles). El mismo `cleanCustomerName` que `invoice-autofill.js:811-818` corta tras `(#N)` para eliminar badges adyacentes ("Industrial", "(Quote Assignee: ...)").

## Idempotencia y cancelación

- **`dataset.saAutofilled = 'done'`** en cada control tras aplicar. `fillNativeSelectByText` y `setCheckbox` chequean este flag y NO sobreescriben si el operador modificó manualmente después.
- **`state.lastSig`** (`customerName||shipTo`) detecta cambios upstream. Si el operador cambia el cliente o el shipTo en el modal, la firma cambia y se re-ejecuta el autofill.
- **`runId` monotónico + `isStale(myRun)`** entre awaits para abortar runs viejos si llegan respuestas async tardías.
- **Cache `_customerCache` por idInDomain** evita refetch en cada scan (el operador puede abrir/cerrar el modal repetidamente).
- **Panel** ofrece botón "Re-aplicar" que limpia `dataset.saAutofilled` de los 3 controles + `state.lastSig=null` y dispara `scanForModal`.

## Plan de validación pendiente

- [x] Configurar `customer.customInputs.DatosFactura.{RazonSocialVenta, Divisa}` en cliente Schneider Electric Mexico en Steelhead (usuario 2026-05-22).
- [ ] Probar flujo end-to-end: `/Receiving/CustomerParts` → RECEIVE → `+` Crear OV → verificar que los 3 campos se llenan automáticamente cuando el cliente es Schneider + shipTo Javier Rojo Gómez.
- [ ] Probar con otro shipTo de Schneider (no Rojo Gómez) — confirmar que Razón Social y Divisa se llenan pero Consolidar queda sin marcar.
- [ ] Probar con cliente que NO tenga `DatosFactura.RazonSocialVenta` ni `.Divisa` configurados — confirmar que el applet reporta "cliente sin DatosFactura.X" sin romper el modal.
- [ ] Probar cambio de cliente a media carrera (cerrar modal, cambiar cliente del wizard padre, re-abrir) — confirmar que `state.lastSig` detecta el cambio y re-ejecuta.
- [ ] Probar cambio de shipTo dentro del modal (el operador cambia el "Enviar a:") — confirmar que Consolidar se re-evalúa.
- [ ] Probar manual override: marcar Razón Social distinto a lo que sugiere el applet, luego cerrar/re-abrir el modal — confirmar que `dataset.saAutofilled='done'` previene el sobreescribir.
- [ ] Confirmar que al guardar la OV los 3 customInputs persisten correctamente y el hook de facturación (`hooks/invoice/invoice.ts` en SteelheadPowerTools) los lee al facturar (lee `salesOrders[i].customInputs.ConsolidarPorProducto`).

## Pendientes derivados

- ~~**Segunda vista de creación de OV**~~ **RESUELTO 2026-07-09 (v0.1.3)**: es `/Domains/<id>/SalesOrders` → "New Sales Order" → modal "Create Sales Order". Selectores RJSF idénticos (confirmado); solo se amplió el gate de URL + el heading bilingüe. Ver sección "Add 2026-07-09".
- **Toggle en popup**: la action `toggle-create-order-autofill` está declarada en `config.json` pero el handler en `extension/background.js` no está implementado (mismo patrón que `invoice-autofill`). Si en el futuro se quiere toggle real, agregar handler + listener en `content.js` + bumpear `extensionVersion` y republicar zip.
- **Consolidación por shipTo generalizable**: hoy `ROJO_GOMEZ_RE` está hardcodeado en el script. Si aparecen más plantas/clientes que requieran consolidación, mover la lista de patrones a `config.json.domain.consolidacionShipTos: string[]`.
- **Cliente con `(#N)` no parseado**: si Steelhead deja de mostrar el sufijo `(#N)` en algún cliente, el applet cae al fallback "sin idInDomain" y no autollena. Mitigación: interceptar la respuesta de `AllCustomers` (o la query que pobla el combo) y cachear `name → idInDomain` como segunda fuente.
- **No hay observer de cambios DENTRO del modal**: el MutationObserver detecta cuándo aparece/desaparece el modal, pero si el operador cambia el shipTo SIN cerrar el modal, el debounce de 350ms del MutationObserver puede no disparar `scanForModal` si el cambio es solo de texto interno. Validar en pruebas; si falla, agregar listener específico al singleValue del react-select de `Enviar a:`.
