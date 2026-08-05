# `packing-slip-drawings` — Planos en Remisión

**Versión:** 0.1.2 · **Estado:** **DESPLEGADO Y VIVO** (config 1.11.69) · pendiente canario con
FISHER y verificación de adjunto/impresión
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

### 6 · El panel va en estilo NATIVO, no dark mode

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
| `packing-slip-modal-core.js` | Reconocimiento puro: `isShippingEmailModal` · `extractPartNumbers` · `extractPackingSlipNumber` |
| `packing-slip-print.js` | `printCombined` — cose con `pdf-lib` e imprime por iframe |
| `packing-slip-drawings.js` | Glue: interceptor, observer, panel |
| `lib/pdf-lib.min.js` | Librería (artefacto, 525 KB) |

**Dos núcleos y no uno** porque el de decisión no sabe qué es un `<tr>` y el de modal no sabe qué es
un plano. Así el golden test del DOM no arrastra la lógica de clasificación.

`pdf.js` **lee**, `pdf-lib` **escribe y cose**: son complementarias. Rasterizar con `pdf.js` habría
degradado justo las cotas finas de los planos, que es lo que el cliente exige impreso.

**Tests:** 26 (`packing-slip-drawings-core`) + 22 (`packing-slip-modal-core`) = **48**.

## Deuda declarada

| Qué | Estado |
|---|---|
| Heading del modal en **ES** | **No medido** — salió en EN con la app en ES. Los patrones ES del núcleo son *candidatos*, no traducciones verificadas |
| Fila «Attachments» en ES | No medida; se aceptan `adjuntos`/`archivos adjuntos` como candidatos |
| Tooltip del botón en **EN** | No medido (en ES es «Enviar Albarán») |
| `SendIcon` / `CloseIcon` en el catálogo de formas | Siguen sin medir. **El modal de remisión tiene ambos** y ya se abrió con permiso: es una llamada de un renglón la próxima vez |
| Módulo de Envío (`/Shipping`) | El `urlPatterns` lo cubre, pero **el panel no se probó ahí**. Si la lista no tiene el formato `#\d+ / Cliente`, degrada a ámbar «no pude verificar» (seguro, pero menos útil) |
| Ruta de descarga `/api/files/<name>` | **Sin verificar.** Sólo afecta a la impresión; si falla, se reporta en el resumen de «no entró» |

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

## Pendiente antes de darlo por bueno

**Canario con el operador presente.** Llegar **navegando** (no recargando — el gate por URL depende
del sondeo de `location.pathname`) a `/Domains/344/Shipping/PackingSlips`, abrir el correo de una
remisión de **FISHER CONTROLES DE MEXICO** —el único cliente con el check— y verificar:

1. **El fix de timing (v0.1.2)**: sobre un cliente con `IncluirPlanos: false` el applet debe quedar
   **INERTE** (cero UI). Si sigue saliendo el ámbar, el `waitForModalContent` no alcanzó.
2. Con FISHER: el panel lista los NP y **premarca los PDF**.
3. El ámbar del hueco en una remisión sin archivos (será lo común — 77%).
4. **No** aparece en el modal de factura (R3), con `cfdi-attacher` activo.
5. **R4**: el adjunto llega de verdad al correo (`userFile.name` citable sin re-subir).
6. **R7**: la impresión arma **un** PDF con la remisión primero y el plano legible.

> ⚠️ Al probar, **no encadenar decenas de queries antes**: el `/graphql` se cuelga por SESIÓN y eso
> produce falsos ámbar. Si algo se ve raro, recargar en frío y volver a medir.
