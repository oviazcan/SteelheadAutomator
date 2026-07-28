# Carga de applets: por qué tardaba y cómo se acotó

**Estado:** **VIVO y validado en piso (2026-07-27)** — extensión **1.7.1**, 26 patrones activos.
El camino no fue recto: se publicó, causó una regresión al navegar dentro de la SPA (§B), se
apagó en minutos sin republicar la extensión, se corrigió la detección y se reactivó por canario
(§B.1). Falta que cada máquina actualice desde el banner del popup; hasta que lo haga, esa
máquina usa el loader viejo, que ignora `urlPatterns` y se comporta como antes. Diagnóstico
original reportado por el operador el 2026-07-27:
*"conforme vamos agregando applets, cada vez tardan más en cargar… en Purchasing no necesito
cargar ni vales de almacén ni paros de línea"*.

## El diagnóstico

Todo estaba en `extension/background.js`. Eran **cuatro** causas, no dos: las dos primeras
se documentaron en la sesión del diagnóstico, las otras dos aparecieron al implementar.

### 1. Se inyectaban TODOS los `autoInject` en TODAS las páginas

```js
const autoApps = (config.apps || []).filter(a => a.autoInject);
for (const app of autoApps) { … await injectAppScripts(tabId, app.id); }
```

El único filtro era `tab.url?.includes('app.gosteelhead.com')`. **No había gate por ruta.**
Cada applet ya tenía el suyo, pero corría **dentro** del script — o sea, después de pagar
descarga, verificación de firma y evaluación.

### 2. La inyección era SECUENCIAL

`for` con `await` dentro: 28 rondas en serie. Efecto secundario: el applet agregado más
recientemente queda **último** en `config.apps[]` y es el último en aparecer — por eso se
notaba justo en la pantalla donde se acababa de trabajar.

### 3. El mismo archivo se descargaba una vez POR APPLET

No había dedup. De las 79 descargas por carga de página, solo **53 eran de archivos
distintos**: `steelhead-api.js` se bajaba **24 veces**, `host-cleanup-shared.js` 3 veces.

### 4. `config.json` se bajaba y verificaba una vez POR SCRIPT ← el costo dominante

`fetchScriptCode()` llamaba a `loadConfig()` en cada archivo, y `loadConfig()` **siempre**
hacía fetch de `config.json` + `config.sig` y verificaba la firma ECDSA. El comentario
explicaba por qué (que la `version` del cache-bust fuera fresca), pero el costo real era:

| Por CADA carga de página | |
|---|---|
| Requests de red | **~237** (79 scripts + 79 config.json + 79 config.sig) |
| Verificaciones de firma ECDSA | **79** |
| Llamadas `chrome.scripting.executeScript` | **79** (una por archivo) |
| Lecturas de `chrome.storage.local` | **28** (una por applet, para el on/off) |

## Lo que se implementó

Toda la lógica de decisión vive en **`extension/applet-gate.js`** (módulo puro, sin APIs de
Chrome) y está probada en `tools/test/applet-gate.test.js` — **29 tests**.

### A. Gate por ruta (`urlPatterns` en el config)

```jsonc
{
  "id": "po-listing-filters",
  "autoInject": true,
  "urlPatterns": ["^/Domains/\\d+/Purchasing/PurchaseOrders/?(?:[?#]|$)"],
  "scripts": [...]
}
```

- **FAIL-OPEN por diseño.** Un app sin `urlPatterns`, con lista vacía, o con un patrón que
  no compila, se inyecta en todas partes — igual que antes. Un patrón mal escrito nunca deja
  al operador sin su applet; a lo sumo lo carga de más.
- **La fuente del patrón es el gate que el applet YA tenía** (`PO_URL_RE`, `SHIPPING_URL_RE`,
  `isScheduleBoardUrl`…). No se inventó ninguno.
- **La divergencia config↔applet está atada por tests**: para cada core que exporta su gate,
  el test exige la implicación *"si el applet dice que aplica en esa ruta, el config lo deja
  pasar"*. Si alguien aprieta un patrón de más, la suite se pone roja.
- El gate del applet **se queda**: es un filtro de CARGA, no de EJECUCIÓN.

### B. Navegación SPA — el punto que costó una regresión en piso

