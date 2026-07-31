# `wo-spec-params` — Reaplicar Parámetros en Órdenes de Trabajo

## 2026-07-30 — una orden puede traer VARIAS specs externas (config 1.11.42)

**Reporte del operador:** *«me marca en la WO 16510 que no encuentra el nodo de calidad, pero sí
lo trae»*. Tenía razón: el nodo estaba a la vista en el árbol.

`findExternalSpec` recorría las specs y hacía `return` con **la primera** externa. Medido en vivo:

```
OT 16510
  «48053-001-01 (Deshidrogenado / Endurecido)»  3 campos
       → NINGÚN nodo de calidad declara sus campos
  «RC Zn (Zinc)»                                5 campos
       → T106-IC00-001 Inspeccionando y Empacando declara 5/5
```

Tomaba la de Deshidrogenado, ningún nodo la tocaba, `findInspectionNode` devolvía cero
candidatos y **las dos specs quedaban sin atender**. Cuál se elegía dependía del orden de la
respuesta del ERP: una lotería. En 16433 y 16462 —con una sola externa— funcionó bien (9/9 y
5/5), y por eso el defecto sobrevivió a la validación.

**Fix:** `findExternalSpecs` devuelve todas y cada una se resuelve con SU nodo. `extFields` pasa
a ser la unión (con una sola considerada, los campos de las demás se colaban al universo PROCESO
y se trataban como parámetros de línea). `faltantesSinDestino` ahora dice **de qué spec** es cada
campo y por qué no hay destino.

**Un test existente atrapó una regresión que metí de paso:** al no encontrar nodo yo cortaba con
`continue` y mandaba TODOS los campos a faltantes, incluidos los correctamente aplicados. El
comportamiento correcto —que ese test ya fijaba— es seguir evaluando lo que existe.

Verificado contra la 16510 real después del fix: RC Zn encuentra su nodo, los 3 de Deshidrogenado
se reportan, y el plan da 0 cambios porque las 5 casillas ya estaban `OK`.

### Modo acotado: escribir solo lo que define el NP

`resolveDesired` tiene dos vías y el preview las mezclaba:

| vía | qué es |
|---|---|
| `NP` | el Número de Parte define el campo — la fuente de verdad declarada |
| `CATALOGO` | el NP no lo define, pero el catálogo ofrece UNA opción → se infiere |

En la corrida de 194 órdenes, **250 de 16 314 casillas** eran de la vía CATALOGO, casi todas
campos de PROCESO (temperatura de tina, concentración, tiempo de centrifugadora) cuyo único
parámetro de catálogo se llama literalmente «Pendiente». **No está demostrado que una orden sana
los tenga llenos.** El modo (opt-in) escribe solo la vía NP; el resumen reporta cuántas dejó
fuera — un filtro que no se ve engaña sobre lo que se aplicó.

**PENDIENTE de decidir con evidencia:** abrir una OT anterior al daño (p.ej. 16400), nodo
`T102-SE00-001 Secando Centrífugo`, campo `Tiempo de Centrifugadora`. Si dice «Pendiente», las
250 se aplican; si está vacío, la vía CATALOGO debe apagarse siempre.

### El «DUPLICADO» que no existía, y el nodo raíz que sí

Reporte del operador sobre tres casos del escaneo: *«la primera no tiene duplicado sino sigue con
nodo raíz… ¿puedes checar que no estés contemplando lo archivado?»*.

Medido en la OT **16649** (NP 50087055) bajando el payload real:

```
ACTIVA     campo 15630 "5 - 12 µm"  →  T104 (EST)-CU/BR-VARIOS   (PROCESS = raíz)
ARCHIVADA  campo 15630 "5 - 12 µm"  →  T104-IC00-001             (QA = el correcto)
```

**Una sola fila viva.** Con el core corregido esa orden da `DUPLICADO: 0` y 74 casillas `OK`: el
CSV que lo reportaba se había exportado **antes** del fix de las varias specs externas. Los 745
duplicados de aquel escaneo mezclan artefacto con daño real y hay que volver a medirlos.

