# Reaplicar Parámetros a las Specs de Órdenes de Trabajo

**Fecha:** 2026-07-28
**Estado:** diseño aprobado, pendiente de verificación en vivo (§8) antes de implementar escrituras
**Applet destino:** nueva acción del bundle `spec-migrator` ("Ajuste Masivo de Specs")

---

## 1. Problema

Se corrigieron masivamente los parámetros de specs de muchos Números de Parte con
`bulk-upload` (carga masiva). Las **Órdenes de Trabajo generadas ANTES de esa
corrección conservan el criterio viejo**: Steelhead copia los parámetros del NP a la
OT en el momento de crearla, y esa copia no se refresca sola.

Hoy la reparación es manual, OT por OT: abrir la orden → *Editar Especificaciones* →
llenar/corregir cada casilla → *Confirmar*. Con más de 1000 órdenes abiertas, es
inviable a mano.

### Evidencia medida (OT 5769, dominio 344, NP 3044551)

Cruzando los nodos de receta contra los parámetros aplicados:

| | Casillas |
|---|---|
| Con parámetro activo | 137 |
| **Vacías** | **13** |
| Con más de un parámetro vivo | 0 |
| Parámetros huérfanos (sin campo declarado) | 0 |

De las 13 vacías, **12 tienen una sola opción posible** en el catálogo de su spec
(decidibles sin ambigüedad) y **1 tiene dos** (`Espesor`: `5 - 8 µm` vs `5 - 10 µm`).

Cinco de esas casillas vacías viven en el nodo `42513391`
("T201-IC00-001 Inspeccionando y Empacando") — exactamente donde el operador estaba
llenando a mano cuando se capturó el scan.

---

## 2. API — las tres operaciones

Capturadas en `scan_results_2026-07-28_201655.json`, pantalla
`/Domains/344/WorkOrders/5769`, botón *Editar Especificaciones* → *Confirmar*.
Las tres son **nuevas** para este repo.

### 2.1 Lectura

```
GetPartNumberWorkOrderSpecsInfo(partNumberId: Int!, workOrderId: Int!)
hash: 0d77c6496b506be62b92c1d821b2e0ec115838cb404ef3ab1cffe2270ddeb827
```

Devuelve `workOrderById` con dos ramas que hay que cruzar:

- **`partNumberWorkOrderSpecsByWorkOrderId.nodes[]`** — las specs asignadas a la OT.
  Cada una lleva su `id` (que es el **`drivenBy`** de las escrituras) y el catálogo
  embebido `specBySpecId.specFieldSpecsBySpecId.nodes[]`, donde cada campo trae sus
  `specFieldParamsBySpecFieldSpecId.nodes[]` (**solo `id` + `name`** — sin `isDefault`,
  sin mínimo/máximo).
- **`recipeNodesByWorkOrderId.nodes[]`** — los nodos de receta. Cada uno lleva:
  - `recipeNodeSpecFieldsByRecipeNodeId.nodes[]` → **qué campos aplican** a ese nodo
  - `partNumberRecipeNodeSpecFieldParamsByRecipeNodeId.nodes[]` → **qué está aplicado**
    (con `archivedAt`, `specFieldId`, y el parámetro completo en
    `specFieldParamBySpecFieldParamId`)

### 2.2 Escrituras

```
ArchivePartNumberRecipeNodeSpecFieldParams(
  partNumberRecipeNodeSpecFieldParamIds: [Int!]!, archivedAt: String!)
hash: 7d33b66bb244910a9065c631630bceb15f01ca282ac208b16fecf85df36937a4
```
Acepta lote. Devuelve el arreglo de ids archivados.

```
AddParamsToPartNumberRecipeNodeSpecFieldParam(input: {
  partNumberId: Int!,
  parametersToAdd: [{ specFieldId, specFieldParamId, recipeNodeId,
                      geometryTypeSpecFieldId: null, locationId: null, drivenBy }]
})
hash: 8e8b0ab50c0404a01985ec894d0c91d3eab4159c6360f923b9920b8e344aaef0
```
Acepta lote en `parametersToAdd`. `drivenBy` = `id` del `PartNumberWorkOrderSpec`
correspondiente a la spec de la que sale el parámetro.

