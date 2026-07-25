# wo-label-pdf-buttons — Botones de impresión de PDF en el listado de OTs (SPEC)

**Estado:** ✅ **VIVO (config 1.7.201, 2026-07-24) — JobTag (🏷️) validado en producción + Verbose (📋) expuesto.** Botones **🏷️ JobTag y 📋 Verbose en la columna Acciones** del listado `/Domains/<d>/WorkOrders` (toggle "🏷️ Etiquetas" del applet `wo-listing-columns`). Genera el JobTag en un **IFRAME OCULTO** dentro del dashboard → **sin abrir pestaña (no roba foco) y sin throttle (rápido)** → auto-descarga `WO<idInDomain>.pdf`. **Fallback automático a pestaña** (`?sa_print=jobtag&sa_dl=1`, lo maneja `wo-schedule-button` invisible) si SH bloquea el enmarcado o el iframe falla. Validado en vivo por el operador: **4/5 en iframe sin pestaña; el 5º cayó a pestaña por hipo de sesión bajo carga (degradó con gracia)**. Commit del iframe `a4bff19`.

## ⚠️ Diseño FINAL VIVO (iframe) — LEE ESTO PRIMERO (supersede las "Fases" de abajo)

El 🏷️ del listado ya **NO abre pestaña** por default. `wo-listing-columns.driveLabel()`:
1. Crea un `<iframe>` **oculto offscreen** (1400×950, `left:-10000px`, opacity:0 — NO `display:none`, que impediría render) con `src = /Domains/<d>/WorkOrders/<idInDomain>` (sin `?sa_print`; la extensión **no** inyecta en iframes —manifest sin `all_frames`—, pero el iframe es **same-origin** → el PADRE en `world:MAIN` maneja su DOM directo).
2. Espera el trigger dentro del iframe (`findTriggerIn` → ancla `data-steelhead-component-id="WORK_ORDER_PAGE_HEADER_PRINT_JOB_TAGS_BUTTON"`), lo clickea (`clickRobustIn` con `iframe.contentWindow.MouseEvent`), espera el botón "Imprimir Regular" del modal (dropdown poblado + no "Cargando"), `sleep(900)` anti-blanco, clickea, toma la **share-URL del `<object>`** (`findShareUrlIn`), **descarga desde el PADRE** (`downloadShort` repone `?downloadName=WO<num>.pdf`), y **quita el iframe**.
3. **Tope de concurrencia 4** (cada iframe carga un SPA completo → pesado). Estado del botón: **⏳** generando · **✅** ok · **⋯** en cola.
4. **Fallback:** si el trigger/share-URL no aparecen en el timeout (enmarcado bloqueado o hipo de sesión) → `window.open(... ?sa_print=jobtag&sa_dl=1)` (pestaña; `wo-schedule-button` la auto-maneja y auto-descarga + auto-cierra).

**Filename:** `WoScheduleCore.buildPdfFilename` da **`WO<idInDomain>.pdf`** (verbose: `-verbose`). La URL interceptada de `GetPdfTemplateOutputV2` NO trae `?downloadName=` → se **repone** con el nombre corto.

**Estado de tipos y robustez (VIVO 1.7.201, commit `736e22b`):**
- ✅ **JobTag** (🏷️) — validado en vivo.
- ✅ **Verbose** (📋) — **EXPUESTO**: 2º botón en Acciones junto al 🏷️ (`LABEL_TYPES`, idempotente por `data-sa-print-type`). Mismo iframe con `typeKey:'verbose'` → "Imprimir Detallado" (orden 1, `GetVerboseTraveler`, template "Orden de Trabajo Completa") → descarga `WO<num>-verbose.pdf`.
- ✅ **Retry del iframe** — `driveLabelCore` reintenta el iframe UNA vez (respiro 600ms, estado `↻`) antes de caer a pestaña → menos fallbacks por el hipo de sesión bajo carga.

**Pendientes reales:** (a) **WorkOrder PDF** (3er tipo) = botón nativo "Abrir PDF", flujo distinto al modal de etiquetas — sin cablear. (b) Los warnings `onFull: ERROR … predictedInventoryUsages` en consola son del **SPA de SH dentro del iframe** (no nuestros) — no suprimibles. (c) **Bundle Safari/iPad** desactualizado (se tocaron paros/vale) — recompilar Xcode.

