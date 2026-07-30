# Diseño — `surtido-guard` v0.3.0: filtro por LÍNEA DESTINO

> Fecha: 2026-07-29
> Estado: **diseño aprobado** por el operador (2026-07-29) · **Paso 0 (inspección en vivo)
> COMPLETADO** — todas las decisiones de DOM están medidas, no supuestas. Listo para plan.
> Tipo: extensión del applet existente `surtido-guard` (no un applet nuevo — ver §3).
> Spec base: [`2026-06-26-surtido-guard-design.md`](2026-06-26-surtido-guard-design.md) ·
> Bitácora: [`docs/applets/surtido-guard.md`](../../applets/surtido-guard.md)

## Problema

En el Workboard **"Preparación de Surtido"**, step **"Preparando Surtido en Almacén"**, el
operador de almacén surte material que va a distintas líneas de producción. Con decenas de
tarjetas en el step no hay forma de ver **solo las que van a la línea que está surtiendo**.

Pedido de operaciones: **filtrar las tarjetas por la línea/estación destino** — la siguiente
estación a la que se va a enviar el material.

### El filtro nativo NO resuelve esto (verificado con el operador)

El Workboard **sí** tiene un filtro por estación, pero filtra por **la estación donde la pieza
está parada** (el step actual), no por la que sigue. Son preguntas opuestas:

| Filtro | Pregunta que responde |
|---|---|
| Nativo de SH | ¿Qué piezas están **en** esta estación? |
| Este applet | ¿Qué piezas **van a** esta línea? |

Son **composables**: el nativo te deja en el step de surtido, el nuestro recorta a las que van
a T204. No hay redundancia.

### Consecuencia de diseño: dos filtros de estación en la misma pantalla

Esto es exactamente el anti-patrón que ya costó una iteración en `auto-router` 0.3.2 (dos
botones parecidos → el operador escogía el equivocado, y ahí solo perdía tiempo). Aquí
confundirlos hace que **se surta material para la línea equivocada**. Mitigaciones, no
documentación:

1. Etiqueta con dirección explícita: **`→ Línea destino`**, nunca "estación" a secas.
2. **Dark-mode** (regla del repo para UI propia): que se lea de un vistazo que no es un control
   nativo de SH.

## Definición de "línea destino"

**La línea de la estación donde la orden está PROGRAMADA** (`validScheduleTasks[].stationId`),
agregada a su **código de línea** — `T204-LI Plata y Estaño s/Cobre Colgado` → **`T204`**.

Decisión del operador (2026-07-29): se filtra por **LÍNEA**, no por estación exacta. Todas las
estaciones con el mismo prefijo (`T204-LI`, `T204-FL01`, …) caen en la misma opción.

`lineCodeOf()` ya existe en `wo-schedule-core.js` (`/^([A-Z]\d{3})/`) — se reusa, no se
reimplementa.

> **Descartadas** como lectura de "destino":
> - El *siguiente nodo de la receta* (`toAccount.recipeNodeId`): es **el mismo para todas** las
>   tarjetas del step, así que no discrimina nada.
> - La *línea contable* (dim 349, la de `pn-specs-column`): es un dato maestro del NP, no dice
>   a dónde va **esta** orden.

## Arquitectura

### 1. Fuentes de datos — cada una donde es más fuerte

**Cero consultas nuevas para el dato central:** `GetRelatedScheduleData` ya lo trae y el applet
ya lo intercepta. Su shape (fixture real `surtido-guard-schedule.json`) tiene el `stationId`
**hermano** del set de accounts programados:

```
allSchedules.nodes[].validScheduleTasks.nodes[].{ stationId, treatmentId,
  scheduleTaskElementsByScheduleTaskId.nodes[].associatedPartsTransferAccounts.nodes[].{ id, workOrderId } }
```

