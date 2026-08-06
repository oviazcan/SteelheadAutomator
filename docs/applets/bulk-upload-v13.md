# Bulk-Upload — Plantilla Carga Masiva v13 (5 rack types + Instrucciones de Empaque)

**Fecha:** 2026-08-03 · **Estado:** ✅ **VIVO en producción — config 1.11.63, tag `v1.11.63`**
(parser, escritura y ambas plantillas publicadas y verificadas) · 🔴 **sin corrida real contra el ERP**
**Relacionado:** [`bulk-upload.md`](bulk-upload.md) (bitácora principal) · [`bulk-upload-v12.md`](bulk-upload-v12.md) (contrato v12)
**Guía para el usuario:** [`../training/guia-plantilla-v13.html`](../training/guia-plantilla-v13.html)
(la que se difunde al equipo; se **genera** con `tools/build-guia-v13.js` leyendo el `.xlsm` real —
al cambiar la plantilla se re-corre, no se edita el HTML) ·
nota técnica: [`../plantilla-carga-masiva-v13.html`](../plantilla-carga-masiva-v13.html)

## Qué trae v13

Dos cambios, ambos **después** de los racks, así que corren lo posterior:

1. **5 rack types por PN** (antes 2) ⇒ **+6** desde los racks.
2. **Columna "Instrucciones de Empaque"** entre los predictivos y Notas adicionales ⇒ **+1** más.

| | v12 | v13 |
|---|---|---|
| Columnas visibles (hoja `Upload`) | 60 | **67** |
| Columnas canónicas (CSV) | 73 | **80** |
| Pares de rack | 2 (canónicas 47/49) | **5 (47, 49, 51, 53, 55)** |
| Tipo de Geometría | 51 | **57** |
| Predictivos | 57–65 | **63–71** |
| **Instrucciones de Empaque** | — | **72** |
| Notas adicionales | 66 | **73** |
| Piezas por Carga … Tiempo de Entrega | 70–72 | **77–79** |

Los headers de rack van **numerados** (`Rack Flybar o Barril 1..5`), decisión del usuario por
consistencia con el resto de la hoja. Al ser únicos, el `AddOut` del VBA ya no les agrega sufijo
—a diferencia de v12, donde los headers repetidos generaban el `" 2"`—. El parser no se entera:
mapea por **posición** y sólo usa los nombres para **detectar la versión**.

**Detalle que salvó la detección:** el conteo usa `/^rack\b/i` **anclado al inicio**. Las columnas
de cantidad se llaman `Pzas/Rack Línea N`: contienen "Rack" pero no empiezan con él. Con `/rack/i`
sin ancla el conteo habría dado **10** y la versión se habría detectado **por accidente** —
correcto por la razón equivocada, que es la clase de acierto que deja de funcionar al primer
cambio de nombre. Fijado por test.

**Por qué 5 racks:** las piezas por carga son **por línea** — el PN 3015610 va 4 en `T204-FL01`
y 1 en `T205-FL01` (ver [`wo-schedule-button.md`](wo-schedule-button.md) 0.8.0).

## Parte 1 — Racks (5 slots)

### `racks` generalizado a N slots

Antes `rackLinea: [41,42], rackSec: [43,44]` + dos ramas fijas. Ahora es un array de pares,
**el mismo patrón que ya usaban `specs` y `prods`**, aplicado también a v10/v11/v12 ⇒ una sola
ruta de código para las cuatro versiones. Agregar slots es alargar el array.

### `ExportarCSV` NO se toca; `Module5` SÍ

`Module1.ExportarCSV` §3 es **header-driven**: emite las columnas de la fila 7 tal cual y
desambigua repetidos con `AddOut`. Igual `Module2`, `Module4` y `Hoja1.cls` (columnas < 39).

`Module5` (`LimpiarDatos`/`LimpiarEspacios`) direcciona por **índice numérico** y no se ajusta al
insertar columnas. Extraído con `olevba -c`:

