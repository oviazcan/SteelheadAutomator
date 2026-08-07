# `receiver-date-override`: lecciones 0.5.64 → 0.5.82

## 0.5.82 (2026-08-07) — «a mí me funciona, a ellos es intermitente»: era el DISPARO, no el ancla

**Reporte de piso:** el campo de fecha aparece siempre en la máquina del consultor y de forma
**intermitente** en los equipos Windows de menor desempeño. Llegó mientras se cerraba el caso
gemelo de [`create-order-autofill`](create-order-autofill.md#fix-2026-08-07-v018--falla-en-los-equipos-windows-de-menor-desempeño),
y el diagnóstico de aquél aplica aquí **medido, no por analogía**: en las pantallas de esta
familia se contaron **0 mutaciones de `childList` en el `body` durante 6 s** con un modal
abierto. El `MutationObserver` **no vigila**: dispara en eventos discretos.

Este applet dependía **solo** de ese observer, con un debounce de 300 ms y **sin poll** — el
mismo perfil que ya había tumbado a `weight-quick-entry` en ESTE MISMO modal (reporte de piso
2026-07-30) y a `create-order-autofill` (v0.1.6). Dos huecos, y ninguno es del ancla:

### 1. Un fallo de montaje sin nadie que reintente

`onModalFound` ya hacía lo correcto —el latch se pone **solo si `injectField` montó**, lección
de 0.5.81— pero eso solo sirve **si alguien vuelve a llamar**. El escenario del equipo lento:
el modal monta el esqueleto → el debounce vence a los 300 ms → el encabezado todavía no llegó
(se llena con la respuesta de red) → `findHeaderFieldAnchor` devuelve null → se reintenta… y si
la fase que faltaba no produce más altas/bajas de nodos, **no hay segundo disparo**. En una
máquina rápida el modal se monta entero dentro de la misma ráfaga y el único disparo cae con
todo listo — por eso no se reproduce en el escritorio del consultor.

**Fix:** el poll acotado de `weight-quick-entry`, que convive con este applet en el mismo modal
y en producción: `[role="dialog"]:not([data-sa-rdo-attached="true"])` cada segundo. Barato a
propósito — casi siempre no hay ningún diálogo pendiente, así que el tick se reduce a un
`querySelectorAll` por atributo.

### 2. El scan se rendía en el PRIMER candidato

```js
if (container) { onModalFound(container); return; }   // ← return montara o no
```

`HEADING_SELECTOR` es amplio (`h1…h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]`)
y el orden de documento no garantiza cuál llega primero. Si el primero que matcheaba resolvía un
contenedor equivocado, el applet se quedaba reintentando **con ése** cada vez y nunca llegaba al
modal bueno: falla **permanente** que depende del orden del DOM — es decir, distinta entre
equipos y estados de pantalla, que es justo como se ve "intermitente".

**Fix:** `onModalFound` devuelve si **montó**, y el recorrido sigue con los demás candidatos.
La política sale al core compartido: `ReceiveModalAnchorCore.firstMounted(candidatos, tryMount)`,
con test.

> **Regla que sale de aquí:** *un intento que no montó no consume el turno del siguiente
> candidato.* Y su gemela, del caso de Crear OV: **lo que se apaga (o falla) necesita quién lo
> vuelva a intentar — y el `MutationObserver` no es ese quién.**

También se exportan `scanForReceiveView` y `detectTick` para poder llamarlos desde la consola:
invocarlos a mano distingue *«no se dispara»* de *«no encuentra el ancla»*, que fue exactamente
lo que destrabó el caso gemelo.

**Validación:** core de anclaje **34/34** (3 tests nuevos), suite **109 archivos verdes**.


**Safari/iPad:** en el bundle **0.6.38** (2026-08-07). Este fix pesa más en el iPad que en escritorio: es el dispositivo del piso y la CPU más lenta del parque — el perfil exacto donde el montaje llega tarde y el observer ya no vuelve a mirar. **Pendiente recompilar en Xcode** (`Resources/` sincronizado ≠ compilado).

## 0.5.81 (2026-08-03) — el ancla que parecía estructura era un hash de emotion

**Reporte de piso: «ya no me aparece la fecha y ubicación de la extensión».** El campo «Fecha real de recibido:» desapareció del modal de recepción, junto con el combo de ubicación de `warehouse-location-prefill` — mismo incidente, misma causa, mismo día. El análisis completo vive en la [bitácora de WLP](warehouse-location-prefill.md#063-2026-08-03--una-clase-de-emotion-es-menos-estable-que-el-texto-que-quisimos-evitar); aquí van las lecciones propias de este applet.

- **Causa raíz:** `p.closest('.css-iyrxkt')` devolvía `null` porque SH rehizo el encabezado y esa clase dejó de existir (medido: **0 ocurrencias**). El `return` posterior era silencioso. La lección general —*una clase `css-<hash>` es el anclaje MENOS estable que hay, por debajo del texto visible; el texto cambia cuando alguien traduce, el hash cambia cuando alguien mueve un padding*— está desarrollada en la bitácora hermana.
- **Corrige la lección 0.5.67/0.5.80 de este archivo.** Aquella documentó el layout con nombres de clase (`.css-xd9ivb` flex-row, `.css-iyrxkt` grid `auto 1fr`) y ancló a ellos. La observación del layout era correcta y sigue siendo útil como historia; **anclarse a los nombres fue el error**, y tenía fecha de caducidad desde el día que se escribió. Lo que se conserva de aquella lección es lo que sí valió: *pide el wrapper HTML real antes de iterar selectores*.
- **EL MODO DE FALLA PROPIO DE ESTE APPLET, que es lo que volvió el bug permanente:** `onModalFound` ponía el latch `data-sa-rdo-attached = 'true'` **ANTES** de llamar a `injectField`. Con el ancla rota, el observer volvía a pasar, veía el latch y se iba. Por eso el síntoma fue **«la fecha desapareció»** y no «la fecha tardó un render en aparecer»: un fallo transitorio de montaje se congelaba para siempre. Ahora `injectField` devuelve booleano y **el latch se pone sólo si el campo quedó montado**; si no, se reintenta en la siguiente pasada del observer.
- **Corolario general: un latch de idempotencia debe marcar el ÉXITO, no el INTENTO.** Marcar la intención convierte cualquier fallo —de anclaje, de timing, de carrera con React— en un fallo definitivo y mudo. Es pariente de la regla que el repo ya tiene sobre los guards que preguntan «¿ya lo hice?» en vez de «¿sigue siendo del mismo dueño?».
- **`warnOnce` por modal.** Al quitar el latch del intento, el observer reintenta en cada mutación; un `console.warn` por pasada llenaría la consola justo cuando hace falta leerla para diagnosticar. El aviso se emite una vez por modal (`data-sa-rdo-warned`).
- **VIVO config 1.11.53**, tag `v1.11.53`. Bundle iPad **0.6.20**. El anclaje se comprobó contra el DOM productivo (monta, y la fila queda en 4 columnas de 400px, sin apretar); **no se cerró** la pasada end-to-end con el código ya deployado porque el renderer de la pestaña automatizada se congeló — modo de falla del arnés, no del applet.

Applet que inyecta un campo "Fecha real de recibido:" + selector de hora (default 12:00) en el modal **"Receive Parts from Customer" / "Recibir piezas del cliente"**. Permite editar el `receivedAt` del receiver al momento de creación, eliminando el paso manual de ir a "All Receivers" después.

- **Diferenciar Create vs Update mutations en flujos de "Save".** El modal de crear receiver dispara `CreateReceiverChecked` (hash `6147f74211e1f2caf8778a6c23ecc4b6fb7e9b96002c35bc04cc5c1df5437da3`). Las variables (`variables.receiverPayload`) tienen `notes`, `customInputs`, `inputSchemaId`, `receiverBomItems` pero **NO `receivedAt`** — el server siempre lo setea a NOW(). `UpdateReceiver` (hash `005653bae4baad289db47d65857cc4e9fb89fa51e06caa78a1f0946dce7f92ec`) solo viaja al editar desde "All Receivers", con shape top-level `{id, notes, receivedAt, customInputs, inputSchemaId}`. Asumir que `UpdateReceiver` cubre el flujo create costó dos rondas (0.5.64 lo intercepté y nunca disparó, 0.5.65 pivoteé a la arquitectura correcta). Antes de escribir interceptors de "guardar", **verifica en el scan cuál mutation viaja realmente** — busca por `responseFields` con prefijo `create*`/`save*`/`update*` y matchea contra el botón del UI.
- **Patrón intercept-response + follow-up mutation.** Cuando el server no acepta el campo que quieres sobrescribir en la mutación principal: (1) snapshot del payload + intent del usuario ANTES de pasar el request original; (2) `await origFetch.apply(this, args)`; (3) `response.clone()` y parse JSON para extraer el id devuelto; (4) fire-and-log un POST follow-up con la mutation de update; (5) devolver la response original al UI sin tocar. Detalles críticos: heredar `opts.headers` del request original (Apollo client headers + cookies), heredar `opts.credentials || 'include'`, NO awaitear el follow-up para no bloquear el UI, y manejar errors con `console.warn` (si el follow-up falla el receiver queda con NOW pero el flujo principal no se rompe — el usuario puede editar manualmente). Patrón en `receiver-date-override.js:96-180` (0.5.65).
- **Layout DOM del header del modal Receive Parts (descubierto pidiendo el wrapper HTML al usuario).** El header tiene un row container `.css-xd9ivb` que es **flex-row** (NO grid). Adentro: varios `.css-iyrxkt` que SÍ son grid (`grid-template-columns: auto 1fr` para label | field). **Dos modos de inserción según el caso:** (1) **Campo con fila propia full-width** (tabla, bloque pegado al header) → sibling del `.css-xd9ivb` (afuera del flex). Sibling de un `.css-iyrxkt` específico lo metería como tercer item del flex y comprimiría las columnas existentes. (2) **Campo extra dentro de una columna del header** (mejor uso de real estate) → children directos del `.css-iyrxkt` objetivo, como par `<p style="grid-column:1">` + `<div style="grid-column:2">`; el grid `auto 1fr` se extiende vertical (ver lección 0.5.80 en la sección WLP). Tres rondas de fix visual al inicio (0.5.65 `grid-column: 1/-1` no aplicaba porque parent no es grid; 0.5.66 detectado regex bilingüe del label como red herring; 0.5.67 finalmente correcto al pedir el HTML del padre real). Re-confirmación de la regla del wrapper: **antes de iterar selectores, pide el outerHTML del padre del bloque relevante**.
- **Labels bilingües en Steelhead.** El UI cambia entre inglés y español según el usuario o configuración. Regex de matching de labels DEBE ser bilingüe desde el primer commit, no parchado después. Pares vistos hasta ahora: "Receive Parts from Customer" / "Recibir piezas del cliente"; "Receiver Comments" / "Comentarios del receptor"; "Customer:" / "Cliente:"; "Save" / "Guardar"; "Save and Add Parts to WO" / "Guardar y Agregar Piezas a OT"; "Save and Print all" / "Guardar + Imprimir todas las piezas". Patrón regex: `/^(?:english\s+text|texto\s+español):?$/i` (non-capturing group, colon opcional, case-insensitive). 0.5.66 falló por usar solo "Receiver Comments" — el title del modal sí era bilingüe pero el regex del label no.
- **Date conversion: mediodía local → UTC para evitar drift.** Native `<input type="date">` devuelve `"YYYY-MM-DD"` (string local), `<input type="time">` devuelve `"HH:MM"` (24h). Construir UTC con `new Date(y, m-1, d, hh, mm, 0).toISOString()` evita que un `2026-05-04` se muestre como `2026-05-03` en zonas horarias al oeste de UTC. Default 12:00 con time picker opcional: si user no toca el time, queda mediodía local (cae en el mismo día UTC para todas las TZ del continente). Patrón aplicable a cualquier conversión date-only → ISO timestamp.
- **Flag bilingüe del título del modal vs flag bilingüe del label interno.** El regex del título (`HEADING_SELECTOR`) ya era bilingüe desde 0.5.64; el del label interno (`Receiver Comments`) no, y por eso 0.5.66 fue una iteración extra. Cuando crees un applet de modal-injection, audita TODOS los regex de DOM lookup para que sean bilingües desde el principio.
- **`response.clone()` antes de parsear.** Si haces `response.json()` directo, consumes el body y el caller no puede leerlo (Steelhead falla). Siempre clonar antes: `const json = await response.clone().json();`.

## 🐞 Bug abierto: el override de fecha "a veces no jala" (intermitente) — investigación 2026-06-03

**Síntoma reportado:** al usar el campo "Fecha real de recibido:" en el modal de Receive Parts, a veces la fecha se modifica y a veces el receiver queda con la fecha del día actual (NOW del server). Sin patrón identificado por el usuario. **No reproducido aún** — esta sesión cerró sin lograr replicar; la siguiente debe arrancar con el protocolo de reproducción de abajo.

### Descartado con evidencia estática (NO son la causa)
- **Hash rotado de `UpdateReceiver`:** el hash hardcodeado en `receiver-date-override.js:93` (`005653bae…`) coincide byte-a-byte con `config.json` (key `UpdateReceiver`). Si estuviera rotado el follow-up fallaría *siempre*, no "a veces". (⚠️ riesgo latente aparte: el hash está **hardcodeado** en el script en vez de leerse de `config.json` — si SH lo rota, el follow-up se rompe en silencio y nadie lo nota porque es fire-and-forget. Mover a lookup de config es un pendiente.)
- **Drift de fecha/TZ:** el ISO se arma a mediodía local (`:125`); un bug de zona horaria dejaría la fecha *corrida un día*, no en *hoy*. El síntoma es "se queda en hoy" → no es drift.

### Origen arquitectónico de la intermitencia
El follow-up `UpdateReceiver` (`:177-190`) se dispara **fire-and-forget (no se awaitea)** para no bloquear el UI. Ese patrón es donde nace la intermitencia. 4 hipótesis vivas, cada una con firma distinta en consola (el applet **ya loguea lo suficiente para distinguirlas** — filtrar por `[RDO]`):

| Línea `[RDO]` tras un Save | Causa raíz implicada |
|---|---|
| **Ninguna** línea de follow-up | Intent no capturado: `userTouched=false` o `querySelector('[data-sa-rdo-attached="true"]')` (`:118`) agarró un modal **stale** (devuelve el PRIMER attached; si el host oculta en vez de desmontar el modal previo, o en el 2º/3er recibo seguido sin recargar, apunta al viejo cuyo `userTouched` ya es `false`). |
| `UpdateReceiver follow-up falló` (catch) | Fetch **cancelado por navegación**. **Sospecha #1:** ocurre con **"Save and Add Parts to WO"** / **"Save and Print all"** (navegan/abren vista y matan el request en vuelo), pero NO con "Save" a secas. |
| `UpdateReceiver follow-up con errors` | Server rechazó el update (receivedAt bloqueado por estado del receiver, payload, etc.). |
| `follow-up OK …` **pero la fecha sigue en hoy** | Server aceptó pero algo *posterior* lo sobrescribió, o se apuntó al receiver equivocado. |

### Protocolo de reproducción (arrancar aquí la próxima sesión)
1. DevTools → Console → filtro `[RDO]`.
2. **Activar "Preserve log"** (crítico: si la causa es navegación, sin esto el log se borra justo cuando perderías la evidencia).
3. Hacer **un recibo que FALLE** y **uno que SÍ JALE**, anotando para cada uno: (a) qué botón de Save se usó, (b) si fue el 1er recibo de la sesión o ya iban varios sin recargar, (c) las líneas `[RDO]` exactas.
4. Mapear la firma observada contra la tabla → caer a la causa raíz → recién ahí proponer fix mínimo (candidatos probables: awaitear/`keepalive:true` el follow-up para sobrevivir navegación; o re-resolver el modal activo en vez de `querySelector` del primer attached).

**Regla:** no shippear fix sin la firma de consola del caso que falla. La intermitencia exige evidencia de reproducción, no parche a ciegas.