| Para qué | Fuente | Por qué esa y no la otra |
|---|---|---|
| **Catálogo del dropdown** (qué líneas hay en el board, cuántas órdenes cada una) | `GetRelatedScheduleData` (ya interceptado) + `AllStations` (hash `834516258e…`, ya en config) para `stationId → name` | Es **completo**: cubre las N órdenes del step aunque el board tenga 8 tarjetas montadas. Un dropdown construido del DOM nacería incompleto y crecería al scrollear — y no podrías elegir una línea cuya tarjeta no se ha montado. |
| **Match por tarjeta** (¿esta tarjeta es T204?) | **Celda de estación de la tabla `Tareas Programadas:`** de la tarjeta (ver §1.1) → código de línea | El nombre `T204-…` **no se traduce**. Y evita el puente frágil `workOrderId` **global** (lo que da la API) ↔ `idInDomain` **visible** (lo que trae la tarjeta), que es un desajuste ya documentado en el repo. |

`AllStations` es un catálogo de ~775 estaciones: **una** llamada por carga de board, cacheada en
memoria, y solo para poner nombres bonitos y conteos. Si falla, el filtro sigue operando con los
códigos de línea que saca del DOM (degrada, no se apaga).

### 1.1 Anclaje medido sobre el HTML real de la tarjeta (2026-07-29)

Wrapper capturado del board **"Preparación de Surtido Almacén 5 (Blanca)"**
(`/Domains/344/Workboards/6234`), tarjeta de la WO 15246. Estructura relevante:

```
div[border-bottom, overflow:hidden]              ← RAÍZ de la tarjeta (lo que se esconde)
└ div[background: green]                          ← capa de color de SH (NO es nuestra)
  └ div[background: rgb(255,255,255), transform]  ← cuerpo blanco (lo que se tinta naranja)
    └ … div.css-iyrxkt[flex: 1 1 0%]              ← contenedor de contenido
      ├ "Proceso: T300 (LES)-T204 (PLA)-CU/BR-VARIOS (16.1) | Estación: Proquipa.N1.A1"
      ├ "Tratamientos: Current (Preparando Surtido en Almacén) : TR-PRM-004 …"
      ├ span[data-steelhead-component-id="WORKBOARD_PAGE_WORKBOARD_CARD_SALES_ORDER_LINK"]
      │   + a[href="/Domains/344/WorkOrders/15246"]  ("WO: #15246")
      ├ div.css-14ok7g3  "Tareas Programadas:"       ← label (bilingüe)
      └ table.MuiTable-root                          ← LA FUENTE DE LA LÍNEA DESTINO
          tr > td[0] "T204 (PLA)-CU/BR-VARIOS"                          ← tratamiento
               td[1] "at T204-LI Plata y Estaño s/Cobre Colgado (16.1)" ← ESTACIÓN
               td[2] "24/7/2026 - 5:00:00 p.m."                         ← fecha
```

**Cinco hallazgos que cambian el diseño:**

1. **La línea destino vive en una `<table>`, no en texto suelto.** Se lee por **posición de
   celda** (`td[1]`), que es estructural y no depende del idioma.

2. **TRAMPA con consecuencia física — no usar `textContent` de la tarjeta.** El bloque de arriba
   dice `Proceso: **T300** (LES)-T204 (PLA)-…`. Un `lineCodeOf` sobre el texto de la tarjeta
   agarraría **`T300`** (el proceso completo) en vez de `T204` (la línea destino) ⇒ filtrar por
   T300 y **surtir material para la línea equivocada**. El anclaje a `td[1]` de la tabla es
   obligatorio, no una preferencia de estilo.

3. **Es una tabla ⇒ N filas ⇒ una orden puede ir a VARIAS líneas.** El filtro compara contra un
   **Set** de códigos por tarjeta (`T204` ∈ {T204, T205} → visible). Consistente con
   `wo-schedule-button` 0.9.0 ("una misma orden puede correr en varias líneas").

4. **`lineCodeOf` no sirve tal cual** en la celda de estación: ancla al inicio
   (`/^([A-Z]\d{3})/`) y la celda empieza con `at `. Se agrega al core
   `lineCodeFromStationText()` con `\b([A-Z]\d{3})\b` (sin anclar) — seguro **porque el ámbito es
   una sola celda** que solo contiene el nombre de la estación.
   - El `at ` es literal **inglés dentro de una UI en español** (mezcla ya conocida en SH). No se
     depende de él: se ignora por completo al no anclar el regex.
   - **`td[1]` es la ÚNICA fuente. NO hay respaldo por tratamiento** (corregido con datos en vivo,
     ver hallazgo 6): el tratamiento a veces no trae ningún código de línea.

