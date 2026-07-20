# Inventario de anclas a texto de Steelhead — migración idioma-indep (2026-07-17)

Generado por el workflow `inventario-anclas-sh` (50 agentes, 1 por applet). Read-only.
Estándar: ver [`dom-patterns.md`](dom-patterns.md) §"anclar por ESTRUCTURA idioma-indep".

**Totales:** 73 anclas de SH-texto en 19/50 applets.

| migración | # |
|---|---|
| bilingual-text | 47 |
| already-idioma-indep | 10 |
| structural | 9 |
| positional | 4 |
| noise | 3 |

**Necesitan wrapper HTML del usuario:** 42.


## 🟢 STRUCTURAL — migrable a handle estable (9)

| applet:línea | elemento SH | ancla actual | biling? | handle estable | HTML? | nota |
|---|---|---|---|---|---|---|
| `bill-autofill.js:162` | Heading del modal "Create Bill" / "Edit Bill" | /create\s+bill\|edit\s+bill/i.test(h.textContent) sobre h1/h2/h3/h4/[c | no | [role="dialog"] #root_DatosContables_Divisa (ya usado como fallback estructural líneas 172 | no | EN-only, es el 'gate' pendiente que ya señala CLAUDE.md ('bill-autofill "Create Bill"'). El propio código YA agregó (2026-07-17) un fallback |
| `bill-autofill.js:677` | Label "Divisa" / "Currency" junto al singleValue de moneda | /divisa\|currency/i.test(labelText) && labelText.length < 50 | sí | root_DatosContables_Divisa (id RJSF ya usado en otra parte del mismo archivo, línea 94/173 | no | Ya bilingüe y funcional, pero hay un handle estable (RJSF_DIVISA_ID) disponible en el mismo archivo que simplificaría/blindaría este extract |
| `bill-autofill.js:693` | Label "Divisa"/"Currency" cerca de <select> nativo (estrategia 2 de extractDivisaFromDOM) | /divisa\|currency/i.test(parent.textContent) && parent.textContent.len | sí | root_DatosContables_Divisa (mismo id, si el select nativo lo usa) | no | Igual que el hallazgo de la línea 677 — ya bilingüe, con handle disponible para reforzar. |
| `bill-autofill.js:796` | Label del combobox de Divisa pasado a tryFillCombobox: 'divisa.*factura\|divisa\|currency' | new RegExp(labelText,'i').test(txt) sobre label/span/div/p, con labelT | sí | root_DatosContables_Divisa (mismo id RJSF ya definido como constante en el archivo) | no | Ya bilingüe, pero anclar directo por id (document.getElementById(RJSF_DIVISA_ID)) sería más robusto que buscar por texto de label — la const |
| `bill-autofill.js:945` | Label "Tipo de Cambio" / "Exchange Rate" (pasado a tryFillTextInput) | labelText='tipo de cambio\|exchange rate' | sí | root_DatosContables_exchangeRate (RJSF_TC_ID, constante ya definida y usada por fillTCById | no | Ya bilingüe, con handle estable disponible en el mismo módulo (usado en otras rutas del propio archivo) — se podría reemplazar la búsqueda p |
| `cfdi-attacher.js:138` | Heading de un dialog anidado detectado más profundo en el árbol, mismo modal 'Send Invoice | /send\s+(invoice\|.*invoices)/i sobre h.textContent, SIN fallback estr | no | el mismo structMatch (MuiSwitch count + SendIcon/EmailOutlinedIcon testid) usado arriba po | no | A diferencia del branch de arriba, esta rama (nodo contiene el dialog más profundo) NO tiene el OR con structMatch — depende 100% del texto  |
| `invoice-auto-regen.js:855` | Botones de paginación del DataGrid nativo de SH: First/Prev/Next/Last ("primera"/"anterior | diccionario de regex _PAGINATION_LABELS por textContent + forma estruc | sí | none | sí | MUI DataGrid suele exponer estos botones con aria-label (p.ej. 'Go to next page') — si el usuario confirma el aria-label real en ambos local |
| `sensor-graph-hide-all.js:14` | Botón ojito de fila de sensor en la tabla 'Current Values' — aria-label del ícono Visibili | button[aria-label="Hide this sensor in the graph."], button[aria-label | no | svg[data-testid="VisibilityIcon"] / svg[data-testid="VisibilityOffIcon"] (ya existe como f | no | El aria-label es un string EN fijo que SH podría traducir según locale del usuario. El propio código YA tiene un fallback idioma-indep por d |
| `weight-quick-entry.js:556` | Texto de link de vista de Número de Parte en la fila: "Ver 'XXX'" / "View 'XXX'" | text.match(/ver\s+'([^']+)'/i) \|\| text.match(/view\s+'([^']+)'/i) so | sí | href del propio <a> (a[href*="part-numbers/"], a[href*="PartNumbers/"]) usado en getPartNu | no | Ya existe un handle estable a solo unas líneas de distancia (getPartNumberId usa el href). extractPnText solo se usa como fallback cuando pn |

## 🟡 POSITIONAL — anclar por posición relativa a un handle (4)

| applet:línea | elemento SH | ancla actual | biling? | handle estable | HTML? | nota |
|---|---|---|---|---|---|---|
| `bill-autofill.js:1006` | Header de columna "Expense Account" / "Cuenta de Gasto" dentro de la sub-tabla de líneas | /expense\s*account\|cuenta.*gasto/i.test(t) && t.length < 30 (dos siti | sí | none visible — la tabla de líneas de Bill no expone testid/aria-label conocido en el códig | sí | Ya bilingüe. Es el único mecanismo para encontrar el índice de la columna Expense Account dentro de una tabla dinámica — sin wrapper HTML no |
| `surtido-guard.js:175` | Botones del modal 'Mover'/'Move' e 'Imprimir y Mover'/'Print and Move...' | b.textContent.trim().toLowerCase().indexOf('mover'\|'imprimir y mover' | sí | none | sí | Ya bilingüe. Posible mejora: si el HTML muestra type="submit" o data-testid en el botón primario, se podría anclar por posición/tipo en vez  |
| `vale-almacen.js:381` | Heading/breadcrumb/page-title de la pantalla actual (h1/h2/h3 o contenedor con clase que m | document.querySelectorAll('h1, h2, h3, [class*="breadcrumb"], [class*= | sí | none | sí | No es comparación contra un label fijo ES/EN sino extracción de un código de línea (idioma-indep, ej. 'T204') embebido en el heading — por e |
| `warehouse-location-prefill.js:530` | Placeholder de los combos react-select de ubicación por línea: "Search Locations" / "Busca | regex /^(?:search\s+locations\|buscar\s+ubicaciones)/i sobre textConte | sí | none | sí | Ya bilingüe. El id 'react-select-*' es un patrón generado por la librería (react-select), no un id estable por instancia — sirve para filtra |

## 🔵 BILINGUAL-TEXT — sin handle; requiere ambos strings (o HTML para hallar handle) (47)

| applet:línea | elemento SH | ancla actual | biling? | handle estable | HTML? | nota |
|---|---|---|---|---|---|---|
| `auto-router-batch.js:26` | Nombre de nodo del árbol de proceso/receta de SH: paso 'Listo para procesar' (defaultStati | /listo para procesar/i.test(n.name \|\| '') | no | none | no | Es nombre de nodo de la receta/árbol de proceso (dato de dominio del tenant, no chrome de UI literal), pero SÍ es texto que Steelhead almace |
| `bill-autofill.js:652` | Label "Vendor" / "Proveedor" junto al combobox de proveedor | /^(?:vendor\|proveedor):?$/i.test(txt) | sí | none visible en el JS (solo clases [class*=singleValue]); podría existir data-testid en el | sí | Ya es bilingüe (patrón aceptado, igual que weight-quick-entry). Solo se marca needsHtml=true por si se quisiera evidencia de un handle más e |
| `bill-autofill.js:712` | Label "Invoice Date:" / "Fecha...Factura:" | /^invoice\s*date:?$/i.test(txt) \|\| /^fecha.*factura:?$/i.test(txt) | sí | none visible en el JS — posible id RJSF root_* para fecha de factura, no confirmable sin w | sí | Ya bilingüe. Si el modal usa un id RJSF root_DatosContables_fechaFactura (o similar) sería mejor anclaje, pero no hay evidencia en el código |
| `bill-autofill.js:786` | Heading/label de sección "Line Items" / "Líneas" | /line\s*items?\|l[ií]neas?/i.test(h.textContent) | sí | none visible; podría haber data-testid en la sección de líneas del bill, no confirmable si | sí | Ya bilingüe. Usado solo como ancla para acotar la búsqueda (findLineItemsSection), con fallback a main/[class*=content] si no matchea — bajo |
| `bill-autofill.js:952` | Label "Cuenta AP" / "Accounts Payable" / "Vendor Account" | labelText='cuenta.*pagar\|accounts?\\s*payable\|a/?p\\s*account\|vendo | sí | none visible en el JS — sin wrapper HTML no se puede confirmar si existe un id RJSF para e | sí | Ya bilingüe. A diferencia de Divisa/TC, este campo no tiene una constante de id conocida en el archivo — se necesitaría el wrapper HTML del  |
| `create-order-autofill.js:31` | Heading del modal MUI Dialog: "Crear Orden de Venta" (ES) / "Create Sales Order" (EN) | MODAL_HEADING_RE = /^\s*(?:crear\s+orden\s+de\s+venta\|create\s+sales\ | sí | none | no | Ya bilingüe (ES+EN) y documentado en el comentario del archivo. No hay data-testid/aria-label visible en el código para el título del Dialog |
| `create-order-autofill.js:220` | Label del react-select de Cliente dentro del modal: "Cliente:" (ES) / "Customer:" (EN) | findSingleValueByLabel(root, /^\s*(?:cliente\|customer):?\s*$/i) — fal | sí | none | sí | Ya bilingüe. Es un fallback secundario (el camino primario usa el badge idioma-indep "(#N)" vía core.pickCustomerFromSingleValues, que SÍ es |
| `create-order-autofill.js:234` | Label de Ship-To dentro del modal: "Enviar a:" (ES) / "Ship To:" (EN) | findSingleValueByLabel(root, /^\s*(?:enviar\s+a\|ship\s+to):?\s*$/i) | sí | none | sí | Ya bilingüe (EN confirmado por observación real según comentario de línea 231-233, no adivinado). Único mecanismo disponible para ubicar el  |
| `invoice-auto-regen.js:412` | Heading de la lista de facturas: "Invoices" / "Facturas" | regex /^(invoices\|facturas)$/i sobre textContent de h1-h6/div/span/p  | sí | none | sí | Ya es ES+EN. No until se vea el wrapper HTML real de la pantalla /Invoices no se puede confirmar si existe un data-testid/aria-label en el h |
| `invoice-auto-regen.js:429` | Botón "CREAR FACTURA" / "CREATE INVOICE" (usado como ancla secundaria para ubicar el headi | comparación exacta .toUpperCase() contra 'CREAR FACTURA' o 'CREATE INV | sí | none | sí | Fallback nivel 2 de findInvoicesHeading, solo se usa si el heading directo no matcheó. Bilingüe ya. Requiere HTML del botón para saber si tr |
| `invoice-auto-regen.js:861` | Texto de estado de paginación del DataGrid: "X - Y of Z" / "X - Y de Z" | regex _PAGINATION_POSITION_RE con alternancia (?:of\|de) sobre <p> tex | sí | none | sí | No es un label fijo de SH sino texto generado dinámicamente por MUI DataGrid Footer; posible que el contenedor tenga un data-testid/class de |
| `invoice-auto-regen.js:944` | Botón "Close" / "Cerrar" del modal de factura | regex /^(close\|cerrar)$/i sobre textContent de <button> | sí | none | sí | Ya bilingüe. Los modales MUI suelen traer aria-label="close" en el IconButton — si se confirma, migra a handle estable. |
| `invoice-auto-regen.js:958` | Botón "Confirmar" / "Confirm" del submodal de confirmación al regenerar PDF | regex /^(confirmar\|confirm)$/i sobre textContent de <button>, usado t | sí | none | sí | Ya bilingüe. Es el único gate crítico de este applet (dispara CreateInvoicePdf real) — buen candidato a pedir el wrapper HTML del submodal d |
| `invoice-autofill.js:933` | label "Customer:"/"Cliente:" del react-select de cliente (fallback en modal manual) | /^\s*customer:?\s*$\|^\s*cliente:?\s*$/i | sí | none evidente cerca (comentario explica que RJSF ids no sirven aquí por colisión de siblin | no | Ya bilingüe, sin deuda; se reporta solo por transparencia del criterio de anclaje. |
| `invoice-autofill.js:999` | label "Divisa:"/"Currency:" cercano al singleValue de divisa | /divisa\|currency/i.test(labelText) | sí | none | no | Ya bilingüe, sin deuda. |
| `invoice-autofill.js:1031` | label "Invoice Date:"/"Fecha de Factura:"/"Invoiced At:" | /^invoice\s*date:?$/i.test(txt) \|\| /^fecha.*factura:?$/i.test(txt) \ | sí | none | no | Ya bilingüe, sin deuda. |
| `invoice-autofill.js:1050` | heading de sección "Line Items"/"Invoice Lines"/"Líneas" | /line\s*items?\|invoice\s*lines\|l[ií]neas/i | sí | none | no | Ya bilingüe, sin deuda. |
| `invoice-autofill.js:1089` | columna de tabla "Income Account" en la sub-table de datos de cada línea de factura | /^\s*income\s+account\s*$/i.test(h.textContent?.trim() \|\| '') | no | none | sí | Solo matchea EN. No hay data-testid/aria-label visible en el código para esta columna; se necesita el wrapper HTML real de la tabla (modal I |
| `invoice-autofill.js:1427` | heading del modal "Create Invoice Manually"/"Crear Factura Manual" | MANUAL_HEADING_RE = /create\s+invoice\s+manually\|crear\s+factura\s+ma | sí | none | no | Ya bilingüe, sin deuda. |
| `invoice-autofill.js:1801` | header de línea manual "Line #N" (modal Create Invoice Manually, usado como idempotencia p | /^\s*Line\s*#\d+\s*$/.test(el.textContent \|\| '') | no | none | sí | Solo matchea 'Line #N' en inglés; si SH renderiza 'Línea #N' en español, con esa instancia el guard de idempotencia no detecta la línea exis |
| `invoice-autofill.js:1868` | label "Ship Via:"/"Envío por:" (react-select) | /^\s*ship\s*via\s*$\|env[ií]o\s*por/i | sí | none | no | Ya bilingüe, sin deuda. |
| `invoice-autofill.js:1911` | label "Ship To:"/"Enviar a:" (react-select) | /^\s*ship\s*to\s*$\|enviar\s*a/i | sí | none | no | Ya bilingüe, sin deuda (mismo patrón que create-order-autofill ya corregido). |
| `invoice-default-tab.js:12` | Tab "Packing Slips" en /Domains/{N}/Invoices | TAB_LABEL_RE = /^\s*packing\s*slips\s*$/i aplicado a textContent de bu | no | none | sí | Solo EN. No hay data-testid/aria-label visible en el código para los tabs de Invoices — se itera genéricamente sobre button/[role=tab]/a com |
| `invoice-listing-marker.js:68` | Div de resumen de la fila del listado de facturas que contiene el label 'Total:' junto con | /total\s*:/i .test(txt) && /terms\s*:\|t[eé]rminos\s*:/i .test(txt) | sí | none | sí | Ya es bilingüe para 'Terms/Términos' (el label que realmente discrimina); 'total' es igual en ambos idiomas así que no requiere alterna. No  |
| `load-calculator-modal.js:251` | Heading del modal de Rack Types (h2#form-dialog-title) cuyo texto contiene algo como "...t | /rack type/i.test(t.textContent \|\| '') | no | id="form-dialog-title" (ya se usa como filtro previo vía querySelectorAll) + role="dialog" | sí | El código ya filtra por el handle estable id="form-dialog-title", pero como puede haber más de un modal con ese mismo id genérico en la SPA, |
| `pn-specs-column.js:104` | Botón del dashboard /PartNumbers "NUEVO NÚMERO DE PARTE" / "NEW PART NUMBER" (usado como a | regex /nuevo\s+número\s+de\s+parte\|new\s+part\s+number/i sobre (b.inn | sí | none | sí | Ya está bien hecho como texto (ES+EN cubierto), así que no es deuda urgente. Pero es el único punto de fallo estructural del applet: si SH l |
| `price-confirm-guard.js:406` | Alert nativo de SH tras guardado fallido ('Error saving price' u equivalente) | Core().isSaveErrorAlert(msg) — la comparación de texto vive en price-c | no | none — window.alert(msg) solo entrega un string; no hay handle estructural alternativo par | no | No se puede ver el string exacto matcheado en isSaveErrorAlert desde este archivo (vive en price-confirm-core.js). Marca de deuda: si SH cor |
| `proceso-calculator.js:241` | Label del combobox de proceso en la ficha del PN (vista sin modal): 'Default Process:' | PROCESS_LABEL_RE = /^\s*default\s*process\s*:?\s*$/i, usado en findPro | no | data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS" (usado como PRIMER | sí | En la ficha (sin modal) este es el ÚNICO camino — no hay component-id de respaldo ahí. Falta confirmar si SH muestra 'Default Process:' en e |
| `receiver-date-override.js:29` | Heading del modal 'Receive Parts from Customer' / 'Recibir Piezas del Cliente' | VIEW_REGEX = /receive\s+parts\s+from\s+customer\|recibir\s+piezas\s+de | sí | none | sí | Ya es bilingüe (buena práctica), pero es el único gate para detectar el modal correcto — no hay data-testid/role visible en el código. Pedir |
| `receiver-date-override.js:289` | Label de campo 'Customer:' / 'Cliente:' dentro del grid del modal (usado para ubicar el wr | /^(?:customer\|cliente):?$/i.test(p.textContent.trim()) sobre todos lo | sí | none | sí | Ya bilingüe. El paso siguiente (.closest('.css-iyrxkt')) SÍ es clase hasheada — eso es lo realmente frágil (regenera en cada build de MUI),  |
| `surtido-guard.js:141` | Modal nativo de mover piezas: heading/label 'Desde Nodo:'/'From Node:' + título 'Mover Pie | regex /Desde Nodo:/i \|\| /From Node:/i AND /Mover Piezas/i \|\| /Move | sí | none | sí | Ya cubre ES+EN, no es deuda urgente. No se ve data-testid/aria-label/id estable en el dialog (solo clase MUI hasheada .MuiDialog-paper, que  |
| `surtido-guard.js:197` | Texto de tarjeta del Workboard 'Tareas Programadas:' (adorno de la señal de programación) | regex /Tareas Programadas:?/i sobre nodeValue vía TreeWalker | no | none | sí | DEUDA YA REGISTRADA en CLAUDE.md (P1 seguridad: candado no bloquea/decora igual con SH en inglés — aquí es solo decoración visual, no el blo |
| `surtido-guard.js:207` | Texto de tarjeta del Workboard 'Proceso:' y 'WO:' (usados para delimitar el ancestro-tarje | regex /Proceso:/i && /WO:/i sobre card.textContent al subir hasta 8 ni | no | none | sí | Mono-ES; en inglés SH probablemente muestre 'Process:'/'WO:' pero no hay evidencia observada, así que no se adivina. Es puramente heurístico |
| `unit-autoconvert.js:109` | Panel A: encabezado 'Per Part Count Unit Definitions:' (modal de definiciones de unidad po | findByText(...) con regex /^per part count unit definitions:?\s*$/i —  | no | none | sí | No se ve ningún data-testid/aria-label/id cerca en este archivo (selector genérico 'p, span, strong, b, h1-h6, div, label'). Es deuda ya doc |
| `unit-autoconvert.js:144` | Panel A: label hermano del input terminado en '/ Part:' (ej. 'DMK Decímetro Cuadrado / Par | regex /\/\s*parts?:?\s*$/i sobre labelP.textContent.trim() — matchea ' | no | none | sí | Repetido en findPeerInput (línea 160) con el mismo patrón. Documentado en CLAUDE.md como deuda pendiente ('/ Part:' EN-only). Sin data-testi |
| `unit-autoconvert.js:160` | Panel A (dentro de findPeerInput): mismo label '/ Part:' usado para localizar el input par | regex /\/\s*parts?:?\s*$/i sobre p.textContent.trim() — mismo patrón E | no | none | sí | Duplicado funcional del anclaje de la línea 144 (misma regex, mismo problema). Ambos sitios deberían corregirse juntos con el mismo string E |
| `warehouse-location-prefill.js:32` | Heading del modal de recibo: "Receive Parts from Customer" / "Recibir Piezas del Cliente" | VIEW_REGEX = /receive\s+parts\s+from\s+customer\|recibir\s+piezas\s+de | sí | none | sí | Ya es bilingüe (buena práctica), pero el selector base (h1-h6 + clases MUI genéricas) es ruidoso. No se ve data-testid/aria-label/role espec |
| `warehouse-location-prefill.js:294` | Label de campo "Receiver Comments:" / "Comentarios del Receptor:" (usado como ancla de iny | regex /^(?:receiver\s+comments\|comentarios\s+del\s+receptor):?$/i sob | sí | none | sí | Bilingüe ya. El anclaje estructural vecino es una clase CSS hasheada (.css-iyrxkt) — eso NO es un handle válido, solo funciona porque el tex |
| `warehouse-location-prefill.js:565` | Label del campo header "Part Groups" / "Grupo de Piezas" | regex /^(?:part\s+groups?\|grupo\s+de\s+(?:piezas\|partes))\s*:?$/i so | sí | none | sí | Bilingüe. Ancla estructural vecina (.css-xd9ivb / .css-iyrxkt) es clase hasheada — no cuenta como handle. Si el control react-select de Part |
| `warehouse-location-prefill.js:566` | Label del campo header "Container" / "Contenedor" | regex /^(?:container\|contenedor)\s*:?$/i sobre el mismo mecanismo de  | sí | none | sí | Mismo caso que 'Part Groups': bilingüe, sin handle estable visible en el código, ancla vecina es clase CSS hasheada. Pedir wrapper HTML del  |
| `weight-quick-entry.js:195` | Placeholder genérico de combobox (react-select) antes de seleccionar: 'Buscar/Search/Selec | PLACEHOLDER_RE = /^(buscar\|search\|select\|seleccionar\|todo\|all\|el | sí | none | sí | Ya cubre ES+EN. Sería más robusto detectar 'sin selección' via el input vacío o un atributo aria-* del combobox en vez de adivinar el texto  |
| `weight-quick-entry.js:211` | Label del campo Cliente en el modal Receive Parts: 'Customer'/'Cliente' | /^(customer\|cliente):?$/i.test(txt) sobre textContent de label/span/d | sí | none | sí | Ya matchea ES+EN. No hay data-testid/aria-label visible en el código para el campo Cliente; para confirmar que no hay handle estable habría  |
| `weight-quick-entry.js:268` | Heading de la vista/modal de recibo: 'Receive Parts from Customer' / 'Recibir Piezas del C | VIEW_REGEX = /receive\s+parts\s+from\s+customer\|recibir\s+piezas\s+de | sí | none | sí | Ya bilingüe. Sería ideal anclar por URL (si Receive Parts tiene ruta propia) o role="dialog"+algún data-testid; no hay evidencia de eso en e |
| `weight-quick-entry.js:465` | Encabezado de columna de la tabla de líneas: 'Cantidad'/'Quantity' | /cantidad\|quantity/i.test(headers[i].textContent.trim()) para localiz | sí | none | sí | Ya bilingüe. Un data-field/data-testid en el <th> sería ideal pero no se observa en el código; requiere el <table> real para confirmar. |
| `weight-quick-entry.js:579` | Valor del dropdown de Unidad de la línea cuando es 'por pieza': 'Count'/'Conteo' | unitVal !== 'Count' && unitVal !== 'Conteo' — comparación exacta de te | sí | none | sí | Ya bilingüe. Si el combobox de unidad expone option[value] con código idioma-indep (p.ej. 'CNT'/unitId), sería el handle correcto; no hay ev |
| `weight-quick-entry.js:672` | Mismo valor de dropdown 'Count'/'Conteo', segundo sitio de uso (watchUnitChanges, oculta/m | unitVal !== 'Count' && unitVal !== 'Conteo' (misma comparación que lín | sí | none | sí | Mismo caso que línea 579; getUnitValue() es la única fuente, así que el fix aplicaría en un solo lugar (getUnitValue) beneficiando ambos sit |
| `weight-quick-entry.js:799` | Botón de guardar del modal: 'SAVE'/'SAVE +'/'SAVE &...'/'GUARDAR'/'GUARDAR +'/'GUARDAR Y.. | text === 'SAVE' \|\| text.startsWith('SAVE +') \|\| text.startsWith('S | sí | none | sí | Ya bilingüe y cubre variantes compuestas (Save & Close, etc.), buen patrón. Podría existir type="submit" en el botón correcto pero el modal  |

## ✅ YA IDIOMA-INDEP — no es deuda (10)

| applet:línea | elemento SH | ancla actual | biling? | handle estable | HTML? | nota |
|---|---|---|---|---|---|---|
| `cfdi-attacher.js:125` | Heading del modal de email de factura, texto observado 'Send Invoice Email' | /send\s+invoice\s+email/i sobre heading.textContent | no | structMatch ya existe en la misma condición (linea 128-129): >=2 tr .MuiSwitch-root + [dat | no | El código ya OR-ea headingMatch \|\| structMatch, así que el structural alcanza para EN. El regex EN-only es redundante pero inofensivo salv |
| `cfdi-attacher.js:153` | Heading del dialog ya existente en el DOM al cargar (chequeo one-time), mismo modal | /send\s+(invoice\|.*invoices)/i sobre h.textContent (OR con structMatc | no | structMatch (MuiSwitch + SendIcon/EmailOutlinedIcon testid) ya está en el OR aquí | no | Igual que el caso de línea 125: el OR con structural ya cubre el caso ES; el regex EN es fallback redundante. |
| `cfdi-attacher.js:180` | Fila de toggle del modal por su label de texto: 'Logo' / 'Attach PDF(s)' / 'Visible to Oth | /^(Logo\|Attach PDFs?\|Visible to Others)$/i sobre tr.textContent.trim | no | el propio bucle de la línea 174-176 (tr que contiene .MuiSwitch-root/[class*="Switch-root" | no | Es un fallback secundario (solo corre si el primario estructural falla). Mono-idioma EN, así que si algún día el fallback es el único camino |
| `invoice-autofill.js:235` | heading del editor de factura "Creating/Editing Invoice for X" / "…Factura para X" | /(?:invoice\|factura)\s+(?:for\|para)\b/i.test(h.textContent \|\| '') | sí | data-rfd-droppable-id="ro-invoice-lines-droppable" (usado como OR alternativo en la misma  | no | El código ya combina esta ancla de texto (bilingüe) con el droppable idioma-indep vía OR (found = divisaInput \|\| tcInput \|\| hasInvoiceHe |
| `invoice-autofill.js:910` | mismo heading "invoice for X"/"factura para X", usado para extraer el nombre del cliente p | txt.match(/(?:invoice\|factura)\s+(?:for\|para)\s+(.+?)$/i) | sí | state.customerName vía InvoiceLowCodeData/customerById (API, ya usado como respaldo según  | no | Ya documentado en el código como fallback DOM con respaldo API idioma-indep. Ancla ya bilingüe. |
| `price-confirm-guard.js:15` | Título del modal nativo 'Part Number Price' (MuiDialogTitle-root) | MODAL_TITLE_RE = /Part\s*Number\s*Price/i probado contra textContent d | no | [id^="root_DatosPrecio"] (schema RJSF idioma-indep) — YA está implementado como fallback O | no | El código ya resuelve el riesgo real: hasPriceSchema es un handle estable y basta por sí solo para detectar el modal en cualquier idioma. El |
| `proceso-calculator.js:243` | Heading del modal de edición de NP: 'PROCESO Y SPECS' (ES) / 'Edit Part Number' (EN) | MODAL_HEADING_RE = /proceso\s*y\s*specs\|edit\s*part\s*number/i, usado | sí | none (aparte de role="dialog"/MuiDialog genérico, que no distingue CUÁL modal es) | no | Ya cubre ambos idiomas (patrón bueno, igual que isCreateOrderModalHeading citado en CLAUDE.md). Sin deuda; se reporta solo para dejar consta |
| `proceso-calculator.js:244` | Label del campo Metal en la ficha (fallback, fuera del modal): 'Material:'/'Metal Base:'/' | MATERIAL_LABEL_RE = /^\s*(material\|metal\s*base\|metal)\s*:?\s*$/i, u | sí | #root_DatosAdicionalesNP_BaseMetal (id RJSF estable, YA es el primer intento en línea 329- | no | El regex ya matchea 'material'/'metal base'/'metal', que cubre ES y EN razonablemente (palabras compartidas). Baja prioridad; documentar sin |
| `proceso-calculator.js:245` | Label del campo Línea (dimensión contable) en modal y ficha: 'Línea:' (ES) / 'Line:' (EN) | LINEA_LABEL_RE = /^\s*(?:l[ií]nea\|line)\s*:?\s*$/i, usado en readSing | sí | data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_ACCOUNTING_DIMENSIONS" acota el SCO | no | Ya bilingüe ES/EN (patrón bueno). El component-id solo resuelve el contenedor, no el campo específico — si Steelhead expone un id por campo  |
| `unit-autoconvert.js:112` | Panel A/B: label 'Modo:'/'Mode:' que indica el modo de la unidad | regex /^(?:modo\|mode):?$/i sobre p.MuiTypography-root.textContent.tri | sí | none | no | Ya matchea ES ('Modo:') y EN ('Mode:') — no es deuda, patrón correcto tal como documenta la bitácora del applet. Se reporta solo para dejar  |

## ⚪ NOISE — reclasificar (no es ancla de SH) (3)

| applet:línea | elemento SH | ancla actual | biling? | handle estable | HTML? | nota |
|---|---|---|---|---|---|---|
| `invoice-autofill.js:1125` | texto "Total: $X" en el header <tr> de cada línea (para extraer el monto) | headerTr?.textContent.match(/Total:\s*\$?\s*(-?[\d,]+(?:\.\d+)?)/i) | no | none | no | "Total" es cognado ES/EN (misma palabra en ambos idiomas) — riesgo bajo de que el regex EN-only falle en instancia española; se incluye por  |
| `invoice-autofill.js:1155` | subtítulo <p>INCOME</p> (layout B fallback, junto al combobox de cuenta de ingreso por lín | /^income$/i.test(t) | no | none | no | Probablemente un tag/enum literal que SH renderiza en mayúsculas fijas (no traducido, análogo a ACCOUNTS_RECEIVABLE en línea 2094) — no conf |
| `invoice-autofill.js:1164` | texto "Total: $X" en el container de línea (layout B fallback) | container.textContent.match(/Total:\s*\$?\s*(-?[\d,]+(?:\.\d+)?)/i) | no | none | no | Mismo caso que línea 1125 — 'Total' es cognado, riesgo bajo. |


## Notas de verificación manual (2026-07-17) — sobre las clasificaciones `structural`

El inventario lo generó un fan-out de 50 agentes; al revisar a mano el set `structural`
(migrable sin HTML), 2 clasificaciones eran optimistas. Registro para no re-litigar:

- ✅ **cfdi-attacher:138 — MIGRADO.** Era el único de 3 paths de detección sin el `structMatch`
  idioma-indep (≥2 `MuiSwitch` + `data-testid` Send/Email). Añadido (aditivo, no regresa).
- ⏸️ **sensor-graph-hide-all:14 — NO migrar sin HTML del contenedor.** El `aria-label` EN es
  primario *por precisión* (evita cazar otros ojitos del sitio); el `data-testid`
  Visibility(Off)Icon ya es fallback idioma-indep. Hacer testid primario over-seleccionaría.
  Ya degrada bien; cierre real = scopear testid al contenedor de "Current Values" (necesita HTML).
- ⏸️ **weight-quick-entry:556 — NO migrar.** El agente sugirió `href`, pero ahí se extrae el
  **nombre** del PN del texto del link ("Ver/View 'XXX'"); el href da el **id/slug**, no el
  nombre → no equivalentes. Ya es bilingüe y funciona.
- ⏸️ **bill-autofill 677/693/796/945 — bilingüe + funcional; migración a id `root_*` requiere
  verificar cada función** (¿lee/llena el mismo campo RJSF?). Pase focalizado, no en lote.
- ✅ **bill-autofill:162** — el gate ya tiene fallback estructural `#root_DatosContables_Divisa`
  (hecho 2026-07-17); dejar el texto como primario (ambos funcionan).


## 🎯 Scorecard (reframe 2026-07-17) — el trabajo está mayormente HECHO

De las 73 anclas de SH-texto, **61 ya cumplen el estándar** y solo ~12 son deuda genuina:

| estado | # | qué significa |
|---|---|---|
| ✅ ya idioma-indep | 10 | anclan por testid/id/aria/role/url/código — nada que hacer |
| ✅ ya bilingüe (ES+EN) | 51 | cumplen el estándar como **último recurso legítimo**; solo "suben" a structural si el HTML revela un handle (la mayoría NO lo tiene: solo texto + CSS hasheado) |
| 🔧 deuda real (mono-idioma) | 12 | necesitan el string del otro locale **o** un handle vía HTML |
| ⚪ ruido | 3 | reclasificar |

**Verdad de ingeniería:** "blindar TODO a HTML" topa donde SH no expone handle. Para los campos
tipo `Vendor:`, `Divisa:`, `Invoice Date:` el HTML del modal muestra **solo texto + clase
hasheada** → el texto bilingüe **es** la respuesta compliant, no un fallo. Subir a structural
solo aplica donde hay `data-testid`/`root_*`/`aria`/`href`/código.

### Deuda real restante (12 mono-idioma) — qué necesita cada una

| ancla | necesita | nota |
|---|---|---|
| `auto-router-batch.js:26` | canon/tag del nodo "listo para procesar" (docs/processes) | Nombre de nodo del árbol de proceso/receta de SH: paso  |
| `bill-autofill.js:162` | — | Heading del modal "Create Bill" / "Edit Bill" |
| `cfdi-attacher.js:138` | — | Heading de un dialog anidado detectado más profundo en  |
| `invoice-autofill.js:1089` | string ES o confirmar no-traduce | columna de tabla "Income Account" en la sub-table de da |
| `invoice-autofill.js:1801` | string ES ("Line #N") | header de línea manual "Line #N" (modal Create Invoice  |
| `invoice-default-tab.js:12` | string ES o HTML del tab (href/mode) | Tab "Packing Slips" en /Domains/{N}/Invoices |
| `load-calculator-modal.js:251` | HTML del modal (reanclar por #form-dialog-title) | Heading del modal de Rack Types (h2#form-dialog-title)  |
| `price-confirm-guard.js:406` | string ES del alert | Alert nativo de SH tras guardado fallido ('Error saving |
| `proceso-calculator.js:241` | HTML de la ficha (¿component-id en vista sin modal?) | Label del combobox de proceso en la ficha del PN (vista |
| `sensor-graph-hide-all.js:14` | — | Botón ojito de fila de sensor en la tabla 'Current Valu |
| `surtido-guard.js:197` | HTML de tarjeta del board | Texto de tarjeta del Workboard 'Tareas Programadas:' (a |
| `surtido-guard.js:207` | HTML de tarjeta del board | Texto de tarjeta del Workboard 'Proceso:' y 'WO:' (usad |
| `unit-autoconvert.js:109` | HAY HTML — recipe estructural (single input/unit + code) | Panel A: encabezado 'Per Part Count Unit Definitions:'  |
| `unit-autoconvert.js:144` | HAY HTML — idem | Panel A: label hermano del input terminado en '/ Part:' |
| `unit-autoconvert.js:160` | HAY HTML — idem | Panel A (dentro de findPeerInput): mismo label '/ Part: |


## ✔️ Cierre de las 12 deudas mono-idioma + ruido (2026-07-17)

### Migradas a estructura (código commiteado en workbench)
| ancla | cómo quedó | commit |
|---|---|---|
| `unit-autoconvert:109/144/160` (Panel A) | `Core.isConvertible(código)` + estructura (no "/ Part:"); heading con fallback estructural `findPanelAContainer` | `7c26367` |
| `cfdi-attacher:138` | 3er path de detección usa el `structMatch` idioma-indep (MuiSwitch+testid) | `7689327` |
| `bill-autofill:162` | gate con fallback `[role=dialog] #root_DatosContables_Divisa` | `0d9e9e6` |

### Resueltas como NO-deuda (documentadas, sin código)
| ancla | por qué |
|---|---|
| `invoice-autofill:1089` (Income Account) | SH **no traduce** esa etiqueta (confirmado por el usuario); sin handle → texto EN es el techo |
| `invoice-autofill:1801` ("Line #N") | EN no-traducido (HTML muestra "Line Items"/"Line 1" en inglés en instancia ES) |
| `auto-router-batch:26` ("Listo para procesar") | **NO es traducción de UI de SH**: el nombre del nodo lo crea NUESTRO tooling (`CreateProcessNode`), es dato del tenant; además hay fallback por frecuencia. Opción futura idioma-indep: incluir `node.type==='SCANNER_NODE'` en el shape de `recipeNodes` (hoy no lo trae) |
| `invoice-autofill:1125/1164` (ruido) | regex `Total: $X` — **"Total" es cognado ES/EN idéntico**, no falla al traducir |
| `invoice-autofill:1155` (ruido) | `<p>INCOME</p>` es enum fijo en mayúsculas (no traducido), análogo a `ACCOUNTS_RECEIVABLE` |

### Bloqueadas por evidencia (necesitan HTML/string — batch de captura)
| ancla | qué necesito |
|---|---|
| `surtido-guard:197/207` | **wrapper HTML de una tarjeta del Workboard** con "Tareas Programadas:" (para anclar la tarjeta por estructura y pintar el verde idioma-indep) |
| `load-calculator-modal:251` | **HTML del modal de Rack Types** (tiene `h2#form-dialog-title`; reanclar por estructura sin "rack type") |
| `proceso-calculator:241` | **HTML de la ficha del PN** (vista sin modal) alrededor del combobox "Default Process:" (¿hay `component-id`/handle en la ficha como en el modal?) |
| `invoice-default-tab:12` | **HTML de la barra de tabs** en `/Domains/N/Invoices` (para anclar el tab por `href`/`mode` en vez de "Packing Slips") |
| `price-confirm-guard:406` | **string ES** del alert nativo "Error saving price" (observarlo con SH en español; es fail-safe cosmético, prioridad baja) |
| `sensor-graph-hide-all:14` | **HTML del contenedor** "Current Values" (para scopear el testid `VisibilityIcon` y hacerlo primario sin perder precisión) |


## ✔️ Cierre con el HTML del usuario (2026-07-20)

El usuario pasó el HTML de las pantallas pendientes. Hallazgo transversal: **`data-steelhead-component-id`
es un atributo REAL y vivo** en toda la UI de NP/Workboard. Vocabulario confirmado (útil a futuro):
`PART_NUMBER_PAGE_PROCESS_SETUP`, `_PROCESS_DEFINITION`, `_PART_NUMBER_INSTRUCTIONS`, `_PROCESS_FILES`,
`PART_NUMBER_PAGE_UNITS`, `CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS`/`_OPT_IN_OUT`/`_MANAGE_SPECS`/
`_PER_PART_COUNT_UNIT_DEFINITIONS`, `WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK`.

### Migradas a estructura (código commiteado)
| ancla | cómo quedó |
|---|---|
| **proceso-calculator:241** (ficha) | `findProcessControl` ahora prueba `[data-steelhead-component-id="PART_NUMBER_PAGE_PROCESS_SETUP"]` (1er combobox = Default Process) antes del texto. Idioma-indep. |
| **invoice-default-tab:12** | `findPackingSlipsTab` ancla `button[value="packing-slips"]` (atributo estable), texto como fallback. |

### Pendientes con hallazgo (necesitan trabajo focalizado, no cierre trivial)
| ancla | hallazgo |
|---|---|
| **load-calculator-modal:251** | **BUG real**: el modal de *Edit* dice "…that can fit on **T204-FL01**" (sin "rack type"), así que `/rack type/i` **no lo matchea**. El modal NO tiene `component-id`; el título es `h2#form-dialog-title`. Ambos (create/edit) comparten "that can fit on". Fix pendiente: anclar por el diálogo tras `CreateEditPartsPerRackTypeQuery` + `#form-dialog-title`, o ampliar a "that can fit on" (aún EN). |
| **surtido-guard:197/207** (verde) | Tengo el HTML de tarjeta (`WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK` existe en cada tarjeta). PERO el usuario reporta que **no pinta verde aunque la clase `sa-sg-green` SÍ se aplica** → es (también) un **bug de CSS/placement**: la clase cae en un `<div>` interno cuyo verde no se ve contra el cuerpo blanco de la tarjeta. Necesita fix de estilo (pintar borde/acento visible) + validación, aparte del anclaje. |
| **sensor-graph-hide-all:14** | El diseño actual (aria-label primario + `data-testid` VisibilityIcon/Off fallback) es correcto; en la tabla "Current Values" cada fila tiene UN ojito. Sin `component-id` en el contenedor. **Se deja como está** (ya degrada idioma-indep). |
| **price-confirm-guard:406** (alert) | El usuario no pudo reproducir el alert en español ("no me salió"). Fail-safe cosmético; **sin evidencia del string ES, se deja**. |
