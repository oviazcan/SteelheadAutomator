# `create-order-autofill` — bitácora

Auto-llena las 3 Entradas Personalizadas (`Razón Social de la Venta`, `Divisa`, `Consolidar por Producto`) del modal **"Crear Orden de Venta"** que sale en el flujo `/Receiving/CustomerParts → RECEIVE → +/Create`. Sustituye al canal write de OV customInputs que no existe en `ordendeventa.ts` (ver bitácoras `powertools-ordendeventa.md` y `powertools-facturacion.md`, ahora en el repo **SteelheadPowerTools**).

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

**Validación:** core 9/9 verde + réplica del singleValue real del modal → `pickCustomerFromSingleValues` saca `idInDomain: 10`. Deployado a gh-pages (config **1.7.59**, verificado en vivo byte-a-byte + `create-order-autofill-core.js` publicado HTTP 200). **Pendiente:** corrida real end-to-end en el modal (que el operador confirme que se llenan Razón Social + Divisa).

**Safari/iPad:** el applet ya estaba en el bundle; el rebuild tomó el core nuevo (`tools/build-safari.sh`, bundle `0.5.0 → 0.5.1`, build-safari test 10/10). **Requiere recompilar en Xcode** para que llegue al iPad (el bundle es estático).

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

- **URL gate**: `/\/Receiving\/CustomerParts(?:\/|$)/`. La URL no cambia durante todo el flujo (lista → modal full-screen "Recibir piezas del cliente" → modal anidado "Crear Orden de Venta"), por eso el gate es por path.
- **MutationObserver** en `document.body` (debounce 350ms) ejecuta `scanForModal`.
- **Firma única del modal anidado**: presencia simultánea de `#root_RazonSocialVenta`, `#root_Divisa`, `#root_ConsolidarPorProducto` (los tres IDs del RJSF de Entradas Personalizadas). Más doble check con `MODAL_HEADING_RE = /^\s*crear\s+orden\s+de\s+venta\s*$/i` (filtra falsos positivos si Steelhead reusa los mismos IDs en otra pantalla).
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

- **Segunda vista de creación de OV**: existe otra pantalla en Steelhead (no documentada aún) donde también se crean OVs sin pasar por Receiving. Cuando el usuario la indique, agregar su URL al gate y validar que los selectores RJSF son los mismos (probablemente sí — RJSF reusa el mismo schema del ReceivedOrder).
- **Toggle en popup**: la action `toggle-create-order-autofill` está declarada en `config.json` pero el handler en `extension/background.js` no está implementado (mismo patrón que `invoice-autofill`). Si en el futuro se quiere toggle real, agregar handler + listener en `content.js` + bumpear `extensionVersion` y republicar zip.
- **Consolidación por shipTo generalizable**: hoy `ROJO_GOMEZ_RE` está hardcodeado en el script. Si aparecen más plantas/clientes que requieran consolidación, mover la lista de patrones a `config.json.domain.consolidacionShipTos: string[]`.
- **Cliente con `(#N)` no parseado**: si Steelhead deja de mostrar el sufijo `(#N)` en algún cliente, el applet cae al fallback "sin idInDomain" y no autollena. Mitigación: interceptar la respuesta de `AllCustomers` (o la query que pobla el combo) y cachear `name → idInDomain` como segunda fuente.
- **No hay observer de cambios DENTRO del modal**: el MutationObserver detecta cuándo aparece/desaparece el modal, pero si el operador cambia el shipTo SIN cerrar el modal, el debounce de 350ms del MutationObserver puede no disparar `scanForModal` si el cambio es solo de texto interno. Validar en pruebas; si falla, agregar listener específico al singleValue del react-select de `Enviar a:`.