### 2.3 El ERP CLONA el parámetro al aplicarlo — consecuencia de diseño

En la captura se pidió `specFieldParamId: 12533622` y el registro resultante quedó
con `specFieldParamId: 34924257`. El clon guarda su origen en
`specFieldParamByDerivedFromId`.

Ejemplo real de la OT 5769, campo `Espesor` (`specFieldId: 15630`):

```
aplicado id=22341384
  └ specFieldParamId 29917475  name "5 - 8 µm"   min 5  max 8
      └ derivedFrom 28818108   name "5 - 10 µm"     ← el origen HOY se llama distinto
catálogo de la spec 14344 (specFieldSpec 106115):
      12533622 "5 - 8 µm"   ·   32594227 "5 - 10 µm"
```

**Ni `29917475` ni `28818108` están en el catálogo.** Hay una cadena de clonación.
Por lo tanto: **comparar por `specFieldParamId` contra el catálogo produce falsos
negativos**. La comparación tiene que ir por linaje o por valor (§5).

Ese ejemplo es, además, la firma exacta del problema del cliente: la OT congeló
`5 - 8 µm` mientras que su origen ya dice `5 - 10 µm`.

---

## 3. La unidad de decisión: la casilla

Una **casilla** es el par **`(recipeNodeId, specFieldId)`**.

Regla heredada de `bulk-upload` 1.4.38 (§"SpecField agrupa, no SpecFieldParam"):
**una sola fila viva por casilla**. Cualquier deduplicación, validación o limpieza
agrupa por campo, nunca por parámetro — el modelo de datos deja eso ambiguo porque
cada fila apunta a un `specFieldParamId`, pero la regla de negocio no lo es.

El universo de casillas de una OT sale de `recipeNodeSpecFieldsByRecipeNodeId`, no de
lo aplicado: es la única fuente que dice qué **debería** estar lleno.

---

## 4. Fuente de verdad: el Número de Parte

Decisión del operador: manda lo que la carga masiva dejó en el NP.

```
GetPartNumber(id) → partNumberSpecFieldParamsByPartNumberId.nodes[]
```

Se agrupan los activos por `specFieldParamBySpecFieldParamId.specFieldSpecBySpecFieldSpecId.id`
— el mismo patrón que ya usa `spec-migrator.js:2798`. Eso da, por cada
`(spec, campo)`, el parámetro que el NP tiene **hoy**.

**Cascada de resolución** del valor deseado de una casilla:

1. El parámetro que el NP tiene para ese `specFieldSpec`
2. Si el NP no lo resuelve y el catálogo de la spec en la OT ofrece **exactamente una**
   opción → esa
3. Si no → `AMBIGUO`, **no se toca**

---

## 5. Clasificación y comparación

### 5.1 Los estados

| Estado | Condición | Acción |
|---|---|---|
| `OK` | El parámetro aplicado equivale al deseado | ninguna |
| `VACÍO` | Ninguna fila viva en la casilla | agregar el deseado |
| `DIFIERE` | La fila viva no equivale al deseado | archivar la vieja + agregar el deseado |
| `DUPLICADO` | Más de una fila viva | conservar la equivalente (o la más reciente), archivar el resto |
| `AMBIGUO` | La cascada §4 no resolvió | reportar, no tocar |
| `SIN_CATÁLOGO` | El campo no existe en ninguna spec viva de la OT | reportar, no tocar |

### 5.2 Equivalencia — cascada que solo puede absolver

Cada escalón puede declarar `OK`; **ninguno puede declarar `DIFIERE`**. Solo agotar
los tres lo hace.

1. `aplicado.specFieldParam.derivedFromId === deseado.id`
2. `aplicado.specFieldParam.id === deseado.id`
3. Identidad de valor: `name`, `minimumValue`, `maximumValue`, `targetValue`, `unitId`
   idénticos

El sesgo es deliberado. Un falso `OK` deja una casilla sin corregir — se detecta en la
siguiente corrida. Un falso `DIFIERE` **cambia el criterio de calidad de una orden en
piso**. Los costos no son simétricos, y la cascada se inclina hacia el barato.

### 5.3 Qué id se manda al agregar

