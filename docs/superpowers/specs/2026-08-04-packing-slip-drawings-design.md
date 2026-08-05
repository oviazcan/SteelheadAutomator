# Spec: Planos en Remisión (`packing-slip-drawings`)

**Fecha:** 2026-08-04
**Estado:** Diseño aprobado · Fase 0 **hecha en vivo** salvo el nombre de la operación de envío
**Applet propuesto:** `remote/scripts/packing-slip-drawings.js` + núcleo puro
`remote/scripts/packing-slip-drawings-core.js`

## Resumen ejecutivo

Cuando el cliente de una remisión (packing slip) tiene prendido el custom input
**`DatosLogisticos.IncluirPlanos`**, el applet adjunta al correo de esa remisión los archivos
vinculados a los números de parte que van en ella, con un panel de revisión previo. Cuando **no hay
plano que adjuntar**, lo dice en voz alta en vez de callarse. Y desde ese mismo panel, un botón
**imprime la remisión junto con lo seleccionado en un solo PDF**, porque el cliente exige además
copias impresas.

El applet tiene **tres trabajos**:

1. **Adjuntar** los planos al correo cuando existen.
2. **Delatar el hueco** cuando el cliente los pide y el NP no los tiene.
3. **Imprimir** la remisión + lo seleccionado en un PDF combinado, de un clic.

El segundo no es un extra: es el caso mayoritario medido (ver §Evidencia).

## Evidencia que sostiene el diseño

Medido el 2026-08-04 contra el snapshot DuckDB de TLC (fresco del mismo día,
`max(packing_slip.created_at) = 2026-08-04 15:37`).

### El campo existe y su path está medido, no adivinado

`customer.custom_input → $.DatosLogisticos.IncluirPlanos` (booleano).

Conteos sobre **todos** los clientes (incluidos archivados):

| Grupo de custom input en `customer` | Clientes |
|---|---|
| `DatosLogisticos` | 89 |
| `DatosContables` | 89 |
| `DatosFactura` | 77 |

Campos dentro de `DatosLogisticos`: `AceptaEnviosParciales` (89), `ObligatorioContarRecibo` (89),
`ObligatorioPesarRecibo` (89), `UnidadMedidaPeso` (84), **`IncluirPlanos` (77)**,
`NormasEmpaqueEmbarque` (2).

### Un solo cliente lo tiene prendido hoy

Ahora sobre los **81 clientes activos** (`archived_at IS NULL`) — por eso el total no cuadra con los
89 de la tabla anterior:

| `IncluirPlanos` | Clientes activos |
|---|---|
| `false` | 74 |
| ausente | 6 |
| **`true`** | **1 — FISHER CONTROLES DE MEXICO** |

El applet es de **nicho por diseño**: no debe estorbarle al 99% de los envíos que no lo necesitan.
Eso justifica el gate temprano por cliente y el `urlPatterns` acotado.

### El hueco es el caso mayoritario

NPs activos de FISHER CONTROLES DE MEXICO:

| Estado | NPs | % |
|---|---|---|
| Con PDF (plano) | 125 | 7.2% |
| Solo fotos (sin PDF) | 272 | 15.8% |
| **Sin ningún archivo** | **1,329** | **77.0%** |
| Total | 1,726 | 100% |

**Consecuencia de diseño:** en la mayoría de las remisiones de Fisher el applet no va a tener nada
que adjuntar. Un applet silencioso en ese escenario es *peor que no tenerlo*: el operador asumiría
que el cliente recibió sus planos. De ahí la nota ámbar de §Comportamiento 4.

### El volumen justifica el panel de revisión

Muestra de las 300 remisiones embarcadas más recientes:

| Métrica | Promedio | Máximo |
|---|---|---|
| NPs por remisión | 1.81 | **50** |
| Archivos alcanzables por remisión | 3.30 | **148** |

Caso real de Fisher: la remisión `1387` trae **88 NPs, 16 PDFs y 27 archivos no-PDF**. Adjuntar sin
revisar mandaría 43 archivos en un correo.

### La distinción plano/foto sí es separable

Extensiones de los archivos vinculados a NPs (todo el dominio TLC):

