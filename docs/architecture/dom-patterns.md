# Trabajo con UI / DOM de Steelhead

**ANTES de empezar a escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del bloque relevante** (el padre cercano que contiene tanto los labels visibles como los inputs/comboboxes). NO adivines la estructura iterando deploys — perdimos varias rondas en `invoice-autofill` (0.5.16 → 0.5.25) asumiendo `<label for>` cuando el modal manual usaba `<p>Label:</p>` con el field como SIBLING. Una sola inspección del wrapper hubiera resuelto todo en un commit.

## Regla: anclar por ESTRUCTURA idioma-indep; el texto es último recurso (estándar 2026-07-17)

Todo anclaje al UI de Steelhead debe ser **idioma-independiente** siempre que sea posible. La
UI de SH cambia de idioma por usuario/config y a veces es **mixta** en el mismo modal, así que
cualquier dependencia de texto visible es frágil por diseño — **incluso el texto bilingüe** (no
cubre un tercer idioma ni un cambio de wording de SH). El objetivo es **blindar a futuro**, no
solo tapar el locale de hoy.

### Jerarquía de anclaje (usa el primero disponible; nunca bajes de nivel sin necesidad)

1. **Handles semánticos estables** — lo mejor:
   - `data-steelhead-component-id="…"` (contenedores; ej. `CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS`, `PART_NUMBER_PAGE_UNITS`).
   - `data-testid="…"` (iconos MUI: `SendIcon`, `TodayIcon`, `CheckBoxIcon`, `DeleteIcon`…).
   - ids RJSF `root_<field>` (`root_DatosContables_Divisa`, `root_DatosPrecio_*`), `id="form-dialog-title"`.
   - `aria-label`, `role` (`dialog`, `tab`, `combobox`), `input[type=…]`, `href`/patrón de URL.
   - **Datos idioma-indep**: códigos de unidad (KGM/LBR/DMK…), IDs, `option[value]` (`USD`/`MXN`).
2. **Posición estructural relativa a (1)** — cuando (1) acota el bloque: "el `input[type=number]`
   dentro del panel", "el `<p>` cuyo 1er token es un código de unidad", "la última `<th>`",
   "el 2º input de la fila = recíproco" (patrón por POSICIÓN de `unit-autoconvert` Panel B).
3. **Texto bilingüe ES+EN** — **solo** donde SH no expone ningún handle estable. Con **ambos**
   strings confirmados (nunca adivinar la traducción). Marca la deuda si solo tienes uno.
4. ❌ **NUNCA** clases CSS hasheadas (`css-q6y9ln`, `css-4w3ppi`, emotion/MUI) — regeneran en
   cada build de SH; son **más** frágiles que el texto.

### Realidad a aceptar

- **No todo elemento tiene handle estable.** Ej.: la columna "Income Account" (invoice-autofill)
  solo tiene texto + clase hasheada + react-select de id dinámico. Ahí "volverlo HTML" = anclar
  por **posición** (frágil) o texto bilingüe. No inventes estructura que SH no da.
- **Evidencia primero (regla dura):** antes de reanclar, pide/consigue el **wrapper HTML** del
  bloque. No adivines ni la estructura ni la traducción.
- Hallazgo 2026-07-17: los **modales contables** de SH (Bill, líneas de factura, unit
  definitions) renderizan sus **etiquetas en inglés** aun con la instancia en español (solo los
  datos salen en ES). No urge traducir esos anclajes, pero **sí** conviene migrarlos a
  estructura cuando el handle existe (ej. bill-gate → `#root_DatosContables_Divisa`).
- **Matiz 2026-07-27 (importante): "los modales de SH están en inglés" NO es regla confiable.**
  En UNA MISMA pantalla conviven ambos idiomas. Medido con la instancia en español, modal Editar NP:
  el panel de unidades sale **en inglés** (`Per Part Count Unit Definitions:`, `KGM Kilogramo / Part:`
  — confirma el hallazgo de arriba), pero el sub-modal de precio que se abre DESDE ese mismo modal
  sale **en español** (`Precio del número de parte`), y su `window.alert` también
  (`Error al guardar el precio`). Conclusión: **no extrapoles el idioma de un modal a su vecino**;
  cada anclaje necesita su propia evidencia — o mejor, no depender del idioma.

