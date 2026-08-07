# `warehouse-location-prefill`: lecciones 0.5.69 → 0.6.4

## 0.6.4 (2026-08-07) — el latch marcaba el INTENTO, y el candado no podía depender del campo

**Lo destapó un test, no un reporte.** Al escribir el trinquete de familia
(`modal-detect-poll-coverage`) para los applets que montan UI en modales, WLP salió **rojo**: su
`GATE_POLL_MS` vigila el CANDADO de un modal **ya detectado**, no la detección. Si la detección
nunca ocurre, ese poll nunca arranca. Es el applet gemelo de `receiver-date-override` —viven en el
mismo modal y desaparecieron juntos el 2026-08-03— y tenía el mismo hueco, completo:

> **El hallazgo que lo motiva** (medido en producción el 2026-08-07, `/Domains/344/SalesOrders` y
> `/Receiving/CustomerParts`): con un modal ABIERTO se contaron **0 mutaciones de `childList` en el
> `document.body` durante 6 segundos**, incluso tecleando dentro del modal. El `MutationObserver`
> **no es un vigilante continuo**: dispara en eventos discretos. En estas pantallas el único evento
> que llega es el montaje del modal — y si el debounce vence mientras ese montaje va a medias (lo
> normal en un equipo lento, donde el contenido se llena con la respuesta de red), el applet mira
> cuando no hay nada que ver, falla en silencio y **nadie vuelve a llamarlo**. En una máquina rápida
> todo se monta en la misma ráfaga y el disparo cae con el DOM completo: por eso el síntoma es
> *«a mí me funciona, a ellos es intermitente»*.
>
> Trinquete de familia: [`tools/test/modal-detect-poll-coverage.test.js`](../../tools/test/modal-detect-poll-coverage.test.js).

### Los tres arreglos

1. **El latch marcaba el intento.** `onModalFound` ponía `saWlpAttached = 'true'` en su **segunda
   línea**, antes de inyectar. Un fallo de anclaje se volvía **permanente**: el observer volvía a
   pasar, veía el latch y se iba. RDO corrigió esto en 0.5.81; WLP no.
2. **Sin poll de re-detección.** Agregado, con el tick barato de `weight-quick-entry`.
3. **El scan se rendía en el primer candidato.** Ahora recorre todos hasta que uno monte
   (`ReceiveModalAnchorCore.firstMounted`).

### Lo delicado: el CANDADO no puede depender de que el campo monte

Mover el latch al final —lo obvio— **habría desarmado el candado justo el día que más se necesita**.
La capa `fetch` que bloquea un recibo sin ubicación se activa con
`document.querySelector('[data-sa-wlp-attached="true"]')`, es decir con el modal **DETECTADO**. Si
el anclaje del combo falla (rehash de emotion), el operador se queda sin el combo del encabezado
**pero conserva los combos por renglón**: frenar el guardado sigue siendo correcto y sigue teniendo
salida. Atarlo al montaje del campo lo habría apagado precisamente en el escenario de falla.

Por eso van **dos marcas**, y el test lo fija:

| marca | significa | se pone |
|---|---|---|
| `data-sa-wlp-attached` | el modal se **detectó** y quedó cableado (candado, watchers, gate poll) | una sola vez |
| `data-sa-wlp-field-mounted` | el combo de ubicación quedó **montado** | solo tras un `injectField` exitoso |

El poll filtra por la **segunda** (`:not([data-sa-wlp-field-mounted="true"])`): un modal donde el
campo falló sigue mereciendo reintentos, y re-cablear el modal —que crea observers y timers— pasa
una sola vez. `injectField` ahora devuelve boolean en sus cuatro salidas.

> **Regla:** cuando un latch protege dos cosas de vida distinta —lo que se cablea una vez y lo que
> se reintenta— necesita dos marcas. Y antes de mover un latch, pregunta **qué más cuelga de él**:
> aquí colgaba un candado de seguridad.

### 0.6.5 (2026-08-07, mismo día) — el campo volvió a montarse PRIMERO

**Reporte de piso con captura: «se quebró WLP, no aparece el campo».** En la captura, el encabezado
traía «Fecha real de recibido:» (RDO ✔) pero **no** «Ubicación inicial:» — y aun así el candado
estaba **funcionando**: «Grupo de Piezas» y «Contenedor» en *— Bloqueado —* y el renglón marcado en
naranja. Esa combinación es la firma exacta del bug de 0.6.4: el modal se detecta y se cablea, y lo
único que falla es `injectField`.

