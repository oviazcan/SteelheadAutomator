# `packing-slip-drawings` — Planos en Remisión

**Versión:** 0.3.0 · **Estado:** **VIVO Y VALIDADO EN PISO** (config 1.11.83, 2026-08-05).
El operador confirmó que **los adjuntos llegan al correo** — R4 cerrado con evidencia de uso real.
**Spec:** [`2026-08-04-packing-slip-drawings-design.md`](../superpowers/specs/2026-08-04-packing-slip-drawings-design.md)
**Plan:** [`2026-08-04-packing-slip-drawings.md`](../superpowers/plans/2026-08-04-packing-slip-drawings.md)

## Qué hace

Cuando el cliente de una remisión tiene prendido `DatosLogisticos.IncluirPlanos`, el applet inyecta
un panel en la fila **Attachments** del modal «Send Shipping Email» con los archivos de los números
de parte que van en esa remisión. Los **PDF vienen premarcados**, las fotos van visibles y
desmarcadas. Al enviar, inyecta lo seleccionado en `SendEmailChecked.variables.attachments`.

Además, un botón **🖨️ Imprimir remisión + selección** cose la remisión y lo marcado en **un solo
PDF** (con `pdf-lib`, calidad vectorial intacta) y abre **un** diálogo de impresión.

## La evidencia que le dio forma

Medido contra el snapshot DuckDB de TLC (2026-08-04, fresco del mismo día):

| Dato | Valor |
|---|---|
| Clientes con `IncluirPlanos` prendido | **1** — FISHER CONTROLES DE MEXICO |
| NP activos de Fisher | 1,726 |
| …con PDF (plano) | **125 (7.2%)** |
| …sólo con fotos | 272 (15.8%) |
| …**sin ningún archivo** | **1,329 (77.0%)** |
| Remisión promedio / máxima | 1.8 NP / **50 NP, 148 archivos** |
| Archivos en TLC | jpg 25,905 · pdf 3,936 · png 627 · resto 68 |

**El hueco es el caso mayoritario, y de ahí sale el segundo trabajo del applet.** En la mayoría de
las remisiones de Fisher no habrá nada que adjuntar. Un applet que se callara ahí sería *peor que no
tenerlo*: el operador creería que el cliente recibió sus planos. Por eso el panel tiene un bloque
ámbar que nombra los NP sin plano, y por eso `pnsSinPlano` incluye también al NP que **sólo tiene
fotos** — también deja al cliente sin lo que pidió.

## Anclaje (todo medido en vivo, 2026-08-04/05, dominio 344)

### El botón de correo sólo se ancla por FORMA

En la columna Acciones hay 7 botones. Medidos:

| # | `aria-label` | Qué es |
|---|---|---|
| 0 | — | Certificación |
| 1 | `Marcar Como Completado` | Check |
| **2** | **ninguno** | **Correo ← el nuestro** |
| 3 | — | Archivar |
| 4 | — | Documento |
| 5 | `Ver Estado de Facturación de Piezas` | Estado facturación |
| 6 | `Ir a Facturas Relacionadas` | Ir a facturas |

**`data-testid` viene `null` en los 7** (confirmado en vivo lo del 2026-08-03). El botón de correo
**no tiene `aria-label` ni `title`**; el tooltip **«Enviar Albarán»** lo inyecta MUI **sólo al
hover**, así que no sirve como ancla estática.

✅ Su path **ya estaba catalogado**: coincide byte por byte con `ICON_SHAPES.EmailOutlinedIcon` de
`mui-icon-anchor-core.js`. No hubo que tocar el catálogo. Lo que aporta esta medición es que **en
esta pantalla la forma no es la segunda opción, es la única**.

### Punto de inyección

```html
<tr class="MuiTableRow-root">
  <td …><p class="MuiTypography-root MuiTypography-body1">Attachments</p></td>
  <td …><div><button class="MuiButton-contained …">+ ADD</button></div></td>
</tr>
```

