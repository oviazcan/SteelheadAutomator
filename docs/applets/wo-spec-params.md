# `wo-spec-params` — Alinear OTs con su Número de Parte

> **Renombrado 2026-08-08.** Antes «Reaplicar Parámetros en Órdenes de Trabajo». El applet ya no
> solo reaplica parámetros: **corrige la spec de la orden y después sus parámetros, en una sola
> pasada**. La acción `sync-wo-specs` que existió unas horas ese día **se retiró del menú**: su
> trabajo vive dentro del flujo único.

## 2026-08-08 — consolidación + el falso negativo que proponía DUPLICAR

**Vivo en `config 1.11.113`.** Suite 111 archivos, 0 rojos.

### Lo que cambió, en una línea
Una sola acción — **🔧 Alinear OTs con su Número de Parte** — que hace dos fases por orden:
**(1)** arregla las specs desalineadas, **(2)** RE-LEE y revisa los parámetros sobre el estado ya
corregido. Al operador no le importa si el problema es una spec completa o un parámetro suelto;
la separación en dos botones era una costura nuestra.

### La re-lectura NO es opcional (es el hallazgo de la sesión)
**Al aplicar la spec nueva, el ERP coloca SOLO sus parámetros en el nodo que declara cada campo.**
Medido en la OT 13219: tras archivar `80065-DS-004` y aplicar `RC Ag`, las 5 casillas quedaron en
`T202-IC00-001 Inspeccionando y Empacando` con el valor del NP —**sin que nadie las moviera**— y
cero en el raíz (`ArchivePartNumberWorkOrderSpecAndParams` archiva también los parámetros).

Consecuencia de diseño: analizar los parámetros ANTES de arreglar la spec produce un plan sobre un
estado que va a dejar de existir, y propone escribir lo que el ERP ya puso.

### El falso negativo que afectaba a producción
`findExternalSpecs` exigía `partNumberSpecByPartNumberSpecId`. **El ERP NO pone ese vínculo** cuando
la spec se aplica con `ApplySpecsToPartNumbersAndWorkOrder` (lo que dispara «Agregar
Especificación»). Resultado: la spec quedaba bien aplicada pero el applet decía *«la orden no tiene
especificación externa»* y **proponía agregar las casillas que ya existían, apuntando al nodo
RAÍZ** — habría duplicado en toda orden ya sincronizada, justo las recién arregladas.

Ahora la señal es la **pertenencia**: si el NP tiene esa spec viva, es del cliente. Con el matiz que
el fixture real destapó — una spec puede llegar por el NP **y** por el tratamiento, y la del
tratamiento no es criterio del cliente: sin excluirla, la OT 10837 pasaba de 3 specs externas a 6.
Fail-safe: sin la lista de specs del NP, conducta idéntica a la anterior.

### El dedup que evitaba BORRAR una casilla
`allOpenWorkOrders` paginaba con `ID_DESC` **sin deduplicar**: en una corrida de ~40 min basta que
una orden cambie de estado para que dos páginas la devuelvan. Con `migrarAInspeccion` encendido la
segunda pasada **archiva lo que la primera creó**. Es el incidente de la OT 15928 — de 2,549
casillas movidas, las 2 que quedaron huecas eran las 2 únicas repetidas.

Tres capas de dedup por `(idInDomain, partNumberId)`: la cola, el checkpoint al escribirse y el
render. **Con esto cae la instrucción «arrancar de cero, no reanudar»: reanudar es seguro.**

### Las 4 operaciones de specs de OT — capturadas y con ruta
Ninguna existía en el config ni en 131 scans previos. Las 4 verificadas vigentes contra el ERP:

| Operación | Hash | Ruta de regeneración |
|---|---|---|
| `ArchivePartNumberWorkOrderSpecAndParams` | `003d319f…` | `workOrderSpecArchive` (ciclo reversible) |
| `UnarchivePartNumberWorkOrderSpecAndParams` | `0b3a3e1f…` | idem |
| `UnarchivePartNumberRecipeNodeSpecFieldParam` | `6d78669b…` | idem |
| `ApplySpecsToPartNumbersAndWorkOrder` | `b482d33a…` | `workOrderSpecAdd` (capture-abort) |

**Gotchas del shape, medidos:**
- **Desarchivar NO manda `archivedAt: null`** — repite el INSTANTE con el que se archivó. Se pasa
  tal cual viene de la lectura para no errarle por formato (`…Z` vs `…+00:00`, mismo instante).
- **Los parámetros viajan EN LA MISMA llamada** que la spec, con `recipeNodeId` explícito: agregar
  la spec y colocar cada campo es un acto atómico.
