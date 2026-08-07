# `create-order-autofill` — bitácora

Auto-llena las Entradas Personalizadas (`Razón Social de la Venta`, `Divisa`, `Consolidar por Producto`) del modal de creación de OV. Sustituye al canal write de OV customInputs que no existe en `ordendeventa.ts` (ver bitácoras `powertools-ordendeventa.md` y `powertools-facturacion.md`, ahora en el repo **SteelheadPowerTools**).

**Dos pantallas cubiertas** (mismos IDs RJSF debajo → mismo autofill). **Tabla re-MEDIDA el
2026-08-06 en producción**; la versión anterior de este encabezado describía el modal de julio y
llevó a perseguir el ancla equivocada tres veces seguidas:

| | `/Receiving/CustomerParts` (RECEIVE → `+`) | `/Domains/<id>/SalesOrders` (**"NUEVA ORDEN DE VENTA"**) |
|---|---|---|
| Título del modal | **"Crear Orden de Venta"** | **"Crear Orden de Venta"** — ya NO "Create Sales Order"; hoy salen **las dos en ES** (el heading bilingüe se queda por si vuelve) |
| Dónde vive el cliente | **`div.…singleValue`** | **`input[role=combobox].value`** |
| ¿Trae el badge `(#N)`? | **NO** → el `idInDomain` se resuelve por `CustomerSearchByName` | **SÍ** (`BRAININ DE MEXICO (#6)`) |
| `Enviar a:` (ship-to) | **sí**, pero sólo **después** de elegir cliente | **sí**, igual |
| ¿El observer despierta solo? | **sí** | **no** → por eso el disparo es por **poll** (v0.1.6) |

⚠️ **Las dos pantallas difieren en las DOS cosas a la vez** —dónde vive el valor *y* si lleva
badge—, y además **el modal vacío no predice al modal lleno**: al elegir cliente, SH monta Contacto,
Facturar a, `¿Envío Directo?`, Enviar a, Enviar vía y Términos de Facturación. Un HTML del modal
recién abierto NO sirve para decidir anclajes.

## Fix 2026-08-07 (v0.1.8) — "falla en los equipos Windows de menor desempeño"

**Reporte de piso, sin síntoma concreto**: al usuario no le falla en su máquina; a los equipos
Windows con menos capacidades, sí. Se investigó **con sondas en producción**, no por lectura.
Salieron tres causas, y las dos primeras **no son de rendimiento** — son bugs que en una máquina
rápida quedan tapados por la suerte del *timing*.

### 1. El disparo se moría al REGRESAR a la pantalla (medido)

```js
function setupObserver() {
  if (observerActive) return;   // ← el poll está DESPUÉS de este return
  …
  observerActive = true;
  startDetectPoll();
}
```

`checkUrl()` apagaba el poll al salir de la ruta (`stopDetectPoll()`) pero **nunca desconectaba el
observer**, así que `observerActive` seguía en `true`. Al volver, `setupObserver()` retornaba en la
primera línea y **`startDetectPoll()` quedaba inalcanzable**. El poll —la red de seguridad que se
introdujo en v0.1.6 justo porque el observer no despierta en esa pantalla— vivía **solo en la
primera visita**.

**Sonda en vivo** (`/Domains/344/SalesOrders`, contando las llamadas a
`getElementById('root_RazonSocialVenta')` con las que arranca `scanForModal`):

| momento | ticks |
|---|---|
| primera visita, 3.5 s | **4** |
| fuera de la ruta, 2.5 s | 0 ✔ |
| **al regresar por `pushState`, 3.5 s** | **0** ❌ |

Y el respaldo que queda tampoco alcanza: con el modal abierto se midieron **0 mutaciones de
`childList` en el `body` durante 6 s**, incluso tecleando en el buscador de cliente. El observer no
es un vigilante continuo: dispara en eventos discretos. Se comprobó que al abrir el modal disparó
**una sola vez** — y en ese instante **todavía no hay cliente elegido**, así que el applet mira
justo cuando no hay nada que ver y no vuelve a mirar nunca.

> **Por qué pega más en un equipo lento:** el observer despierta 350 ms *después* de que las
> mutaciones paran. En una máquina rápida, elegir cliente monta Contacto / Facturar a / **Enviar
> a** dentro de la misma ráfaga y la firma sale completa. En una lenta el montaje se parte, el
> debounce vence a media construcción, el applet lee un modal **incompleto** (sin ship-to →
> *Consolidar* nunca se marca) y —sin poll— nadie corrige esa lectura parcial.

