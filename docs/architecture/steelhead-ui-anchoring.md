# Anclaje a la UI / DOM de Steelhead — jerarquía, catálogo de iconos e incidentes

> **Origen:** este documento se extrajo de `CLAUDE.md` el 2026-08-04 para bajar el costo de
> arranque de cada sesión. El **enunciado** de la jerarquía de anclaje (los 4 niveles) sigue en
> `CLAUDE.md`; aquí vive la **narrativa medida** que lo sostiene: el catálogo de las 14 formas de
> icono, los incidentes del 2026-08-03 (SH quitó los `data-testid`, el rehash de emotion), y la
> verificación applet por applet.
>
> Documentos hermanos: [`dom-patterns.md`](dom-patterns.md) (patrones de extracción/inyección) ·
> [`anchor-migration-inventory.md`](anchor-migration-inventory.md) (inventario de sitios a migrar) ·
> [`bilingual-anchoring-debt.md`](bilingual-anchoring-debt.md) (deuda ES+EN por applet).

## Trabajo con UI / DOM de Steelhead
**ANTES de escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — una sola inspección del wrapper resuelve todo en un commit.

### Regla: ESTRUCTURA antes que texto; bilingüe (ES+EN) solo donde no hay estructura
**Orden de preferencia para anclar a la UI de Steelhead** (el repo se movió a esto; el bilingüe
es el último recurso, no el primero):
1. **Anclas estructurales del HTML** — ids de schema RJSF (`root_<Grupo>*`), **la FORMA del
   icono** (`svg path[d]`), posición en la tabla/fila, relación padre/hijo. **No dependen del
   idioma y son las únicas que sirven en un candado**, donde un gate que no matchea **se apaga
   en silencio** (caso `price-confirm-guard` v0.1.5: con la UI en español el título era «Precio
   del número de parte» y el gate por texto llevaba semanas sin disparar).
   ⚠️ **`data-testid` YA NO es confiable (2026-08-03): SH publicó un build que lo ELIMINA.**
   Medido en **cinco** pantallas cargadas y con contenido real —`/Reporting/View` (189 svg),
   `/Receiving/CustomerParts` (159 svg), y los listados de reportes, OTs y NPs—: **0
   `[data-testid]`** en todas. Los únicos dos que sobreviven en la app
   (`sentinelStart`/`sentinelEnd`) los pone **react-virtuoso**, no SH. Se sigue buscando
   PRIMERO (si SH lo repone, sirve), pero **ninguna decisión puede depender sólo de él**.
   ✅ **`data-steelhead-component-id` SIGUE VIVO — corrección del mismo día.** La primera
   redacción de esta regla decía que SH lo había eliminado también: **era una
   sobregeneralización**. Se midió 0 en tres pantallas y se concluyó "lo eliminó", cuando esas
   tres simplemente no tienen ninguno. Medido después donde SÍ debería estar: **38 en la ficha
   de OT y 40 en la ficha de NP**, incluidos los anclajes que el repo usa
   (`WORK_ORDER_PAGE_HEADER_OPEN_PDF_BUTTON`, `WORK_ORDER_PAGE_HEADER_PRINT_JOB_TAGS_BUTTON`,
   `PART_NUMBER_PAGE_UNITS*`). Viven en **fichas de detalle, no en listados**. Los ids de
   schema RJSF (`root_*`) también siguen vivos.
   **Verificado applet por applet (2026-08-03):** `wo-schedule-button` monta su readout
   (`🔀📅 Sin programar`) junto al ancla PDF ✓ · `price-confirm-guard` tiene `PART_NUMBER_PAGE_UNITS`
   presente y el mecanismo RJSF vivo (4 grupos `root_*` en la ficha de NP) ✓ · `wo-listing-columns`
   y `proceso-calculator` comparten anclas de esas mismas fichas ✓.
   **Sin verificar, con su motivo — para que nadie lo tome por hecho:** (a) el **gate** de
   `price-confirm-guard` usa `root_DatosPrecio*`, que sólo aparece **dentro del sub-modal de
   precio**; abrirlo toca precios productivos, así que **no se abrió** — lo que sí se comprobó es
   que la familia `root_*` no desapareció. (b) `surtido-guard` usa
   `WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK`, que vive **en las tarjetas**: el board probado
   (8496) tenía **0 tarjetas**, así que su 0 **no prueba nada** — es exactamente el error de método
   que esta regla acaba de corregir, y hay que repetirlo en un board CON tarjetas del step de
   surtido.
   **CERRADO 2026-08-03 con el HTML que aportó el operador** (la automatización no lograba abrir
   los modales; pegar el DOM salió más rápido y más fiable que insistir por CDP):
   **(a) `surtido-guard` ESTÁ SANO** — `WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK` presente
   en las tarjetas, y de paso se ve el **0.4.0 discriminando en vivo**: la tarjeta sin «Tareas
   Programadas» sale con `class="sa-sg-orange"` y las dos que sí las traen (T204-LI, 24/7/2026
   5:00 p.m.) quedan sin marcar — exactamente el comportamiento que el fix buscaba.
   **(b) el GATE de `price-confirm-guard` ESTÁ VIVO** — `<fieldset id="root_DatosPrecio">` con
   `root_DatosPrecio_Divisa` dentro del modal «Precio del número de parte». El ancla estructural
   que sostiene el candado existe.
   **(c) `CloseIcon` MEDIDO** (botón «Cancelar» de ese modal). El canónico de MUI resultaba
   correcto: no matcheaba porque el icono no está en las pantallas donde se buscó — **«no
   aparece» ≠ «es distinto»**, la misma confusión que produjo la sobregeneralización de los SHC.
   Se sumaron además la variante **outlined de `EditIcon`** y **`PrintIcon`**, este último con un
   matiz que importa: el workboard usa **PrintIcon** para «Print Job Tags» mientras la ficha de
   OT usa **QrCode2Icon** para «Imprimir Etiquetas de Trabajo» — dos botones con la misma función
   nominal y distinto icono, y es justo por casos así que **la FORMA va antes que el aria**.
   **CATÁLOGO COMPLETO: 13 de 13 MEDIDOS (2026-08-03) — VIVO config 1.11.61, bundle iPad 0.6.27.**
   (Son **14 entradas** en `ICON_SHAPES`: las 13 que hacían falta más `PauseIcon`, que entró como
   señal auxiliar del anclaje de `report-regen`.) El operador aportó también el HTML del modal «Send Invoice
   Email» y del dashboard de sensores 117 (la ruta real es
   `/Domains/<d>/Maintenance/SensorDashboards/<id>`, no la que se había intentado) ⇒ cerrados
   **`SendIcon`**, **`VisibilityIcon`** y **`VisibilityOffIcon`**. y, con el último fragmento,
   **`RestorePageOutlinedIcon`** (ficha de factura, dentro de un `popoverHandle`). Ése es el
   **único del catálogo SIN `aria-label` ni `data-testid`**: la forma es su única señal, lo que
   significa que `invoice-auto-regen` quedó **totalmente ciego** cuando SH borró el testid — no
   tenía ninguna red. **Trinquete nuevo:** un test se pone rojo si alguien agrega un icono con la
   lista de formas vacía «para medirlo después».
   **La misma lección se confirmó TRES veces**: los canónicos de MUI de `CloseIcon`, `SendIcon`
   y `VisibilityIcon` **eran correctos desde el principio** y daban `false` únicamente porque se
   probaron en pantallas donde esos iconos no viven. **Probar un path en la pantalla equivocada
   no dice nada sobre el path.** (Lo que sí es cierto es que `EditIcon` y `ArchiveIcon` SÍ
   difieren del canónico por optimización SVGO — o sea que medir sigue siendo obligatorio; lo
   que no se vale es concluir «el path está mal» desde un no-match en el lugar equivocado.)
   **Ojo con `Visibility*`: la correspondencia icono↔acción es INVERSA** — el ojo TACHADO va en
   el botón que dice «Show this sensor…» (está oculto, ofrece mostrarlo). Confundirlos
   invertiría `sensor-graph-hide-all`; hay un test que lo fija.
   **CIERRA ADEMÁS DOS PENDIENTES QUE VENÍAN DE ANTES:**
   **(a) la deuda bilingüe de `sensor-graph-hide-all` NO muerde hoy** — sus dos `aria-label`
   primarios siguen **EN INGLÉS** en la UI real (`"Hide this sensor in the graph."` /
   `"Show this sensor in the graph."`), que es exactamente lo que el applet tiene hardcodeado.
   Sigue siendo deuda (si SH los traduce, la primaria cae), pero ahora con el fallback por FORMA
   detrás, ya no se queda sin red.
   **(b) `cfdi-attacher` está VIVO y montando** — en el HTML del modal se ve su
   `<tr id="sa-cfdi-toggle">` con el checkbox «Adjuntar XML(s) CFDI». Su `structMatch` encuentra
   los 3 MuiSwitch y ahora, con `SendIcon` catalogado, tiene dos iconos válidos donde antes se
   sostenía sólo del `EmailOutlinedIcon` del botón «Save Draft».
   **LECCIÓN DE MÉTODO, que es lo que conviene no perder: «0 ocurrencias en N pantallas» NO
   prueba «lo eliminaron»; prueba «no está en esas N».** Para afirmar una eliminación hay que
   medir donde el atributo debería estar. Verificado en consecuencia: `wo-schedule-button`
   monta su readout (`🔀📅 Sin programar`) junto al ancla PDF, y el ancla de
   `price-confirm-guard` existe ⇒ **el «pendiente de mayor riesgo» que se había apuntado (los
   candados sin ancla) NO EXISTE**.
   La alternativa que sí aguantó: **el `d` del `<path>` del icono** — SH no lo puede cambiar sin
   cambiar lo que el operador VE. Núcleo
   [`mui-icon-anchor-core.js`](../../remote/scripts/mui-icon-anchor-core.js) (15 golden): busca por
   testid → por forma, y **devuelve `by: 'testid'|'shape'`** para que se pueda ver por qué
   matcheó y detectar el día que SH reponga o vuelva a quitar los atributos.
   **BARRIDO COMPLETO (2026-08-03): los 9 applets pasan por el núcleo.** `report-regen`,
   `cfdi-attacher`, `invoice-auto-regen`, `invoice-listing-marker`, `proceso-calculator`,
   `sensor-graph-hide-all`, `schedule-batch-highlighter`, `wo-listing-columns` y
   `wo-schedule-button`. Cada uno conserva su comportamiento anterior como fallback por si el
   core no cargó, y **`tools/test/mui-icon-core-wiring.test.js` (4 tests) ata config↔código**:
   un applet que usa el núcleo pero no lo declara en `config.apps[].scripts` caería al
   fallback ROTO **en silencio** — el mismo molde que `popup-actions-wired`.
   **7 iconos con forma MEDIDA en vivo** (Play, Email, Edit, Archive, FilterList, QrCode2,
   CalendarMonth) y **5 pendientes de medir** (Close, Send, RestorePage, Visibility,
   VisibilityOff), que van con la lista VACÍA a propósito: un path adivinado no matchea —el
   Edit canónico dice `a.9959.9959 0` y el real `a.996.996 0`; el Archive real empieza con `m`
   minúscula— y encima finge cobertura. Vacío + anotado degrada al estado de hoy, nunca peor.
   Dos tests registran esa deuda y **se ponen rojos si alguien mide un icono y no lo mueve de
   lista en el mismo commit**.
   **Intento de medición de los 5 (2026-08-03): siguen abiertos, y NO por la misma razón** —
   la distinción importa para decidir qué hacer con cada uno. **`VisibilityIcon`/`OffIcon` son
   IMPOSIBLES hoy**: el dominio 344 no tiene ningún Sensor Dashboard creado (lista vacía), así
   que no hay pantalla donde leerlos — y de paso, eso significa que `sensor-graph-hide-all`
   tampoco tiene dónde correr aquí (prioridad real: baja; su deuda de verdad es que ancla a un
   `aria-label` EXACTO en inglés, sin verificar contra el locale español). **`SendIcon` NO se
   midió por SEGURIDAD**, no por falta de acceso: su único hogar es el modal de envío de
   factura por correo, y abrirlo en el ERP productivo es una acción con efectos externos —
   mientras tanto lo sostiene el aria, y `cfdi-attacher` acepta además `EmailOutlinedIcon`, que
   sí está medido. **`CloseIcon` y `RestorePageOutlinedIcon` sólo faltó alcanzarlos**: los
   modales no abrieron por automatización (la OT probada no tenía etiquetas; el listado de
   facturas abre por omisión en Packing Slips) y el renderer se congeló varias veces — falla
   del ARNÉS, ya documentada, no de la app. Se cierran con un intento desde la pantalla
   correcta.
   **Tercera señal descubierta midiendo: SH conserva `aria-label` en muchos botones de icono**,
   traducido («Editar», «Archivar», «Imprimir Etiquetas de Trabajo»). Va al FINAL de la
   cascada, después de la forma, porque el texto sí cambia con el idioma — y porque **un aria
   laxo no falla: acierta el icono EQUIVOCADO**. Encontrado verificando en vivo: con `/…|qr/i`,
   `QrCode2Icon` matcheaba **«Escanear Código QR»**, el botón de la CÁMARA, en una pantalla
   donde el QR de etiquetas ni existe ⇒ `wo-schedule-button` habría abierto la cámara en vez de
   generar el PDF. Los patrones se endurecieron para exigir la palabra que nombra la ACCIÓN
   (etiqueta/label/tag), no la tecnología; `/ver/` se quitó de `VisibilityIcon` porque mordía
   «Ver Documentos». 5 tests de regresión con los textos reales.