La intuición del operador apuntaba bien aunque el mecanismo fuera otro: el filtro `archivedAt`
sí estaba en el código (8 sitios), lo que fallaba era la **selección de la spec externa**.

**Pero su segunda observación sí destapó algo vivo:** los parámetros están en el **nodo raíz** y
el applet los da por buenos. Es la regla de cobertura POR ORDEN —un campo cuenta como cubierto si
vive en cualquier nodo— que se puso para no proponer duplicados. Estar en el raíz cuenta.

El core sí lo ve, en `fueraDeInspeccion`:

```
15630 Espesor · 15820 Adherencia · 19445 Apariencia Homogénea · 22067 Primeras Piezas
   → los 4 viven en T104 (EST)-CU/BR-VARIOS (PROCESS)
```

La herramienta es el modo **migrar**, apagado por omisión. Sobre la misma orden produce
`MIGRAR: 4` — archiva en el raíz y repone en `T104-IC00-001`.

**VALIDADO EN VIVO (2026-07-31):** el operador aplicó esos 4 y confirmó en la UI. El caso reunía
las tres señales de seguridad que conviene exigir antes de soltar el modo en masa:
`origen=NP` (el valor sale del Número de Parte, no del catálogo), `tenía == quedará` (no se toca
ningún criterio, solo el nodo) y `forzada=no` (el nodo destino ya declara esos campos).

### El modelo, corregido por el operador

Una spec puede llegar a la orden **por el NP y además por el tratamiento** — verificado:
`E27780 (Epóxico MT)` aparece dos veces, `De: TR-PME-007 Curado` y `De: TR-ICA-009 Inspección`.
**Es CORRECTO que la del tratamiento vaya sin parámetro**: no se puede poner el mismo specField
con parámetro por cada OT, así que entra el del NP y el del tratamiento se queda vacío. Pasa
también con Antitarnish. El applet no debe leer esa segunda entrada como un hueco por llenar.

### Lección de método, dos veces el mismo día

Al diagnosticar la 16510 medí dos veces con el **shape equivocado**: primero con `WorkOrder`
(que no trae `type` de los nodos) y luego buscando los campos de la spec en
`partNumberWorkOrderSpecFields…` en vez de `spec.specFieldSpecsBySpecId`. En ambos casos la
señal fue **un cero absurdo** —las 9 specs con cero campos— y lo que lo resolvió fue **copiar el
acceso exacto del core** en vez de deducirlo del nombre. Mismo patrón que el incidente del shape
de `AddParamsToPartNumber`.

> El modelo completo de mediciones —los dos ejes, DÓNDE se mide vs BAJO QUÉ CRITERIO— está en
> [`docs/api/spec-measurement-model.md`](../api/spec-measurement-model.md). Es la causa
> estructural detrás de estos casos: un campo sin nodo que lo declare nunca se pide.

---

**Versión:** 0.5.0 · **Estado:** ✅ **VIVO (config 1.11.3, tag `v1.11.3`)** · fase 1 validada end-to-end el 2026-07-28; fases 2 y 3 y el modo *migrar* **sin corrida real**
**Bundle:** 5ª acción de *Ajuste Masivo de Specs* (`spec-migrator`)
**Diseño:** [`docs/superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md`](../superpowers/specs/2026-07-28-wo-spec-params-reapply-design.md)
**Plan:** [`docs/superpowers/plans/2026-07-28-wo-spec-params-fase1.md`](../superpowers/plans/2026-07-28-wo-spec-params-fase1.md)

## Qué resuelve

Steelhead copia los parámetros de las specs del Número de Parte a la Orden de Trabajo **cuando
la crea**, y esa copia no se refresca. Se corrigieron masivamente muchos NP con `bulk-upload`,
pero **las OTs generadas antes conservan el criterio viejo** — y hay más de 1000 abiertas.

Hoy la reparación es manual: abrir la orden → *Editar Especificaciones* → llenar/corregir cada
casilla → *Confirmar*.

## Las tres operaciones