Se ancla por el **texto de la primera celda** (`attachments|adjuntos|archivos adjuntos`) y se inserta
la fila **después**, heredando las clases MUI del vecino vivo. El paper trae `css-1d28aor`:
**prohibido usarlo**.

### El modal ya trae los números de parte

El preview del correo incluye la tabla `SO # | WO # | Part # | QTY`
(`#1770 - 4300016123 | #13667 | 10-4307003-001 | 2567`). Se leen de ahí, sin descubrir query nueva.
El preview **repite el bloque «Parts List»** varias veces, por eso `extractPartNumbers` deduplica.

## La mutation (R1 cerrado el 2026-08-05)

```
SendEmailChecked | 63afd0cb799d8c9d17106fb1827fa210641d6608e9c1c2483480eb0be17635bc | len=11789
```

Es **la misma que usa `cfdi-attacher`**, y el hash capturado **coincide byte por byte con el de
`remote/config.json`** — no hubo que rotar nada. Shape de `variables` confirmado:

```
emailType · subject · body · rawBody · recipientEmails · attachments · template ·
includeLogo · attachPdf · customerId · visibleToOthers · ccRecipients ·
linkInfo · additionalFiles · sourceUrl · linkedEntitySpecificData
```

`attachments` llega como **array vacío** y `linkInfo` como array de `{displayName, link, idInDomain}`.

**Hashes capturados de paso, NO agregados al config** (el applet no los usa, y meterlos sin usarlos
sólo sumaría huérfanas al trinquete de cobertura). Quedan aquí por si hacen falta:

| Operación | Hash |
|---|---|
| `GetPackingSlip` | `407230952236567708a9e2190721a65c4fc8dd4bbe94337b9660e49283d7801e` |
| `CreatePackingSlipEmailLog` | `879b910870ec2c254f9a61fcfac8961cd16394fab22c2325b10f64d8849d4ad7` |
| `ListAllPackingSlips` | `e7da7868b6c0a52140379a8a039a483b68d6d0ddeb2946a6958308775464b904` |
| `CreateEmailLogForCertReports` | `be2440c8b9e4cafea8d53fe8f264117de4492b9a84b20a3da1e5ffcce887a6e7` |

**El applet no introduce ningún hash nuevo**: `SendEmailChecked`, `CustomerSearchByName`, `Customer`,
`SearchPartNumbers` y `GetPartNumber` ya estaban en `config.json`. Por eso no necesita ruta de
regeneración propia y el trinquete de cobertura no se movió.

## Lecciones que costaron algo

### 1 · El payload del envío congela la pestaña si lo tocas mal (R8)

`SendEmailChecked` pesa **~11.8 KB** porque lleva el **HTML completo del correo**. Durante el
reconocimiento, un interceptor que hacía `JSON.parse` + **regex global** sobre ese body **congeló la
pestaña dos veces, >25 s cada una**, irrecuperable salvo recarga.

**Regla que el applet respeta:** guardas baratas **antes** del parse (¿hay selección? ¿es
`/graphql`? ¿el body trae `"operationName"`?), un solo `JSON.parse`, tocar **sólo**
`variables.attachments`, re-serializar. Sin regex globales. Es lo que hace `cfdi-attacher`, y por eso
él nunca congeló.

**Corolario para depurar en vivo:** encadenar tres parches de `fetch` en la misma pestaña también la
congela. Para capturar operaciones, `read_network_requests` del navegador **no inyecta nada** y no
congela — pero no da el body; para el body basta un `indexOf` + `substr`, nunca un regex global.

### 2 · Este applet NUNCA cancela un envío (al revés que `cfdi-attacher`)