**Medido en producción con `1.11.107` servido** (wizard abierto por automatización, consola
capturada): `campoUbicacion_WLP: true`, `campoMontado_WLP: true`, **cero warns**, campo visible en
`x=1271`. Y forzando el remontaje con el campo de RDO ya presente, **volvió a montar**. O sea: la
versión con el fix **sí monta**.

**Lo que el operador vio fue la ventana entre `1.11.105` y `1.11.107`** — es decir, entre el fix de
`receiver-date-override` y el de este applet. En esa franja RDO ya tenía poll (montaba siempre y
antes) mientras WLP seguía con el latch puesto **al INTENTO**: si `injectField` fallaba en ese
primer disparo, el latch quedaba puesto y no había reintento. Una pestaña abierta desde antes del
deploy sigue corriendo el código que se le inyectó: **hace falta recargar** (⌘⇧R).

> **Regla que sale de aquí:** *arreglar el disparo de un applet cambia el timing de sus vecinos.*
> RDO y WLP se anclan al MISMO encabezado; darle poll a uno lo hace montar antes, y el que todavía
> no tiene red de seguridad pasa de "falla a veces" a "falla siempre". Cuando dos applets comparten
> contenedor, **se arreglan en el mismo deploy** o el intermedio es una regresión visible.

**Corrección adicional de este mismo día:** al introducir las dos marcas, `injectField` quedó
**después** de todo el cableado — detrás de `applyUnusedFieldStatesWithRetry`, `evaluateSaveGate` y
`watchLineRows`, tres funciones que tocan el DOM del modal y que, si tiran, se llevan por delante el
montaje del campo. Se restauró el orden original (**el campo primero**) y cada paso del cableado va
en su propio `try`, para que un fallo no deje sin instalar a los siguientes — el candado es el
último y el que menos puede faltar. El test ya no fija un orden textual (esa primera versión se
rompió al restaurar el orden correcto): fija que **no haya un `return` entre el intento de montar el
campo y `startGatePoll`**, que es la intención real.

⚠️ **Verificado el MONTAJE en vivo** (wizard abierto por automatización con `1.11.107`: campo
presente y visible, sin warns). **Falta verificar el CANDADO en vivo** — que siga bloqueando el
guardado de un renglón sin ubicación no se probó, porque exigiría intentar guardar un recibo real en
el ERP productivo. Al primer uso en piso, confirmarlo.


**Safari/iPad:** en el bundle **0.6.38** (2026-08-07). Este fix pesa más en el iPad que en escritorio: es el dispositivo del piso y la CPU más lenta del parque — el perfil exacto donde el montaje llega tarde y el observer ya no vuelve a mirar. **Pendiente recompilar en Xcode** (`Resources/` sincronizado ≠ compilado).

## 0.6.3 (2026-08-03) — una clase de emotion es MENOS estable que el texto que quisimos evitar

**Reporte de piso: «ya no me aparece la fecha y ubicación de la extensión».** Con captura del modal de recepción sin ninguno de los dos campos. Applet hermano `receiver-date-override` afectado idéntico y el mismo día: la bitácora de allá cuenta la misma historia desde su lado.