- **ARCHIVAR antes de AGREGAR, siempre.** Si la vieja y la nueva declaran los mismos specFields
  **chocan y el parámetro no se aplica** — y falla EN SILENCIO. El orden vive en el núcleo
  (`specSyncSteps`), no en el glue.
- **La spec que YA ESTUVO se DESARCHIVA; la que nunca estuvo se AGREGA.** Agregar una archivada la
  rechaza el ERP.
- **`drivenBy`** dice de dónde viene el parámetro (tratamiento o NP). Omitirlo lo deja como
  «Creación manual» y se pierde la trazabilidad.

### El candado que evita un desastre
`planSpecSync` solo toca specs con `partNumberSpecByPartNumberSpecId`. Una orden trae ~8 specs y
**solo UNA es del NP**; las otras vienen del TRATAMIENTO (Inspección Recibo, T202-LI, Preparación
de Embarque). Archivar «lo que no está en el NP» se llevaría la configuración de la línea entera.

### Alcance del frente (medido sobre el dominio, no muestreado)
- **568 órdenes abiertas · 2,389 casillas** con criterio de cliente en el nodo raíz, en **345 NP**.
- **315 de 348 NP cambiaron de spec** — el 90 % del universo pendiente.
- **El frente NP está limpio**: de 348 NP consultados al ERP, **1 solo** tiene parámetros forzados
  vivos (`80252-678-16`, 6 params). Las 1,825 filas forzadas del snapshot eran casi todas
  archivadas — `part_number_spec_field_param` no trae `archived_at`, así que ese conteo es un TECHO.
- La corrida del 4-ago tocó **725 órdenes** (rango real 12,369–17,557, **no** 13,819 como decía la
  bitácora) y **ninguna de las que tocó quedó mal**. Lo que faltó fue alcance: la fase 2 **no
  recuerda entre corridas** qué NP ya procesó.

### Estado de validación
| | |
|---|---|
| Núcleo (`planSpecSync`, `specSyncSteps`, `findExternalSpecs`) | ✅ 16 tests, incluido el fixture real de la OT 10837 |
| Glue (`analyzeSpecSync`, `applySpecSync`) | ✅ 6 tests con mocks |
| Dedup de hallazgos | ✅ 8 tests |
| Deploy | ✅ `config 1.11.113`, firma verificada EN VIVO |
| **Flujo consolidado contra el ERP** | ❌ **NUNCA se ha ejercido.** La 1ª corrida real está pendiente |

### Pendientes REALES (verificados al 2026-08-08)
1. **Ejercer el flujo consolidado en vivo.** Sugerido: **OT 5769** (su NP tiene 1 spec viva y 1
   archivada, y la orden aún conserva la vieja).
2. **Al agregar la spec se manda `parametersToAdd: []`.** Se apoya en que el ERP los coloca solo
   —comprobado en la 13219—, pero no se ha verificado en una orden cuyo nodo NO declare el campo.
3. **Los campos de sensor de tina no se llenan.** Su criterio vive en el TRATAMIENTO (eje 2b) y
   `buildCatalogIndex` solo mira las specs del NP. El operador confirmó que **sí deberían llenarse**.
4. **9 órdenes irresolubles por diseño**: más de un nodo de Inspección y Empaque (o ninguno). Requieren
   que Calidad decida a cuál va el criterio.
5. **42 casillas huecas en 26 órdenes abiertas** (criterio archivado y nunca repuesto); 5 órdenes
   abiertas sin NINGÚN criterio de cliente. Solo 2-3 son de la corrida del 4-ago: el resto es
   archivado manual.
6. **Auditoría de specFields declarados por nodo** — debe vivir EN LA EXTENSIÓN, no en consultas
   sueltas: los procesos siguen evolucionando y el hueco se reabre.


## 2026-08-07 — el caso que el applet NO cubre: **el NP cambió de spec**

Reporte del operador sobre la OT **13219** (NP `LIV30919378001A`): el applet omite `Espesor` con
*«el Número de Parte no define este campo y el catálogo ofrece 2 opciones»* — **y el NP sí trae el
dato** (`7.62 - 12.7 µm`, visto en la ficha).

### Por qué falla: el match es por `specFieldSpecId`, y ése cambia al migrar de spec

`buildPartNumberIndex` indexa los parámetros del NP **por `specFieldSpecId`** (la identidad de
*(spec, campo)*), y `resolveDesired` busca `pnIndex.get(c.specFieldSpecId)` con el id que trae el
**catálogo de la ORDEN**. Cuando el NP migra de spec, esos dos ids dejan de coincidir:

| Spec del NP `LIV30919378001A` | ¿viva en el NP? | `specFieldSpecId` de Espesor |
|---|---|---|
| **RC Ag (Plata)** | ✅ viva | **177260** ← aquí vive el parámetro del NP |
| 80065-DS-004 (Plata) | ❌ archivada | **104936** ← ésta es la que heredó la OT |
| ASTM B700 (Plata) | ❌ archivada | 171775 |

`pnIndex.get(104936)` no existe ⇒ sin hit ⇒ cae a la vía CATÁLOGO ⇒ 2 opciones ⇒ `AMBIGUO`.

**No es un caso raro: 315 de los 348 NP pendientes cambiaron de spec** (tienen vivas y archivadas).
Es el 90% del universo, y es justo el caso de uso del applet — *el NP se corrigió, la orden quedó
vieja*.

### El arreglo NO es casar el parámetro por campo

La tentación es buscar en el NP por `specFieldId` saltándose la spec. **Sería un parche que empeora
las cosas:** si la orden conserva `80065-DS-004` VIVA, el operador en piso sigue viendo la spec
retirada, ahora con un valor que no le corresponde. Peor que omitirla.

**El modelo correcto (aportado por el operador):** se **archiva la spec anterior** en la OT y se
**aplica la nueva**; los parámetros del NP se colocan solos *siempre que haya un campo en el proceso
que los tome* (el eje 1 del modelo de mediciones).

### Las dos operaciones que faltaban — CAPTURADAS 2026-08-07

Ninguna estaba en el config ni en 131 scans previos. Se capturaron haciendo el flujo a mano con el
hash-scanner y **las dos responden vigentes** (probadas aparte contra el ERP):

| Operación | Hash | Para qué |
|---|---|---|
| `ArchivePartNumberWorkOrderSpecAndParams` | `003d319f4ddc856f3c88aa2d1a31b8540a4e24dd02d350cb78916819178bdef6` | archivar la spec vieja de la OT |
| `ApplySpecsToPartNumbersAndWorkOrder` | `b482d33a758a040268d17d594eb91187b9261a1aa42febcfc02066ac55ce2383` | agregar la spec nueva **con sus parámetros** |

```jsonc
// ARCHIVAR — el id es el partNumberWorkOrderSpec, no el spec
{"partNumberWorkOrderSpecId": 5543787, "archivedAt": "2026-08-07T23:44:49.039Z"}

// AGREGAR — los parámetros viajan EN LA MISMA llamada, con su recipeNodeId ya resuelto
{"workOrderId": 1880048,
 "partNumberSpecsToApply": [{"partNumberId": 3028987,
   "specsToApply": [{"specId": 20902, "classificationSetId": null, "classificationIds": [],
     "parametersToAdd": [{"specFieldParamId": 33193234, "specFieldId": 15630,
                          "geometryTypeSpecFieldId": null, "locationId": null,
                          "recipeNodeId": 45934338}]}]}]}
```

**El ERP no arrastra los parámetros solo.** Van en el mismo payload, y con `recipeNodeId` explícito
— así que **agregar la spec y colocar cada campo en el nodo correcto es UN acto atómico**: el
problema del nodo raíz se resuelve ahí mismo, sin migrar nada después.

### Tres reglas duras del flujo (las tres del operador, y las tres muerden)

1. **ARCHIVAR primero, AGREGAR después.** Si las dos specs declaran los mismos specFields,
   **chocan y el parámetro no se aplica** — hay que reaplicarlo a mano. Es el mismo `23P01` que ya
   mordió en el frente NP (`assign-pending-params`, 2026-07-16).
2. **La spec que YA ESTUVO en la OT se DESARCHIVA; la que nunca estuvo se AGREGA.** *Agregar una que
   ya estaba y se archivó no se puede.* Verificado en la propia OT 13219, que tiene los dos casos a
   la vez: `T204-LI (16.1)` archivada (se desarchivaría) y `RC Ag (Plata)` ausente (se agrega).
3. **`drivenBy` dice DE DÓNDE viene el parámetro** — del tratamiento o del NP, que es lo que explica
   por qué quedó en la OT. **Omitirlo lo deja como «Creación manual»**, perdiendo la trazabilidad.

### Pendiente
Implementar el modo. **Los hashes NO se agregaron al `config.json` todavía**: entrarían sin ruta de
regeneración y subirían el trinquete de 51 a 53. Van junto con su entidad centinela, en el mismo
commit que el modo.


## 2026-08-05 — «la OT 6009 sigue con nodo raíz y ya corrimos la corrección dos veces»

Reporte del operador con captura: la OT **6009** (NP `PHA76627`, spec externa «RC Decapado»)
muestra sus dos campos con **Nodo de Receta = `T101 (DEC)-CU-BARE (4.0) #1`** — el nodo **raíz**.