`cfdi-attacher` **aborta** el correo si el XML no se pudo adjuntar, y hace bien: una factura sin CFDI
es inválida. Aquí la asimetría es la contraria: **una remisión sin plano sigue siendo una remisión
válida**. Un falso bloqueo cuesta un embarque detenido; un falso «sin planos» cuesta un correo de
seguimiento. Ante error, se avisa por consola y el correo sale.

### 3 · Buscar la fila POR SU NÚMERO, no la primera

La primera versión de `readCustomerNameFromList` tomaba **la primera fila** de la tabla. Con todas
las filas visibles del mismo cliente el bug es **invisible**; en cuanto no lo sean, leería el cliente
de otra remisión y decidiría con él. Ahora se extrae el número del modal
(`Modal().extractPackingSlipNumber`) y se busca **esa** fila. Sin número → `null` → ámbar, no se
adivina. La decisión vive en el núcleo puro y tiene 6 tests.

### 4 · El modal de remisión también matchea el filtro de `cfdi-attacher` (R3)

`cfdi-attacher` reconoce el suyo por «≥2 MuiSwitch + icono Send/Email». El de remisión tiene **5
MuiSwitch y un icono de correo** ⇒ **también pasaría**. Los separa el heading, con dos asimetrías:

- un heading **ajeno** (`invoice`/`factura`) **gana sobre la estructura** — un falso positivo ahí nos
  pondría a inyectar adjuntos en el correo de una **factura**;
- sin heading legible, red estructural con **umbral de 4 switches** (factura 3, remisión 5).

### 5 · Dos bugs que sólo aparecieron en producción (v0.1.0 → 0.1.2)

Ambos salieron en la **primera corrida real**, ninguno lo habría atrapado un test unitario.

**a) El panel se montaba DOS veces.** El latch ponía `'pending'` antes del `await`, pero el guard
sólo rechazaba `'1'` — así que entre el disparo del observer y su `.then()` cabían más mutaciones y
todas pasaban. Ahora rechaza ambos estados **y** `mountPanel` pregunta por el NODO
(`tr[data-sa-ps-drawings]`) como defensa en profundidad: *el latch dice «ya lo intenté», el nodo dice
«ya está ahí»*.

**b) Se decidía antes de que llegara el dato.** El observer dispara en cuanto **aparece** el
diálogo, pero el preview del correo —de donde salen el número de remisión y la tabla de partes— se
carga **después**, asíncrono. Resultado: `psNumber = null` ⇒ ámbar «no pude verificar» sobre un
cliente que sí tenía `IncluirPlanos: false` y debía dejar el applet **inerte**.

> **La lección, que es más general que el bug:** una degradación honesta pero **prematura** es su
> propio modo de falla. Si el aviso ámbar sale casi siempre, el operador aprende a ignorarlo — y
> entonces deja de servir justo el día que el dato falte de verdad. **Fail-safe no es sinónimo de
> avisar pronto: es avisar cuando de verdad no sabes.** Ahora se espera al contenido (20×250 ms) y
> sólo entonces se decide.

**Falso bug descartado en el camino:** en medio de esto, la cadena de resolución del cliente pareció
fallar. Medida en frío responde en **182 ms** y devuelve `false` correctamente. Lo que se vio era el
`/graphql` saturado **por las pruebas de la propia sesión** (3 envíos de correo + decenas de
queries) — el límite es **por SESIÓN**, como advierte el `CLAUDE.md`. Diagnosticar en un ERP que uno
mismo acaba de saturar produce falsos positivos: **medir en frío antes de culpar al código**.

### 6 · Buscar la causa de un síntoma menor destapó el bug caro (v0.1.3)

**Síntoma reportado:** el panel salía con «no pude verificar» sobre SCHNEIDER, que tiene
`IncluirPlanos: false` y debía dejar el applet **inerte**.