2. **Texto ES+EN como red de seguridad** — encima de la estructural, para que solo AMPLÍE el
   match (si SH renombra el schema, el applet sigue vivo). Nunca como única señal de un gate.
3. **Bilingüe puro** — únicamente cuando **no hay estructura que anclar**: `window.alert`,
   toasts, texto suelto sin contenedor identificable.
4. ⛔ **NUNCA una clase `css-<hash>`** (`.css-iyrxkt`, `.css-xd9ivb`, `.css-9l3uo3`…). **Van
   por DEBAJO del texto**, fuera de la jerarquía: las genera **emotion a partir del contenido
   del estilo**, así que el hash cambia **cuando alguien mueve un padding** — sin avisar, sin
   cambiar nada visible y sin que el idioma tenga nada que ver. El texto visible, en cambio,
   sólo cambia cuando alguien traduce. **Parecen estructura y no lo son**, que es justo lo que
   las vuelve peligrosas: un applet anclado a `.css-iyrxkt` *se lee* como si cumpliera la
   regla 1.
   **Pasó el 2026-08-03** (reporte de piso: *«ya no me aparece la fecha y ubicación»*):
   `receiver-date-override` y `warehouse-location-prefill` hacían `p.closest('.css-iyrxkt')`
   para subir del label a su contenedor. SH rehízo el encabezado del modal de recepción —de
   `.css-xd9ivb` (flex row) con grids `.css-iyrxkt` `auto 1fr`, a **`.css-bomumo` con
   `.css-1xauu9w` flex-column por campo**— y esa clase **dejó de existir** (medido: 0
   ocurrencias, igual que `.css-xd9ivb`). `closest()` → `null` → `return` **en silencio**: los
   scripts cargaban, el modal se detectaba, y no se pintaba nada. Un tercer sitio
   (`findHeaderComboByLabel`) murió igual y **dejó habilitados campos que debían estar
   bloqueados**, sin aviso.
   **La salida NO es cambiar de hash: es SUBIR por relación estructural** (`parentElement`,
   número de labels hijos, orden de documento) partiendo del texto ES+EN, y **HEREDAR las
   clases de presentación del vecino vivo** (`anchor.wrapperClass` / `labelClass`) en vez de
   escribirlas a mano — así el próximo rehash de emotion nos sigue vistiendo igual que a SH.
   Decisión en el core puro
   [`receive-modal-anchor-core.js`](../../remote/scripts/receive-modal-anchor-core.js) (31 golden,
   con fixtures del layout de hoy **y** del viejo). **Que los dos applets tuvieran copias
   separadas del mismo anclaje es lo que hizo que se rompieran igual, en silencio y el mismo
   día** → la decisión y el montaje viven en UN solo lugar.
   **Deuda medida (2026-08-03): 24 sitios en 9 archivos** anclan a clases `css-*`
   (`po-listing-filters`, `proceso-calculator`, `invoice-autofill`, `load-calculator-modal`,
   `invoice-listing-marker`, `po-listing-filters-core`). Los del modal de recibo ya están
   saldados; **el resto sigue vivo y falla exactamente así de callado.**