| Ext | Archivos | NPs |
|---|---|---|
| `jpg` | 25,905 | 13,181 |
| `pdf` | **3,936** | **3,228** |
| `png` | 627 | 624 |
| `jpeg` | 55 | 54 |
| `bmp` / `gif` / `tif` / `step` | 13 | 12 |

El PDF es señal fuerte de plano; el JPG lo es de foto (la convención de fotografía del repo es
`<PN>_<VISTA>_<num>` / `<PN>__<descriptor>`, ver `file-uploader-core.js`). Por eso el default
premarca PDF — **pero no oculta nada**: un plano escaneado en JPG sigue visible y marcable con un
clic. La heurística elige el default; **el operador decide**.

## Decisiones tomadas (con el usuario, 2026-08-04)

| Decisión | Resolución |
|---|---|
| Qué correo intercepta | El del **Packing Slip / Remisión** (Panel de Envío / lista de Remisiones) |
| Dónde vive el check | En el **CLIENTE**, ya dado de alta: `DatosLogisticos.IncluirPlanos` |
| Qué se adjunta | Los archivos de los NPs de la remisión, **con panel de revisión** |
| Default del panel | **PDF premarcados; fotos visibles y desmarcadas** |
| Si falta el plano | **Nota ámbar, no bloquea** el envío |
| **Superficies de entrada** | **DOS**: la lista de albaranes (`/Shipping/PackingSlips`) **y** el módulo de Envío donde se crean (`/Shipping`) |
| **Impresión** | Botón que arma **un PDF combinado** (remisión + lo seleccionado), calidad vectorial intacta |
| **Cuándo imprime** | **Siempre que el panel esté montado**, mande correo o no |

## Reconocimiento en vivo (2026-08-04, dominio 344 = Ecoplating TLC)

Hecho por automatización de Chrome sobre el ERP productivo. **Todo lo de esta sección está medido,
no supuesto.**

### El modal existe y se llama «Send Shipping Email»

Se abre desde la columna **Acciones** de la lista de albaranes. Título en **inglés** aunque la app
esté en español — UI mixta confirmada, tal como advierte el `CLAUDE.md`.

Estructura (`div.MuiDialog-paper`, ~33 KB de HTML):

| Fila (`<tr>`) | Contenido |
|---|---|
| `To` | Chips de destinatarios + `ADD CUSTOMER CONTACT` + toggle BCC/CC |
| `Subject` | *«Remisión desde Ecoplating TLC - Actualización de Estatus…»* |
| **`Attachments`** | **botón `+ ADD`** ← punto de inyección |
| `Logo` | MuiSwitch |
| `Parts List` | MuiSwitch |
| `Visible to Others` | MuiSwitch |
| `Enlace de Albarán de Entrega` | MuiSwitch |

Pie: `SAVE DRAFT` · `CANCEL` · `SEND`. Total **5 MuiSwitch** (el `structMatch` de `cfdi-attacher`
—≥2 switches + icono Send/Email— también reconocería este modal; hay que **distinguirlos** para que
los dos applets no se pisen).

### Punto de inyección medido

```html
<tr class="MuiTableRow-root">
  <td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium">
    <p class="MuiTypography-root MuiTypography-body1">Attachments</p>
  </td>
  <td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium">
    <div><button class="MuiButtonBase-root MuiButton-root MuiButton-contained …">…ADD</button></div>
  </td>
</tr>
```

**Ancla:** la `<tr>` cuya primera celda tiene el texto `Attachments` (ES pendiente, ver deuda),
insertando nuestra fila **después**, y **heredando las clases MUI del vecino vivo**. Sin `css-<hash>`
(el paper trae `css-1d28aor` — **prohibido usarlo**).

### El modal YA trae los números de parte  ← mata el riesgo R2

El preview del correo incluye la tabla `SO # | WO # | Part # | QTY`, p. ej.
`#1770 - 4300016123 | #13667 | 10-4307003-001 | 2567`, más el cuerpo con `Remisión: #1746` y
`Partes: 10-4307003-001`.

**Consecuencia:** los NPs de la remisión se pueden leer **del propio DOM del modal**, sin descubrir
ninguna query nueva de GraphQL. Se prefiere la API cuando esté disponible y el DOM queda como
respaldo — pero el respaldo ya existe y está verificado.