**Lo que apareció buscando la causa, y era mucho peor:** resolver los archivos cuesta **dos queries
por número de parte**, y se disparaban **automáticamente al abrir el modal**, antes de confirmar que
el cliente quisiera planos. Una remisión real de Fisher trae **88 NP ⇒ 176 peticiones en ráfaga**. El
`/graphql` se cuelga a las ~40 y el límite es **por SESIÓN**: habría tumbado también la pantalla
nativa del operador. Y eso en **cada** correo de remisión, cuando **80 de 81 clientes** ni siquiera
quieren planos.

> **La regla que queda:** el trabajo caro va **después** de la confirmación, no antes. Un applet de
> nicho que hace su trabajo pesado «por si acaso» no es entusiasta, es un ataque de denegación de
> servicio contra su propio ERP.

Ahora la carga automática exige un `true` **confirmado**. Con `null` se pinta **una sola línea** con
un botón *«Buscar planos de N NP»*: se conserva la salida de emergencia sin pagar el costo por
defecto. De paso arregla el ruido — el panel completo en todos los correos era un aviso que casi
siempre sobra, y esos se aprenden a ignorar.

**La causa del síntoma** era que identificar al cliente dependía de leer la tabla que queda **detrás**
del modal, y esa tabla sólo existe en la lista de albaranes. Se **amplió** (no se cambió) con
`findCustomerName`, que localiza al `Customer` dentro de las respuestas que el modal ya pide,
apoyándose en el `__typename` que Apollo estampa en cada nodo — sin necesidad de conocer el shape.
Se limpia al cerrar el modal: si sobreviviera, el siguiente decidiría con el dueño anterior — el
nodo stale del `CLAUDE.md`, sólo que en una variable.

### 7 · Homónimos: el error que MIENTE en vez de fallar (v0.1.5)

El ERP tiene números de parte **duplicados**. Medido: `S49B0531A7` existe dos veces para FISHER,
ambos activos, y los archivos cuelgan sólo del registro **viejo** (3027607) mientras el nuevo
(3657419) está vacío. Como se pedía `orderBy: ID_DESC` y se tomaba el primero, se leía justo el vacío
y el panel afirmaba **«sin archivos cargados» sobre un NP que sí tiene plano**.

> Es el peor error que este applet puede cometer, y no por su tamaño: **no falla ruidosamente,
> miente en voz baja**. Hace exactamente aquello que el applet existe para evitar — que el cliente no
> reciba lo que pidió y nadie se entere. Un ámbar falso es más dañino que no tener ámbar.

Se **unen** los archivos de todos los homónimos (tope de 3 por nombre) y el dedup por `filename`
limpia los repetidos. El link del NP apunta al registro que **sí** tiene archivos.

### 8 · Rutas: parecerse a las vecinas no es estar medida (v0.2.0)

La ficha de un número de parte es **`/PartNumbers/<id>`, SIN prefijo de dominio**. La primera versión
antepuso `/Domains/<d>/` por analogía con el resto de rutas de la app (`/Domains/344/Shipping`,
`/Invoices`…) y daba 404. **El dato estaba en el propio repo y no se leyó**: `pn-specs-column` ancla
a `a[href^="/PartNumbers/"]`. Una ruta inventada por simetría falla igual que una adivinada.

En cambio `/api/files/<userFile.name>` **sí se midió** antes de usarla: HTTP 200, `application/pdf`.
Cierra R4 y sostiene tanto los enlaces como la descarga para imprimir.

### 9 · Una query bien elegida borra tres rodeos (v0.3.0)

El scan que aportó el operador destapó que **`GetPackingSlip({idInDomain, revisionNumber})`** devuelve
de una sola vez lo que el applet conseguía por tres caminos distintos:

| Campo | Qué sustituyó |
|---|---|
| `customerByCustomerId.customInputs` | leer la tabla de atrás → `CustomerSearchByName` → `Customer` |
| `partNumbersIncluded.nodes[].{id,name}` | `SearchPartNumbers` **y con él todo el problema de homónimos** |
| `packingSlipPdfsByPackingSlipId[].filename` | el PDF de la remisión, que no aparecía por ningún lado |