5. **La raíz de la tarjeta a esconder es el nodo `[data-item-index]`** — el item de react-virtuoso
   (`div[style="overflow-anchor: none"]`), verificado en vivo (`data-item-index="1"`).
   > Corrección: una lectura previa de este spec afirmó que ese atributo **no existía**. Era falso
   > — el HTML capturado empezaba **debajo** del wrapper de virtuoso. `decorateCards` funciona
   > bien hoy y **no hay bug latente**; se confirmó `sa-sg-orange` aplicado al cuerpo blanco en el
   > board real.

**Confirmación del filtro nativo (§Problema), con evidencia DOM:** `Estación: Proquipa.N1.A1` es
una **ubicación de almacén** — dónde está *parada*. Nada que ver con `T204-LI`. Los dos filtros
miran campos distintos de la misma tarjeta.

**6. Medición en el board vivo (6 tarjetas, `/Domains/344/Workboards/6234`) — dos correcciones
más:**

| WO | `td[0]` (tratamiento) | `td[1]` (estación) | `Proceso:` de la tarjeta |
|---|---|---|---|
| 12831 | `TR-PRM-001 Antitarnish Manual` | `at `**`T300`**`-CE03-002 Célula de Antitarnish` | **`T400`** (ANT)-CU-VARIOS (20.0) |

- **La trampa del hallazgo 2 NO es teórica:** en la **única** tarjeta programada del board, el
  `Proceso:` dice `T400` y la estación destino real es `T300`. Un filtro anclado al `Proceso:`
  habría mandado a surtir a la línea equivocada en el primer caso real.
- **`td[0]` puede no traer código de línea:** `TR-PRM-001 Antitarnish Manual` no contiene ninguno.
  Por eso el respaldo por tratamiento se **elimina** del diseño — `td[1]` es la única fuente.
- **El destino puede ser una CÉLULA, no solo una línea** (`T300-CE03-002`). Agrupar por prefijo
  `T300` junta las células de esa línea, que es la granularidad pedida.
- **5 de 6 tarjetas NO están programadas** (sin tabla, y las 5 en naranja). Con la decisión de
  esconderlas, filtrar dejaría **1 de 6** visibles: por eso el contador y el
  `N sin programar ocultas` no son adorno, son lo que evita que el board parezca vacío.
- **El board tiene VARIOS scrollers** (aquí 2, bajo el agrupador `Scheduled`). El filtro recorre
  **todos**, no uno. Los `data-item-index` **se repiten entre scrollers** ⇒ nunca usar el índice
  como identidad; se opera sobre el nodo.

### 2. Fail-safe: el árbitro cruzado

Mismo patrón que `isDomSignalBroken` (v0.2.0), por la misma razón: **este filtro ESCONDE**, así
que un ancla que deja de matchear no falla de forma benigna — escondería trabajo real.

- Si la API reporta estaciones programadas pero **ninguna** tarjeta montada revela línea
  (`lineCodeOf` → null en todas) ⇒ la señal DOM se rompió ⇒ **el filtro se desactiva solo**,
  muestra todo y lo dice en el box. Nunca esconde a ciegas.
- Una tarjeta cuya línea no se puede determinar **se muestra** (no se esconde por ignorancia).

### 3. Dónde vive el código: mismo applet, separaciones duras

**Mismo applet** (`surtido-guard`), porque comparte lo caro: el interceptor de
`GetRelatedScheduleData`, el scope del nodo de surtido, y el ciclo de decorado de tarjetas. Un
applet nuevo duplicaría los tres. Además ya está en el bundle Safari, y **el iPad es el
dispositivo con el que se surte**.

El riesgo de mezclar comodidad con un candado se acota con tres reglas, no con buena voluntad:

1. Núcleo puro nuevo y aparte: **`surtido-guard-filter-core.js`** con golden tests
   (`lineCodeFromCardText`, `buildLineIndex`, `visibleUnderFilter`, `summarizeFilter`).