- **El dato que orientó todo desde el principio: en la captura el ⚡ PESO SÍ aparecía.** O sea la extensión cargaba y estaba inyectando applets en esa pantalla. Eso descartó de entrada las tres sospechas baratas (gate por URL, deploy no propagado, extensión desactualizada) y acotó la búsqueda a lo que estos dos comparten y `weight-quick-entry` no: **el lugar donde montan**. Los tres tienen los mismos `urlPatterns`, verificado.
- **Causa raíz, medida en vivo por capas.** Los scripts cargaban (`WarehouseLocationPrefill` = object), el modal se detectaba (`data-sa-rdo-attached="true"` puesto), y aun así el campo no se pintaba. La capa que fallaba era el ANCLA: **`.css-iyrxkt` → 0 ocurrencias en todo el documento, `.css-xd9ivb` → 0**. `p.closest('.css-iyrxkt')` devolvía `null` y la función hacía `return` en silencio.
- **No fue sólo un rehash: SH cambió el layout.** El encabezado pasó de `.css-xd9ivb` (flex row) con varios `.css-iyrxkt` (cada uno un grid `auto 1fr`) a **`.css-bomumo` (flex row) con `.css-1xauu9w` (flex column) por campo** — cuatro columnas de `flex: 1 1 0%`, dos de ellas vacías. Con ese layout, además, el `gridColumn: 1 / 2` que el applet fijaba ya no significaba nada.
- **LA LECCIÓN: `css-<hash>` es el anclaje MENOS estable que hay, por debajo del texto.** El repo tenía la regla «estructura antes que texto» y estos dos applets la cumplían *de nombre*: `.css-iyrxkt` **parece** estructura, pero es una clase que **emotion genera a partir del contenido del estilo**. El texto visible cambia cuando alguien traduce; el hash cambia **cuando alguien mueve un padding**. La jerarquía correcta pone `data-steelhead-component-id` / `data-testid` / ids de schema arriba, y las clases generadas **fuera de la lista**, más abajo que el texto bilingüe.
- **Aquí no había nivel 1 disponible, y se midió antes de concluirlo:** el diálogo completo tiene **0 `data-steelhead-component-id` y 0 `data-testid`**. Así que la entrada sigue siendo el texto ES+EN («Comentarios del receptor:» / «Receiver Comments:»), que estaba bien; lo que había que cambiar era **la subida**: `p.parentElement` (wrapper del campo) → `.parentElement` (fila), por relación estructural.
- **Las clases de presentación ahora se HEREDAN del vecino vivo** (`anchor.wrapperClass`, `anchor.labelClass`) en vez de escribirse a mano. El próximo rehash de emotion nos seguirá vistiendo igual que a SH en lugar de dejarnos con un nombre de clase muerto. Ésa es la parte que evita la *siguiente* ocurrencia de este mismo bug, no sólo la de hoy.
- **La decisión vive en un core compartido nuevo, [`receive-modal-anchor-core.js`](../../remote/scripts/receive-modal-anchor-core.js) (31 golden).** Que RDO y WLP tuvieran **copias separadas del mismo anclaje** es justo lo que hizo que los dos se rompieran igual, en silencio y el mismo día. El montaje también vive ahí, con `document` inyectado para que siga siendo probable en node.
- **Se reusan los huecos que SH ya deja.** La fila es `flex nowrap` con columnas de `flex: 1 1 0%`: cada columna nueva angosta a todas las demás. `pickInsertionSlot` toma una de las dos vacías; si no hay, crea un hermano. Medido en el DOM real: **antes 4 columnas de 400px, después 4 columnas de 400px** — los dos campos entraron sin apretar nada.
- **Tercer sitio roto por la misma causa, que el reporte no mencionaba:** `findHeaderComboByLabel` iteraba `.css-iyrxkt` buscando `.css-xd9ivb` adentro, así que devolvía `null` siempre y **los campos que debían quedar bloqueados (Grupo de Piezas, Contenedor) se quedaban habilitados**, sin ningún aviso. Reescrito con el patrón que este mismo archivo ya usaba y tenía validado en piso desde 0.6.1: localizar el texto del label y subir al ancestro **más cercano** con un control react-select (subir por cercanía, y no tomar «el primero que sigue en orden de documento», es lo que impide cruzarse al campo vecino).
- **El candado quedó vivo todo el tiempo, y eso cambia la severidad del reporte.** Medido en vivo: la nota «⛔ Falta la ubicación inicial (1 línea)» seguía pintándose y la capa del payload seguía exigiendo `locationId`. O sea el trabajo **no se volvió imposible, se volvió manual**: había que poner la ubicación renglón por renglón, sin la herramienta del encabezado que la ponía de un jalón — y en el iPad, con teclado en pantalla, eso duele el doble. Es la contracara del diseño de 0.6.0: la capa del payload es idioma- y layout-independiente, así que sobrevivió al cambio que tumbó a la capa DOM.
- **Verificado contra el DOM productivo** (modal real, dominio Ecoplating TLC): los dos anclajes resuelven (`mode: 'sibling'`, `wrapperClass: css-1xauu9w`), los dos campos **montan**, y la fila queda en 4 columnas de 400px. Suite 91 archivos verdes. **VIVO config 1.11.53**, tag `v1.11.53`, firma KMS verificada en vivo. Bundle iPad **0.6.20** (verificado en el artefacto; falta recompilar en Xcode).
- **Lo que NO se verificó:** el modal real **con el código ya deployado**. El montaje se comprobó ejecutando la lógica del core contra el DOM productivo, y por separado se confirmó que `window.ReceiveModalAnchorCore` ya carga desde producción tras el deploy — pero la pasada final end-to-end no se cerró porque el renderer de la pestaña automatizada se congeló dos veces (modo de falla del **arnés**, ya documentado en el repo, no del applet).

## 0.6.2 (2026-07-30) — la MISMA trampa, ahora en NUESTRO combo del encabezado