Steelhead cambia de pantalla con `history.pushState`, y ahí `chrome.tabs.onUpdated` **no**
vuelve a emitir `status:'complete'`. Con solo el gate de (A), el applet de la pantalla a la
que llegas **navegando** (que es lo normal) simplemente no existe.

**Primer intento (FALLÓ en producción, 2026-07-27).** Se atendió `changeInfo.url` sin
`status`, asumiendo que ese era el pushState. **No lo es de forma confiable.** Síntomas en
piso, a los minutos de publicar:

- Work Orders sin sus toggles de columnas (`wo-listing-columns` nunca llegaba).
- El botón de `report-regen` sin aparecer.
- **Bills mostrando `invoice-autofill` en vez de `bill-autofill`** ← el que delató la causa:
  `invoice-autofill` estaba ahí porque **sobrevivía en el `window` de la pantalla anterior**,
  mientras que `bill-autofill` —el que tocaba— nunca se inyectaba. Eso solo se explica si la
  inyección al navegar no está ocurriendo.

Se apagó el gate en **minutos y sin republicar la extensión**, moviendo los patrones a
`urlPatternsDisabled` (el loader ignora ese campo). Eso fue posible **solo** por el diseño
fail-open. Descartado por medición, no por intuición: el zip publicado estaba íntegro y los
**83 scripts servidos casaban con su hash firmado** — la otra hipótesis capaz de explicar los
tres síntomas a la vez, y peor, porque con el loader viejo un fallo de integridad aborta la
carga de todos los applets siguientes.

**Segundo intento (el que quedó).** La detección se hace desde **`content.js`**, que corre
DENTRO de la página:

- **Por sondeo de `location.pathname` cada 400ms**, no parcheando `history.pushState`: el
  content script vive en un **mundo aislado**; comparte el DOM con la página pero **no su
  objeto `history`**, así que un patch ahí no vería las llamadas del front. `location` sí
  refleja la URL real. Comparar un string cada 400ms es despreciable y funciona pase lo que
  pase del lado del front. Más `popstate`.
- El mensaje al background **despierta al service worker** si MV3 lo suspendió.
- `document.documentElement.dataset.saSpaNav` cuenta las navegaciones detectadas: testigo
  observable para validar en piso.
- Las inyecciones se **serializan por pestaña** (`Gate.makeSerializer`). Sin eso, la carga
  dura y el aviso de navegación pueden leer ambos un `__saLoadedApps` vacío e inyectar el
  mismo applet dos veces — así nacen las UIs duplicadas (el incidente de "los dos buscadores"
  en `schedule-batch-highlighter`).

La página lleva la cuenta de qué apps tiene (`window.__saLoadedApps`): vive ahí y no en el
service worker porque MV3 lo suspende, y porque ese latch debe morir con el `window`.

**Resultado neto: se re-inyecta MENOS que antes**, no más. Antes cada carga dura re-evaluaba
los 28; ahora, al navegar, solo entra lo que falta.

### B.1 Reactivación por canario (hecha)

Se reactivó en dos tiempos. Primero **`po-listing-filters` solo, como canario**: visible (el
buscador del header de Compras), de bajo riesgo y conocido por el operador. La prueba que
importaba no era recargar —la carga dura nunca estuvo rota— sino **llegar a Compras navegando
dentro de la app**. El operador lo confirmó así, con la extensión 1.7.1 instalada. Con esa
evidencia se encendieron los 25 restantes en un deploy de config, sin tocar el zip.

Si alguna vez hay que volver a apagarlo: mover los patrones a `urlPatternsDisabled` y ajustar
el test que vigila que no queden residuales. Sigue sin requerir republicar la extensión.

Un test (`el gate por ruta sigue en cuarentena, salvo el canario`) se pone rojo si alguien
reactiva un patrón de más.

### C. Caché de código verificado

`chrome.storage.local`, con clave `sac_<version>_<path>`. La `version` del config forma parte
de la clave, así que un deploy invalida solo. El hash del script **se verifica siempre**,
venga de red o de caché, y solo se persiste lo que ya pasó verificación: el caché no relaja
la integridad. Se excluyen libs >300KB (pdf.min.js) para no llenar la cuota.

### D. Dedup, lotes, paralelismo y una sola lectura de storage

Archivos únicos (no uno por applet), descarga con `runPool` de concurrencia 6, evaluación en
**lotes** (un `executeScript` por hasta 12 archivos / 800KB) y **una** llamada a
`chrome.storage.local.get` con todas las claves de on/off. Más `loadConfig()` con TTL de 10s
y dedup de vuelo, que es lo que mata la causa #4.

