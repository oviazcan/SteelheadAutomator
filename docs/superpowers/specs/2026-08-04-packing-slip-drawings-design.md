# Spec: Planos en Remisión (`packing-slip-drawings`)

**Fecha:** 2026-08-04
**Estado:** Diseño aprobado — pendiente Fase 0 (reconocimiento en vivo)
**Applet propuesto:** `remote/scripts/packing-slip-drawings.js` + núcleo puro
`remote/scripts/packing-slip-drawings-core.js`

## Resumen ejecutivo

Cuando el cliente de una remisión (packing slip) tiene prendido el custom input
**`DatosLogisticos.IncluirPlanos`**, el applet adjunta al correo de esa remisión los archivos
vinculados a los números de parte que van en ella, con un panel de revisión previo. Cuando **no hay
plano que adjuntar**, lo dice en voz alta en vez de callarse.

El applet tiene **dos trabajos, no uno**:

1. **Adjuntar** los planos cuando existen.
2. **Delatar el hueco** cuando el cliente los pide y el NP no los tiene.

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

4. **Golden test** `tools/test/packing-slip-drawings-core.test.js`.

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
    "scripts/packing-slip-drawings-core.js",
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
silenciosa, así que gatearlo es seguro — a diferencia de `price-confirm-guard`. El patrón cubre
tanto `/Shipping` como `/Shipping/PackingSlips`. El `urlPatterns` definitivo se confirma en Fase 0
con la URL real donde vive el modal.

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

| # | Riesgo | Cómo se cierra |
|---|---|---|
| **R1** | **El correo de la remisión podría no pasar por `SendEmailChecked`.** Todo el diseño cuelga de esto. | **Fase 0**: reconocimiento en vivo. Bloqueante. |
| **R2** | No se sabe qué query del front resuelve **remisión → NPs**, ni qué trae `linkInfo` para un packing slip. En la DB el puente es `packing_slip_item → parts_transfer_account → part_number`; el equivalente GraphQL está por confirmar. | Fase 0 |
| **R3** | `cfdi-attacher` y este applet parchean `fetch` en la misma pantalla (`/Shipping/PackingSlips` está en el `urlPatterns` de `invoice-autofill` y el CFDI vive en el modal de factura). Encadenado de patches. | Fase 0 + prueba con ambos activos |
| **R4** | El adjunto por `{filename}` sin re-subir asume que el `userFile.name` es directamente citable como adjunto. | Fase 0: verificar con **un** archivo real antes de construir el panel |
| **R5** | Un plano escaneado en JPG no viene premarcado | Mitigado: está **visible** y a un clic. No se oculta nada. |
| **R6** | El snapshot DuckDB es de TLC; MTY no fue medido | El diseño no depende del volumen; el gate es por cliente. Verificar que MTY tenga el mismo grupo `DatosLogisticos` antes de habilitar ahí |

### Fase 0 — reconocimiento en vivo (bloqueante, antes de escribir el applet)

Sobre una remisión real de FISHER CONTROLES DE MEXICO, con el `hash-scanner` corriendo:

1. Abrir el modal de correo de la remisión y **capturar el wrapper HTML completo** (se le pide al
   operador).
2. Mandar el correo y registrar: **nombre de la operación** (¿`SendEmailChecked`?), el shape de
   `variables` (`linkInfo`, `attachments`), y las queries que carga la pantalla.
3. Identificar la query que devuelve los NPs del packing slip.
4. Verificar R4 adjuntando **un** archivo existente de un NP.

Fase 0 entrega: nombre de op, shape de `variables`, query de NPs, y el HTML del modal. **Sin eso no
se escribe el applet.**

## Plan de pruebas

- **Golden test del núcleo** (`node --test`), sin DOM ni red: las tres formas de `customInputs`;
  `null` ≠ `false`; clasificación por extensión incluyendo mayúsculas y nombres con puntos; dedup;
  premarcado; `pnsSinPlano`; plan vacío.
- **Cableado**: `popup-actions-wired.test.js` (el toggle necesita su `case` en el background) y
  `mui-icon-core-wiring.test.js` (el núcleo de iconos declarado en `config.apps[].scripts`).
- **En vivo, contra el ERP** (una búsqueda a la vez — el `/graphql` se cuelga bajo ráfaga):
  remisión de Fisher con PDF · remisión de Fisher sin ningún archivo (la mayoría) · remisión de la
  remisión 1387 (88 NPs) para el peso del panel · un cliente con `IncluirPlanos: false` para
  confirmar que el applet queda inerte · con `cfdi-attacher` activo simultáneamente.

## Fuera de alcance

- Subir planos faltantes (eso es `file-uploader`).
- Adjuntar planos al correo de **factura** (eso es el modal del CFDI).
- Adjuntar archivos que no cuelgan del NP (los de cliente, nodo de proceso o lote).
- Cerrar el hueco del 77% de NPs sin archivo — el applet lo **mide y lo delata**; llenarlo es
  trabajo de operación.

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