- **Un latch de idempotencia marca el ÉXITO, no el INTENTO (regla de robustez).**
  `receiver-date-override` ponía `data-sa-rdo-attached='true'` **antes** de montar el campo:
  con el ancla rota, el observer volvía a pasar, veía el latch y se iba. Por eso el síntoma
  fue *«la fecha desapareció»* y no *«tardó un render en aparecer»* — **un fallo transitorio
  de montaje se congeló para siempre**. La función de montaje debe devolver si logró montar, y
  el latch ponerse sólo entonces; si no montó, el observer reintenta (con el `warn` acotado a
  uno por modal, o la consola se llena justo cuando hace falta leerla). Es pariente de la regla
  del guard que pregunta «¿ya lo hice?» en vez de «¿sigue siendo del mismo dueño?».

**Cuando toque texto (nivel 2 o 3): todo anclaje que dependa de TEXTO visible del UI de Steelhead debe matchear tanto español como inglés.** La UI de SH cambia de idioma por usuario/config (y a veces es mixta: un mismo modal muestra "Modo:" en español y "Per Part Count Unit Definitions" en inglés). Un anclaje mono-idioma se rompe silenciosamente al cambiar el locale. Aplica a: encabezados de modal (`isCreateOrderModalHeading` ES+EN es el patrón bueno), botones ("Guardar"/"Save", "Cancelar"/"Cancel"), labels de campo, adornos ("/ Part:"/"/ Parte:", "Parts /"/"Partes /"), regex de detección.
- **No adivines la traducción:** obtén el string real de AMBOS locales (pídelo o obsérvalo) antes de anclar. Si solo tienes uno, ánclalo pero **marca la deuda bilingüe** en la bitácora.
- Ejemplos de deuda detectada: `unit-autoconvert` (headingA EN-only, modoP ES-only, "/ Part:" EN-only), `create-order-autofill` (ya corregido a ES+EN).