---

### (Histórico — enfoque previo de pestaña, superado por el iframe de arriba)

## Mecanismo confirmado (2026-07-24)

El PDF se genera **server-side** (PDFGeneratorAPI) y se entrega como **share-URL** que el modal de preview muestra en un `<object>`:
```
<object data="https://app.gosteelhead.com/api/pdf/share/14798/<token>?downloadName=work-order-part-number-15550.pdf" type="application/pdf">
```
`shareId 14798` es constante; el token cambia por render. **Todos los lugares de impresión usan el mismo mecanismo** (`GetPdfTemplateOutputV2(template,data)` → share-URL; solo cambian query de datos + template por tipo). El `data` lo arma el front → **no lo reconstruimos**; **auto-manejamos** el flujo nativo y tomamos la URL del `<object>`.

**Flujo nativo (DOM real, ficha `/Domains/<d>/WorkOrders/<idInDomain>`):**
1. Botón header **"Imprimir Etiquetas de Trabajo"** (`button.MuiButton-outlined` + `svg[data-testid="QrCode2Icon"]`, misma barra que el readout de programación).
2. Modal **"Imprimir Etiqueta de Trabajo"**: 2 filas, cada una = dropdown de plantilla + botón `MuiButton-contained` **"Imprimir Regular"** (JobTag, orden 0) / **"Imprimir Detallado"** (Verbose, orden 1). + "Cancelar".
3. Modal preview **"Vista Previa de Etiqueta de Trabajo"** con el `<object data="…/api/pdf/share/…">` → de ahí sale la URL.

## Diseño FINAL (decisión del usuario 2026-07-24): botón SOLO en Acciones del listado

**En la ficha NO se pone botón** ("dentro de la WO no tiene caso"). El botón vive en la
columna **Acciones** del dashboard general (`/Domains/<d>/WorkOrders`). La ficha solo hace
el auto-manejo **INVISIBLE**, disparado por `?sa_print=`.

### `wo-listing-columns.js` — botón 🏷️ en Acciones (por fila)
- **4º toggle "🏷️ Etiquetas"** (`sa_wo_labels_enabled`, persistente, default OFF). Al activar,
  inyecta un botón 🏷️ (acento verde) en la **celda NATIVA de Acciones** de cada fila (la que
  tiene Editar/Archivar; anclaje por `svg[data-testid="EditIcon"|"ArchiveIcon"]` idioma-agnóstico,
  fallback última td). Re-inyecta en cada sync (idempotente por fila, sobrevive el re-render).
- **Click** → abre `/Domains/<d>/WorkOrders/<idInDomain>?sa_print=jobtag` en **pestaña nueva**
  (user-gesture → no lo bloquea el popup blocker). **Por-OT (una a la vez) → sin el techo ~16-20**
  de merge de PDFGeneratorAPI en batch.

### `wo-schedule-button.js` — auto-manejo INVISIBLE en la ficha (sin botones)
- **`maybeAutoPrintFromParam()`**: en la ficha, si `?sa_print=jobtag|verbose` → espera el botón
  nativo "Imprimir Etiquetas de Trabajo" (hasta 15s) → `autoPrint(tipo,'self')`. `window.__saWoPrintFired`
  evita doble disparo; se resetea en cada nav.
- **`autoPrint(typeKey, openTarget)`**: click trigger nativo → espera modal → click "Imprimir
  Regular/Detallado" (por texto ES, fallback por ORDEN + QrCode2Icon) → espera el `<object>` con la
  share-URL → navega la pestaña al PDF (`'self'`) o la abre (`'newtab'`) → cierra modales (sin preview).
  **Fail-safe:** ante fallo deja el modal nativo abierto + toast (no deja colgado al operador).

### Core puro (`wo-schedule-core.js`) — +5 golden tests
`PRINT_TYPES`, `parsePrintParam`, `isPdfShareUrl`/`parsePdfShareUrl`, `buildPdfFilename`,
`isPrintDialogHeading`/`isPrintPreviewHeading`. **Deuda bilingüe:** textos del modal en ES confirmados;
EN sin capturar (el anclaje primario del botón del modal es ESTRUCTURAL —order + QrCode2Icon—, el texto
solo confirma). **Sin hash nuevo ni cambio de `config.json`** (el auto-manejo dispara la UI nativa; SH
llama `GetPdfTemplateOutputV2`, nosotros no).