**Reporte de piso, urgente: «cuando colocan la ubicación desde el applet no lo detecta y les bloquea como si no la hubieran ingresado».** Reproducido en vivo antes de tocar código: se teclea `A2Aduana` en el campo «Ubicación inicial:» del encabezado, se sale con Tab, y el campo **queda mostrando el texto** mientras el renglón sigue en naranja y el pie dice «⛔ Falta la ubicación inicial (1 línea)». El candado tenía razón —no había `locationId` que inyectar— pero **la UI decía lo contrario**.

- **Es exactamente la lección de 0.6.1, aplicada a nuestro propio widget.** Ahí el error fue juzgar el combo del RENGLÓN por la ausencia del placeholder; aquí es que **texto visible ≠ valor elegido** en el combo que nosotros inyectamos. `selectedLocation` sólo se escribe en `selectLocation()`, que únicamente se dispara con el `mousedown` de una opción del dropdown; **no había ningún manejo de teclado**, así que Enter y Tab no hacían nada y el `blur` se limitaba a esconder la lista. Dos caminos llegan al bug: teclear sin elegir, y elegir y luego editar el texto (el `input` invalida la selección pero **deja el texto puesto**).
- **El diagnóstico llegó preguntando, no adivinando.** Había dos hipótesis con arreglos distintos: capa DOM (aviso naranja + botones grises) o capa payload (mensaje al dar clic, que apuntaría a un desajuste del canal `pendingLocationId` entre dos instancias del script). El operador respondió «aviso naranja + botones grises» y «en el campo de arriba», y eso descartó la mitad del árbol en un solo paso. **Con dos causas plausibles y fixes incompatibles, una pregunta de diez segundos vale más que un deploy.**
- **El fix RESUELVE en vez de sólo avisar.** `resolveTypedLocation(texto, catálogo)` (núcleo puro) devuelve `exact` (el texto es idéntico al `name` o al `path` de una ubicación), `unique` (filtra a una sola), `ambiguous`, `none` o `empty`; Enter, Tab y el `blur` la usan. Teclear el nombre y seguir adelante —que es lo natural, y más en el iPad, donde atinarle a la opción del dropdown cuesta— ahora simplemente funciona.
- **Nunca adivina.** Con varias candidatas no elige ninguna: mandar material a la ubicación equivocada es peor que pedir un clic más. La pasada exacta va **antes** que la parcial justo para que `A2Aduana` resuelva aunque exista `A2AduanaBis`; y dos ubicaciones con el mismo `name` se quedan en `ambiguous`.
- **Si no resuelve, el campo se VACÍA y dice por qué** («⚠️ «Aduana» coincide con 5 ubicaciones — elige una de la lista»). Un campo con texto que no se aplicó es una **mentira visible**, y era justo la que hacía leer el bloqueo como una falla de la extensión. Excepción: si el catálogo todavía no cargó no se borra nada (sería castigar al operador por una demora de la consulta).
- **El poll del candado (900 ms) es la red** para el caso en que el operador va del teclado directo al botón de guardar: si el input ya no tiene el foco, resuelve lo tecleado. Mientras **sí** lo tiene no se toca — estaría escribiendo.
- **Validado EN VIVO con el applet publicado (config 1.11.34):** `A2Aduana` + Tab → el campo queda en `Ecoplating.N2.A2.A2Aduana`, el renglón pierde el naranja y el aviso del pie desaparece; `Aduana` + Tab → el campo se vacía, sale el aviso de las 5 coincidencias y el candado sigue bloqueando (correcto: no hay ubicación). +10 golden con las ubicaciones reales del dominio 344 (49/49).
- **Lo que NO se validó hoy (para no dejar un mapa falso):** lo de arriba cubre el combo del **ENCABEZADO**. Los dos pendientes que 0.6.1 dejó sobre el combo del **RENGLÓN** —(a) que bloquee en el estado «tecleando sin elegir» y (b) la vía manual completa: elegir en el combo del renglón → desbloquea— **siguen abiertos**, son de otro widget y este fix no los toca. Tampoco se probó el guardado real (`CreateReceiverChecked` nunca se disparó: la validación fue toda sobre modales que se cancelaron).

Applet hermano de `receiver-date-override` que inyecta un combobox custom "Ubicación inicial:" en el header del modal Receive Parts. Al elegir una ubicación, **intercepta `CreateReceiverChecked` y agrega `locationId` en todos los `receiverBomItems[].inventoryTransferEvent.debitAccounts.accounts[]`** antes de enviar al server. Default del combobox filtra solo ubicaciones con "Aduana" en el path; sentinel "Mostrar todas" da escape al catálogo completo con paginación lazy de a 200.