Lo notable del segundo: el bug de los homónimos **no se arregló, se volvió imposible**. Ya no hay que
resolver un nombre a un id, así que no hay a quién equivocarse. Arreglar la causa venció a blindar el
síntoma — y el blindaje (unir homónimos) se quedó igual, como respaldo.

**Todo lo anterior se conservó como RESPALDO.** Si `GetPackingSlip` falla o la revisión no es la
pedida, cae a la cadena vieja en vez de quedarse mudo. Un anclaje no se cambia, se amplía.

### 10 · El enlace del modal jamás iba a servir para imprimir

El botón «Click to View Packing Slip #NNNN» apunta al **portal del cliente**
(`/…/cu/…/PackingSlips/<id>?token=…`): HTML con token de acceso, no un PDF. Por eso la impresión
fallaba. Se detecta la firma `%PDF` antes de dárselo a `pdf-lib`, y el aviso dice **qué hacer**, no
qué excepción se lanzó.

⚠️ Ese token da acceso al portal del cliente: **no se registra en código, logs ni bitácora.**

### 11 · No etiquetar lo que sólo se está adivinando

El panel mostraba «(plano)» / «(foto)» junto a cada archivo. El operador lo objetó con razón: es una
**heurística por extensión vestida de hecho**, y hay fotos en PDF y planos en JPG.

> La heurística se quedó donde es honesta —decidir qué viene **premarcado**, que es una sugerencia
> reversible de un clic— y desapareció de donde afirmaba. Una etiqueta impresa junto al archivo tiene
> autoridad que la heurística no se ganó.

En su lugar, **miniaturas**: imágenes como `<img>` y **PDF rasterizados con `pdf.js` sobre `<canvas>`**
(serial, tope de 12 por panel — cada una descarga y rasteriza, y en paralelo congelaría la pestaña).
Que el operador vea el archivo es mejor respuesta que cualquier etiqueta.

### 12 · El panel va en estilo NATIVO, no dark mode

Excepción deliberada a la regla del repo, con **precedente exacto encontrado en vivo**: SH ya tiene
en este mismo modal una fila **«Incluir Certificado»** con checkbox y link. Nuestro panel es su
hermano; verse igual es mejor UX que gritar «soy de la extensión». La autoría se marca con el **📐**
del label y el atributo `data-sa-ps-drawings`.

## Estados de la UI (los tres no se confunden entre sí)

| `IncluirPlanos` | Qué hace |
|---|---|
| `true` | Panel completo, PDF premarcados |
| `false` | **Applet inerte, cero UI** — correcto para 74 de 81 clientes |
| `null` | Panel visible, **nada premarcado**, ámbar «no pude verificar si este cliente pide planos» |

Y dentro del panel:

- **ámbar «sin plano»** — el cliente los pide y el NP no los tiene (el 77%);
- **ámbar «no pude verificar»** — no se resolvió el NP. **No es lo mismo que «no tiene».**

## Arquitectura

| Archivo | Responsabilidad |
|---|---|
| `packing-slip-drawings-core.js` | Decisión pura: `readIncluirPlanos` · `classifyFile` · `buildAttachmentPlan` · `toAttachments` |
| `packing-slip-modal-core.js` | Reconocimiento puro: `isShippingEmailModal` · `extractPartNumbers` · `extractPackingSlipNumber` · `findCustomerName` |
| `packing-slip-print.js` | `printCombined` — cose con `pdf-lib` e imprime por iframe |
| `lib/pdf.min.js` | `pdf.js` para rasterizar la miniatura de los PDF (ya lo usaba `po-reconciler`) |
| `packing-slip-drawings.js` | Glue: interceptor, observer, panel |
| `lib/pdf-lib.min.js` | Librería (artefacto, 525 KB) |