| Op | Tipo | Hash |
|---|---|---|
| `GetPartNumberWorkOrderSpecsInfo` | query | `0d77c649…` |
| `ArchivePartNumberRecipeNodeSpecFieldParams` | mutation | `7d33b66b…` |
| `AddParamsToPartNumberRecipeNodeSpecFieldParam` | mutation | `8e8b0ab5…` |

La lectura pesa **0.87 MB por (OT × NP)** — 52 nodos de receta y 334 specFieldSpecs embebidos.
Se destila a unos pocos KB y el crudo se descarta en el acto.

## Los tres ids que no hay que confundir

**El ERP CLONA el parámetro al aplicarlo.** Pides el id del catálogo y el registro queda con
otro, encadenado por `specFieldParamByDerivedFromId`.

| | Qué es | Para qué |
|---|---|---|
| `fila.id` | el `PartNumberRecipeNodeSpecFieldParam` | lo que se **archiva** |
| `specFieldParamBySpecFieldParamId.id` | el clon | no se manda nunca |
| `specFieldParamByDerivedFromId.id` | el id del **catálogo** | lo que se **escribe** y con lo que se **compara** |

Prueba, de la OT 5769: la fila `26249942` se creó mandando `specFieldParamId: 12533622`
(catálogo) y quedó con `specFieldParamId: 34924257` y `derivedFromId: 12533622`.

## El modelo: dos universos

La unidad es la **casilla** = `(recipeNodeId, specFieldId)`, una sola fila viva por casilla
(lección `bulk-upload` 1.4.38: el SpecField agrupa, no el SpecFieldParam).

Pero **las specs de una OT no son todas iguales**:

| | Señal | Universo de casillas |
|---|---|---|
| **Externa** (del cliente, vía el NP) | `partNumberSpecByPartNumberSpecId != null` | **todos** sus campos vivos, en **un solo nodo** |
| **De proceso / línea** | ese campo es `null` | lo que cada nodo declara en `recipeNodeSpecFields` |

En la OT 5769, de 7 specs solo **una** es externa (`40004-014-01 (Estaño)`, 6 campos vivos).

**El nodo destino se identifica por TIPO, no por nombre**: es el `QUALITY_ASSURANCE_NODE` que
toca la spec externa. Hay **tres** de ese tipo por orden —`Inspeccionando Recibo`,
`T201-IC00-001 Inspeccionando y Empacando`, `Inspeccionando Calidad Embarques`— así que el tipo
solo no basta. Si los candidatos no son exactamente uno, **no se fuerza nada** y se reporta.

### Forzar
Aplicar un campo de la spec externa al nodo destino **aunque no lo declare**. Activado por
omisión, pero **marcado aparte**: cada forzado es una declaración que falta en la configuración
del proceso, y esa lista es el pendiente del operador.

### Anomalías
Parámetros de la spec externa en un nodo que **no** es el destino. Se reportan y **no se
tocan** — corregirlos perpetuaría el error, archivarlos es una decisión no autorizada. Medidas
en la OT 5769: **5**, todas en el nodo raíz `PROCESS`.

> **Nadie las está limpiando.** El operador recordaba que "un applet de aplicación masiva de
> specs" ya lo hacía: ese applet es `bulk-upload` STEP 6b (regla 1.4.38), que deduplica dejando
> una fila viva por SpecField con `processNodeId: null` — pero **sobre el NP**. Ningún script
> del repo toca `PartNumberRecipeNodeSpecFieldParam`, que es la tabla de la **OT**.
>
> **Hipótesis (sin confirmar):** en el NP un parámetro vive *sin* nodo de proceso, y en la OT
> tiene que colgar de un `recipeNodeId` — así que al generar la orden el ERP elige uno, y el
> candidato natural es la raíz. Si es cierto, **toda** OT traerá lo mismo: no es basura
> ocasional sino el comportamiento por omisión. Se confirma contando anomalías en varias OTs de
> NPs distintos; el applet ya deja ese conteo listo.

## La comparación: cascada que solo puede absolver

Tres escalones; **ninguno puede declarar `DIFIERE`**, solo agotarlos lo hace.