## 0.6.1 (2026-07-29) — el renglón se juzga por señal POSITIVA, no por ausencia de placeholder

**Falso negativo encontrado validando 0.6.0 EN VIVO, no en los tests.** Al **teclear** en el combo de ubicación del renglón sin elegir nada, react-select **retira el placeholder** aunque no haya valor ⇒ el criterio «no hay placeholder = ya tiene ubicación» daba el renglón por resuelto y **liberaba el guardado**. Medido sobre el DOM real en ese estado exacto: `control = css-1bsomep-control`, su `input.value = "A3Aduana"`, **sin `singleValue`** → criterio viejo `true` (mentira), criterio nuevo `false`.

- **La lección es sobre el TIPO de señal, no sobre este widget.** «No aparece el placeholder» es una señal **negativa**: cubre el estado con valor y también el estado intermedio de escritura, que significa lo contrario. La señal correcta es **positiva**: *hay un valor elegido* (`singleValue`). Un candado apoyado en la ausencia de algo hereda todos los motivos por los que ese algo puede faltar.
- **Para exigir la señal positiva primero hay que poder localizar el combo en CUALQUIER estado**, y sin placeholder ya no se podía. Se ancla por el label del renglón «Ubicación Inicial:» (ES+EN) + el primer `[class*="-control"]` que le sigue en **orden de documento** (`compareDocumentPosition`) — así no se depende de la forma del grid, que fue lo que costó rondas en 0.5.65-80. Verificado en vivo: el label vive en un `.css-xd9ivb` y el control es un nodo posterior, no un descendiente.
- **El fallback conserva el criterio viejo** cuando el label no se reconoce (locale desconocido): peor cubrir menos que apagarse. Y ahí el candado del payload sigue siendo la red — justo el reparto que motivó las dos capas.
- **Marcas naranjas huérfanas:** el combo que llevaba la marca puede cambiar de estado (o React re-crearlo) y entonces ya no aparece en la lista de renglones para limpiarse solo. Sin un barrido explícito queda una marca naranja sobre un renglón ya resuelto — **una mentira visible**, que es peor que no marcar. `markMissingRows` ahora recorre las marcas del modal y borra las que no correspondan.
- **Estado de validación (honesto).** Con el applet **deployado** se validó end-to-end el 0.6.0: bloqueo con el renglón vacío, el clic en GUARDAR que **no guarda** (toast + tooltip nombrando `Línea 1 · FPN123`), el desbloqueo al poner la ubicación en el encabezado y el re-bloqueo al quitarla; y aparte, el mecanismo del listener capture en **ambas direcciones** (con capture el botón «Hoy» no cambia la fecha; sin capture, 28→29). Del **0.6.1** se validó el criterio nuevo con las funciones exactas del fix contra el DOM real **en el estado del bug**, pero **queda por confirmar con el applet ya publicado**: (a) que bloquee en el estado «tecleando sin elegir» y (b) la vía manual completa (elegir en el combo del renglón → desbloquea). Las dos se quedaron a medias porque la sesión de `/graphql` se colgó —el modo de falla por ráfaga de requests ya documentado en `po-listing-filters`/`batch-name-filter`, que es del ARNÉS, no del applet—. Riesgo bajo: (a) ya está medido sobre el DOM real y (b) recorre el mismo camino de código que el desbloqueo por encabezado, que sí se vio funcionar.
- **Lección de método: los 33 tests del núcleo pasaban y el applet estaba mal.** El estado «tecleando sin elegir» no estaba en ningún test porque **no se me ocurrió como estado** — apareció solo porque la página se congeló a media interacción y dejó el DOM ahí. Los tests fijan los estados que ya conoces; los estados que no conoces los encuentra el uso real.

## 0.6.0 (2026-07-29) — CANDADO: no se guarda hasta que TODO tenga ubicación

Pedido del operador: que el botón de guardar **no se habilite** hasta que cada renglón tenga ubicación inicial —por el combo del encabezado o puesta a mano— y que el tooltip diga **qué línea/lote** sigue sin ella. Núcleo puro nuevo [`warehouse-location-guard-core.js`](../../remote/scripts/warehouse-location-guard-core.js), **33 golden tests**.