| Código v17 | Consecuencia si no se corrige |
|---|---|
| `For c = 1 To 60` (×3) | **6 columnas nunca se limpian** → datos de la carga anterior se re-suben. **El peor: no se ve.** |
| `phHybridCols = Array(8, 15, 39)` | El `39` era Geometría; en v13 es **Rack 3** → placeholder dentro de una columna de rack |
| `phCols = Array(…, 35, 37)` | Los 3 racks nuevos sin `(seleccione)` |

Corregido en **[`vbas/Module5_v19.bas`](../../vbas/Module5_v19.bas)** ← **el vigente**.

**Lección: cuando un layout posicional se ensancha, el riesgo no está sólo en el parser que LEE
— está en toda macro que direccione por índice. La que exporta se salvó por ser header-driven;
la que LIMPIA no, y su falla es invisible porque deja la plantilla viéndose limpia.**

### El v18 se quedó corto por una columna — y por eso ahora hay trinquete

El `Module5_v18` se escribió para **66** columnas, cuando la v13 todavía era "5 racks". La
columna *Instrucciones de Empaque* entró **después**, dejando la hoja en **67**, así que el v18
—ya pegado en las plantillas— dejaba **`Tiempo de Entrega` sin limpiar**: el valor de la carga
anterior sobrevivía a *Limpiar Datos* y se re-subía. Los índices de placeholders NO se vieron
afectados (todos ≤ 45, o sea antes de la columna nueva). Corregido en **v19** (topes a 67).

**La lección de fondo no es el número, es que este módulo se rompe cada vez que la hoja cambia
de ancho y lo hace en silencio.** Por eso el tope dejó de ser un dato en la cabeza de alguien y
pasó a estar **atado a la plantilla real**: `tools/test/module5-column-cap.test.js` mide el
ancho de la hoja `Upload` y lo compara contra los `For c = 1 To N` del VBA vigente. **Verificado
que muerde**: apuntado al v18 falla con *"recorre hasta 66 pero la plantilla tiene 67 columnas
visibles: las columnas 67..67 nunca se limpiarían"*. Además fija que las dos plantillas v13
tengan el mismo ancho, que los índices de `phCols`/`phHybridCols`/`boolCols` caigan en rango, y
que el índice de *Tipo de Geometría* siga siendo el que el VBA cree —el caso exacto que rompió
al pasar de v12 a v13, cuando los racks la empujaron de 39 a 45—.

> Al liberar un `Module5_vNN` nuevo hay que actualizar la ruta en ese test, en el mismo commit.

## Parte 2 — Instrucciones de Empaque

### NO es un campo del PN

Es una **`ProcessNodeDescription`**: la descripción de la tupla *(PN, nodo de proceso)*. Es la
primera columna de la plantilla que escribe **fuera** del PN, contra el árbol de procesos.

**Tres entidades que no hay que confundir — la de en medio es la peligrosa:**

| Entidad | Alcance |
|---|---|
| `partNumber.descriptionMarkdown` | descripción del PN. Otra cosa |
| `processNode.descriptionMarkdown` | descripción **GLOBAL** del nodo, **compartida por todos los PNs del dominio** |
| `ProcessNodeDescription` (PN + nodo) | ← la que escribimos |

Hoy la global del nodo destino trae el aviso rojo *"No olvidar empacar conforme a requerimientos
del cliente y registrar el peso de las piezas…"*. **Eso resolvió la ambigüedad del nombre**: la
columna dice "Empaque" y el nodo se llama "Preparando **Embarque** en Almacén", pero ese nodo *es*
donde se empaca. Evidencia del propio ERP, no interpretación.

### Mutation (capturada en vivo)

`SaveManyPartNumberProcessNodeDescriptionsAndFiles` — hash `22bb7738…`, capturada con el
hash-scanner sobre el PN 3887933 / nodo 154303 y reproducida **byte a byte** en test:

```json
{"input":{"partNumberId":3887933,"processNodeDescriptions":[{
  "processNodeId":154303,"processNodeOccurrence":1,"otherOccurrences":[],
  "descriptionMarkdown":"…","cascadeToOccurrences":false,"cascadeToRecipeNodes":false}]}}
```

`cascade*` en `false`: la instrucción es de ESE PN en ESE nodo; propagar tocaría otras
ocurrencias o recetas que nadie pidió.

### El nodo se liga por NOMBRE, no por id

**Requisito del usuario, y es correcto:** los ids son **por dominio** (los centinelas viven en
TLC/344; MTY es otro dominio). Un id fijo funcionaría en TLC y escribiría en el nodo equivocado
—o en ninguno— en MTY. El nombre vive en `config.steelhead.domain.bulkUpload.packingInstructions.nodeName`.

**Match exacto (normalizado) y exactamente UNA coincidencia.** Medido sobre el árbol real: hay
**7 nodos cuyo nombre incluye "Embarque"** (`SP Preparación de Embarque en Almacén`, `Listo para
Preparar Embarque en Almacén`, `SP Embarque en Almacén`, …). Un match por subcadena elegiría
cualquiera; ante 0 o >1 **no se adivina**: se reporta y el PN se salta. Misma regla que
`wo-spec-params` usa para el nodo de inspección.

La normalización quita acentos, colapsa espacios y baja a minúsculas porque los nombres los
teclean humanos — en el árbol real convive `Inspeccionando y  Empacando` con **doble espacio**.

### El DOM lo confirma (captura del operador, 2026-08-03)

La sección en la ficha del PN se ancla por **`data-steelhead-component-id="PART_NUMBER_PAGE_PART_NUMBER_INSTRUCTIONS"`**
— ancla **estructural**, idioma-independiente, nivel 1 de la jerarquía del repo. Su encabezado reza:

> Instrucciones del Número de Parte en «Preparando Embarque en Almacén» **#1**

Eso confirma tres cosas de una: (a) la descripción es **del número de parte**, no la global del
nodo; (b) el **`#N` es `processNodeOccurrence`**; (c) el nodo destino es el correcto. Dentro del
span hay un `MuiIconButton` con el path del **lápiz** de MUI: ése abre el diálogo (que hidrata
`ProcessNodeDescriptionDialogData`). El cuerpo **renderiza markdown** — el `**Embarque**` del
payload sale como `<strong>`, lo que confirma que el texto del Excel se guarda crudo.

**Límite conocido:** el `#1` implica que un nodo puede repetirse en una receta. `buildPackingPayload`
escribe siempre en la **ocurrencia 1** (`otherOccurrences: []`, sin cascada). En el árbol medido
el nodo aparece una sola vez; si alguna receta lo repitiera, las ocurrencias 2+ quedarían sin
instrucciones. Es un supuesto declarado, no un descuido.

### Lectura del árbol: cero hashes nuevos

El nodo es **compartido** (`isShared: true` en los 60 del árbol; el usuario lo confirmó). Se
resuelve con **`GetProcessNode({id, processNodeOccurrence, rootId})`** —que ya está en config,
ya está en producción y **ya tiene ruta de regeneración**— y se **cachea por proceso**: 1–2
lecturas por corrida, no una por PN. Se cachea por proceso y no global para que una receta que
no tenga el nodo se **reporte** en vez de heredar el id de otra.

### Semántica de la celda

| Celda | Acción | Qué se manda |
|---|---|---|
| vacía | `skip` | nada (el PN conserva lo suyo) |
| `-` | `clear` | `descriptionMarkdown: ""` (no hay mutation de borrado) |
| texto | `set` | el texto **crudo** (el campo es markdown y ya convive con HTML inline) |

**`skip` ≠ `clear` es el par crítico:** si "vacío" produjera `''` en vez de `null`, cada carga con
la columna en blanco **borraría** las instrucciones de todos los PNs de la corrida, en silencio.
Fijado por test.

