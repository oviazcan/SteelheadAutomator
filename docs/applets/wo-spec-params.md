# `wo-spec-params` — Reaplicar Parámetros en Órdenes de Trabajo

**Versión:** 0.1.0 (fase 1) · **Estado:** implementado en `workbench`, **sin deployar**, sin corrida de escritura real
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
| Lectura contra el ERP | ✅ verificada en vivo (solo lecturas) |
| **Corrida de escritura** | ❌ **pendiente** |
| Deploy | ❌ no deployado |

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

## Pendientes

1. **Corrida de escritura real** sobre la OT 5769 (bloquea el deploy).
2. **Fase 2 — origen por Número de Parte**: das los NP corregidos y busca sus OTs. Es la que
   cierra el problema de raíz.
3. **Fase 3 — escaneo de las 1000+ órdenes abiertas**: con 0.87 MB por consulta son ~1.3 GB, así
   que exige troceo, checkpoint reanudable en IndexedDB, monitor de memoria con guardrail al 88%
   (`host-cleanup-shared`) y pool de 3 — el `/graphql` se cuelga a ~40-45 peticiones en ráfaga,
   sin devolver 429, y tumba también la pantalla nativa.
4. **Decidir qué hacer con las anomalías del nodo raíz** (ver la hipótesis de arriba).
5. **Correr headless** las rutas de regeneración.
6. Bundle Safari/iPad: evaluar si aplica.

## Bitácora

### 0.1.0 — 2026-07-28 (implementación de la fase 1)

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