**Audit COMPLETO 2026-07-09** (workflow multi-agente + grep inline de los que cortó el límite de gasto): **39 applets, detección terminada** → **10 con deuda** (~30 anclajes), **29 limpios** (`weight-quick-entry` = patrón bueno; los 19 API-driven confirmados sin anclaje de texto SH: no usan findByText/tests contra textContent/regex de labels de SH). **1er batch de fixes DEPLOYADO (config 1.7.100)**: labels de traducción confiable en 7 applets (Vendor/Proveedor, Divisa/Currency ×2 applets, Name/Nombre, Line Items/Líneas, Cliente/Customer, Línea/Line, NUEVO NÚMERO/NEW PART NUMBER, Terms/Términos, Modo/Mode). **Aún pendiente:** los *gates* mono-idioma (necesitan evidencia del string en el otro locale antes de anclar — no adivinar): ~~price-confirm-guard `"Part Number Price"`~~ **(RESUELTO v0.1.5 2026-07-27, y la lección generaliza: la salida de un gate mono-idioma NO es traducirlo sino ANCLARLO POR ESTRUCTURA del HTML —id de schema RJSF, `data-steelhead-component-id`— y dejar el texto ES+EN como red de seguridad que solo amplía. El bilingüe queda como única herramienta donde NO hay estructura: `window.alert`, toasts, texto suelto)**, bill-autofill `"Create Bill"`, invoice-autofill `"Creating Invoice for"`, cfdi-attacher `"Send Invoice Email"`, unit-autoconvert `"Per Part Count Unit Definitions"`/`"/ Part:"`/`"Parts /"`, create-order-autofill `"Enviar a:"`, ~~surtido-guard `"Tareas Programadas:"`/`"Proceso:"`~~ **(RESUELTO v0.2.0: `Tareas Programadas:` ya es ES+EN con `Scheduled tasks:`; el fallback por `"Proceso:"` se eliminó)**, proceso-calculator `"Default Process:"`. Y re-scan de ~19 API-driven (Workflow resumeFromRunId). Reporte HTML en scratchpad.

**PENDIENTE (audit repo-wide de anclajes bilingües):** revisar TODOS los applets de `remote/scripts/*.js` que anclen por texto de UI y confirmar que cada anclaje matchee ES+EN. Priorizar los que corren sobre modales/formularios de SH (autofills, guards, create-order, unit-autoconvert, invoice-*, receiver-date, warehouse, weight-quick-entry, surtido-guard, price-confirm, vale-almacen). Registrar hallazgos por applet y hardenizar con evidencia de ambos locales. Ver task en el tracker.

Patrones específicos (label-driven extractors, react-select, MUI X DatePicker, modal injection, auto-fill con cancellation tokens, etc.) en [`docs/architecture/dom-patterns.md`](dom-patterns.md) — ahí también vive la **jerarquía de anclaje** (estándar 2026-07-17, con el caso medido de `price-confirm-guard`) y cómo **inspeccionar en vivo por automatización de Chrome** sin que la página se congele (la ventana no puede quedar tapada del todo; no necesita el foco).