Sólo `-` exacto es sentinel: `--`, `—` y `- ver anexo` son texto.

### `partHasEnrichLine` cuenta la columna

Sin esa señal, una corrida de precio + instrucciones sobre PNs existentes se clasificaría
**`SOLO_PRECIO`** y el preview anunciaría "sólo precios" mientras el STEP 7c reescribe
instrucciones — **el mismo molde del bug 1.5.42**, donde una columna mal contabilizada dejó la
clasificación mintiendo sobre lo que la corrida hace.

### Costo

El input lleva `partNumberId` **singular** ⇒ **no batchea PNs**: 1 llamada por PN con dato, con
`runPool` (concurrencia 4, configurable). En 8 000 PNs son 8 000 llamadas y este applet ya cargó
con `HTTP 429`.

## Verificación (evidencia, no plausibilidad)

### `tools/verify-template-layout.js`

Abre el `.xlsm`, **simula `ExportarCSV` §3**, mete **un valor sonda por columna** y lo pasa por el
**parser real** en un `vm`. Corridas:

| Plantilla | Resultado |
|---|---|
| `Plantilla_CargaMasiva_v13.xlsm` (la del usuario) | `v13` · 67 visibles → **80** · 5 racks · empaque y notas OK · **10/10 ✓** |
| `…v13_compatibilidad.xlsm` (Excel 2019) | idéntica · **10/10 ✓** |
| `Plantilla_CargaMasiva_v12.xlsm` | `v12` · 73 · 2 racks · empaque `null` · **10/10 ✓** (sin regresión) |

El verificador **caza el corrimiento**: cuando la columna nueva apareció, marcó
`ancho del header canónico: 80 ← esperaba 79` con todo lo demás en verde.
**Lo que NO cubre:** que las columnas nuevas tengan su lista desplegable — eso se ve en Excel.

### Tests (suite 94 archivos, 0 rojos)

- `bulk-upload-v13-parse.test.js` (**10**): mapeo de las 80 columnas · slots de rack vacíos ·
  rack sin cantidad · sentinel de racks · v12 no se confunde con v13 · red de seguridad por ancho ·
  los 3 estados de empaque · **header angosto de 79** · v10/v11/v12 con empaque `null` · v11/v10 intactos.
- `bulk-upload-packing.test.js` (**15**): contra el **árbol real de 63 nodos** (fixture) —
  `skip`≠`clear`, match exacto vs los 7 "Embarque", ambigüedad, repetición del mismo id,
  acentos/espacios, payload byte a byte.
- `bulk-upload-packing-wired.test.js` (**9**): el contrato entre config, módulo, centinela y glue.
- `template-layout-real.test.js` (**9**): ata **las plantillas del repo** al parser — no basta
  con que el verificador manual pase, el layout es parte del contrato y debe romper la suite si
  cambia. Cubre los 5 slots numerados con nombre y cantidad distintos por slot (caza cruces de
  pares), que `Pzas/Rack` no infle el conteo, que Empaque y Notas —vecinas— no se intercambien,
  y que la v12 siga siendo v12.
- `module5-column-cap.test.js` (**4**): el tope del VBA contra el ancho real de la hoja.
- `hash-regen-coverage.test.js`: el trinquete subió a **60** al agregar la mutation y volvió a
  **59** con su centinela — hizo exactamente su trabajo.

### Detección de versión: dos señales

v12 y v13 comparten `E="Id SH"` y 4 specs ⇒ el discriminante son los racks. Confundirlos **no da
error visible**: saca los predictivos de las columnas de dims. Basta que UNA acierte:
`countRackHeaders ≥ 3` **ó** `ancho ≥ 80`.

**Caso real cubierto:** la plantilla se armó en dos pasos (racks primero, columna de empaque
después). Un header de 79 con 5 racks **no es "v13 al que le falta una columna"** — todo lo
posterior corre −1 — así que se mapea el layout de 79 completo y se apaga la columna, en vez de
leer Notas como instrucciones.