**Fix:** cada recurso se enciende y se apaga por **su propio** estado, no por el del vecino. La
decisión sale a `Core.lifecycleActions({routeMatches, observerConnected, pollRunning})`, pura y con
test de regresión. De paso, al salir de la ruta el observer **sí se desconecta** (dejarlo vivo
cobra en cada render de la SPA, en todas las demás pantallas).

> **Regla que sale de aquí:** *un latch protege UN recurso.* Cuando un solo `if` guarda dos
> arranques, el segundo hereda el ciclo de vida del primero — y si el primero nunca se apaga, el
> segundo nunca vuelve.

### 2. Un fallo de red se reportaba como «falta configurar el cliente» — y se cacheaba

`fetchCustomerCustomInputs` hacía `catch → _customerCache.set(idInDomain, null)`. Un timeout (el
default son **90 s**), un 5xx o la red de planta caída producían exactamente el mismo `null` que un
cliente sin capturar, así que el panel pintaba el bloque **ámbar** «el cliente no tiene
`DatosFactura.RazonSocialVenta`» con la liga para ir a capturar **algo que ya estaba capturado**. Y
como el veneno quedaba en el caché por `idInDomain`, **ni cerrando y reabriendo el modal** se
recuperaba: el segundo intento leía el veneno en vez de reintentar.

**Fix:** `fetchCustomerCustomInputs` devuelve `{customer, error}`; el fallo **no se cachea**;
`Core.customerFieldResult(value, fetchError, campo)` separa `needsSetup` (falta el dato en el
cliente → liga a su ficha) de `retry` (no pudimos leerlo → «no pude leer al cliente (…) —
reintentando»). Y la firma se **suelta** cuando la corrida murió, para que el siguiente tick lo
intente otra vez: antes `state.lastSig` marcaba el **intento**, así que un fallo transitorio dejaba
el modal muerto hasta que el operador cambiara de cliente.

> **Regla:** *un dato que no pudimos leer no es un dato ausente.* Y **AUSENTE ≠ ERROR** aplica
> también al caché: guardar el resultado de una consulta que falló convierte un problema de 200 ms
> en uno que dura toda la sesión.

### 3. El tick del poll pagaba de más (lo único que sí es rendimiento)

Con el modal abierto, **cada segundo**, la pasada hacía: 3× `querySelectorAll` de headings sobre
**todo el documento** (`isCreateOrderModal` + `getModalRoot` una vez por extractor), un
`querySelectorAll('h1…h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]')` global
leyendo el `textContent` de cada match, y un `querySelectorAll('label, span, div, p')` **del
documento entero** — el walk del wizard de recepción, que en la pantalla de Órdenes de Venta
**nunca encuentra nada porque ahí no hay wizard**, y aun así se pagaba entero. Todo eso en el mismo
hilo con el que el operador teclea el nombre del cliente.

Medición (Mac, DOM de 2308 nodos, modal abierto): **2.94 ms por tick**. En un equipo de piso con la
lista cargada y CPU de gama baja son **decenas de ms cada segundo**, y otro tanto por cada disparo
del observer al teclear. La afirmación de la v0.1.6 —*«`scanForModal` ya era idempotente por
`lastSig`, así que el poll no repite trabajo»*— era cierta para el **fetch** y falsa para el
**DOM**: la firma se calcula **después** de todo el barrido, así que el trabajo caro se pagaba
aunque nada hubiera cambiado.

**Fix:** el root se calcula **una vez por pasada** con `campo.closest('[role="dialog"]')`
—O(profundidad), no O(documento)— y se reparte a los extractores; `isCreateOrderModal` busca el
título **dentro del root** (con degradación al barrido global si no colgara de ahí, para que el
gate no se apague en silencio); el wizard y el bloque del label «Cliente:» se **cachean** revalidando
por `isConnected`; y el walk del wizard **solo corre en `/Receiving/CustomerParts`**, que es la única
pantalla donde ese wizard existe.

**Validación:** core **32/32** (8 tests nuevos), suite **109 archivos verdes**.


**Safari/iPad:** en el bundle **0.6.38** (2026-08-07). Este fix pesa más en el iPad que en escritorio: es el dispositivo del piso y la CPU más lenta del parque — el perfil exacto donde el montaje llega tarde y el observer ya no vuelve a mirar. **Pendiente recompilar en Xcode** (`Resources/` sincronizado ≠ compilado).