2. Todo el glue del filtro corre dentro de `try/catch`. Un error del filtro **no puede** impedir
   que el candado se monte.
3. El filtro **no toca el enforcement**: no lee ni escribe `window.__saSurtidoGuardEnabled`, no
   reenvuelve `fetch`, no llama `evaluateMove`.

**Invariante de seguridad (no negociable):** esconder es **puramente visual**. El candado
bloquea sobre el *payload* de `CreateManyPartsTransfersChecked`, así que una tarjeta oculta sigue
igual de bloqueada. Y el ocultamiento usa `display:none` (**no desmonta el nodo**), así que
`decorateCards` sigue viendo TODAS las tarjetas y su propio árbitro (`anyScheduled`) no se
altera. Un test fija esto: con filtro activo, `evaluateMove` da el mismo veredicto.

### 4. UI

Box dark-mode **en flujo normal** dentro de la barra de acciones del header del Workboard.

**Ancla medida (2026-07-29):** la barra es el `div[display:flex]` que contiene el título del board
y los 4 botones de acción (`ESCANEAR ETIQUETA DE TRABAJO`, `GESTIONAR INVENTARIO`,
`CONFIGURACIÓN DE ETIQUETAS`, `NUEVA TARJETA`). Se localiza subiendo desde el botón
`NUEVA TARJETA` / `NEW CARD` (texto ES+EN) hasta su contenedor flex; sin
`data-steelhead-component-id` disponible en esa zona, ese es el mejor anclaje.

**A diferencia de `batch-name-filter`, aquí NO se necesita `position:fixed`:** ese header tiene
`overflow: visible` (medido), así que no recorta. Se inyecta como un hijo más del flex y hereda el
comportamiento responsive. Menos código y menos deuda de posicionamiento.

```
🔒 → Línea destino:  [ Todas ▾ ]   Mostrando 6 de 47   ✕
      T204 (6) · T205 (11) · T109 (3) · Sin programar (4)
```

- El renglón de abajo son **conteos informativos, NO clicables**. En particular
  `Sin programar (4)` es un dato, **no** una opción del dropdown: el operador descartó
  explícitamente tener "Sin programar" como filtro seleccionable.
- El dropdown contiene exactamente: `Todas` + una entrada por línea presente en el board.
- Conteos **desde la API**, no de lo montado.
- **No persiste** entre recargas (igual que el candado, por diseño): un filtro pegado que
  esconde trabajo hace que el operador crea que no hay pendientes.
- Con filtro activo, el contador `Mostrando 6 de 47` **siempre** a la vista.

#### Las no programadas

Decisión del operador: **se esconden como el resto** cuando hay filtro activo (vista limpia de
la línea). Como no tienen estación, ningún filtro por línea las puede reclamar.

Salvaguarda que **no** cambia ese comportamiento pero evita que el vacío mienta: el box muestra
`N sin programar ocultas` mientras haya filtro. El dato no se pierde de vista; solo la tarjeta.
(Misma lección que `batch-name-filter` 0.3.x: un vacío sin explicar se lee como "no hay nada".)

### 5. Efecto del filtro: esconder, con caída medida a atenuar

Decisión del operador: **esconder de verdad** (el board se acorta, se deja de scrollear).

**El riesgo que hay que medir, no suponer:** si el step usa listas **virtualizadas**,
`display:none` sobre un hijo puede dejar huecos o encimar tarjetas, porque el contenedor calcula
alturas y posiciones. Si al medirlo se rompe el layout, se cae a **atenuar** (`opacity:.25` +
`grayscale`), que es lo que `schedule-batch-highlighter` eligió por esta misma razón. El resto
del diseño no cambia — solo el efecto visual.

**MEDIDO EN VIVO (2026-07-29) — esconder FUNCIONA. Decisión cerrada.**

El board **sí** está virtualizado, con **react-virtuoso**
(`[data-testid="virtuoso-scroller"]` / `"virtuoso-item-list"`, items con `data-item-index` +
`data-known-size`, `overflow-anchor: none`). Una hipótesis previa de este spec decía lo contrario;
la medición la refutó.