## Datos de la plantilla (medidos)

- Hoja `Upload` = `xl/worksheets/sheet1.xml`. Header fila **7**, datos desde la **9**.
- **7 504 fórmulas** en 15 columnas; **4 500 son de predictivos**, todas **después** de los racks.
- Las columnas de rack **tienen dropdown**, declarado en `extLst` (no en `dataValidations`):
  `sqref = AI9:AI508 AK9:AK508`, lista `OFFSET(Listas!$F$2,…)`. **Por eso se COPIAN, no se crean
  en blanco.**
- Por eso el `.xlsm` no se genera por XML: habría que reescribir esas fórmulas, `calcChain.xml`
  (375 KB), validaciones, tabla, comentarios y referencias cruzadas de `CAT_*` / `Cálculo MP`.

## Publicación (2026-08-03) — VIVO en 1.11.63

`tools/deploy.sh` desde el worktree de `main`. Invariante confirmado con `deploy-status.sh`:
**main = gh-pages = EN VIVO = 1.11.63**, tag `v1.11.63`, firma KMS verificada en vivo.
Comprobado por HTTP contra el sitio publicado, no sólo en git:

| Recurso | |
|---|---|
| `templates/Plantilla_CargaMasiva_v13.xlsm` | HTTP 200 · 601 291 B · **md5 idéntico** al validado |
| `templates/…v13_compatibilidad.xlsm` | HTTP 200 · 719 012 B |
| `scripts/bulk-upload-packing.js` | HTTP 200 · 6 518 B |
| `config.json` vivo | mutation ✓ · `nodeName` ✓ · `templateUrl` v13 ✓ · botones v13 ✓ |

La plantilla se **bajó del sitio** y se le pasó el verificador: layout correcto. Lo que el
operador descarga es exactamente lo validado.

### Tres cosas del deploy que conviene no volver a aprender

1. **`workbench` estaba 47 commits atrás de `main`** (config 1.11.47 vs 1.11.62). Deployar
   desde ahí habría **revertido 15 versiones de trabajo ajeno** (`invoice-autofill`,
   `cfdi-attacher`, `proceso-calculator`, `report-regen` 0.3.5, `config.sig`, `extension/`).
   El merge completo daba conflictos en código de producción ajeno a la tarea ⇒ se **abortó** y
   se fue por **cherry-pick quirúrgico**, tras medir que `main` **no había tocado ningún archivo
   de bulk-upload** (los 5 scripts idénticos). Verificación del config resultante: 122 queries y
   75 mutations de main **intactas**, +1 mía, **nada perdido**.
   **Regla: antes de deployar desde un worktree, comparar su `config.version` contra `main`.**
2. **Los `.xlsm` de `templates/` NO los deploya `deploy.sh`** (hace `git add scripts config.json`).
   Se subieron en un commit propio **antes** del config, para no dejar una ventana con el botón
   apuntando a un archivo inexistente. **El `pre-push` rebotó ese push**: valida el espejo
   `gh-pages == main:remote/` **antes** de mirar si es "solo-docs", y gh-pages aún no tenía
   `bulk-upload-packing.js`. La salida: dejar el commit local y que `deploy.sh` empuje ambos
   juntos, con la punta ya espejando main.
3. El hook exime del bump sólo a los push que **no tocan** `config.json` ni `scripts/`.

## Desfases de TEXTO VISIBLE — detectados y CORREGIDOS (2026-08-05)

Ninguno rompía la carga, pero los tres **le mentían al operador sobre qué versión estaba usando**,
que es justo lo que uno consulta cuando algo sale raro. Los tres se arreglaron **quitando el número
escrito a mano**, que es la causa común: un literal se desfasa en el siguiente cambio de layout.