1. **Raíz de catálogo** — `derivedFrom ?? id` de ambos lados
2. **Id directo**
3. **Identidad de valor** — nombre normalizado + mínimo + máximo + objetivo + unidad

**El escalón 3 es el caballo de batalla, no el 1.** Medido en la OT 5769: de 136 aciertos,
**132 por identidad y solo 4 por linaje**. El catálogo de una spec evoluciona, así que un
parámetro aplicado puede descender de una versión ya reemplazada (la OT deriva de `17890459`
mientras el catálogo vigente ofrece `17854613`, ambos "Sí o No"). **Un prototipo apoyado solo en
linaje marcó 134 falsos `DIFIERE`** y habría reescrito casi toda la orden.

El sesgo es deliberado: un falso `OK` deja una casilla sin corregir y la siguiente corrida la
agarra; un falso `DIFIERE` **cambia el criterio de calidad de una orden en piso**.

La normalización del nombre colapsa espacios y baja a minúsculas pero **no quita acentos**: "Si"
y "Sí" son cadenas distintas y en un catálogo de calidad esa diferencia puede ser real.

## Estados

| Estado | Acción |
|---|---|
| `OK` | ninguna |
| `VACIO` | agregar |
| `DIFIERE` | archivar + agregar |
| `DUPLICADO` | conservar la equivalente, archivar el resto |
| `AMBIGUO` / `SIN_CATALOGO` | reportar, **no tocar** |

**El NP puede tener varias filas activas por campo.** Verificado: el NP `80236-167-07` tiene
cuatro para `Espesor`, tres archivadas y una activa. Si hubiera **dos o más activas**, el
deseado es indeterminado → `AMBIGUO`, no se adivina (sugerir correr antes *Validar params
duplicados*).

## Orden de escritura

**Archiva primero, agrega después.** Es el orden del flujo nativo (eventLog del scan), y si el
archivado falla **no se agrega**: dejaría dos filas vivas en la casilla, justo el estado que
este applet existe para evitar.

## Arquitectura

```
remote/scripts/wo-spec-params-core.js   núcleo PURO — 34 golden tests
remote/scripts/wo-spec-params.js        glue: consultas, panel, escrituras — 16 tests
tools/test/fixtures/wo-spec-params-5769.json   fixture REAL de producción
```

UI en **tema oscuro** (`#1c2430` / `#e6e9ee` / `#141a23` / `#13a36f`), `textContent` en todo lo
que viene de GraphQL.

## Rutas de regeneración de hash

Anclas **estructurales** verificadas en vivo el 2026-07-28 — no texto, porque esa pantalla
mezcla idiomas:

- **query** → `route-catalog.json` / `workorder-edit-specs`, con
  `WORK_ORDER_PAGE_PARTS_EDIT_SPECS_BUTTON` (el cid vive en el **wrapper** y el `<button>` es su
  hijo, por eso el selector cubre las dos formas)
- **las 2 mutations** → `sentinels-config.json` / `workOrderSpecParams`, captura-y-aborta sobre
  la OT Centinela 11677, guardando con `WORK_PARTS_INFO_SAVE_SPECS_AND_CLOSE_BUTTON`

**Pendiente de correr headless:** cambiar el parámetro es un dropdown del modal aún no
guionizado, y hay que confirmar que la OT Centinela tenga una spec con un campo de dos opciones
(si solo hay una, no hay cambio que provocar).

## Estado de validación

| | |
|---|---|
| Núcleo puro | ✅ 34/34 contra fixture real |
| Glue | ✅ 16/16 |
| Suite completa | ✅ 83 archivos, 0 rojos |
| Lectura contra el ERP | ✅ verificada en vivo |
| **Corrida de escritura** | ✅ **VALIDADA por el operador 2026-07-28** |
| Deploy | ✅ config 1.10.1, tag `v1.10.1` |

**La prueba que hizo el operador es la buena:** desalineó parámetros a propósito en una OT y
corrió el corrector. *"Funciona perfecto."* No es una lectura pasiva — provocó el defecto y
verificó que el applet lo revierte, que es justo el ciclo que va a correr en piso.