## Impacto medido

Sobre `remote/config.json` 1.7.213 → 1.7.214:

| En `/Purchasing/PurchaseOrders` | Antes | 1ª tanda (18 gateados) | Final (26 gateados) |
|---|---|---|---|
| Applets inyectados | 28 | 11 | **3** |
| Archivos descargados | 79 | 18 | **6** |
| Llamadas `executeScript` | 79 | 2 | **1** |
| Requests de red (1ª carga) | ~237 | ~20 | **~8** |
| Requests de red (cargas siguientes) | ~237 | ~2 | **~2** (config.json + config.sig) |
| Lecturas de storage para el on/off | 28 | 1 | **1** |

Por pantalla (config 1.7.216): Compras 3 applets/6 archivos · WorkOrders 3/7 · Shipping 3/6 ·
ScheduleBoard 4/12 · Workboards 5/9 · PartNumbers 6/14 · Invoices 7/9 ·
SalesOrders 8/14 · Receiving/CustomerParts 9/16.

## Lo que falta

### 1. Que cada máquina actualice la extensión

Ya publicado (zip 1.7.0 + `extensionVersion` 1.7.0 → el popup muestra el banner). Falta que el
operador acepte la actualización en cada máquina; hasta entonces esa máquina sigue con el
loader viejo y todo se comporta como antes (el campo `urlPatterns` le es invisible).

**`tools/deploy.sh --zip`** (nuevo) publica el zip **en el mismo commit de gh-pages** que el
config, que es lo que exige el hook `pre-push` (espejo + bump) y lo que evita que el banner
ofrezca un zip viejo. Valida además que `manifest.version == config.extensionVersion` antes de
empaquetar, y al final verifica el manifest DENTRO del zip SERVIDO — el gotcha registrado en
`docs/applets/bulk-upload.md` (Chrome lee el manifest, no el config; ya costó publicar un zip
1.6.3 mientras el config decía 1.6.4). Antes esto se hacía a mano.

**Rollback:** `tools/rollback.sh v1.7.214` revierte config y scripts, pero **no el zip** — para
volver al loader anterior hay que republicar el zip con `manifest.json` en 1.6.6.

### 2. Los 2 applets que siguen cargando en todas partes (a propósito)

La 1ª tanda gateó **18 de 28**: los que ya tenían un gate por URL escrito y probado en su
código (el patrón se copia de ahí). La 2ª tanda gateó **8 más**, los modal-driven, con las
pantallas que dio el operador el 2026-07-27 — fijadas en tests, porque no hay un core del cual
derivarlas:

| Grupo | Pantallas | Applets |
|---|---|---|
| Modal "Receive Parts" | `/Receiving/CustomerParts`, `/Domains/<d>/SalesOrders/<n>` | `weight-quick-entry`, `receiver-date-override`, `warehouse-location-prefill` |
| Edición de un NP | `PartNumbers`, `/Receiving/CustomerParts`, `Quotes`, `SalesOrders` | `unit-autoconvert`, `proceso-calculator`, `load-calculator` |
| Facturas | `/Domains/<d>/Invoices` | `cfdi-attacher`, `invoice-auto-regen` |

**Quedan dos sin patrón, y así deben quedarse:**

- **`price-confirm-guard`** — es un **candado de seguridad**, y la lista de pantallas donde se
  edita un precio **no es exhaustiva** (el operador: *"también en otros urls donde exista la
  edición de un NP"*). Un patrón incompleto lo apaga **en silencio** y deja pasar una captura
  de precio sin reconfirmar. El ahorro serían 2 archivos; no compensa. Los otros tres de la
  misma familia sí se gatearon porque su falla es **visible** (no autocompleta), no silenciosa.
- **`report-regen`** — el operador lo quiere en todas las pantallas.

Hay un test (`price-confirm-guard y report-regen se quedan SIN urlPatterns a propósito`) que se
pone rojo si alguien los gatea, con el porqué en el mensaje del assert.

### 3. Validación en piso

- Que cada applet siga apareciendo en su pantalla (los 18 gateados).
- Que al **navegar dentro de la SPA** a una pantalla, su applet aparezca (camino B).
- Que la segunda carga sea notoriamente más rápida (caché de código).