| Dónde | Decía | Ahora |
|---|---|---|
| `Module1.ExportarCSV`, MsgBox final | `"CSV v12 exportado:"` | `TplVer(ws)` lo **lee del título de la hoja** (`A2`), la misma cadena que el operador ve. Sin versión en el título, la omite |
| `bulk-upload.js`, título del panel | `Steelhead Automator v10 — …` | `Carga Masiva · plantilla ${tplLabel}` con la versión que el parser **DETECTÓ** (`schemaVersion`). Sin dato muestra `?`, y con mezcla, `v12/v13 ⚠️` |
| Hoja **`Ayuda`** de AMBOS `.xlsm` | el layout **v10** completo (69 columnas `A–BQ`, racks ×2 en `AP–AS`, "Etiqueta 5") | regenerada **leyendo la hoja Upload del propio archivo** con [`tools/rebuild-ayuda-sheet.js`](../../tools/rebuild-ayuda-sheet.js) |

La hoja `Ayuda` era la más dañina de las tres: **no era un rótulo, era un mapa de columnas
equivocado** dentro del archivo que el operador tiene abierto. Quien la siguiera capturaba corrido.

**El del panel dejó de ser un rótulo y pasó a ser información:** el título ahora contesta *«¿con qué
layout se leyó mi archivo?»*, que es la pregunta que uno se hace al ver datos corridos — antes
contestaba siempre lo mismo. La guía lo usa como la comprobación rápida antes de ejecutar.

### ⛔ Reescribir la hoja por XML NO funciona: Excel rechaza el archivo

**Excel abre los `.xlsm` así producidos con *"Encontramos un problema con contenido de
'Plantilla_CargaMasiva_v13_compatibilidad.xlsm'. ¿Deseas que intentemos recuperar el máximo de
contenido posible?"*.** Producción se revirtió a los `.xlsm` que el usuario editó a mano.

**La causa fue tocar algo FUERA de `<sheetData>`, que era lo único que había que tocar.** El
original trae `<pane ySplit="1" topLeftCell="A39" …/>` y el script lo llevaba a `topLeftCell="A1"`
"por cortesía", para no dejar la hoja abierta a media página. Con **una fila congelada el panel
inferior no puede empezar en A1**: la incoherencia basta para que Excel declare el libro dañado.
De paso quedaba un `<selection activeCell="A152"/>` apuntando fuera del nuevo `dimension` (136).

**La lección que importa no es el atributo, es qué probaba cada verificación.** Se comprobó que el
zip estaba íntegro, que el XML parseaba, que `vbaProject.bin` seguía byte a byte, que sólo cambiaba
1 entrada de 33 y que `verify-template-layout` daba 10/10 — y **las seis pasaron mientras el archivo
estaba roto**. Ninguna responde *«¿Excel lo acepta?»*; sólo responden *«¿el zip y el XML son
coherentes con lo que YO esperaba?»*. El único juez del formato de Excel es Excel. Que la única
prueba que faltaba fuera justo la que no podía correr desde el repo **no la vuelve opcional**: la
convierte en el paso que bloquea la publicación, no en una nota al pie.

**Vía vigente: `--text`.** [`tools/rebuild-ayuda-sheet.js`](../../tools/rebuild-ayuda-sheet.js)
`<archivo> --text` emite el contenido —generado igual, leyendo la hoja `Upload` real— para pegarlo a
mano en la columna A. No toca el empaquetado, así que no puede romperlo. La escritura directa quedó
corregida (ya no toca el `<pane>`) pero **marcada como no validada contra Excel** en el encabezado
del script.

### Cómo se genera el contenido (esta parte sí sirve)

El repo tiene la regla de que **el `.xlsm` no se genera por XML** (habría que reescribir 7 504
fórmulas, `calcChain.xml`, validaciones y referencias cruzadas). Esto NO es eso: se reescribe **una
sola entrada del zip** —`xl/worksheets/sheet4.xml`, una hoja de una columna sin fórmulas— con
`zip <archivo> <entrada>`, que actualiza esa entrada y deja el resto tal cual.