**El applet no falló. La corrida nunca llegó a esa orden.** El barrido del 2026-08-04 recorre de
la orden más nueva hacia atrás y **se detuvo**; el corte es casi perfecto y se mide solo:

| Tramo | Movidas | Pendientes |
|---|---|---|
| `id_in_domain` ≥ **13 819** (lo que alcanzó a ver) | **700** | 11 |
| `id_in_domain` < 13 819 (nunca leído) | 12 | **553** |

La 6009 está en **6 009**: ~7 800 posiciones bajo el piso. Del dominio, **2 210 de las 6 061
órdenes activas** quedaron abajo de ese corte.

**Alcance vivo del daño (snapshot del 5 ago): 564 órdenes activas · 2 395 casillas** con criterio
de calidad del cliente colgando de un nodo `PROCESS`. **Cero solapamiento** con las 712 que la
corrida sí tocó — no dejó trabajo a medias, simplemente no las vio.

### La 6009 está SANA para corregirse — se verificó pieza por pieza

Importa porque las dos hipótesis naturales eran otras, y **el dato refutó las dos**:

| Hipótesis | Veredicto |
|---|---|
| «El proceso no tiene nodo de inspección» | ❌ lo tiene: `198905 T101-IC00-001`, declara 23 campos |
| «La orden copió una receta que aún no declaraba el campo» (como la 10837) | ❌ **su** nodo QA `42598561` **sí** declara 19445 y 22067 |
| «El NP tiene dos filas y el deseado sale `AMBIGUO`» | ❌ las forzadas (`processNodeId=244434`) están **archivadas desde el 30 jul**; queda una viva por campo, sin nodo forzado |

Con eso `findInspectionNode` da **exactamente un** candidato y `desired.via = NP` con `writeId`
válido ⇒ **`migrarAInspeccion` produciría `MIGRAR` sobre esta orden hoy mismo.** No hace falta
tocar código: hace falta **volver a barrer el tramo viejo**.

> **Por qué nacieron en el raíz:** los dos params se crearon `2026-06-05 11:54:06`, **el mismo
> instante que la orden**, heredando la fila del NP forzada a `244434` — que es exactamente su
> `default_process_node_id`. Es el bug de `bulk-upload` pre-`046ec5b`, ya diagnosticado abajo. El
> frente NP de este NP **ya se limpió** (30 jul); lo que quedó sin limpiar es la OT.

**Ruido a no confundir con la corrida:** la orden trae una tercera fila (`26890439`, Apariencia
Homogénea, en el nodo QA) **creada y archivada el 5 ago con 16 s de diferencia**, por un usuario
del cliente desde la UI. Es un intento manual, no del applet.

### Lección de método (dos, y las dos costaron)

1. **`TIMESTAMP '…-06:00'` en DuckDB DESCARTA el offset** y lo normaliza a UTC-naive: mi ventana
   se corrió 6 h y la corrida de 712 órdenes se leyó como **2**. La señal fue un número absurdo,
   no un error. Para comparar contra `TIMESTAMPTZ` hay que escribir **`TIMESTAMPTZ`**.
2. **`part_number_spec_field_param` NO trae `archived_at` en el snapshot de reportes.** Contar ahí
   el «frente NP» da **92 055 params forzados** cuando la mayoría están archivados. Ese frente
   **no se puede medir desde DuckDB** — hay que preguntarle al ERP (`GetPartNumber`).

### Qué hacer

1. **Re-correr el barrido con `migrarAInspeccion`, acotado a `id_in_domain < 13 819`** — son 2 210
   órdenes, de las que 564 tienen algo que mover.
2. **Arrancar de cero, no reanudar** (pendiente 2 de abajo sigue abierto: con el modo de mover
   encendido, un hallazgo duplicado **borra** una casilla — incidente OT 15928).
3. Al terminar, comparar **`archivados` vs `aplicados`**: la diferencia es el número exacto de
   casillas huecas.

## 2026-08-03 — 0.6.0: «las de GDE1214700 Antitarnish no se aplicaron» (OT 10837)

Reporte del operador: *"tengo en el tratamiento y además en el número de parte, así que chocan,
pero debía haberse aplicado al menos una de las dos y no se aplicó ninguna"*.
**✅ VIVO en config 1.11.51** (ver el bloque de estado al final; el «Sin deployar» que decía aquí
quedó obsoleto el 2026-08-03 y se corrigió al mergear `workbench`, commit `20a469a`).

### El choque era real y tenía efecto, pero no el que parecía