Patrón bueno de referencia: `proceso-calculator.findProcessControl()` (component-id primario +
texto fallback), `report-regen`/`sensor-graph-hide-all` (por `data-testid`), `bill-autofill`
gate (fallback `[role=dialog] #root_DatosContables_Divisa`). Inventario y estado de migración
en [`bilingual-anchoring-debt.md`](bilingual-anchoring-debt.md).

### Por qué la jerarquía existe: el caso medido de `price-confirm-guard` (2026-07-27)

El gate del candado de precio era `MODAL_TITLE_RE || hasPriceSchema`. Medido EN VIVO con la UI en
español, con el modal abierto:

```
gatePorTitulo: false     ← /Part Number Price/i nunca matcheó (el modal se llama
                            «Precio del número de parte»)
gatePorSchema: true      ← lo ÚNICO que sostenía el candado
```

Dos lecciones que valen para cualquier applet:

1. **Un anclaje de texto que falla no truena: se apaga en silencio.** El candado llevaba semanas
   dependiendo por completo del ancla estructural sin que nadie lo supiera, y antes de que ésta
   existiera (`dc0717b`, 2026-07-16) simplemente **no se disparaba** en ese flujo. En un guard eso
   significa que la operación protegida pasaba sin protección. Por eso el nivel 3 (texto) **nunca**
   debe ser la única señal de un gate.
2. **Adivinar la traducción falla aunque "suene bien".** `bilingual-anchoring-debt.md` traía dos
   hipótesis y **las dos eran incorrectas**: «Precio de Número de Parte» (real: «Precio d**el**
   número de parte») y «Error al guardar precio» (real: «Error al guardar **el** precio»). Un regex
   derivado de cualquiera habría fallado en silencio.

Forma final (v0.1.5): decisión pura `PriceConfirmCore.isPriceModal({hasPriceSchema, title})` —
estructura decide, texto ES+EN solo **amplía**— y el glue cae a la señal estructural si el core no
cargó. **El texto como red de seguridad nunca debe poder REDUCIR el match.**

## Inspección en vivo por automatización de Chrome (MCP)

Cuando inspecciones la SPA con las herramientas de navegador en vez de pedir el wrapper HTML:

- **La ventana de Chrome NO puede quedar tapada por completo.** Si otra app (terminal/IDE en
  pantalla completa) la cubre al 100%, Chrome la marca `hidden` por **detección de oclusión** y
  **congela la página**: `setTimeout` estrangulado, respuestas de `fetch` que **nunca resuelven**,
  screenshots que expiran y `Runtime.evaluate` reventando a los 45s. Se ve idéntico a "el ERP está
  caído" — perdí varios intentos creyendo eso.
- **Abrir ventana nueva en vez de pestaña NO basta** (medido): nace detrás y se congela igual.
  Y **`tabs_context_mcp{createIfEmpty:true}` tampoco garantiza ventana nueva** — su descripción
  dice que crea una, pero medido el 2026-08-04 **reusó la ventana existente y sólo agregó una
  pestaña**. No hay herramienta MCP que fuerce ventana nueva; lo que sí funciona es que el
  usuario deje la ventana **asomada a un costado**, y entonces basta esa franja.
- **CHEQUEO OBLIGATORIO antes de cualquier lote largo:** leer `document.visibilityState`. Si dice
  `hidden`, **no arranques** — pídele al usuario que destape la ventana. Un lote de 246 peticiones
  lanzado en `hidden` no falla: se queda quieto.
- **La firma del congelamiento en un LOTE es «0 hechas y 0 errores»**, y es la que más engaña.
  Un fetch que no resuelve, en singular, se nota; pero un pool que reporta `0/246 · err:0` parece
  saturación del servidor —incluso encaja con el modo de falla real del `/graphql` bajo ráfaga—
  y lleva a concluir «hay que esperar a que el ERP se destrabe». **La diferencia se mide en un
  segundo**: un `fetch` suelto con `AbortController`. Si responde en ~200 ms, el ERP está
  perfecto y el problema es la pestaña. Pasó el 2026-08-04: se declaró saturado el endpoint, se
  abortó la corrida y se recargó la pestaña «para no castigarlo»; con la ventana destapada el
  mismo fetch tardó **222 ms**. **Ese diagnóstico lo aportó el operador, no la medición** — el
  costo de no haber leído esta sección antes.