### El botón de correo solo se ancla por FORMA

En la columna Acciones hay **7 botones**. Medidos en vivo:

| # | `aria-label` | Forma (`path d`) | Qué es |
|---|---|---|---|
| 0 | — | `M9.68 13.69 12 11.93l2.31 1.76…` | Certificación / medalla |
| 1 | `Marcar Como Completado` | `M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z` | Check |
| **2** | **— (ninguno)** | **`M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2zm-2 0-8 5-8-5zm0 12H4V8l8 5 8-5z`** | **Correo ← el nuestro** |
| 3 | — | `m20.54 5.23-1.39-1.68…` | Archivar |
| 4 | — | `M14 2H6c-1.1 0-2 .9-2 2v16…` | Documento |
| 5 | `Ver Estado de Facturación de Piezas` | `M3 13h2v-2H3zm0 4h2v-2H3z…` | Estado facturación |
| 6 | `Ir a Facturas Relacionadas` | `M19 19H5V5h7V3H5c-1.11 0…` | Ir a facturas |

**Confirmado en vivo:** `data-testid` viene **`null` en los 7** (SH lo eliminó, como documenta la
bitácora del 2026-08-03), y el botón de correo **no tiene `aria-label` ni `title`**. El tooltip
**«Enviar Albarán»** lo inyecta MUI **solo al hacer hover**, así que **no sirve como ancla estática**.

⇒ **La forma del `path` es la ÚNICA ancla viable** para el botón de correo.

✅ **Y ya está catalogada.** El path medido coincide **byte por byte** con la primera entrada de
`ICON_SHAPES.EmailOutlinedIcon` en `mui-icon-anchor-core.js` (medida en su día en `/Reporting/View`).
**No hay que agregar nada al catálogo**: `MuiIconAnchorCore.findIconButton(root, 'EmailOutlinedIcon')`
ya encuentra este botón por forma. Lo que sí aporta el reconocimiento es la **confirmación de que la
misma forma se reusa en el listado de albaranes**, y que aquí **no hay aria de respaldo** — en esta
pantalla la forma no es la segunda opción, es la única.

**Oportunidad pendiente (barata):** el catálogo lista `SendIcon` y `CloseIcon` como *no medidos*, con
la nota «no se toca sin que el operador lo pida» — precisamente porque viven en modales de envío. El
modal de la remisión **tiene ambos** y hoy sí se abrió con permiso. Medir sus `path` es una llamada
de un renglón la próxima vez que se abra.

### Deuda bilingüe declarada

Solo se obtuvo el locale que estaba activo:

| String | ES | EN |
|---|---|---|
| Título del modal | *(no visto — el modal salió en EN con la app en ES)* | `Send Shipping Email` |
| Fila de adjuntos | *(pendiente)* | `Attachments` |
| Tooltip del botón | `Enviar Albarán` | *(pendiente)* |

Se anclan los conocidos y **se marca la deuda** (regla: no se adivina la traducción).

### Lo que NO se pudo capturar

**El nombre de la operación que manda el correo.** Dos intentos de clic en `SEND` **congelaron la
pestaña** (>25 s sin responder, irrecuperable salvo recarga). El envío se probó con la lista de
destinatarios reducida a **un solo correo del consultor** y una allowlist que abortaba cualquier
destinatario ajeno; el capturador registró **cero requests** antes del congelamiento y la columna
«Enviado En» de la remisión #1746 **no cambió**.

**Hipótesis principal del congelamiento — y es en sí un requisito de diseño:** el payload del envío
lleva el **HTML completo del correo** (cuerpo + tabla de partes + preview), y el interceptor de
pruebas hacía `JSON.parse` + regex global sobre ese string **de forma síncrona**. Con un body así de
grande eso basta para bloquear el hilo principal.

> **Regla que sale de aquí, y que el applet DEBE respetar:** el interceptor de `SendEmailChecked`
> **no puede hacer trabajo síncrono pesado sobre el body**. Nada de regex globales ni de
> re-serializar el HTML completo. Se hace `JSON.parse` una vez, se toca **solo** `variables.attachments`
> y se re-serializa — que es exactamente lo que hace `cfdi-attacher` hoy, y por eso no congela.