## Fix 2026-08-06 (v0.1.7) — la Divisa se reportaba en ROJO estando bien puesta

**Reportado desde producción con captura**, ya con el poll vivo y el autofill arrancando solo en
las dos pantallas: el modal mostraba `USD - Dólar americano` **puesto**, y el panel marcaba
`✗ DIVISA — usuario tocó después de autofill`. Razón Social, en la misma pasada, salía en verde
(`ya estaba: ECO030618BR4 - ECOPLATING SA DE CV…`).

**Root cause — el applet no reconocía su propio trabajo.** `fillNativeSelectByText` **llenaba** con
`scoreOptionMatch` (substring: el cliente guarda `"USD"` y la opción dice `"USD - Dólar
americano"`, score 60) pero **comprobaba** «¿ya está bien?» con **igualdad exacta** del texto. En la
re-pasada, la Divisa no coincidía consigo misma, caía en la rama del candado anti-sobrescritura y
se reportaba como cambio del operador. **Razón Social se salvaba por casualidad**: ahí el cliente
guarda el texto completo, así que la igualdad exacta sí daba — por eso una salía verde y la otra
roja teniendo AMBAS el valor correcto, que es lo que delató la asimetría.

El poll **no causó** el bug: lo hizo visible al repetir la pasada. Con el observer solo, la
segunda evaluación casi nunca ocurría.

**Fix:** `Core.isSelectAlreadyOnTarget(optionTexts, selectedIndex, target)` — puro y testeado —
pregunta con **la misma vara** con la que se escribe: ¿el `selectedIndex` actual es el índice que
elegiría `scoreOptionMatch`? El candado que respeta al operador **no se debilita**: sólo se llega a
él cuando el valor actual NO es el que pondríamos, o sea cuando el cambio sí es ajeno; hay test
para las dos caras.

> **Regla que sale de aquí:** *se verifica con la misma vara con la que se escribe.* Una
> comprobación más estricta que la acción que verifica no protege — **delata el trabajo propio como
> ajeno**, y encima en el color que el operador lee como "esto falló".

> ### ✅ VALIDADO POR EL OPERADOR (2026-08-06) — cierre de la saga
> *"ya jala, también el link del cliente"*. Confirmado **en las dos pantallas**: el autofill
> **arranca solo** (sin tocar consola), la Divisa dejó de reportarse en rojo, y el bloque ámbar
> con **«Abrir ficha del cliente ↗»** funciona cuando al cliente le faltan las Entradas
> Personalizadas. Vivo en `1.11.95`; iPad en bundle `0.6.34` (**pendiente recompilar en Xcode**).

**Validación:** core **24/24**, suite **1885/1885**. Deploy **1.11.95**, verificado en vivo
(`isSelectAlreadyOnTarget` servido). Bundle iPad **0.6.34**.

## Fix 2026-08-06 (v0.1.6) — el disparo pasa a POLL + liga para configurar al cliente

### 1. El disparo: se deja de confiar sólo en el `MutationObserver`

**Evidencia que lo obligó** (máquina del operador, sesión sana — no la contaminada del día
anterior): en `/Domains/<id>/SalesOrders` el modal estaba abierto y el applet **no había corrido**;
en cuanto se invocó `scanForModal()` a mano, hizo todo el trabajo y logueó
`modal detectado | cliente=BRAININ DE MEXICO (#6)`. Eso **descarta la firma pegada**
(`sig === lastSig` habría retornado sin loguear) y **descarta la extracción**: el problema era el
**DISPARO**. Y el contraste que faltaba:

| Pantalla | ¿el observer despierta solo? |
|---|---|
| `/Receiving/CustomerParts` | **sí** (cerrar y reabrir el modal lo corrió) |
| `/Domains/<id>/SalesOrders` | **no** |

**La causa de esa asimetría nunca se encontró.** En vez de seguir parchando el ancla se cambió el
mecanismo, y no por uno inventado: **`weight-quick-entry` —que en los mismos logs del operador se
ve funcionando— no se fía del observer, agrega un POLL** (`DETECT_POLL_MS = 1000`). Se copió ese
patrón. El observer se queda (reacciona en el mismo frame cuando sí dispara) y el poll es la red de
seguridad. `scanForModal` ya era idempotente por `lastSig`, así que el poll no repite trabajo ni
refetchea (el customer va cacheado por `idInDomain`).