**Y aun así esconder es seguro**, porque virtuoso re-mide con `ResizeObserver`. Experimento: se
ocultaron 2 de 6 items con `display:none` sobre el nodo `[data-item-index]`:

| Señal | Antes | Después |
|---|---|---|
| `scrollHeight` de `virtuoso-item-list` | 1034 | **524** (recalculó solo) |
| Rects de los items visibles | contiguos | **contiguos: 365→416→467→678→889** |
| Huecos / tarjetas encimadas | — | **ninguno** |

Revertido sin residuo (`scrollHeight` volvió a 1034). ⇒ **Se implementa esconder**, no atenuar.

**Dos guardas que sí hace falta poner** (consecuencia de la virtualización, no del ocultamiento):

1. **Virtuoso monta más items al liberarse espacio.** Eso es lo *deseado* (rellena con las que sí
   matchean), pero si el filtro esconde casi todo, puede montar mucho más de lo normal. Tope: al
   pasar de **200** items montados con filtro activo, se cae a atenuar y se avisa en el box.
2. **Si el conteo de la API dice 0 para la línea elegida**, no se esconde nada: se muestra el aviso
   "ninguna orden va a T204". Evita el escenario de un board en blanco con virtuoso montando todo
   en busca de algo que no existe.

## Paso 0 — inspección en vivo del board: ✅ COMPLETADO (2026-07-29)

Regla dura del repo: **no se escriben selectores sin el wrapper HTML real**.

- [x] **1. Wrapper completo de una tarjeta** con `Tareas Programadas:` — HTML provisto por el
      operador. Resolvió el anclaje y destapó la trampa del `Proceso:` (§1.1).
- [x] **2. ¿Es virtualización real?** **SÍ — react-virtuoso** (§5). Refutó la hipótesis contraria
      de una versión previa de este spec.
- [x] **3. Qué pasa al ocultar** con `display:none`: **nada malo** — virtuoso recalcula
      (`scrollHeight` 1034→524) y los rects quedan contiguos. Revertido sin residuo (§5).
- [x] **4. Dónde anclar el box:** la barra flex del header con los 4 botones de acción, que tiene
      `overflow: visible` ⇒ inyección en flujo, sin `position:fixed` (§4).
      **Pendiente menor, no bloqueante:** no se ubicó el filtro **nativo** de estación en el DOM
      visible (está detrás de algún menú). No estorba: el box va en la barra de acciones, no junto
      a él. Se confirma visualmente en la validación.

Se hace **leyendo DOM, sin disparar queries** — el `/graphql` de la sesión se cuelga con ráfagas
(~40-45 requests, sin 429, no se recupera al recargar).

> **Lección del arnés (2026-07-29):** la inspección por automatización de Chrome **exige la
> pestaña visible**. Con `document.hidden === true` Chrome throttlea `setTimeout` a ~1/minuto, así
> que cualquier polling con `sleep` revienta el timeout de 45 s de `Runtime.evaluate` sin que la
> página tenga nada malo. Corolario: en pestaña oculta, sondear con **llamadas separadas e
> instantáneas**, nunca con un loop que espera dentro del `evaluate`.

## Plan de validación en vivo

1. **Catálogo**: el dropdown lista las líneas del board con conteos que cuadran con el board.
2. **Filtro**: elegir `T204` deja solo las de T204; el layout no se rompe al scrollear.
3. **Limpiar** (`✕`) repone las N tarjetas.
4. **No programadas**: se esconden y el box reporta `N sin programar ocultas`.
5. **Invariante del candado**: con filtro activo, mover una **no programada** (quitando el
   filtro para alcanzarla) sigue **bloqueado**.
6. **Árbitro**: forzando `lineCodeOf`→null en todas, el filtro se desactiva solo y lo avisa.
7. **iPad**: rebundle Safari + prueba en el dispositivo con el que se surte.

## Fuera de alcance

- Filtrar por estación **exacta** dentro de una línea (decidido: por línea).
- Persistir el filtro entre recargas.
- Filtrar en otros steps o workboards (hoy: solo el step de surtido).
- Tocar el filtro **nativo** de estación de SH.