Queda como **R1 abierto**: confirmar el nombre de la operación (muy probablemente `SendEmailChecked`,
la misma que ya intercepta `cfdi-attacher`) con el **hash-scanner** durante un envío real. Es una
verificación de 30 segundos con el operador presente.

## Arquitectura

Sigue el molde probado de `cfdi-attacher.js`, que ya resuelve el problema equivalente para el XML
CFDI en el correo de factura.

### Diferencia clave contra `cfdi-attacher`

El CFDI **sube** el binario a `/api/files` porque el XML llega en base64 dentro del `writeResult` y
todavía no existe como archivo del servidor. **Aquí no aplica:** los archivos del NP ya viven en
Steelhead (`part_number_user_file.user_file_name` → `user_file.name`), así que el adjunto se arma
**directo**, sin subir nada:

```js
{ filename: userFile.name, displayName: userFile.originalName }
```

Esto elimina todo un eje de fallo (subida, reintentos, throttle) y hace el applet notablemente más
barato que su primo.

### Capas

1. **Núcleo puro** `packing-slip-drawings-core.js` — sin DOM ni red, con golden test.
   - `readIncluirPlanos(customInputs)` → `true | false | null`. **`null` es distinto de `false`**:
     significa «no pude leerlo», y gobierna la degradación explícita. Tolera las tres formas en que
     el ERP entrega custom inputs (objeto, string JSON, booleano como string `"true"`), tal como lo
     hace `duplicate-tiers.parseCustomInputs`.
   - `classifyFile(originalName)` → `'plano' | 'foto' | 'otro'`. PDF/DWG/DXF/STEP → plano;
     extensiones de imagen (reusa el criterio de `FileUploaderCore.isImageFile`) → foto; resto → otro.
   - `buildAttachmentPlan({ pns, filesByPn })` → `{ groups, preselected, pnsSinPlano, totals }`.
     Determinista y ordenado; es la función que decide qué viene premarcado y **cuáles NPs quedan sin
     plano**.
   - `toAttachments(selectedFiles)` → `[{ filename, displayName }]`.
   - `dedupeByFilename(...)` — un mismo archivo puede colgar de dos NPs de la misma remisión; se
     adjunta **una vez**.

2. **Interceptor de `fetch`** (patrón `cfdi-attacher`, con sentinel `window.__saPsDrawingsFetchPatched`
   para no re-parchear en bumps de versión).
   - **Entrada:** cachea la respuesta de la query del packing slip → `{ customerId, pnIds }`.
   - **Salida:** al detectar `SendEmailChecked`, si el plan tiene selección → inyecta
     `variables.attachments = [...(existentes), ...nuestros]`.
   - **No re-implementa el patch:** si `cfdi-attacher` ya parcheó `fetch`, ambos conviven porque cada
     uno guarda su propio `_origFetch` y encadena. Verificar en Fase 0 que el orden de inyección no
     rompa el encadenado (ver §Riesgos R3).