El flujo nativo mandó el id del **catálogo de la spec** (`12533622`), no el del NP.
Si el ERP no resuelve el NP por su cuenta, hay que traducir NP → catálogo casando por
`specFieldSpecId` + identidad de valor antes de escribir. **Pendiente de verificación
(§8.2).**

---

## 6. Orígenes de selección

| # | Origen | Molde |
|---|---|---|
| 1 | La OT abierta en pantalla | botón en `/Domains/<d>/WorkOrders/<id>` |
| 2 | Pegar números de OT | `pn-lifecycle` v0.2.0 ("Pegar IDs") |
| 3 | Por Número de Parte | das los NP corregidos → busca sus OTs |
| 4 | Escaneo total de OTs abiertas | corrida larga, ver §7 |

Una OT puede tener varios NP, y la consulta pide `partNumberId`. La expansión
OT → NPs usa `PartNumbersByWorkOrderIdInDomain` (ya conocida, la usa
`wo-listing-columns`). La unidad real de trabajo es el par **(OT, NP)**.

**Alcance de escritura** (decisión del operador): cualquier orden abierta, haya
arrancado o no.

**"Abierta" = no completada**: `AllWorkOrders` con el mismo criterio que usa el
listado nativo de órdenes (`hideCompleted`). Las completadas y las archivadas quedan
fuera y ni siquiera se leen — leerlas costaría 0.87 MB cada una para nada.

### 6.1 Fases de entrega

Los cuatro orígenes no se construyen a la vez. El modelo de decisión (§3-§5) es lo
que hay que validar primero, y para eso basta una orden:

| Fase | Entrega | Para qué |
|---|---|---|
| **1** | Núcleo puro + golden tests + orígenes 1 y 2 (pantalla y pegar OTs) | Valida el modelo contra órdenes reales con el operador mirando. Aquí se resuelven las incógnitas de §8. |
| **2** | Origen 3 (por Número de Parte) | Cierra el problema de raíz: los NP que se corrigieron son los que tienen OTs desalineadas. |
| **3** | Origen 4 (escaneo total) con troceo, checkpoint y reanudación | Solo tiene sentido cuando las fases 1-2 probaron que el diff es confiable a escala pequeña. |

Cada fase se deploya y se valida en piso antes de la siguiente. La fase 3 es la única
que exige la maquinaria de §7 completa.

---

## 7. El escaneo total: 0.87 MB por consulta

Medido sobre la respuesta real de la OT 5769: **0.87 MB por cada (OT × NP)** — 52
nodos de receta (0.57 MB) y 334 specFieldSpecs de catálogo embebido (0.29 MB).

Con 1000+ órdenes abiertas y ~1.5 NP por orden: **~1500 consultas ≈ 1.3 GB** de
tráfico y de parseo. Ese modo nace troceado y reanudable o no funciona.

- **Destilar y tirar.** De cada respuesta se extraen las casillas (~3 KB) y el resto
  se descarta en el acto. Nunca se acumula el crudo. Patrón `extractWorkOrderBatches`
  de `wo-listing-columns`.
- **Pool de 3.** Lección de `po-listing-filters`: el `/graphql` se cuelga alrededor de
  las 40-45 peticiones en ráfaga —sin devolver 429, sin recuperarse al recargar— y
  tumba también la pantalla nativa, porque el límite es por sesión y no por pestaña.
- **Memoria del host.** Monitor con guardrail al 88%, Datadog detenido, drenado
  periódico de Apollo — todo vía `host-cleanup-shared` (`window.SteelheadHostCleanup`),
  sin copiar el patrón en línea.
- **Checkpoint reanudable.** Una corrida de miles de pares no puede perderse a la
  mitad. Estado en IndexedDB (molde `bulk-upload`, que migró `sa_load_history` por
  esta misma razón).
- **Troceo por filtro.** El escaneo total se puede acotar (por línea, cliente o NP)
  para correrlo por partes.

---

## 8. Verificación en vivo — OBLIGATORIA antes de implementar escrituras

El scan **no incluye** un `GetPartNumber` con parámetros: sus muestras salieron
vacías, que es justo el caso que arregló `hash-scanner` 0.6.24 (el backup de recarga
guardaba las operaciones `known` sin muestras). Por eso lo siguiente es hipótesis
razonada, no dato.