### La corrida pendiente (invariantes de la OT 5769)

| Qué | Esperado |
|---|---|
| Especificación externa | `40004-014-01 (Estaño)`, 6 campos |
| Nodo de inspección | `T201-IC00-001 Inspeccionando y Empacando` (`42513391`) |
| Anomalías | 5, todas en el nodo raíz `42513351` |
| Casillas que difieren | 2, ambas en el nodo de inspección |

```
Espesor              OT "5 - 8 µm"     → NP "5 - 10 µm"   (escribe 32594227, archiva 26249942)
Espesor (Intermedio) OT "0.5 - 1.0 µm" → NP "No aplica"   (escribe 32596235, archiva 26249943)
```

**Ninguna casilla debe apuntar al nodo raíz.** Si alguna lo hace, el applet está por perpetuar
el error de datos — parar y revisar `findInspectionNode`.

Tras aplicar: **releer** para confirmar. No basta con que la mutación no lance excepción — la
lección de `wo-schedule-button` 0.7.0 es que el ERP puede responder `{clientMutationId: null}`
sin confirmar nada.

Las **5 anomalías deben seguir intactas**. Si desaparecieron, algo las archivó sin autorización.

## Fase 2 — origen por Número de Parte (0.2.0)

Pegas los NP que corregiste —**nombres o ids**— y el applet encuentra sus órdenes abiertas.
Es la vía principal: los NP corregidos **son** los que tienen órdenes desalineadas.

### Tres hallazgos verificados en vivo, y los tres cambiaron el diseño

**1. `searchQuery` NO busca por Número de Parte.** Cero resultados para un NP que sí tiene
órdenes. Mismo patrón que la lección de `po-listing-filters` con proveedores. La vía es
**`partNumberIdFilter: [ids]`** — acepta lista con semántica OR (2 NP → 7 órdenes) y **no
aparecía en el sample del scan**: se descubrió probando.

**2. Los nombres parecidos se ignoran EN SILENCIO.** `partNumberIdsFilter`, `partNumberFilter`
y `partNumberIds` devuelven **4284 órdenes —el dominio entero— en vez de 4**. Un typo ahí no
falla ruidosamente: procesa todo. Por eso hay un test que fija el nombre bueno **dentro del
cuerpo** de `workOrdersForPartNumber` (acotado ahí porque `partNumberIds` es también el nombre
legítimo de una estructura interna).

**3. Los nombres de NP NO son únicos.** `80236-167-07` resuelve a **nueve NP activos**, de los
que solo dos tienen órdenes (4 y 1). `SearchPartNumbers` ni siquiera expone el cliente para
distinguirlos.

**La salida es segura sin preguntar:** un nombre se expande a **todos** sus homónimos exactos,
porque **cada orden se compara contra el NP que ella misma tiene asociado**, nunca contra "el
que pegaste". Expandir solo amplía cobertura; no puede corregir una orden contra el NP
equivocado. El panel informa a cuántos NP resolvió cada nombre y cuántos venían sin órdenes.

### Dimensionamiento corregido
El dominio tiene **4284 órdenes activas**, no las 1000+ estimadas. A 0.87 MB por (OT × NP), el
escaneo total serían **~3.7 GB** — otro argumento para que la fase 2 sea el camino principal y
la 3 el último recurso.

## Fase 3 — escaneo del dominio completo (0.3.0)

Recorre **las 4284 órdenes abiertas**. A ~0.87 MB por lectura son unos **40 minutos**, así que
nació con el checklist de memory-hardening completo, no como parche.

### EJE A — memoria propia
- **`slimResult`** guarda ~2 KB por orden en vez del resultado con los nodos crudos. En 4284
  órdenes esa diferencia **es** el OOM. Hay un test que falla si el slim pasa de 4 KB.
- **`workOrder = null`** tras clasificar, para soltar los 0.87 MB antes de la siguiente vuelta.
- **Caché de Números de Parte** durante el escaneo (muchas órdenes comparten NP) y `clear()` al
  terminar.
- **`closePanel` suelta todo**: detiene el escaneo, para el monitor y vacía la caché.