- **La UI se inspeccionó EN VIVO antes de escribir un solo selector** (regla del repo), y de ahí salió el criterio de detección con sus **dos estados medidos**: un combo de ubicación **vacío** es `css-qpe0ht-control` + `[id$="-placeholder"]` «Buscar Ubicaciones...»; **con valor** es `css-1bsomep-control` + `singleValue` con el path (`Ecoplating.N2.A2.A2Aduana`). Como react-select **sustituye** el placeholder por el singleValue, **la presencia del placeholder ES la señal de "vacío"** — y es la misma señal que `findLocationCombos` ya usaba desde 0.5.x, o sea que el candado no introduce ningún anclaje nuevo por texto. Ese detalle importa: el criterio ya venía probado en producción.
- **El pie del modal NO expone `data-steelhead-component-id`** (medido: los 4 botones vienen sin él), así que aquí no hay ancla estructural que ganarle al texto. Se compensa así: el pie se localiza **por estructura** (se ancla en el botón de Cancelar y se sube al contenedor que agrupa varios botones) y los botones de guardar sí van por texto **ES+EN** (`Guardar`/`Save`, con `Cancelar`/`Cancel` excluido de forma exacta para que un futuro «Guardar y cancelar pendientes» no se escape). Los tres reales quedaron fijados en un test: «Guardar», «Guardar + imprimir todas las piezas», «Guardar y agregar piezas a OT».
- **DOS capas, y la segunda existe justo porque la primera depende del idioma.** Un candado que se ancla a texto **se apaga en silencio** cuando el locale cambia (la lección de `price-confirm-guard` 0.1.5, que llevaba semanas sin disparar). Por eso el candado real vive en el **interceptor de `fetch`**: se juzga el payload de `CreateReceiverChecked` **ya mutado** (después de inyectar el locationId del encabezado) y si algún `debitAccounts.accounts[]` va sin `locationId`, la mutación **no sale** — `Response` sintética con `errors`. Si el layout o el idioma cambian y la capa DOM deja de reconocer los combos, la escritura sigue frenada: **la falla pasa de silenciosa a ruidosa**.
- **El candado del payload se acota a NUESTRO modal** (`[data-sa-wlp-attached="true"]` presente). Fuera de él —p.ej. la «Entrada de recepción con IA», que vive en el listado y puede crear recibos sin pasar por el modal— el operador no tiene los combos a la vista, y frenarlo ahí lo dejaría **sin salida ni explicación**. Un candado que bloquea donde no se puede obedecer no es seguridad, es una pared.
- **Ambas capas son fail-safe por decisión explícita:** sin evidencia POSITIVA de faltante, se deja pasar. `payloadMissingLocations` devuelve `checked:false` si el payload no trae la forma esperada (sin `receiverBomItems`, sin `debitAccounts`, cero accounts inspeccionables) y el llamador entonces **no bloquea**; `decideSaveGate` con entradas basura devuelve `blocked:false`. La asimetría es deliberada: un falso bloqueo **para el piso** (nadie puede recibir material), un falso paso solo repone el comportamiento de hoy, que ya era guardar sin ubicación.
- **`disabled` no se usa NUNCA para bloquear, y tampoco `className`: los dos los pinta React.** El bloqueo son listeners **capture en el propio botón** (React escucha en el contenedor raíz durante la burbuja, así que un `stopPropagation` en capture llega antes y su `onClick` jamás se dispara) y el estilo cuelga de un **atributo nuestro** (`[data-sa-wlp-blocked]`). Si React re-crea el botón, el poll lo vuelve a marcar. Mismo razonamiento que el overlay de los combos per-line (0.5.78), aplicado a un botón: el listener capture es **más robusto que el overlay** porque no depende de geometría ni de `z-index`.
- **Si React ya tiene el botón deshabilitado, no lo tocamos.** El pie nace gris por motivos de Steelhead (falta el cliente, p.ej.). Atribuirnos ese gris haría que nuestro tooltip mintiera sobre la causa; el candado solo actúa cuando React habilitó el botón y la ubicación es lo que falta.
- **El candado se re-mide ANTES de tragar el clic.** Si en ese instante ya no falta nada, el clic pasa y el gate se recalcula. Vale más un candado que se abre solo que uno que deja al operador atorado con un veredicto viejo.
- **El tooltip no basta: un botón gris sin explicación A LA VISTA se lee como falla de la extensión.** Van tres señales, no una: (a) contador en el pie, junto a los botones —ahí es donde mira quien quiere guardar—, **clicable** para saltar al primer renglón pendiente; (b) tooltip **dark-mode** propio (regla de diseño: que se distinga de la UI de SH) con las líneas pendientes, `Línea 3 · 80095-337-01 · lote T-226`, tope de 8 y «…y N más»; (c) **marca naranja** en el combo de cada renglón que falta. Lo (c) es lo que de verdad resuelve «cuál línea es» cuando hay 30 renglones, donde un tooltip que lista 8 no alcanza. El marcado resalta **la excepción** (lo que falta), no la norma — misma lección que `surtido-guard` 0.2.0.
- **`title` nativo como red del tooltip propio, pero no los dos a la vez:** se retira en `mouseenter` y se repone en `mouseleave`. Si nuestro JS de hover no corriera, el nativo dice lo mismo.
- **El observer del tbody pasó a `subtree:true` y eso obliga a que TODA escritura sea idempotente.** El cambio que importa —un combo pasando de placeholder a singleValue— ocurre **dentro** del renglón, no en la lista de renglones, así que `childList` sin subtree no lo veía. Con subtree, cualquier escritura incondicional se re-dispararía a sí misma en bucle: por eso `setAttrIfNeeded` y todos los `if (x !== y)` antes de asignar. Más un poll de 900 ms como red, porque teclear el nombre del lote **no muta el DOM** (`value` no es atributo) y React puede re-crear el pie y borrar el aviso.
- **El núcleo puede llegar DESPUÉS del applet.** El loader nuevo baja los scripts con un pool de concurrencia (no en serie), así que `window.WarehouseLocationGuardCore` no está garantizado al correr `init()`. El aviso de «no cargó» va **diferido 3 s** para no dar una falsa alarma, y el poll activa el candado en cuanto el núcleo aparece. Sin núcleo, el candado queda apagado y el applet prellena como siempre.
- **`injectStyles()` ahora se versiona (`data-sa-v`).** El remote loader puede reinyectar el script sin recargar la SPA, y un `<style>` con el mismo id se habría quedado sin las reglas nuevas. Se compara y se escribe **el mismo número** — el bug de `pn-specs-column` 0.3.1 fue subirlo en un solo lado, y por eso el `<style>` se borraba y recreaba en cada sync.
- **`locationId: 0` cuenta como FALTANTE.** Los ids de Steelhead son enteros positivos; tratar `0` como "puesto" dejaría pasar exactamente el caso que el candado busca frenar.