Sí llegan dos: la spec `GDE1214700 (Antitarnish)` (specId 18452) entra por el NP
(`partNumberSpec 1155160`) **y** por el tratamiento (`treatmentSpec 8293` → `TR-PRM-001
Antitarnish Manual`), con los mismos 3 campos. La primera hipótesis —que la duplicidad
bloqueaba la escritura— se **descartó con un control**: la OT 2472 también la trae doble y sí
aplicó.

Pero al reparar el caso apareció que el choque **sí** hacía daño, en otro punto:
`buildCatalogIndex` recorre las `partNumberWorkOrderSpecs` una por una, así que cada campo salía
con **dos candidatos idénticos** —el mismo `specFieldSpecId` 149308, los mismos parámetros— y
`resolveDesired` los contaba como dos opciones: `AMBIGUO, el catálogo ofrece 2 opciones`. No son
dos opciones; es la misma contada dos veces. **La dedup va por `specFieldSpecId`, NO por
specId**: dos specs *distintas* que declaren el mismo campo sí son alternativas reales y ahí el
`AMBIGUO` es la respuesta correcta (hay test que lo fija).

### La causa de fondo: la orden nació 5 días antes de que arreglaran la receta

| | OT 10837 / 10839 | OT 2472 (control) |
|---|---|---|
| Proceso | `T400 (ANT)-CU-VARIOS (20.0)` | `T300 (LES)-T205 (PLA)-T300 (ANT)…` |
| Nodo QA de Antitarnish | **declara 0, aplicados 0** | declara 5, aplicados 5 |
| processNode maestro | `268059` | `157804` |

Las órdenes se crearon el **2026-07-02 16:01**. El processNode `268059` nació el 2026-06-05 y se
**actualizó el 2026-07-07 22:48** — cinco días después; hoy declara los 3 campos igual que su
homónimo. Las órdenes copiaron la receta incompleta y **esa copia no se refresca**: es el
problema que este applet resuelve, un nivel más abajo — no quedaron viejos los parámetros, quedó
vieja la **declaración de campos del nodo**. Sin ella, los 3 parámetros del NP (que van sin nodo
forzado) quedaron FUERA por la regla de herencia del ERP.

Descartado en el camino: el `treatment_spec 7569` (`TR-ICA-006`) está archivado desde el
2026-02-09 y parecía explicarlo, pero **ambos** maestros cuelgan del mismo tratamiento `86895` y
uno funciona. El tratamiento no era la variable.

### Rescate por receta maestra

Cuando ningún nodo de la orden toca la spec externa, se consulta el `processNode` **maestro** del
que deriva cada nodo de calidad (`processNodeByDerivedFrom`) y se elige el nodo cuyo maestro
declara el campo. Es evidencia **estructural**, no un match por nombre, y **la regla de
exactamente-uno se mantiene**: con dos candidatos no se toca nada.

- `masterDeclaredFields(processNode)` — núcleo puro. El id viaja en `specFieldBySpecFieldId.id`;
  el campo plano `specFieldId` **no viene** en esa selección y leerlo de ahí daría un Set de
  `undefined`.
- `GetProcessNode` exige las **tres** variables (`id`, `processNodeOccurrence`, `rootId`): con
  menos responde error de variables faltantes, no datos parciales. `rootId` es el maestro del
  nodo `PROCESS` de la orden. **Ya tenía ruta de regeneración** en `route-catalog.json` → cero
  deuda nueva.
- Sólo se consulta si la orden dejó campos sin destino, en **serie**, y con caché por
  processNode: en un barrido todas las órdenes del mismo proceso comparten maestros. La caché se
  vacía **al empezar** cada corrida, no sólo al terminar — corregir la receta y volver a correr
  es el flujo esperado, y una caché viva devolvería el estado viejo.
- Si la receta no se puede leer, **no se adivina**: la orden se reporta sin destino, como antes.

### La validación que importa no es el conteo, es el contenido

Lo que el applet escribiría en la OT 10837 coincide **campo por campo** con lo que la orden de
control 2472 tiene aplicado — y eso quedó como golden test, no como comprobación de una vez:

```
20570 Protección - Sulfuro de sodio al 2.5%  → "Sí o No"
25415 Apariencia Homogénea - Antitarnish     → "Sí o No"
22546 Primeras Piezas Antitarnish            → "Sí o No (ambos pasan)"
```

Los tres al nodo `44947411`, `drivenBy` la entrada externa, y **cero archivados** (las casillas
estaban vacías, no equivocadas).

El test compara **nombres, no ids**, y la razón importa: el id que se escribe es la raíz del
parámetro del NP, que puede ser una revisión más nueva que la del catálogo de la orden
(`28878284` vs `17824087`, ambos «Sí o No»). El id vigente cambia; el criterio de calidad no.

