# Diseño — `surtido-guard` v0.3.0: filtro por LÍNEA DESTINO

> Fecha: 2026-07-29
> Estado: **diseño pendiente de aprobación**. Bloqueado en la inspección en vivo del board (paso 0).
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
| **Match por tarjeta** (¿esta tarjeta es T204?) | Texto de la tarjeta, sección `Tareas Programadas:` / `Scheduled tasks:` → `lineCodeOf()` | El nombre `T204-…` **no se traduce**. Y evita el puente frágil `workOrderId` **global** (lo que da la API) ↔ `idInDomain` **visible** (lo que trae la tarjeta), que es un desajuste ya documentado en el repo. |

`AllStations` es un catálogo de ~775 estaciones: **una** llamada por carga de board, cacheada en
memoria, y solo para poner nombres bonitos y conteos. Si falla, el filtro sigue operando con los
códigos de línea que saca del DOM (degrada, no se apaga).

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

Box dark-mode en el header del Workboard. `position:fixed` sobre `document.body` — el header
`MuiPaper` de SH tiene `overflow:hidden` que recorta un panel `absolute` (lección ya pagada por
`batch-name-filter`).

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

**El riesgo que hay que medir, no suponer:** el step usa listas **virtualizadas**
(`[data-item-index]`). `display:none` sobre un hijo virtualizado puede dejar huecos o encimar
tarjetas, porque el contenedor calcula alturas y posiciones. Si al medirlo se rompe el layout,
se cae a **atenuar** (`opacity:.25` + `grayscale`), que es lo que `schedule-batch-highlighter`
eligió por esta misma razón. El resto del diseño no cambia — solo el efecto visual.

## Paso 0 (bloqueante): inspección en vivo del board

Regla dura del repo: **no se escriben selectores sin el wrapper HTML real**. Una sola pasada
sobre el board resuelve todo lo que falta:

1. **Wrapper completo de una tarjeta** con `Tareas Programadas:` — para leer el nombre de la
   estación (¿en qué nodo vive, hay atributo estable, cómo se separa de tratamiento y fecha?).
2. **¿Es virtualización real?** Contenedor, `data-item-index`, si las alturas son inline.
3. **Qué pasa al ocultar** una tarjeta con `display:none` (huecos / encimadas / nada).
4. **Dónde anclar el box** en el header, y dónde queda el filtro nativo de estación (para no
   pegarlos y que se confundan).

Se hace **leyendo DOM, sin disparar queries** — el `/graphql` de la sesión se cuelga con ráfagas
(~40-45 requests, sin 429, no se recupera al recargar).

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