## Lecciones previas (0.5.69 → 0.5.80)

- **Validar el shape del payload con instrumentación read-only ANTES de mutar (ciclo Task 7 → Task 8 del plan).** El plan original asumía que `locationId` venía null o con default en `accounts[].locationId`, listo para sobrescribir. La instrumentación de Task 7 (window.__saWlpLastPayload + log de keys) reveló que el campo **NO existe en el payload cuando el usuario no toca el combo per-line** — Steelhead lo omite y el server cae al default global. Hay diferencia entre "set" y "add", aunque en JS ambas se escriben igual. Pedir un dump del usuario en producción real para confirmar el shape antes de escribir la mutación cerró el ciclo en una iteración. Lección reforzada del cierre de `process-canon` (0.5.52-56) y `invoice-auto-regen` (0.5.36-37).
- **Sentinel para confirmar shape: dos pruebas, no una.** El primer dump (sin selección de ubicación per-line) mostró `accounts[]` SIN `locationId`. Pero podría haber sido que vivía en otro nivel. La segunda prueba — que el usuario seleccione ubicación específica en el combo nativo per-line de cada renglón — confirmó el path exacto (`debitAccounts.accounts[].locationId` numérico) y descartó alternativas (no era path string, no estaba en `creditAccounts`, no estaba en `createInventoryBatch`). El dump comparativo es lo que da certeza para escribir mutaciones.
- **Disabling visual de combos per-line via overlay CSS, NO `disabled` attribute.** React-select re-renderea agresivamente y pierde el `disabled` en el siguiente render; un overlay sobre `.css-qpe0ht-control` con `pointer-events: none` + opacity sobrevive ciclos de React. El overlay es solo capa de UX — la garantía dura es el interceptor del payload, que sobrescribe `locationId` independientemente de lo que el combo-line haya cargado.
- **Bloqueo REAL de clicks sobre el overlay (0.5.78): `pointer-events: auto` no basta.** El overlay con `pointer-events: auto` capturaba el cursor (visualmente gris, cursor `not-allowed`) pero el click seguía abriendo el dropdown del react-select porque (1) react-select crea su propio stacking context con su input y (2) el overlay no tenía `z-index` explícito. Fix: `z-index: 10` + `cursor: not-allowed` en CSS, y handlers capture-phase en el overlay para `mousedown`, `click`, `focus` que llaman `e.stopPropagation()` + `e.preventDefault()`. La fase capture es importante porque react-select usa eventos burbujeando hacia su control raíz; en capture el overlay los come antes. Patrón aplicable a cualquier UX donde necesitas tapar un widget React-controlado sin desmontarlo.
- **Patrón "intercept-and-mutate" puro** (a diferencia de `receiver-date-override` que requiere follow-up `UpdateReceiver` porque el server siempre setea `receivedAt = NOW()`). Aquí el server SÍ acepta `locationId` en el create, así que la mutación va en el body original, sin follow-up. Más limpio y atómico.
- **Coexistencia con `receiver-date-override`**: cada applet patcha `window.fetch` con su propio guard (`window.__saWlpFetchPatched` / `window.__saRdoFetchPatched`). WLP muta el REQUEST body; RDO clona el RESPONSE para disparar follow-up. Independientes; el orden de carga no importa.
- **Combobox custom (vanilla HTML/CSS), no react-select.** Las lecciones de `invoice-autofill` son claras: react-select pelea contra programmatic value setters y requiere keystroke-by-keystroke con cancellation tokens. Para un combobox que controlamos nosotros desde cero, mucho más simple es construirlo a mano con `<input>` + `<div class="dropdown">` y manejar el state explícito. Costo bajo, cero peleas con React.
- **State channel modal → fetch patch via module-level vars.** El interceptor es singleton global; el modal state vive en WeakMap. Para que el patch sepa qué `locationId` aplicar, hay dos vars module-level (`pendingLocationId`, `pendingLocationOwner`) que `selectLocation`/`clearSelection`/`cleanupModal` actualizan. Detalle crítico de cleanup: `cleanupModal` debe limpiar **incondicionalmente**, no solo si `pendingLocationOwner === modal`. Si `findModalForState` regresa `null` durante `selectLocation` (race raro pero posible), el `pendingLocationOwner` queda `null` y un cleanup guardado nunca se dispara, dejando `pendingLocationId` con un id stale para el siguiente modal.
- **Race en double-click de paginación lazy ("Cargar más").** El handler `mousedown` async no protege contra clicks dobles rápidos: el texto `'Cargando…'` es solo visual. Sin un `state.fullCacheLoading` flag con early-return, dos handlers paralelos disparan `fetchAllLocations(state.fullCacheOffset, 200)` con el MISMO offset y duplican entradas en `fullCache`. Patrón aplicable a cualquier sentinel async de UI: flag in-flight + early-return + `finally` para limpiar.
- **Mutation safety: `opts.body` solo se asigna DESPUÉS de que todos los loops completan, y solo si `totalAccounts > 0`.** Si una excepción rompe a media iteración, el `opts` original queda intacto y el catch path puede pasar `args` originales a `origFetch`. La separación de "calcular mutación" → "commit a opts.body" → "log post-commit" → "return mutated args" hace imposible que un body parcialmente mutado escape al server.
- **Wildcard SQL en `SearchLocationsOnPath` (0.5.79): `searchText: ''` devuelve `[]`.** El backend trata `searchText` como argumento de SQL `LIKE`, así que `LIKE ''` solo matchea path vacío (cero filas). Para "todo el catálogo" hay que pasar `searchText: '%'` y `searchTextLast: '%'` (wildcard que matchea cualquier path no-NULL). Lo mismo ya hacía `fetchAduanaLocations` con `'%Aduana%'` — la lección es que **no hay shortcut "vacío = todos"** en este endpoint. Aplicable a otros queries de Steelhead que usan parámetros de búsqueda parcial.

- **Real estate del modal: ANCLAR DENTRO del `.css-iyrxkt`, no como sibling del `.css-xd9ivb` (0.5.80).** Versiones tempranas de RDO/WLP insertaban su wrapper como sibling del row container `.css-xd9ivb` (flex-row del header), lo que les daba una fila full-width pero solo usaban la columna izquierda — desperdiciando el espacio bajo Comentarios y Entradas Personalizadas. Fix: cada applet añade su par `<p class="css-9l3uo3" style="grid-column:1">label</p>` + `<div style="grid-column:2">controls</div>` directo como children del `.css-iyrxkt` del campo objetivo (RDO bajo Cliente, WLP bajo Comentarios). El grid `auto 1fr` del padre se extiende vertical y los nuevos elementos ocupan rows extra automáticamente. **Refina la nota de 0.5.65-67**: "sibling del row container" sigue siendo correcto cuando el campo necesita su propia fila independiente (full-width, ej. tabla pegada al header); para "campo extra dentro de una columna existente" anchor al `.css-iyrxkt` del campo. Mantén las clases CSS del label idénticas a las nativas (`css-9l3uo3`) para visual consistency.