### Validación en vivo (2026-08-03)
Corriendo el applet **publicado** (bajado de gh-pages, byte-idéntico a lo probado) contra el ERP:

```
versión viva 0.6.0 · rescate: true
OT 10837 · NP PHA20842
  tally     : OK 13 · VACIO 3 · AMBIGUO 0
  sin destino: 0            (antes: 3)
  nodo      : 44947411 «Inspeccionando y  Empacando Antitarnish»
  plan      : 0 archivar · 3 agregar
  consultas : 6             (5 de la orden + 1 de receta maestra)
```

Estable entre corridas. **Sólo lectura y decisión — la escritura no se ha ejecutado.**

**Error propio, corregido al validar en vivo (mismo día).** La primera versión de esto decía
que «la vía del NP no puede resolver porque sus parámetros vienen con
`specFieldSpecBySpecFieldSpecId: null`». **Es falso**, y era un artefacto del fixture: yo tomé el
NP de `partNumberById` **embebido en `GetPartNumberWorkOrderSpecsInfo`**, y ESA selección no trae
`specFieldSpec`. El applet no usa ése: pide `GetPartNumber`, que sí los trae poblados. Medido en
vivo el 2026-08-03:

```
GetPartNumber(3016541) → 28985361 specFieldSpec=149308 derivedFrom=28878284  "Sí o No"
                         28985362 specFieldSpec=166976 derivedFrom=28878286  "Sí o No"
                         28985363 specFieldSpec=149700 derivedFrom=17854562  "Sí o No (ambos pasan)"
```

Así que la OT 10837 resuelve **por vía NP**, no por catálogo, y escribe la **raíz de catálogo**
(`derivedFrom`) — la regla de los tres ids, funcionando. El fixture ya viene de `GetPartNumber` y
hay un test que falla si vuelve a ser indexable-vacío.

**La dedup del catálogo sigue siendo necesaria** aunque aquí gane el NP: es el respaldo cuando el
NP no define el campo, y sin ella ese respaldo devolvía `AMBIGUO` por conteo doble.

**Lección de método:** un fixture recortado a mano puede cambiar la respuesta sin fallar ningún
test — el mío hacía pasar los 68 y sostenía una conclusión equivocada sobre POR QUÉ fallaba el
caso. Lo destapó correr el applet **vivo** contra el ERP **vivo**, no la suite.

### El defecto que hacía todo esto invisible

`faltantesSinDestino` se calculaba desde 0.4.0 y **nunca se mostraba ni se contaba** — una sola
aparición en el glue, guardándola en el resultado. La orden reportaba `touched: 0` y era
**indistinguible de una orden sana**; en el barrido de fase 3, que sólo conserva el slim, la
señal se perdía por completo. Es el modo de falla que este repo ya pagó en `price-confirm-guard`
y `surtido-guard` 0.4.0: **«no tengo dónde ponerlo» se leía igual que «no hacía falta»**.

Corregido en los tres canales: `nSinDestino` en el slim, `sinDestino` en `summarize`, bloque
ámbar en el panel y renglón `SIN_DESTINO:<n>` en el CSV — este último importa porque una orden
sin destino **no genera renglones de cambios** y desaparecía del reporte justo siendo la que
necesita atención.

### Cobertura
Fixtures reales `wo-spec-params-10837.json` (la orden) y `wo-spec-params-masters.json` (los dos
processNode maestros). **Core 68/68, glue 45/45, suite 91 archivos 0 rojos.**

### El alcance, medido (ya no es un pendiente)

Escaneo de **las 428 órdenes activas anteriores al 4 de julio** con el applet publicado, sólo
lectura, 1 131 consultas, 0 fallos:

| | |
|---|---|
| sanas | **396** |
| las arregla el applet solo (rescate) | **12** |
| necesitan declarar el campo en la receta | **14** |

El dominio tiene hoy **5 428** órdenes activas (no 4 284), pero **más de 5 000 nacieron después**
de que se corrigieran las recetas: se muestrearon las 25 más recientes y salieron **25 sanas**.
Mapa de posición→fecha (`ID_DESC`): offset 0 = 3 ago · 1000 = 29 jul · 3000 = 17 jul · 5000 = 4 jul.
**Barrer el dominio completo trabajaría casi todo en balde**; el tramo que importa son las últimas
~428.

### Lo que el applet NO puede arreglar solo, y dónde se captura

Las 14 restantes necesitan que un humano declare el specField en la receta — el rescate sólo
funciona si el **maestro** lo declara. Concentradas en **5 nodos y 6 campos**:

| processNode | nodo | campos a declarar | OTs |
|---|---|---|---|
| 172393 | `T109-IC00-001 Inspeccionando y Empacando` | 16405, 33474, 32963 | 10075, 10076, 10204 |
| 171436 | `T106-IC00-001 Inspeccionando y Empacando` | 16405, 33474, 32963, 33222 | 8016, 9894-9896, 9916 |
| 187309 | `T201-IC00-001 Inspeccionando y Empacando` | 33579 | 7893, 8084, 8092, 8093 |
| 197146 | `T105-IC00-001 Inspeccionando y Empacando` | 33222 | 8017 |
| 169853 | `T205-IC00-001 Inspeccionando y Empacando` | 20561 | 7723 |

**Cuál de los tres nodos de calidad, resuelto con dato y no con criterio.** Cada proceso tiene
`Inspeccionando Recibo`, `Txxx-IC00-001 Inspeccionando y Empacando` e `Inspeccionando Calidad
Embarques`; el primer reporte los listaba **los tres**, lo que habría metido criterios del cliente
en recibo y embarque. Se resolvió midiendo dónde viven hoy los **campos hermanos** de esas specs
en todo el dominio: Estaño 4 950 filas, Zinc 4 950, Plata Mate 3 745 — **siempre en el nodo de la
línea**, nunca en recibo ni embarques. Los 6 campos de la tabla **nunca se han aplicado** en
ninguna orden (son nuevos), así que su nodo no se podía deducir de su propia historia.

Entregable para el operador: `plan-specfields.html` (self-contained, generado en scratchpad).

### Pendientes REALES
1. **La escritura del rescate nunca se ha ejecutado.** Todo lo validado es lectura + decisión.
   Antes de cualquier barrido: correr sobre **una** orden (la 7723, de un solo campo), **releer** y
   confirmar que la casilla quedó en el nodo de calidad — el ERP responde sin confirmar nada.
2. **Capturar los 6 campos** de la tabla de arriba antes del barrido, o esas 14 seguirán botándose.
3. Al aplicar en masa, revisar el resumen: un número repetido e idéntico de cambios por orden es la
   firma del error de la corrida de los 9 551.

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

**Versión:** 0.6.0 · **Estado:** ✅ **VIVO — config 1.11.51** (deployado por la sesión paralela; el script servido es byte-idéntico al validado). Lectura y decisión **verificadas en vivo**; **la ESCRITURA del rescate sigue sin ejecutarse ni una vez** · fase 1 validada end-to-end el 2026-07-28; fases 2 y 3 **sin corrida real**

> **Reconciliado el 2026-08-04 al mergear `workbench` (commit `20a469a`).** Este bloque venía de
> `workbench` y traía DOS afirmaciones que el merge dejó en falso:
> 1. **`config 1.11.52` → `1.11.51`.** Medido en los deploys de `gh-pages`: `1.11.50` (`60f67a6`)
>    publicó el núcleo, **`1.11.51` (`93b5d91`) el glue — último deploy que tocó este applet**, y
>    `1.11.52` (`9b8baa6`) fue `extensionVersion` 1.7.3 + el zip del **popup**, sin ningún script de
>    aquí. El `1.11.52` atribuía el applet al bump siguiente, de otra sesión.
> 2. **El modo `migrarAInspeccion` YA tuvo su 1ª corrida real** (2026-08-04, 672 órdenes, **2,551
>    casillas movidas**, 46/48 correctas en la validación en vivo, 2 huecas en la OT 15928 por el
>    único renglón con casillas repetidas). Ver la sección de esta misma bitácora; decir «sin
>    corrida real» habría hecho que la próxima sesión repitiera el análisis ya hecho.
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

## 2026-08-04 — primera corrida real de `migrarAInspeccion`: 2,551 movidas y 2 casillas huecas

El operador corrió el barrido con el check de mover encendido y **aplicó**: 2,551 casillas
`MIGRAR` en 672 órdenes, 430 NPs. Es la primera vez que ese modo se ejerce contra el ERP.

**El movimiento es de UBICACIÓN, no de contenido**: los 2,551 renglones traen `tenia == quedara`
(medido: 100%, cero excepciones). No cambia ningún criterio de calidad, solo dónde vive.

### Validación en vivo — 15 órdenes, 13 líneas, 46 de 48 casillas correctas

Muestra deliberadamente diversa (T101, T102, T104, T105, T108, T109, T110, T112, T114, T201,
T202, T204, T301; estaño, plata, zinc, níquel, níquel electroless, iridizado, fosfato de
manganeso, lavado, decapado), consultada contra el ERP después de aplicar. **14 de 15 órdenes
quedaron perfectas**: una sola fila viva, en el nodo de Inspección y Empaque, mismo valor.

### El fallo: la OT 15928 perdió dos criterios de calidad