### Estado / pendientes
- **MVP = JobTag** (el prioritario). El toggle inyecta el botón; el flujo completo
  (listado → pestaña nueva → ficha auto-maneja → PDF) **PENDIENTE de validación EN VIVO**
  (el timing/selectores del modal no se testean headless). Riesgo bajo: aditivo, no-destructivo, fail-safe.
- **Verbose**: `autoPrint` ya lo soporta (`?sa_print=verbose`); falta exponerlo en el botón (menú) tras validar JobTag.
- **WorkOrder PDF** (3er tipo): es el botón nativo **"Abrir PDF"** del header (flujo distinto al modal de
  etiquetas); se suma como `?sa_print=wo` (drive de "Abrir PDF") en una iteración posterior.

---

## (Análisis original) Estado previo

## Qué se pide

Producción quiere, en la columna **Acciones** del listado `/Domains/<d>/WorkOrders`, botón(es) para **regenerar el PDF de las etiquetas** de la OT. Hay **3 PDFs imprimibles** distintos; el que piden es el **JobTag**, pero se busca colocar los tres:

1. **JobTag** (etiquetas de contenedor) — el prioritario.
2. **Verbose** (traveler verboso).
3. **WorkOrder PDF** (PDF de la orden).

Idealmente **headless** (sin el modal de preview), pero el usuario lo dejó como deseo, no requisito duro ("no sé si podemos… aunque no salga el modal de preview").

## Arquitectura de los 3 flujos (decodificada del escán, con variables reales)

Cada flujo = **query de datos** → (ensamblado en cliente) → **`GetPdfTemplateOutputV2`** que renderiza y devuelve el PDF (`pdfTemplateOutputV2`, escalar).

| Flujo | Query de datos | Variables reales capturadas |
|---|---|---|
| **JobTag** | `DataForPrintTravelersMinimal` | `{ workOrderIds: [<woGlobalId>], partNumberIds: [<pnId>] }` |
| **Verbose** | `GetVerboseTraveler` | `{ workOrderIds: [<woGlobalId>], partNumberIds: [<pnId>] }` |
| **WorkOrder PDF** | `GetWorkOrderLowCodePdf` | `{ idInDomain: <woIdInDomain> }` |
| (label de PN suelto) | `PartNumberLowCodePdf` | `{ id: <pnId> }` |
| **Renderizador común** | `GetPdfTemplateOutputV2` | `{ docs: [{ template: <templateId>, data: {…gigante…} }] }` → `pdfTemplateOutputV2` |

- **Template del JobTag confirmado: `1296783`.** Los templates de Verbose y WorkOrder aún NO capturados (falta disparar esos 2 flujos con el escáner, o leer `GetPdfTemplates`/`GetPdfConfigsByType`, que salieron **hash-only**).
- `workOrderIds`/`partNumberIds` son **ids GLOBALES** (no idInDomain). El listado ya resuelve el `woGlobalId` (vía `PartNumbersByWorkOrderIdInDomain.workOrderByIdInDomain.id`) y el `pnId` (mismo query) — así que las variables de las 3 queries de datos **son derivables por fila**.

## Por qué el headless "reconstruir desde cero" está DESCARTADO (evidencia)

`GetPdfTemplateOutputV2` recibe `docs[].data` = un objeto **enorme ensamblado en el cliente** por el motor low-code de SH. Top-level keys del `data` del JobTag (template 1296783), scan real:

```
partNumber (con customInputs, specs[8], unitConversions[8], rackTypes, labels[4]),
selectedPartsTransferAccount, otherPartGroups, allPartsOnWorkOrder,
partGroup, treatments[39], treatmentOverrides, treatmentsWithDetails[39],
receivedBatches (con receivers), partQty, partQtyInGroup, timezone,
receivedOrder, bomItemShipToAddresses, workOrder, partNumberWorkOrder,
customer (todos sus datos fiscales), recipe, logoUrl, origin,
domain (tinPrice/zincPrice/…/TipoCambio[237]/DiasInhabiles[36]), currentUser,
additionalPayload.pdfsToGenerate[] (por contenedor)
```