- **No necesita el foco.** Medido con la ventana apenas destapada (1710 → 1576 px, o sea 134 px
  asomando): `visibilityState:"visible"`, `hasFocus():false`, `setTimeout(300)` → 302 ms, rAF 1 ms,
  fetch 120 ms. Basta con que asome una franja; el teclado se queda en el editor.
- **Los `window.alert` nativos bloquean TODO** (JS, screenshots, inyección) y **solo el usuario
  puede cerrarlos**. Si un applet devuelve un error sintético que hace a SH lanzar un `alert`, lo
  vas a sufrir aquí — razón extra para suprimirlos bien.
- Mientras la página esté congelada, las esperas por **`MutationObserver`** siguen funcionando
  (sus callbacks no se estrangulan); los `setTimeout` no. Sirve como paliativo, no como solución.

## Patrones de label en Steelhead vistos hasta ahora

- **Forms RJSF (página invoice editada):** `<label class="control-label">` con input/select como sibling cercano. ID típicamente `root_<field>`.
- **Modal "Create Invoice Manually":** `<p class="MuiTypography-body1">Ship Date:</p>` (no `<label>`) seguido por `<div>...input...</div>` SIBLING. Para wrapper-de-un-solo-hijo, sube hasta el labelRoot que sea sibling del field.
- **Comboboxes react-select:** `<input role="combobox" aria-autocomplete="list">` dentro de `<div class="...-control">`. NO usar `value` setter — abrir con click, escribir search, click en option.
- **MUI X DatePicker (masked):** ignora native `value` setter; requiere keystroke-by-keystroke con `beforeinput`/`input` events.
- **react-datepicker (plain `<input type="text">`):** sí responde a native value setter + InputEvent.

## Leer el estado de un react-select: señal POSITIVA, nunca la ausencia del placeholder (2026-07-29)

Un react-select tiene **tres** estados, no dos, y el tercero es el que rompe los candados:

| Estado | `[id$="-placeholder"]` | `[class*="singleValue"]` |
|---|---|---|
| vacío | **sí** | no |
| con valor elegido | no | **sí** |
| **escribiendo sin elegir** | **no** | no |

Medido en el modal Recibir piezas del cliente: vacío = `css-qpe0ht-control` con «Buscar Ubicaciones...»; con valor = `css-1bsomep-control` con `singleValue`; **tecleando** = `css-1bsomep-control`, `input.value="A3Aduana"` y **ningún** `singleValue`.

Por eso **«no hay placeholder» NO significa «tiene valor»**: es una señal **negativa** y hereda todos los motivos por los que el placeholder puede faltar. En `warehouse-location-prefill` 0.6.0 eso liberaba el guardado de un renglón sin ubicación en cuanto el operador tecleaba en el combo (corregido en 0.6.1). La regla: **para decidir, exige la presencia del valor** (`singleValue`), no la ausencia del placeholder.

Consecuencia práctica: exigir la señal positiva obliga a poder **localizar el combo en cualquier estado** — y sin placeholder ya no se puede buscar por él. La vía que funcionó: hallar el nodo del label y tomar el primer `[class*="-control"]` que lo siga en **orden de documento** con `compareDocumentPosition`, que no depende de la forma del grid (el label vive en un `.css-xd9ivb` y el control es un nodo posterior, no un descendiente).

## Nodo inyectado en una tabla de React: el guard va sobre el DUEÑO, no sobre la existencia (2026-07-31)

React **recicla los `<tr>`**: al archivar, filtrar, ordenar o paginar reusa el nodo y le cambia el
contenido. Un nodo nuestro inyectado en esa fila **sobrevive al reciclaje**, así que el guard típico

```js
let td = tr.querySelector(':scope > .' + col.cls);
if (!td) { …crear, poner data-sa-<entidad>id y pintar… }   // si ya existía, no se toca nunca
```

deja la celda con el **id y el contenido de la entidad anterior**. Síntoma característico y fácil de
reconocer: **la celda nativa muestra la entidad correcta y las columnas nuestras muestran otra**,
coherentes entre sí porque vienen todas del mismo registro viejo. Recargar la página lo "arregla"
—se reconstruye el DOM— lo que despista: parece un problema de caché de datos y es de identidad de nodo.