### 8.1 La cadena de linaje
`GetPartNumber(3044551)` → ¿existe un parámetro activo con `id 28818108`? ¿su
`specFieldSpecId` es `106115`?
- **Si sí** → confirmada la cadena `catálogo → clon del NP → clon de la OT`, y el
  escalón 1 de §5.2 es el bueno.
- **Si no** → el escalón 1 nunca acierta y la comparación se apoya en el escalón 3
  (identidad de valor). El diseño sigue en pie, más frágil.

### 8.2 Qué id acepta `AddParams`
Aplicar una casilla vacía en una OT de prueba mandando el id del catálogo y verificar
qué parámetro quedó. Determina si hace falta la traducción de §5.3.

### 8.3 Corrida de prueba
Una sola OT, dry-run → aplicar → releer → confirmar que las casillas quedaron como el
preview prometió.

---

## 9. Seguridad

- **Dry-run siempre primero.** Preview con el diff casilla por casilla antes de
  cualquier escritura.
- **Confirmación explícita** del operador sobre el conteo de lo que se va a tocar.
- **Reporte CSV** de lo aplicado, con los ids archivados y creados, para poder
  revertir a mano.
- **Nada se toca en `AMBIGUO` ni `SIN_CATÁLOGO`** — se reportan para decisión humana.
- **Fail-safe ante dato faltante**: si la lectura de una OT falla, esa OT se salta y
  se reporta; nunca se escribe sobre información incompleta.

---

## 10. Arquitectura

```
remote/scripts/wo-spec-params-core.js   ← núcleo PURO: clasificar casillas, planear
                                          el diff. Sin red, sin DOM. Golden tests.
remote/scripts/wo-spec-params.js        ← glue: consultas, pool, panel, escrituras
```

Ambos se agregan al arreglo `scripts` de la app `spec-migrator` en `config.json`,
junto con una quinta acción:

```json
{ "id": "reapply-wo-params", "label": "Reaplicar Params en OTs",
  "sublabel": "Alinea las specs de las órdenes con su Número de Parte",
  "icon": "🔧", "handler": "message", "message": "reapply-wo-params",
  "fn": "WoSpecParams.open" }
```

**No** dentro de `spec-migrator.js`: ese archivo ya trae 4,097 líneas y no necesita
otro modo encima.

El núcleo puro recibe la respuesta cruda de la OT y el mapa de parámetros del NP, y
devuelve el plan (`toArchive[]`, `toAdd[]`, `report[]`). Toda la decisión es testeable
sin navegador.

### Convenciones del repo que aplican
- **UI en tema oscuro** (base `#1c2430`, texto `#e6e9ee`, acento `#13a36f`) — para que
  el operador distinga de un vistazo que no es pantalla nativa de Steelhead.
- **Anclaje estructural antes que texto**; si hay que anclar por texto
  (*Editar Especificaciones*), bilingüe ES+EN, y solo como red de seguridad que amplía.
- **La UI de entrada se monta siempre que la ruta aplique**, nunca detrás del propio
  gate de estado del applet.

---

## 11. Deuda que se cierra en el mismo trabajo

Regla dura del repo, ya verificada por `tools/test/hash-regen-coverage.test.js`
(trinquete: falla si el número de operaciones huérfanas sube):

- `GetPartNumberWorkOrderSpecsInfo` → ruta en `route-catalog.json`
  (`goto` la OT + `clickButton` *Editar Especificaciones*)
- `ArchivePartNumberRecipeNodeSpecFieldParams` → centinela con captura-y-aborta
- `AddParamsToPartNumberRecipeNodeSpecFieldParam` → centinela con captura-y-aborta

Un hash sin ruta de regeneración es deuda: cuando Steelhead lo rote, el applet cae en
captura manual.

---

## 12. Fuera de alcance

- Reaplicar specs **completas** que falten en la OT (aquí solo se reparan parámetros
  de las specs ya asignadas).
- Tocar órdenes completadas o cerradas.
- Editar los valores del parámetro (mínimo, máximo, objetivo) — eso es
  `spec-params-bulk`.