`additionalPayload.pdfsToGenerate[]` trae **strings ya computados en cliente**: `factoresDisplay: "1.35 KG/pz · 5.15 DM2/pz · 0.16 LM/pz"`, `convertedQuantities: ["4.05: KGM Kilogramo", …]`, `combinedExternalSpecs.markdown`, `containerDisplay: "1/1"`, etc.

→ Reconstruir esto sería **reversar TODO el data-binding low-code de SH** (formateos, conversiones de unidad, specs combinadas, un tag por contenedor). Frágil, no mantenible, y **adivinado** (contra la regla del repo: no reconstruir transforms/DOM a ojo). **DESCARTADO.**

## Enfoques viables (decisión del usuario — PENDIENTE)

- **A) Hijack del flujo nativo (headless, sin preview) — RECOMENDADO.** El botón dispara el print nativo del JobTag, **deja que SH arme el `data` y renderice**, e **intercepta** (fetch interceptor sobre `GetPdfTemplateOutputV2`) el PDF ya generado → lo descarga/abre solo y oculta el modal. No reconstruimos nada. **Riesgo/desconocido:** dónde se puede DISPARAR el print — si el listado no expone el print por fila, hay que **navegar a la ficha** (`/WorkOrders/<id>`, ancla `WORK_ORDER_PAGE_HEADER_PRINT_JOB_TAGS_BUTTON`) y autodisparar.
- **B) Un clic al modal nativo (con preview).** El botón solo ABRE el modal nativo apuntando al JobTag (menos pasos que hoy); el preview aparece y el operador confirma. Lo más simple y robusto; no headless.

## Desconocidos a resolver cuando el usuario vuelva

1. **Decisión A vs B** (enfoque).
2. **DOM de la columna Acciones del listado** (wrapper HTML) — regla del repo: pedir el wrapper antes de escribir selectores. ¿Hay un menú de acciones por fila? ¿Expone "imprimir"?
3. **Dónde se dispara HOY el generador** ("en otro contexto abre un modal") — ¿en la ficha de OT (Print Job Tags), en la ficha del lote, en recibo? Esto define si el hijack corre en el listado o requiere navegar.
4. **Qué devuelve `pdfTemplateOutputV2`** exactamente — ¿base64 del PDF? ¿URL a `/api/files`? ¿data-uri? (El escán solo dio la forma `["pdfTemplateOutputV2"]`, no el valor.) Define cómo lo descargamos/abrimos.
5. **Templates de Verbose y WorkOrder PDF** — capturar disparando esos 2 flujos (solo tengo el del JobTag = 1296783).

## Inventario de hashes (registrar en `config.json` al construir)

```json
"DataForPrintTravelersMinimal": "7708a31478e82216ae914557f3c56fe14c5a04eb50d5632ce1df665692eec8ab",
"GetVerboseTraveler":           "9928638f6feb5627fb103e3048d56c777095aae68043c690ace2dd643d482b6d",
"GetWorkOrderLowCodePdf":       "917b06ef184473b3b62ca562014583c8298ca12ab06bafb05fe9f4b7bd0db6ea",
"GetPdfTemplateOutputV2":       "8e5833feca445b4a4c772f0e8722723c0cd827ffc6910f0d7d8e272e0ad81b0c",
"PartNumberLowCodePdf":         "fefd3e10ad9b2befee0f4ddc1b21fa1b23036b97effffd1960d96ece8d542227",
"GetPdfTemplates":              "7db90aba15dd0f414c283523dd607d91a4e29c45de7aa27c279c5a4e4e152e5e",
"GetPdfConfigsByType":          "6902481b90f8da330f21bf484a847b1240260ec583e44a1c7456d532f23b5b34",
"GetCustomerPdfConfigs":        "82ec2501399d0d12332cbfb5cb3fe9d48ec04ea1b61c5d0b08bc9e10a205d3b1"
```

Nota: si el enfoque final es **A (hijack)**, probablemente NO haga falta registrar `GetPdfTemplateOutputV2` como query nuestra (SH la dispara; nosotros solo interceptamos su respuesta). Si algún flujo lo llamamos nosotros, cada hash necesita **ruta de regeneración** en `hash-autopilot` (regla del repo: hash sin ruta = deuda).