### EJE B — memoria del host
- **`stopDatadogSessionReplay()`** al arrancar la corrida, no al cargar el applet.
- **`createMemMonitor`** con lectura visible en el panel. **`onGuardrail` al 88% DETIENE**,
  guarda el avance y pide recargar — checkpoint antes que crash.
- **`makePeriodicDrain(50)`** al cierre de cada orden + `apolloCacheDrain()` al final.

### Reanudación
Checkpoint en **IndexedDB** al cierre de cada lote de 100 (localStorage no aguanta una corrida
así — misma razón por la que `bulk-upload` migró `sa_load_history`). Al reabrir ofrece
**reanudar** o **empezar de cero**, y el botón **Detener** corta sin perder lo andado.

### Concurrencia
Pool de **3**, con el tope clavado en el código: el `/graphql` se cuelga alrededor de las 40-45
peticiones en ráfaga —sin devolver 429, sin recuperarse al recargar— y tumba también la
pantalla nativa, porque el límite es por sesión y no por pestaña.

**Las escrituras van en serie.** La lectura tolera pool; escribir no.

## 2026-07-29 — el bug que el operador cazó mirando el patrón

La corrida de las 4436 órdenes reportó **9551 cambios en 1890 órdenes**, con casi todas
diciendo exactamente `5 cambios · 1 forzada · 4 anomalías`. El operador frenó: *"me llama la
atención que quiere hacer muchos cambios en órdenes nuevas"*. **Un hallazgo genuino no se
repite idéntico 1890 veces** — eso era firma de bug, y lo era.

### Causa
La cobertura se medía **por nodo** en vez de **por orden**. Los campos de la spec externa viven
REPARTIDOS entre nodos que los declaran —el raíz y el de inspección declaran los mismos— y
mirando solo el de inspección se proponía agregar ahí lo que ya existía en el raíz.

| | reparto | applet decía | |
|---|---|---|---|
| OT 16333 | todo en el QA | 1 cambio | ✓ |
| OT 16341 | 4 en PROCESS, 1 en QA | 5 cambios | ✗ |
| OT 16339 | 4 en PROCESS, 1 en QA | 5 cambios | ✗ |

A las **tres** les faltaba lo mismo: el campo 33579. De 9551 cambios, ~1890 eran legítimos y
**~7660 habrían duplicado parámetros**.

### Por qué la fase 1 pasó la validación y esto no
La OT 5769 con la que se validó **no era representativa**: el operador ya había trabajado en
ella a mano, así que su nodo de inspección tenía parámetros. En órdenes vírgenes el reparto es
el otro. **Validar sobre un caso ya tocado esconde el comportamiento normal.**

## El nodo raíz: diagnóstico cerrado

**Culpable: `bulk-upload`, no el deduplicador.** Hasta el commit `046ec5b` (regla 1.4.38,
2026-05-25) escribía:

```js
processNodeId: part.processId || pn.defaultProcessNodeId || null
```

Forzaba el proceso **por defecto del NP**. Verificado en vivo: el NP `80247-572-20` tiene 4
params con `NODO=241753`, y su `processNodeByDefaultProcessNodeId` es exactamente `241753`
(`"T204 (DEC)-T204 (EST)-CU/BR-VARIOS (16.1)"`) — el mismo nombre del nodo raíz de la OT 16339.

**La regla de herencia del ERP** (aportada por el operador): al crear una OT se heredan del NP
sus specs, specFields y parámetros; si el parámetro **no** trae nodo forzado se aplica al nodo
que declare ese specField, y si ninguno lo declara **queda fuera**. Con nodo forzado, va a ese
nodo. De ahí que los 4 aparezcan en el raíz aunque el raíz no declare los campos: **no llegaron
por declaración, llegaron por nodo forzado**.

El fix de mayo detuvo la sangría pero **no limpió lo ya escrito**.

### Por qué el deduplicador no los corrigió, corriendo sobre todo el dominio

Dos límites, ninguno de lógica:

1. `if (bucket.params.length < 2) continue` — solo miraba SpecFields **duplicados**, y estos
   casos tienen **una sola** fila (forzada, pero una).
2. Su modo masivo **solo archivaba**. Lo admitía su propio comentario: *"el validator sólo
   archive y no podemos convertir un row con processNode en NULL"*.

### Por qué el Espesor Intermedio no se aplicaba
El parámetro correcto vivía bajo el nombre viejo, **archivado**. *Asignar Params Pendientes*
pregunta *"¿qué NP no tienen este param?"*; como el NP sí tenía una fila, no salía como
pendiente. El hueco estaba en la OT, y ningún applet las miraba.

## Los dos frentes de corrección (0.5.0)

**Frente NP** — se levantan los dos límites del deduplicador. Un SpecField con una sola fila
entra si trae nodo forzado, y el apply **repone con `processNodeId: null` después de archivar**
(antes chocaría con el constraint de 1 fila viva por specFieldId). La decisión vive en
`planForcedNodeRelease` (núcleo puro, 7 tests): `ok` · `archive-only` · `rewrite` ·
**`ambiguous`** cuando las filas forzadas tienen valores distintos — ahí **no se toca nada**,
porque elegir criterio de calidad no le toca a una herramienta.

**Frente OT** — modo `migrarAInspeccion`, interruptor en el panel, apagado por omisión: archiva
el parámetro donde esté y lo repone en el nodo de Inspección y Empaque. **Sin nodo de
inspección identificado no mueve nada**: sacar un parámetro sin saber dónde ponerlo lo deja
huérfano.

### El orden de ejecución importa
1. **Frente NP primero** → las OTs nuevas nacen bien.
2. **Frente OT después** → acomoda las que ya existen.

Al revés se migran órdenes que van a seguir naciendo torcidas.

## Pendientes

1. **Corridas reales de las fases 2 y 3** (la 1 ya está validada).
2. **Decidir qué hacer con las anomalías del nodo raíz** (ver la hipótesis de arriba).
4. **Correr headless** las rutas de regeneración.
5. Bundle Safari/iPad: evaluar si aplica.

## Bitácora

### 0.1.0 — 2026-07-28 · VALIDADO EN VIVO

**El operador desalineó parámetros a propósito en una OT, corrió el corrector y confirmó:
"funciona perfecto".** Deployado en config 1.10.1 (tag `v1.10.1`), firma KMS verificada en vivo.

**Nota del deploy:** salió con la otra sesión trabajando en `wo-schedule-button` — 261 líneas
sin commitear que `deploy.sh` habría arrastrado con su `git add remote/` (el incidente del
2026-06-24). Se resguardaron a un patch + `git stash`, se deployó solo lo de este applet
(el commit tocó únicamente `config.json` y `config.sig`) y se restauraron íntegras.
Su WIP **creció durante la operación** (de 3 a 5 archivos: agregó `RelatedSchedulingTreatments`),
lo que confirma que la sesión estaba activa. Sus cambios eran adiciones sobre el merge, así que
no hubo choque.

### 0.1.0 — implementación de la fase 1

Todo el diseño se verificó **en vivo contra el ERP antes de escribir código**, y eso cambió dos
decisiones:

- **El linaje no era la comparación principal.** El primer prototipo, apoyado en `derivedFrom`,
  marcó 134 falsos `DIFIERE` sobre 136 casillas correctas. La identidad de valor pasó a ser el
  escalón principal.
- **El modelo era de un solo universo.** El operador corrigió: los campos de la spec externa van
  completos en el nodo de inspección, y el nodo raíz **no debería tenerlos**. Eso partió el
  modelo en dos y convirtió 5 casillas en anomalías.

Dos errores propios, encontrados al auto-revisar antes de implementar:

- **Los conteos de los tests estaban inventados** (`OK 5 · VACÍO 4`). Al calcularlos contra el
  fixture salieron distintos. Importa porque el plan prohíbe ajustar los tests para que pasen:
  con números malos, eso vuelve el plan una trampa.
- Un test ordenaba `[42513391, 99999]` creyendo que `42513391` era el menor.