**Dos núcleos y no uno** porque el de decisión no sabe qué es un `<tr>` y el de modal no sabe qué es
un plano. Así el golden test del DOM no arrastra la lógica de clasificación.

`pdf.js` **lee**, `pdf-lib` **escribe y cose**: son complementarias. Rasterizar con `pdf.js` habría
degradado justo las cotas finas de los planos, que es lo que el cliente exige impreso.

**Tests:** 26 (`packing-slip-drawings-core`) + 29 (`packing-slip-modal-core`) = **55**.

## Deuda declarada

| Qué | Estado |
|---|---|
| Heading del modal en **ES** | **No medido** — salió en EN con la app en ES. Los patrones ES del núcleo son *candidatos*, no traducciones verificadas |
| Fila «Attachments» en ES | No medida; se aceptan `adjuntos`/`archivos adjuntos` como candidatos |
| Tooltip del botón en **EN** | No medido (en ES es «Enviar Albarán») |
| `SendIcon` / `CloseIcon` en el catálogo de formas | Siguen sin medir. **El modal de remisión tiene ambos** y ya se abrió con permiso: es una llamada de un renglón la próxima vez |
| Módulo de Envío (`/Shipping`) | El `urlPatterns` lo cubre, pero **el panel no se probó ahí**. Si la lista no tiene el formato `#\d+ / Cliente`, degrada a ámbar «no pude verificar» (seguro, pero menos útil) |
| Ruta de descarga `/api/files/<name>` | ✅ **VERIFICADA en vivo**: HTTP 200, `content-type: application/pdf` |

## Lo que YA se verificó en producción (2026-08-05)

| Verificación | Resultado |
|---|---|
| Los 5 módulos cargan (`applet`, `core`, `modalCore`, `print`, `PDFLib`) | ✅ los 5 como `object` |
| El panel se monta bajo la fila Attachments | ✅ con label 📐, ámbar y botón de imprimir |
| Se monta **una sola vez** (tras el fix) | ✅ `filasNuestras: 1` |
| El heading detectado | ✅ `Send Shipping Email` |
| Los 5 scripts se sirven desde GitHub Pages | ✅ HTTP 200 (un 503 transitorio que se resolvió al reintentar) |
| Firma ECDSA del config en vivo | ✅ verifica en 1.11.67/68/69 |
| Suite completa | ✅ 105 archivos, 0 rojos |

## Estado de los riesgos (todos cerrados)

| # | Riesgo | Cómo se cerró |
|---|---|---|
| **R1** | Nombre de la mutation de envío | `SendEmailChecked`, capturada en vivo; su hash **coincide byte a byte** con el de `config.json` |
| **R2** | Cómo resolver remisión → NP | `GetPackingSlip.partNumbersIncluded` da los NP **con su id** |
| **R3** | `cfdi-attacher` y este applet en el mismo modal | Separados por heading + umbral de switches; probado con ambos activos |
| **R4** | ¿El adjunto llega al correo? | ✅ **Validado por el operador con un envío real** (2026-08-05) |
| **R7** | PDF de la remisión para imprimir | `packingSlipPdfsByPackingSlipId[].filename` (se prefiere `isFinalized`) |
| **R8** | El payload congela la pestaña | Guardas baratas antes del `JSON.parse`; sin regex globales |

## Lo que queda abierto (menor)

- **Deuda bilingüe**: heading del modal en ES y fila «Attachments» en ES **no medidos** (el modal sale
  en inglés con la app en español). Los patrones ES del núcleo son *candidatos*, no traducciones
  verificadas. La red estructural (≥4 switches) los sostiene mientras tanto.
- **`revisionNumber`**: se pide siempre `1`. Una remisión con revisión >1 caería al respaldo (la
  cadena vieja), que sigue funcionando. No se ha visto un caso real.
- **`SendIcon` / `CloseIcon`** siguen sin medir en el catálogo de formas, aunque el modal de remisión
  tiene ambos.