**El daño no se queda en el dato viejo.** Si el applet reparte los resultados del fetch con
`querySelectorAll('[data-sa-…id="' + id + '"]')`, un atributo stale hace que la respuesta de la entidad
**anterior** se pinte sobre la fila de la **nueva**: la mentira se refresca sola.

**La regla:** todo nodo inyectado lleva **de quién es** y eso se **revalida en cada pasada**, no solo al
crearlo. La decisión va al core, pura y testeable:

```js
function isStaleNode(attrValue, id) {
  if (id == null) return false;                    // fila sin id: no está reciclada, no resuelve aún
  if (attrValue == null || attrValue === '') return true;   // nodo nuestro sin dueño
  return String(attrValue) !== String(id);
}
```

Dos bordes que importan y no son simétricos:
- **Sin atributo ⇒ reconstruir.** Un nodo con nuestra clase pero sin dueño no es confiable. En
  `wo-listing-columns` el atributo se ponía condicionado (`if (woIdInDomain != null)`), así que una
  celda nacida antes de que la fila resolviera su link quedaba **huérfana mostrando «—» para siempre**.
- **Sin id actual ⇒ NO reconstruir.** Una fila sin link no está reciclada: todavía no resuelve.
  Reconstruir ahí borra celdas buenas en cada sync y el `MutationObserver` entra en bucle.

**Es el mismo problema que la virtualización, con otro disfraz.** En `schedule-batch-highlighter` las
referencias a checkbox guardadas en un `Set` quedaban "muertas" al reciclar filas y el des-marcado por
referencia fallaba; ahí la salida fue barrer las filas visibles. En las tablas con celdas propias la
salida es revalidar la identidad. En los dos casos el error de fondo es el mismo: **un guard de
idempotencia que pregunta «¿ya lo hice?» en vez de «¿sigue siendo del mismo dueño?» no ahorra trabajo,
conserva una mentira.**

Casos: `pn-specs-column` 0.3.3 (reportado en piso al archivar un NP) y `wo-listing-columns` 0.8.2
(mismo molde; se encontró porque el operador pidió revisarlo). `isStaleNode` vive en los **dos** cores
—son applets de rutas distintas sin core común— con un test que corre ambas sobre los mismos casos y
**falla si divergen**. Los applets que construyen tablas **propias** en sus paneles (`archiver`,
`bulk-upload`, `cfdi-attacher`, `pn-lifecycle`, `spec-migrator`) **no** tienen este problema: nadie
recicla sus nodos.

## Deshabilitar un control de React: listener capture en el nodo, no `disabled` ni `className`

`disabled` y `className` los reescribe React en el siguiente render. Lo que sí sobrevive:

- **Bloquear el evento:** listener en **fase capture sobre el propio botón** con `stopPropagation()` + `preventDefault()`. React 17+ escucha en el contenedor raíz durante la **burbuja**, así que un capture en el nodo corre antes y su `onClick` nunca se dispara. **Medido en ambas direcciones** (2026-07-29, botón «Hoy» del modal de recibo): con el capture la fecha no cambia; sin él, 28→29.
- **Marcar el estilo:** un **atributo propio** (`data-sa-wlp-blocked`) + regla CSS global que cuelgue de él.
- **Re-aplicar:** si React re-crea el nodo se pierden ambos, así que el applet los repone en su observer/poll — de forma **idempotente**.

Es preferible al overlay de `warehouse-location-prefill` 0.5.78 (que sigue siendo lo correcto para tapar un widget entero como un react-select): el listener no depende de geometría ni de `z-index`.

## Auto-fill que reacciona a cambios del usuario

Patrones de cancellation tokens (`runId` monotónico + `myRunId` local + `bailIfStale()`), idempotencia de acciones "create", lectura label-driven de campos vs walking-up desde singleValues, y pausar fill mientras el usuario interactúa con el upstream input — documentados en detalle en [`../applets/invoice-autofill.md`](../applets/invoice-autofill.md).

El mismo patrón de cancellation token se aplica en `bulk-upload`, `process-deep-audit` y `spec-params-bulk` — ver sus bitácoras para variaciones específicas (pool concurrente con semáforo + `runPool(items, worker, concurrency, onProgress, myRunId)`).
