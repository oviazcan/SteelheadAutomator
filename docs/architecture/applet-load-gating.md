# Carga de applets: por qué tardaba y cómo se acotó

**Estado:** **VIVO en producción (2026-07-27)** — config **1.7.215**, tag `v1.7.215`, zip de la
extensión **1.7.0** publicado y verificado en vivo (firma del config OK, `unzip -p … manifest.json`
del zip SERVIDO reporta 1.7.0). **Falta validar en piso** y que cada máquina actualice la
extensión desde el banner del popup — hasta que lo haga, sigue con el loader viejo, que ignora
`urlPatterns` y se comporta exactamente como antes. Diagnóstico original reportado por el
operador el 2026-07-27:
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

### B. Navegación SPA (lo que faltaba en el plan original)

Steelhead cambia de pantalla con `history.pushState`, y ahí `chrome.tabs.onUpdated` **no**
vuelve a emitir `status:'complete'`. Con solo el gate de (A), un applet habría desaparecido
para el operador que llega a esa pantalla navegando dentro de la SPA (que es lo normal).

Se atiende también `changeInfo.url` sin `status` — que es exactamente el pushState — y la
propia página lleva la cuenta de qué apps ya tiene (`window.__saLoadedApps`). Vive en la
página y no en el service worker porque el SW de MV3 se suspende, y porque ese latch debe
morir con el `window` (recarga dura = todo de nuevo).

**Resultado neto: se re-inyecta MENOS que antes**, no más. Antes cada carga dura re-evaluaba
los 28; ahora, al navegar, solo entra lo que falta.

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

| En `/Purchasing/PurchaseOrders` | Antes | Después |
|---|---|---|
| Applets inyectados | 28 | **11** |
| Archivos descargados | 79 | **18** |
| Llamadas `executeScript` | 79 | **2** |
| Requests de red (1ª carga) | ~237 | **~20** |
| Requests de red (cargas siguientes) | ~237 | **~2** (config.json + config.sig) |
| Lecturas de storage para el on/off | 28 | **1** |

Otras pantallas quedan en 11-13 applets / 18-24 archivos / 2 lotes.

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

### 2. Los 10 applets que siguen cargando en todas partes

Reciben `urlPatterns` **18 de los 28** `autoInject`: exactamente los que ya tenían un gate por
URL escrito y probado en su código. Los otros 10 se activan por **modal** (MutationObserver
sobre un diálogo de Steelhead) o por **intercepción de fetch**, y su código no dice en qué
pantalla vive ese modal:

`load-calculator` · `proceso-calculator` · `report-regen` · `cfdi-attacher` ·
`invoice-auto-regen` · `weight-quick-entry` · `unit-autoconvert` · `price-confirm-guard` ·
`receiver-date-override` · `warehouse-location-prefill`

Se quedan sin patrón **a propósito**: mismo criterio que la regla de anclajes bilingües del
repo — no se adivina. Ponerles un patrón equivocado apaga un candado de seguridad
(`price-confirm-guard`) o un autofill sin que nadie se entere. Cerrar estos 10 con evidencia
del operador (¿desde qué pantalla abres "Receive Parts"? ¿desde dónde mandas el correo de la
factura?) llevaría Compras de 11 applets a ~4.

### 3. Validación en piso

- Que cada applet siga apareciendo en su pantalla (los 18 gateados).
- Que al **navegar dentro de la SPA** a una pantalla, su applet aparezca (camino B).
- Que la segunda carga sea notoriamente más rápida (caché de código).