Se verificó en ambas plantillas: **1 entrada modificada** de 33, `vbaProject.bin` **idéntico byte a
byte**, `3× For c = 1 To 67` del `Module5_v19` intacto, las 4 macros presentes, el XML válido y
`tools/verify-template-layout.js` en **10/10** — y aun así Excel las rechazaba (ver arriba). Los textos van
como `inlineStr` con `xml:space="preserve"` — así no hay que reindexar `sharedStrings.xml` y la
sangría, que ES el formato de esa hoja, no se pierde. Los estilos se reusan de `styles.xml`
(`s=1` título, `s=3` sección, `s=4` contenido, `s=5` nota); el formato anterior estaba aplicado sin
patrón —líneas equivalentes con `s=2`, `s=3` y `s=4` mezclados—, así que era ruido, no semántica.

### Cerrado en producción (2026-08-05)

Las dos plantillas publicadas llevan **las tres correcciones juntas** — `Module1 v15.5` (pegado a
mano en Excel: `vbaProject.bin` es OLE binario y no se puede escribir desde el repo) + la hoja
`Ayuda` regenerada. Verificado **bajando los archivos del sitio**: `md5` idéntico al local,
`"Varios clientes"` en el código, `MsgBox "CSV " & TplVer(ws)`, `3× For c = 1 To 67`, cero rastro
del layout v10 en la Ayuda y `verify-template-layout` en 10/10. Deploy `v1.11.84` para el título
del panel.

**El paso en falso que hay que no repetir: cada copia traía la MITAD del arreglo.** Se publicaron
`.xlsm` con la Ayuda corregida y el VBA viejo, mientras los que el usuario editaba venían de una
descarga previa —VBA nuevo, Ayuda vieja—. Ninguna de las dos copias estaba completa y las dos se
veían "arregladas" desde su propio lado. La salida fue **tomar como base el archivo del usuario**
(el único con el VBA bueno, que es lo irreproducible) y reinsertarle la Ayuda encima, no al revés.
Regla: **cuando un artefacto se edita por dos vías —una a mano y otra por script— la base es
siempre la que NO se puede regenerar.**

**Y la lección de método por tercera vez en el día:** para comprobar si el bloqueo de multi-cliente
seguía vivo se buscó la frase `"UN SOLO cliente"` en el VBA — y dio positivo **en el comentario que
documenta que se quitó**. El mismo patrón que con los regex de self-closing: *buscar el síntoma en
vez de la cosa*. La comprobación correcta ignora los comentarios (`grep -vE "^\s*'"`) y busca la
estructura viva (`"Varios clientes"`).

## Multi-cliente en `COTIZACIÓN+NP`: la plantilla vetaba lo que el applet sí sabe hacer

**RESUELTO 2026-08-05 — decisión del usuario: multi-cliente se queda.**