Dos detalles que **no** son cosméticos:
- **El poll llama a `scanForModal` SIEMPRE**, sin filtrar antes por «¿hay modal?». Ese camino es
  también el que **resetea `lastSig`** al cerrarse el modal; sin el reset, abrir una segunda OV
  para el **mismo cliente y destino** da una firma idéntica y el applet se salta el trabajo,
  dejando el modal nuevo —DOM nuevo, campos vacíos— sin llenar.
- **`observerActive` pasa a marcar el ÉXITO**, no el intento: se pone *después* de `obs.observe()`,
  así un fallo de montaje se reintenta en el próximo `checkUrl()` en vez de congelarse. (La regla
  del CLAUDE.md, que este applet violaba.)

### 2. Cuando al cliente le faltan los customInputs, el panel deja de ser un callejón sin salida

`razon=FAIL | divisa=FAIL` con `cliente sin DatosFactura.*` **no es un fallo del applet**: es un
dato que falta **en el cliente**. Ahora esos resultados se marcan `needsSetup` y el panel muestra un
bloque ámbar que dice **dónde** se configura (Catálogo de Clientes → Entradas Personalizadas →
`DatosFactura`) y ofrece **la ficha del cliente en pestaña aparte**
(`/Domains/<domainId>/Customers/<idInDomain>`, formato confirmado por el operador con
`…/Domains/344/Customers/6` para BRAININ (#6)).

`Core.customerUrl(domainId, idInDomain)` **devuelve `null` si falta cualquiera de los dos, o si no
son numéricos**, y entonces el aviso se muestra **sin liga**: un dominio inventado mandaría al
operador a la ficha de OTRO dominio (TLC vs MTY), que es peor que no ofrecer liga. El `domainId`
sale de la ruta (`domainIdFromPath`) y, en Recibo —cuya URL no lo trae—, de
`SteelheadAPI.getDomain().id`.

También se soltó el foco del botón «Re-aplicar» al hacer clic: MUI marca `aria-hidden` en todo el
fondo al abrir su modal y nuestro panel vive en el `<body>`, así que un control nuestro con el foco
dentro disparaba el error real que reportaba la consola de SH (*«Blocked aria-hidden on an element
because its descendant retained focus»*). Con el enlace nuevo eso habría empeorado.

**Validación:** core **21/21**, suite **1882/1882**. Deploy **1.11.93** con `tools/deploy.sh` (con
re-sellado de firma, a diferencia del manual del día anterior). **✅ Corrida real del operador
CONFIRMADA el 2026-08-06 en las dos pantallas** (ver el recuadro de validación al inicio).

## Fix 2026-08-05 (v0.1.5) — en Recibo el cliente vive en el WIZARD PADRE, no en el modal

**Síntoma:** tras el v0.1.4, en `/Receiving/CustomerParts` seguía sin pasar nada — y el detalle
que lo delató: *"ni siquiera sale el banner"*. El panel sólo se pinta cuando hay cliente; sin
cliente el applet hace `removePanel()` y se calla. **Un applet mudo era el síntoma de "no
encuentro cliente", no de "no me cargué".**

**Lo que se descartó primero (medido, no supuesto):** el applet **sí** se inyecta en esa ruta —
`window.__saLoadedApps.ids` la trae junto con otros 8 applets, `matchesCreateOrderUrl` da `true` y
el core nuevo está cargado. O sea: cargaba y corría; simplemente no veía a nadie.

> ⚠️ **CORRECCIÓN 2026-08-06 — la causa que decía esta sección era EQUIVOCADA.** Se creía que el
> modal de Recibo nacía sin cliente y que había que leerlo del wizard padre. **Falso**, y lo mostró
> una sonda en el DOM productivo, con el modal abierto y el flujo ya funcionando:
>
> ```
> 2 modal singleValues: ['MAKE_TO_ORDER', 'SSCHNEIDER ELECTRIC MEXICO', 'Thalia Itzel Salazar', …]
> 3 modal comboValues : []
> 4 picked en modal   : null
> ```
>
> **El cliente SÍ está en el modal**, como `singleValue` (la forma histórica — aquí el input va
> vacío, al revés que en la lista de OVs). Lo que NO trae es el badge **`(#N)`**, y por eso
> `pickCustomerFromCandidates` devuelve `null`. **Las dos pantallas difieren en las DOS cosas a la
> vez**: dónde vive el valor *y* si lleva badge —
> `/Domains/<id>/SalesOrders` → `input.value` **con** `(#N)`; `/Receiving/CustomerParts` →
> `singleValue` **sin** `(#N)`. Perseguir una sola de esas diferencias lleva al ancla equivocada.
>
> **La causa real en Recibo:** sin `(#N)`, el idInDomain depende por completo de
> `resolveIdInDomainByName` → `CustomerSearchByName`… que iba con variables inválidas
> (`{searchText,name,query,first}`). **El arreglo que destrabó Recibo fue el de esas variables**
> (`{nameLike:'%…%', orderBy:['NAME_ASC']}`), no el del wizard padre. Log real de cierre:
> `idInDomain resuelto por nombre → 1` → `autofill | razon=OK | divisa=OK | consolidar=OK`.
>
> El camino del wizard padre **se queda** como red de seguridad (no estorba y cubre el caso de que
> SH vacíe el campo), pero **no era el bug**. Lección: *que un fix funcione no prueba que la causa
> que le atribuiste sea la correcta.*

**Root cause (redacción original, conservada por trazabilidad — ver corrección arriba).** Se leyó
que el modal "Crear Orden de Venta" del flujo de Recibo nacía con su campo `Cliente:` VACÍO y que
el cliente real vivía en el wizard **"Recibir piezas del cliente"**, fuera del `[role="dialog"]` al
que ancla `getModalRoot()`. Esa lectura salió de un HTML del modal **recién abierto** (antes de que
SH lo poblara), no del modal en uso.

**Fix:** si el modal no tiene cliente, se lee del wizard padre. **El anclaje no se inventó: está
copiado de [`weight-quick-entry`](weight-quick-entry.md), que resuelve el cliente en esta misma
pantalla en producción** — heading bilingüe (`Recibir piezas del cliente` / `Receive Parts From
Customer`, ahora `Core.isReceiveWizardHeading`), cascada de contenedor
`[role=dialog]` → `MuiDialog` → `MuiPaper` → `document.body` (el wizard **no** siempre es un
diálogo), lectura de `singleValue` **o** `input.value`, y filtro de placeholder
(`/^(buscar|search|select|seleccionar|…)/i`) para no tomar un "Select..." por nombre de cliente. El
subárbol del modal se excluye explícitamente, así que el `Cliente:` vacío de adentro nunca gana.

**Bug latente que salió a la luz:** ahí el nombre llega **sin `(#N)`** (`SCHNEIDER ELECTRIC USA
INC`), así que el idInDomain depende de `resolveIdInDomainByName` → `CustomerSearchByName`… que
iba con variables **`{searchText, name, query, first}`**, las cuales no corresponden a ninguna
firma viva. Nunca se había notado porque era un fallback teórico; al volverse la vía **principal**
del flujo de Recibo, importaba. Se alinearon con las de `weight-quick-entry`
(**`{nameLike: '%…%', orderBy: ['NAME_ASC']}`**), probadas en producción, más su match por
`includes` en mayúsculas. *Lección: un fallback que nunca se ejerce no está probado — está
supuesto.*

**Validación:** core **18/18**, suite **1868/1868**. Deploy **1.11.90**.

**Safari/iPad (bundle 0.6.32):** el rebuild tomó los dos fixes (v0.1.4 y v0.1.5). Verificado **en el
ARTEFACTO**, no en el log —`build-safari.sh` imprime caracteres, no bytes—: con baseline **0** antes
del rebuild, `main-bundle.js` pasó a traer `pickCustomerFromCandidates` (5), `collectComboboxValues`
(3), `isReceiveWizardHeading` (3) y `extractCustomerFromReceiveWizard` (4), `node --check` OK.
**Falta recompilar en Xcode.**

**Nota de proceso:** el deploy NO usó `tools/deploy.sh` — el worktree de `main` tenía WIP **de otra
sesión viva** (`hash-coverage-multirepo`, `wo-spec-params`, `extract-process-tree`,
`external-sinks`, modificados minutos antes). Se hizo `git add` selectivo de los 3 archivos
propios y el espejo a `gh-pages` desde un **worktree temporal** (removido con `git worktree
remove` + `prune` para no dejar el huérfano que bloquea todo deploy). El `pre-push` validó el
espejo. La WIP ajena quedó intacta.

## Fix 2026-08-05 (v0.1.4) — el cliente se mudó del `singleValue` al `value` del input

**Síntoma reportado:** "el order autofill no está funcionando". Ni Razón Social ni Divisa se
llenaban, en **las dos** pantallas.

**Root cause (MEDIDA en vivo, no inferida del HTML estático).** El HTML que pasó el operador era
del modal **recién abierto**, y ahí el applet se comporta bien (espera en silencio a que haya
cliente). La falla solo aparece **después de elegir cliente**, así que se reprodujo en
`/Domains/344/SalesOrders`: se tecleó `HUBBELL` en el combo de Cliente y se confirmó la opción.
Estado resultante del modal:

| Sonda | Valor medido |
|---|---|
| `singleValues` del modal | `MAKE_TO_ORDER`, `Miguel Castillo`, `Cinco Sur 104…`, `Cinco Sur 104…`, `Flete Propio`, `67 Días` |
| ¿alguno con `(#N)`? | **no** — `pickCustomerFromSingleValues → null` |
| `input[role=combobox].value` del Cliente | **`HUBBELL PRODUCTS MEXICO (#20)`** |
| `wrap.querySelector('[class*="singleValue"]')` del Cliente | **`null`** |
| Panel del applet | `Miguel Castillo → Cinco Sur 104…` · `✗ RAZÓN SOCIAL sin idInDomain` |

**SH cambió el control de "Cliente:": el valor elegido ya no se pinta como
`<div class="…singleValue">`, se escribe en el `value` del `<input role="combobox">`.** La prueba
de que lo puso SH y no el tecleo: se escribió `HUBBELL` y el input quedó en
`HUBBELL PRODUCTS MEXICO (#20)` — el label completo del valor, con badge.

Dos fallas encadenadas, y la segunda es la peor:
1. `collectSingleValueTexts()` ya no ve al cliente → sin `(#N)` que parsear.
2. El fallback `findSingleValueByLabel(/cliente/)` recorría **8 hermanos** buscando un
   `singleValue`; al no haber ya uno en el bloque del Cliente, seguía de largo y devolvía el del
   **Contacto**. El panel entonces mostraba `Miguel Castillo` **como si fuera el cliente**: no
   fallaba, mentía coherentemente. Es el mismo patrón que el CLAUDE.md marca como el peor modo de
   falla — un dato equivocado se ve igual que un dato bueno.

**Fix:**
1. `Core.pickCustomerFromCandidates(singleValues, comboboxValues)` (nuevo, puro): elige por badge
   `(#N)` sobre la unión de las DOS formas. Los `singleValue` van **primero** → si SH repone la
   forma vieja, ésta sigue mandando. **Se AMPLÍA el anclaje, no se cambia.**
2. `collectComboboxValues(root)` en el glue.
3. `findSingleValueByLabel` → **`findFieldTextByLabel(root, re, maxHops)`**: devuelve
   `{text, from:'singleValue'|'input'}` y acepta un tope de hermanos. Cliente = **`maxHops:1`**
   (solo su propio bloque, mata el robo al Contacto); ship-to = `8` (sin cambio, sigue resolviendo).
4. **Un `value` de input sin `(#N)` NO se acepta como cliente**: es texto EN TRÁNSITO mientras el
   operador teclea. Aceptarlo dispararía un `CustomerSearchByName` **por tecla** contra un
   `/graphql` que se cuelga bajo ráfaga (~40 requests). El `singleValue` sí se acepta sin badge —
   para eso existe el fallback por nombre.

**Hallazgo colateral que corrige la bitácora previa:** el modal **sí** expone `Enviar a:`, pero
sólo **después** de elegir cliente (junto con Contacto, Facturar a, Enviar vía, Términos de
Facturación y el nuevo `¿Envío Directo?`). Leyendo sólo el HTML del modal vacío parecía que el
ship-to había desaparecido y que la regla Rojo Gómez estaba muerta; **no lo está**. Registro del
error de método: *un modal vacío no prueba qué campos tiene el modal lleno.* También apareció
`Ubicación:` con `data-steelhead-component-id="CREATE_SALES_ORDER_SHOW_LOCATION_SELECT"`.

**Validación:** core **17/17 verde** (3 tests nuevos con el snapshot real medido, incluido el
assert de que la vía histórica sigue ganando y que el contacto **no** puede pasar por cliente);
suite completa **1867/1867**. **End-to-end contra el ERP productivo con el script ya deployado
(1.11.89)**, cliente SCHNEIDER ELECTRIC MEXICO (#1) — log del propio applet:

```
[SA] [create-order-autofill] modal detectado | cliente=SCHNEIDER ELECTRIC MEXICO (#1) | shipTo=Javier Rojo Gómez 1121-A,…
[SA] [create-order-autofill] autofill | razon=OK | divisa=OK | consolidar=OK
```

Razón Social → `ECO030618BR4 - ECOPLATING SA DE CV…`, Divisa → `USD - Dólar americano`,
Consolidar → **marcado** (la regla Rojo Gómez volvió a disparar). No se guardó ninguna OV.

### ⚠️ Pendiente ABIERTO (sin causa raíz) — el disparo automático

La extracción quedó arreglada, pero en `/Domains/<id>/SalesOrders` **el autofill no arrancó solo**:
sólo corrió al invocar `scanForModal()` a mano. Medido: con el modal abierto y el cliente ya
elegido, **cero** entradas de `modal detectado` en consola (con `sa_debug` activo, mientras
`report-regen` sí logueaba), y una mutación directa sobre `document.body` tampoco lo despertó.

**Lo que SÍ está descartado:**
- No lo introdujo este fix: `git diff v1.11.87 v1.11.89 -- create-order-autofill.js` no toca ni
  una línea de `init`/`checkUrl`/`setupObserver`/`scanForModal`/observer.
- No es el debounce posponiéndose por ráfaga: se midieron 17 mutaciones con **11 gaps > 350 ms**
  (máximo **2049 ms**) — el timer tuvo margen de sobra.
- No es el gate de URL (`matches=true` en el log de init), ni el latch de habilitación, ni
  permisos (`autoInject` no los consulta), ni una excepción no capturada (consola limpia).

**Lo que NO se pudo concluir:** por qué el `MutationObserver` no reacciona. Sospecha principal —
sin confirmar— el patrón que el propio CLAUDE.md marca como anti-patrón: `setupObserver()` pone
`observerActive = true` **antes** de `obs.observe(document.body, …)`, así que un fallo de montaje
queda **congelado para siempre** (latch del INTENTO, no del ÉXITO). **No se arregló a ciegas.**

**Advertencia de método para quien retome esto:** la sesión de diagnóstico acumuló ~50 peticiones
al `/graphql` y muy probablemente lo dejó degradado (el límite es **por sesión** y no se recupera
recargando), además de congelar una pestaña al re-evaluar el script remoto con `new Function`.
**Las mediciones de timing hechas al final de esa sesión no son confiables** y hay que repetirlas
en sesión limpia antes de sacar conclusiones.

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

**Validación:** core **14/14 verde** (2 tests nuevos: heading ES/EN + gate de URL incl. rechazo de `/SalesOrders/9876` y dominio no-numérico). ~~**Pendiente:** run real en la pantalla SalesOrders~~ → **CUMPLIDO 2026-08-06** (el operador confirmó Razón Social + Divisa ahí; hizo falta antes arreglar la extracción en v0.1.4 y el disparo en v0.1.6).

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
- [x] ~~Probar flujo end-to-end en `/Receiving/CustomerParts`~~ **CUMPLIDO 2026-08-06**, log del
      applet en la máquina del operador con SCHNEIDER ELECTRIC MEXICO (#1) y shipTo Javier Rojo
      Gómez: `idInDomain resuelto por nombre → 1` → `autofill | razon=OK | divisa=OK | consolidar=OK`.
      Y **arrancando solo**, sin invocar nada (v0.1.6 en adelante).
- [ ] Probar con otro shipTo de Schneider (no Rojo Gómez) — confirmar que Razón Social y Divisa se llenan pero Consolidar queda sin marcar.
      *(Sigue abierto: el caso «otra planta» se vio con BRAININ, que es otro cliente, no con un
      segundo destino de Schneider.)*
- [x] ~~Probar con cliente que NO tenga `DatosFactura`~~ **CUMPLIDO 2026-08-06** con BRAININ DE
      MEXICO (#6): el applet reporta `el cliente no tiene DatosFactura.*` sin romper el modal y
      —desde v0.1.6— ofrece la liga a su ficha para configurarlo.
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