3. **Panel de revisión** — dark mode obligatorio (base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`,
   acento `#13a36f`), inyectado en el modal de correo de la remisión. Agrupado por NP, con checkbox
   por archivo, contador de adjuntos y peso total, y el bloque ámbar de NPs sin plano.

4. **Módulo de impresión** `packing-slip-print.js` (ver §Impresión).

5. **Golden test** `tools/test/packing-slip-drawings-core.test.js`.

## Impresión — «el cliente exige copias impresas»

Botón **🖨️ Imprimir** dentro del panel, que arma **un solo PDF** con la remisión seguida de los
archivos seleccionados y abre **un único diálogo de impresión**.

### Por qué PDF combinado y no N impresiones

Con 88 NPs en una remisión real de Fisher, la impresión archivo-por-archivo son decenas de diálogos.
Y rasterizar (renderizar cada página a canvas con el `pdf.js` que ya está en el repo) degrada justo
lo que el cliente exige: un plano de ingeniería con cotas finas. Se paga **una librería nueva** para
conservar la calidad vectorial.

### Librería

`pdf-lib` en `remote/scripts/lib/pdf-lib.min.js`. **No es una excepción arquitectónica**: el
directorio ya sirve `pdf.min.js` (377 KB, usado por `po-reconciler`) y `xlsx.full.min.js` (881 KB,
usado por `portal-importer`), cada uno declarado en el array `scripts` del applet que lo necesita.
Se carga **solo** en este applet.

`pdf.js` **lee**; `pdf-lib` **escribe y cose**. Son complementarias, no redundantes.

### Flujo

1. **PDF de la remisión** — se obtiene del endpoint de documentos de SH (`/api/pdf/share/…`, el mismo
   patrón que ya usan `wo-listing-columns` y `wo-schedule-button` para las etiquetas de OT). La ruta
   exacta para un packing slip se confirma en la verificación pendiente (§R7).
2. **Archivos seleccionados** — se descargan por su `userFile.name`.
3. **Costura** — `pdf-lib` copia páginas: primero la remisión, luego los archivos **agrupados por NP**
   y en el orden del panel. Las imágenes (JPG/PNG) se embeben **una por página, escaladas a carta**
   respetando su relación de aspecto.
4. **Impresión** — el PDF resultante va a un `Blob`, se abre en iframe oculto y se llama `print()`
   **una vez**. Es el patrón de iframe ya probado en `wo-listing-columns`, con su fallback a pestaña.

### Reglas

- **La selección manda.** Se imprime exactamente lo que está marcado en el panel — la misma
  selección que iría al correo, sin trabajo doble.
- **Independiente del correo.** El botón funciona con el panel montado, se mande o no el correo.
- **Degradación explícita.** Si no se consigue el PDF de la remisión, se imprimen **solo los
  archivos** y se avisa en ámbar que la remisión no entró. Nunca se imprime en silencio algo
  distinto de lo que el operador marcó.
- **Sin selección** → el botón imprime solo la remisión (equivale al comportamiento nativo).

### Anclaje del modal (jerarquía del repo)

El modal de correo se localiza por **estructura primero**: `role="dialog"` que contenga filas de
toggle `MuiSwitch` + icono `SendIcon`/`EmailOutlinedIcon` resuelto por
`MuiIconAnchorCore.hasAnyIcon` (testid → **forma del `<path>`** → aria bilingüe). Texto ES+EN solo
**amplía** el match, nunca lo decide en solitario. **Prohibido** anclar a clases `css-<hash>`.

⚠️ El wrapper HTML real del modal de correo de la remisión **se le pide al operador** antes de
escribir selectores (regla del repo: una inspección resuelve lo que diez deploys no).

### Registro en `config.json`

```jsonc
{
  "id": "packing-slip-drawings",
  "name": "Planos en Remisión",
  "subtitle": "Adjunta los planos del NP al correo de la remisión",
  "icon": "📐",
  "category": "Herramientas",
  "autoInject": true,
  "urlPatterns": ["^/Domains/\\d+/Shipping(?:/|$)"],
  "scripts": [
    "scripts/steelhead-api.js",
    "scripts/mui-icon-anchor-core.js",
    "scripts/lib/pdf-lib.min.js",
    "scripts/packing-slip-drawings-core.js",
    "scripts/packing-slip-modal-core.js",
    "scripts/packing-slip-print.js",
    "scripts/packing-slip-drawings.js"
  ],
  "requiredPermissions": [],
  "actions": [{
    "id": "toggle-packing-slip-drawings",
    "label": "Planos en Remisión",
    "sublabel": "Adjunta los planos del NP al enviar la remisión",
    "icon": "📐",
    "type": "toggle",
    "handler": "message",
    "message": "toggle-packing-slip-drawings"
  }]
}
```

`urlPatterns` **con evidencia**: la falla de este applet es **visible** (el panel no aparece), no
silenciosa, así que gatearlo es seguro — a diferencia de `price-confirm-guard`.

**Cubre las DOS superficies de entrada** que pidió el operador: `^/Domains/\d+/Shipping(?:/|$)`
matchea tanto el **módulo de Envío donde se crean** las remisiones (`/Shipping`) como la **lista de
albaranes** (`/Shipping/PackingSlips`). Nótese que es **deliberadamente más ancho** que el de
`batch-name-filter` (`^/Domains/\d+/Shipping/?(?:[?#]|$)`), que excluye a propósito las sub-rutas.
El modal se verificó en vivo en `/Shipping/PackingSlips`; **queda por verificar que el módulo de
Envío monte el mismo modal** — si montara otro distinto, el anclaje por forma del icono debería
cubrir ambos.

**Todo hash nuevo necesita su ruta de regeneración** en `tools/hash-autopilot/route-catalog.json`
(regla dura del repo; el trinquete `hash-regen-coverage.test.js` lo verifica). Si Fase 0 descubre
que hace falta una query nueva para resolver NP→archivos, su ruta entra en el mismo commit.

## Comportamiento

1. **Gate temprano.** Si el cliente de la remisión no tiene `IncluirPlanos === true`, el applet **no
   monta el panel** y no toca el correo. Es lo que pasa en 74 de 81 clientes.

2. **Panel al abrir el modal de correo.** Lista los NPs de la remisión con sus archivos. PDF
   premarcados; fotos listadas y desmarcadas. Muestra conteo y peso total de lo seleccionado.

3. **Al enviar.** El interceptor inyecta en `variables.attachments` solo lo seleccionado, deduplicado
   por `filename`. Si la selección quedó vacía, **no toca el payload** — el correo sale como siempre.

4. **Hueco explícito (ámbar).** Los NPs de la remisión sin ningún archivo se listan en un bloque
   ámbar: «*Este cliente pide planos. N de M números de parte no tienen ninguno cargado.*» **No
   bloquea el envío.** Ámbar (aviso), no rojo (bloqueo) — el rojo del repo está reservado para
   candados.

5. **Degradación explícita.** Si no puedo resolver el cliente, los NPs o los archivos, el panel
   muestra la nota ámbar «no pude verificar» **nombrando qué faltó**, no adjunta nada y **jamás
   impide el envío**. Regla del repo: *«no tengo el dato» nunca puede significar «prohibido»*.

## Errores y fail-safes

| Escenario | Comportamiento |
|---|---|
| `IncluirPlanos` ausente o ilegible (`null`) | No adjunta · nota ámbar «no pude leer la preferencia del cliente» · el correo sale |
| Cliente con el check en `false` | Applet inerte, cero UI, cero payload tocado |
| No se resuelven los NPs de la remisión | No adjunta · ámbar nombrando el hueco · el correo sale |
| NP sin archivos | Se lista en el bloque ámbar · el correo sale |
| Falla la query de archivos | No adjunta · ámbar · el correo sale · `console.warn` |
| Selección vacía | El payload **no se toca** (no se manda `attachments: []`) |
| Mismo archivo en dos NPs | Se adjunta una sola vez (dedup por `filename`) |

**Regla transversal:** este applet **nunca cancela un envío**. A diferencia de `cfdi-attacher` —que
sí aborta el correo si el XML no se pudo adjuntar, porque una factura sin CFDI es inválida— una
remisión sin plano **sigue siendo una remisión válida**. La asimetría es deliberada: aquí un falso
bloqueo cuesta un embarque detenido, y un falso «sin planos» cuesta un correo de seguimiento.

## Riesgos y qué los cierra

| # | Riesgo | Estado | Cómo se cierra |
|---|---|---|---|
| **R1** | **El correo de la remisión podría no pasar por `SendEmailChecked`.** Todo el interceptor cuelga de esto. | **ABIERTO** | Un envío real con el `hash-scanner` corriendo (30 s con el operador presente). Ver §Lo que NO se pudo capturar |
| **R2** | Qué resuelve **remisión → NPs** | **CERRADO** | El modal **ya trae la tabla de partes en su DOM**. La API queda como preferida, el DOM como respaldo verificado |
| **R3** | `cfdi-attacher` y este applet parchean `fetch` y **ambos reconocen un modal de ≥2 MuiSwitch + icono de correo**. El de remisión tiene 5 switches ⇒ el `structMatch` del CFDI también matchearía. | **ABIERTO — subió de prioridad** | Distinguir por el heading (`Send Shipping Email` vs `Send Invoice Email`) **y** por la ruta. Probar con ambos activos |
| **R4** | El adjunto por `{filename}` sin re-subir asume que `userFile.name` es citable directo | ABIERTO | Verificar con **un** archivo real antes de construir el panel |
| **R5** | Un plano escaneado en JPG no viene premarcado | MITIGADO | Está **visible** y a un clic. No se oculta nada |
| **R6** | El snapshot DuckDB es de TLC; MTY no medido | ABIERTO | Verificar que MTY tenga el mismo grupo `DatosLogisticos` antes de habilitar ahí |
| **R7** | La ruta del **PDF de la remisión** para imprimir no está confirmada | ABIERTO | Inspeccionar el botón de descarga de la fila; degrada a «solo archivos» + ámbar |
| **R8** | **El payload del envío es enorme** (lleva el HTML del correo). Trabajo síncrono sobre él **congela la pestaña** — medido dos veces. | **MEDIDO** | Regla dura: `JSON.parse` una vez, tocar solo `variables.attachments`, re-serializar. Sin regex globales sobre el body |

### Lo que falta de Fase 0

Solo queda **R1** (y de paso R4/R7, que se resuelven en la misma sesión): un envío real de una
remisión con el `hash-scanner` corriendo, para registrar el nombre de la operación y el shape de sus
`variables` (`linkInfo`, `attachments`). Todo lo demás —modal, punto de inyección, NPs, anclaje del
botón— **ya está capturado en vivo** (ver §Reconocimiento en vivo).

## Plan de pruebas

- **Golden test del núcleo** (`node --test`), sin DOM ni red: las tres formas de `customInputs`;
  `null` ≠ `false`; clasificación por extensión incluyendo mayúsculas y nombres con puntos; dedup;
  premarcado; `pnsSinPlano`; plan vacío.
- **Cableado**: `popup-actions-wired.test.js` (el toggle necesita su `case` en el background) y
  `mui-icon-core-wiring.test.js` (el núcleo de iconos declarado en `config.apps[].scripts`).
- **Forma del icono**: el `path` del sobre entra al catálogo de `mui-icon-anchor-core` con su test,
  y se verifica que `by: 'shape'` (no `'testid'`, que ya no existe).
- **En vivo, contra el ERP** (una búsqueda a la vez — el `/graphql` se cuelga bajo ráfaga):
  remisión de Fisher con PDF · remisión de Fisher sin ningún archivo (la mayoría) · la remisión
  **1387 (88 NPs)** para el peso del panel y del PDF combinado · un cliente con `IncluirPlanos: false`
  para confirmar que el applet queda inerte · **con `cfdi-attacher` activo simultáneamente** (R3) ·
  **desde las dos superficies**: `/Shipping` y `/Shipping/PackingSlips`.
- **Anti-congelamiento (R8)**: medir que el interceptor no añade trabajo síncrono perceptible sobre
  el payload de envío. Es la prueba que nació de congelar la pestaña dos veces en el reconocimiento.

## Fuera de alcance

- Subir planos faltantes (eso es `file-uploader`).
- Adjuntar planos al correo de **factura** (eso es el modal del CFDI).
- Adjuntar archivos que no cuelgan del NP (los de cliente, nodo de proceso o lote).
- Cerrar el hueco del 77% de NPs sin archivo — el applet lo **mide y lo delata**; llenarlo es
  trabajo de operación.
- Elegir impresora, número de copias o dúplex: eso lo decide el diálogo nativo del navegador.
- Reescribir el cuerpo del correo o su plantilla.

## Apéndice — consultas de la evidencia

Las consultas corrieron con `run_query.py` del proyecto **Reportes SH** contra el snapshot TLC del
2026-08-04. La cadena remisión → NP en la base de reportes es:

```sql
packing_slip
  → packing_slip_item      (packing_slip_id)
  → parts_transfer_account (packing_slip_item_id → part_number_id)
  → part_number_user_file  (part_number_id → user_file_name)
  → user_file              (name, original_name)
```

⚠️ Esa es la forma en **la base de reportes**, no necesariamente el camino de la **API GraphQL** que
usará el applet. Confirmarlo es objetivo de Fase 0 (R2).