`ExportarCSV` **bloqueaba** la exportación con más de un cliente (*"requiere UN SOLO cliente;
encontré N. Usa SOLO_PN para varios"*), mientras el applet **sí** crea una cotización por cliente
—nombrada `{Cliente} {Layout}`— desde hace varias versiones, el preview lo muestra
(`Clientes: N (1 cot c/u)`) y la hoja `Ayuda` lo anuncia como característica. Ganaba la plantilla:
**una capacidad viva, inalcanzable desde el flujo normal.**

Se cambió el `Exit Sub` por una **confirmación** `vbYesNo` que dice cuántas cotizaciones se van a
crear — mismo patrón que el aviso de `SOLO_PN > 2000` que ya vivía dos bloques más abajo. Un archivo
con un cliente colado por error sigue sin pasar en silencio, pero el caso legítimo ya no se veta.
Editado en **`vbas/Module1.bas` y `vbas/Module1_compat.bas`**; verificado antes de tocar que el
`ExportarCSV` de ambos `.bas` fuera **idéntico al que vive en el `.xlsm`** (210 líneas de código,
sin contar comentarios — `olevba` no decodifica los `──` de los comentarios, así que la comparación
se hace ignorándolos). **Falta pegarlo en las dos plantillas y republicarlas.**

**Lección de método (me pasó DOS veces el mismo día, en el mismo archivo):** un regex que exige la
etiqueta de cierre **se traga los elementos self-closing y le cuelga al anterior el contenido del
siguiente**. Primero con las celdas (`<c r="C3" s="109"/>` corrió las columnas de la fila 3 y me hizo
leer el encabezado del layout completo mal); después, ya "corregido", con las **validaciones**
(`<dataValidation … sqref="E8"/>` vacía ⇒ reporté que la columna `B` *no tenía desplegable* cuando
`B9:B508` **sí lo declara**, tres líneas más abajo). **Corregir el patrón en un sitio no lo corrige
en los demás: hay que buscar el patrón, no el síntoma.** Ambas rutas ya están arregladas en
[`tools/lib/xlsx-read.js`](../../tools/lib/xlsx-read.js), que es hoy el único lector del `.xlsm`.

**Rareza menor confirmada** (con el lector ya corregido): `N9:N508` tiene **dos** validaciones
`extLst`, la segunda con las columnas cruzadas
(`OFFSET(Listas!$I$2,0,0,COUNTA(Listas!$J:$J)-1,1)` — lista de `I`, conteo de `J`). Sin impacto
conocido: gana la primera.

## Pendientes

- 🔴 **Corrida real contra el ERP.** Nada de v13 se ha ejercido: todo lo verificado es parseo,
  layout y decisión en frío. **La escritura de instrucciones de empaque NUNCA se ha ejecutado.**
  Primera prueba: lote chico, con los 5 racks y la columna de empaque llenos.
- 🟡 **Ruta de regeneración: declarada y con ancla, falta correrla headless.** La entidad
  `partNumberPackingDescription` ya lleva el ancla estructural verificada
  (`PART_NUMBER_PAGE_PART_NUMBER_INSTRUCTIONS` → botón lápiz → diálogo → Save), así que ya no es
  una ruta "por escribir". Mismo estado que las otras tres capture-abort del repo.
- ⚠️ **Volumen:** 5 racks ≈ ×2.5 escrituras de rack, más 1 llamada por PN con instrucciones.
- ⚠️ **Posible rotación de `GetPartNumber`:** el scan registra `previousHash` = el de nuestro
  config (`5efd689d…`) → `98f2b7fa…`. **No prueba que el nuestro esté muerto** (precedente:
  `AllWorkOrders` siguió válido server-side), pero lo usan `pn-specs-column`, `pn-lifecycle` y
  `bulk-upload`. Correr `tools/run-hash-validation.sh`.
- Caso borde heredado: sentinel `-` en el slot 1 de racks **con** otro slot lleno no borra; trata
  `-` como nombre de rack → error visible `RackType "-" no encontrado`.
- ⏳ **Bundle Safari/iPad sin rebundlear.** `bulk-upload` no está en la lista blanca del bundle,
  así que la v13 **no aplica al iPad** hoy; si algún día entra, el módulo `bulk-upload-packing.js`
  tiene que ir con él.

### Resuelto en esta sesión (no re-abrir)

- ✅ **`Module5_v19` pegado en AMBAS plantillas.** Verificado extrayendo el VBA con `olevba -c`
  de cada `.xlsm`: `LimpiarDatos (v19`, **3× `For c = 1 To 67`**, `LimpiarEspacios (v15`,
  `phHybridCols = Array(8, 15, 45)` y los 5 racks en `phCols`. (El v18 quedaba en 66 y dejaba
  `Tiempo de Entrega` sin limpiar; `vbas/Module5_v18.bas` se **borró** para que nadie pegue el
  equivocado.)
- ✅ **Publicado en `gh-pages`** — ver §Publicación.