```
Primeras Piezas      · T104 (EST)-CU/BR-VARIOS (6.0) · archivada 2026-08-04T17:20:58Z
Apariencia Homogénea · T104 (EST)-CU/BR-VARIOS (6.0) · archivada 2026-08-04T17:20:58Z
→ ninguna fila viva en el destino T104-IC00-001 Inspeccionando y Empacando
```

Ese timestamp es la corrida (11:20:58 del centro, seis minutos antes de descargar el reporte).
La orden tiene 72 filas de params, **68 vivas**: solo esas dos quedaron huecas. **El archivado
se ejecutó y el alta no** — exactamente el modo de falla que el orden archiva-primero deja
abierto. El código protege el caso inverso (si falla el archivado no agrega); éste no.

### Causa: la casilla se planificó DOS veces

**La 15928 es la única orden del reporte con casillas repetidas.** De 2,549 casillas `MIGRAR`,
**2,547 aparecen una sola vez**; las 2 que aparecen **dos veces** son justamente las dos que
quedaron huecas. La correlación es exacta y única en todo el universo del barrido.

Una casilla planificada dos veces se ejecuta dos veces: la primera pasada archiva el origen y
crea la fila en el destino; la segunda, con el plan viejo, **archiva lo que la primera acababa
de crear** —o su alta choca con la restricción de unicidad—. En ambos caminos la casilla termina
vacía.

El duplicado sale de **reanudar** el barrido: `mergeCheckpoint` mezcla el avance guardado con lo
que se vuelve a procesar y una orden puede quedar dos veces en `hallazgos`. La 15928 tiene **un
solo `partNumberId`** (3798757), así que no es el reparto multi-PN.

> **LECCIÓN: un renglón repetido en el reporte deja de ser cosmético en cuanto el modo ESCRIBE
> borrando.** Sin `migrarAInspeccion` un hallazgo duplicado solo agrega dos veces lo mismo y el
> segundo intento choca sin consecuencia. Con el modo encendido, el segundo intento **archiva lo
> que el primero creó**: el duplicado pasa de ruido a pérdida de dato. La deduplicación de
> `hallazgos` por `(idInDomain, partNumberId)` deja de ser higiene y se vuelve un requisito.

### El reporte escondía justo lo que hacía falta ver

**El CSV no exporta `fueraDeInspeccion`.** `downloadScanCsv` solo itera `h.cambios`, así que las
casillas externas que viven fuera del nodo de inspección —las candidatas a `MIGRAR`— **son
invisibles en el reporte mientras el check esté apagado**. Los 2,551 movimientos no aparecían por
ningún lado en el escaneo de la noche anterior.

**Y `anomalies` está muerta a propósito** desde que el universo EXTERNA cubre todos sus campos
vivan donde vivan (lo dice el comentario del core). El CSV **sí** emite su renglón, que por eso
sale siempre en cero. Un análisis que use `nAnomalias` como proxy de «¿hay algo fuera de lugar?»
concluye **que no hay nada que mover** — y se equivoca por 2,551. Pasó en esta misma sesión.

**Las omitidas tampoco viajan.** El panel dice *«… y N más (van en el CSV)»* para `plan.skipped`
(`AMBIGUO` / `SIN_CATALOGO`), pero `downloadScanCsv` no las escribe. El mensaje promete algo que
el archivo no cumple.

### Cómo se encuentra el resto del daño

No hace falta extrapolar de una muestra: la pantalla final imprime **`X parámetros archivados ·
Y aplicados`**. Si **`Y < X`**, la diferencia **es** el número exacto de casillas huecas de la
corrida. Ese contador ya existe y es la medición buena.

Reparar es barato: una casilla hueca sale como `VACIO` en el siguiente escaneo y se repone sola.

## Pendientes

1. **Corridas reales de las fases 2 y 3** (la 1 ya está validada).
2. **Dedup de `hallazgos` en `mergeCheckpoint`** por `(idInDomain, partNumberId)` — con
   `migrarAInspeccion` un duplicado **borra un dato** (incidente OT 15928, arriba). Mientras no
   exista: **arrancar de cero, no reanudar**, cuando el check de mover esté encendido.
3. **Exportar al CSV `fueraDeInspeccion` y `plan.skipped`.** Hoy el reporte omite las candidatas
   a `MIGRAR` y las omitidas, y el panel promete estas últimas.
4. **Reparar la OT 15928** (2 casillas) y las que revele la cuenta `archivados` vs `aplicados`.
5. **Decidir qué hacer con las anomalías del nodo raíz** (ver la hipótesis de arriba).
6. **Correr headless** las rutas de regeneración.
7. Bundle Safari/iPad: evaluar si aplica.

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
