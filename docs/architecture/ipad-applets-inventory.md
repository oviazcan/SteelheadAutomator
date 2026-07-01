# Inventario de portabilidad de applets a Safari/iPad

> **Fecha:** 2026-06-30 · Generado por el workflow `ipad-applets-port-inventory` (9 agentes: descubrir → clasificar en paralelo → plan).
> Entregable humano: `docs/architecture/ipad-applets-inventory.html`. Decisión base: `ipad-surtido-guard-decision.md`.

> **Actualización 2026-07-01 — Bundle v0.5.0 (canal de lanzadores del popup + 6 con-popup).** Se resolvió la infraestructura de "applets con interfaz" en Safari sin tocar el código de los applets: el popup ofrece **botones lanzadores** que mandan el comando a la tab (`tabs.sendMessage(tabId,{__saCmd,action,nonce})`, con fallback a `storage.local`); `bridge.js` (mundo aislado) lo recibe con `runtime.onMessage` y lo reenvía al MAIN world por `postMessage`; y `safari/sa-dispatcher.js` (MAIN world) resuelve la acción → función global del applet vía **allowlist** (`LAUNCH_FN`) + fallback a `config.actions[].fn`. **Ojo:** `storage.onChanged` NO dispara en el content script de iPadOS (por eso el canal es `tabs.sendMessage`, no storage — fix 2026-07-01). Con esto **entraron al bundle**: `vale-almacen` (FAB), y las 6 "con-popup" **`archiver`, `sensor-status-autofill`, `load-calculator`, `auto-router`, `wo-completer`, `wo-deadline`** (lanzadas desde el popup). Total: **23 applets, 8 lanzadores**. Regresión en `tools/test/build-safari.test.js` (cadena popup→bridge→dispatcher→applet). **Gotcha auto-router:** en Chrome su trigger de popup (`chrome.runtime.onMessage`) está muerto en MAIN world y solo corre por el FAB; en Safari el dispatcher usa `postMessage`, así que los lanzadores **sí operan**. **Automatización:** `tools/safari-bundle-scan.py` (escáner de candidatos + clasificación por bloqueadores iOS) + skill `safari-bundle-sync` orquestan escaneo→integración→rebuild. Peso: **~940 KB** (todos los iPads objetivo son nuevos).

# Plan de Bundle Safari/iPad — SteelheadAutomator

## 1. Resumen ejecutivo

| Categoría | Applets | De valor alto |
|---|---|---|
| **directo** | 16 | 8 |
| **con-popup** | 6 | 0 (4 medio, 2 bajo) |
| **no-aplica** | 11 | — |
| **Total** | **33** | **8** |

El 48 % de los applets son portables como content script directo. Los 8 de valor alto son todos "directo" y todos de esfuerzo bajo o medio, lo que hace viable un Bundle v1 ambicioso sin tocar la arquitectura de popup. La ruta crítica es la infraestructura de empaquetado (Xcode wrapper + build script), no la adaptación del código de los applets.

---

## 2. Tabla maestra

Ordenada por portabilidad (directo → con-popup → no-aplica) y dentro de cada grupo por valor descendente.

| id | portabilidad | valor | esfuerzo | dependencias propias | APIs de riesgo | nota |
|---|---|---|---|---|---|---|
| surtido-guard | directo | alto | bajo | steelhead-api, surtido-guard-core | ninguna | POC validado en Safari/iPadOS; entra primero al bundle |
| weight-quick-entry | directo | alto | bajo | steelhead-api | ninguna | intercept fetch + MutationObserver puro; toggle via data-attribute |
| receiver-date-override | directo | alto | bajo | ninguna | ninguna | cero deps; script más fácil de portar de todo el catálogo |
| warehouse-location-prefill | directo | alto | bajo | steelhead-api | ninguna | catálogo paginado via fetch nativo; MutationObserver |
| create-order-autofill | directo | alto | bajo | steelhead-api | ninguna | autofill DOM puro; toggle puede quedar siempre-ON |
| proceso-calculator | directo | alto | bajo | steelhead-api | ninguna | MutationObserver + modal inline; patrón canónico |
| invoice-listing-marker | directo | alto | bajo | ninguna | ninguna | solo MutationObserver + rAF; cero deps |
| paros-linea | directo | alto | medio | steelhead-api | `<input type=file>` con user gesture (compatible iOS) | FAB auto-inyectado; localStorage del sitio (MAIN world, OK en iOS); esfuerzo medio por catálogos paginados |
| report-regen | directo | medio | bajo | steelhead-api | ninguna | mismo patrón que surtido-guard (intercept fetch + MutationObserver) |
| invoice-default-tab | directo | medio | bajo | ninguna | ninguna | parche history.pushState + MutationObserver; cero deps |
| cfdi-attacher | directo | medio | bajo | steelhead-api | ninguna | intercept fetch + FormData; upload compatible con Safari iOS |
| invoice-autofill | directo | medio | bajo | steelhead-api | ninguna | intercept fetch + autofill DOM; toggle siempre-ON |
| bill-autofill | directo | medio | bajo | steelhead-api | ninguna | mismo patrón que invoice-autofill |
| wo-mover | directo | medio | bajo | steelhead-api, host-cleanup-shared, ov-operations | `chrome.runtime?.onMessage` (optional chaining; falla silencioso) | FAB self-contained; reasignación de OTs útil en supervisión de piso |
| unit-autoconvert | directo | medio | bajo | steelhead-api, unit-autoconvert-core | ninguna | tres scripts en orden; valor limitado en piso |
| invoice-auto-regen | directo | medio | medio | steelhead-api | `navigator.clipboard` solo en helpers de diagnóstico fuera del flujo operativo | paginación DOM pesada; puede ser lento en iPad A-series viejos |
| load-calculator | con-popup | medio | medio | steelhead-api, load-calculator-engine, load-calculator-stations, load-calculator-modal | ninguna | Fase 2 (modal nativo) es interceptor directo; Fase 1 (Configurador) requiere popup |
| archiver | con-popup | medio | medio | steelhead-api, host-cleanup-shared | ninguna | localStorage compatible; solo hay que mapear acción de popup a Safari |
| sensor-status-autofill | con-popup | medio | medio | steelhead-api | ninguna | FAB y modales DOM puros; solo falta el trigger de popup |
| auto-router | con-popup | medio | medio | steelhead-api, auto-router-engine, auto-router-api, auto-router-panel, auto-router-batch, board-metal-tooltip | `chrome.runtime?.onMessage` (optional chaining) | capa autoInject es directa; acciones del popup son el trabajo de Fase 2 |
| report-liberator | con-popup | bajo | medio | steelhead-api | `navigator.clipboard` (requiere gesto de usuario; presenta diálogo en iOS) | tarea administrativa esporádica |
| wo-deadline | con-popup | bajo | medio | steelhead-api | ninguna | técnicamente portable; raramente útil en piso |
| carga-masiva | no-aplica | bajo | alto | steelhead-api, host-cleanup-shared, bulk-upload-cc/parse/classify, catalog-fetcher | IndexedDB, FileReader, anchor.download, navigator.clipboard | flujo de 10–30 min con Excel; herramienta de oficina |
| hash-scanner | no-aplica | bajo | alto | steelhead-api | anchor.download (Blob) | herramienta de developer; sin valor operativo |
| auditor | no-aplica | bajo | alto | steelhead-api, host-cleanup-shared, duplicate-tiers | anchor.download CSV/JSON | auditoría batch de miles de PNs; descarga no funciona en iOS |
| file-uploader | no-aplica | bajo | alto | steelhead-api, host-cleanup-shared, file-uploader-core | anchor.download (reporte CSV), `<input file>` masivo | flujo de escritorio con convención de nombres en filesystem |
| spec-migrator | no-aplica | bajo | alto | steelhead-api, host-cleanup-shared | anchor.download XLSX, `<input file>`, clipboard | migración masiva de specs; depende de Excel local |
| inventory-reset | no-aplica | bajo | alto | steelhead-api | FileReader, clipboard | operación destructiva de admin; sin sentido en piso |
| po-comparator | no-aplica | bajo | alto | steelhead-api, claude-api, ov-operations | FileReader, window.open | parseo de PDF con Claude API; flujo de oficina |
| po-reconciler | no-aplica | bajo | alto | steelhead-api, claude-api, po-comparator, pdf.min.js | FileReader, anchor.download | conciliación contable; wizard de escritorio |
| portal-importer | no-aplica | bajo | alto | steelhead-api, claude-api, xlsx.full.min.js, ov-operations, po-comparator | chrome.storage.local, clipboard, FileReader | importador de XLS de portales de cliente; tarea de oficina |
| process-canon | no-aplica | bajo | alto | steelhead-api, process-shared, process-deep-audit | anchor.download XLSX | configuración de nodos de proceso para ingeniería en escritorio |
| spec-params-bulk | no-aplica | bajo | alto | steelhead-api, spec-shared | anchor.download XLSX, `<input file>`, SheetJS | flujo descargar-editar-subir XLSX; puro escritorio |

---

## 3. Bundle v1 recomendado

### Applets incluidos

Todos los "directo". Se recomiendan los 16; excluir `invoice-auto-regen` si el iPad objetivo es un modelo antiguo (A12 o anterior) dado el DOM-paginado intensivo.

**Valor alto (8):** surtido-guard, weight-quick-entry, receiver-date-override, warehouse-location-prefill, create-order-autofill, proceso-calculator, invoice-listing-marker, paros-linea

**Valor medio (8):** report-regen, invoice-default-tab, cfdi-attacher, invoice-autofill, bill-autofill, wo-mover, unit-autoconvert, invoice-auto-regen

### Orden de carga obligatorio

El bundle Safari necesita un único archivo concatenado (o declaración ordenada en manifest `content_scripts.js`). El orden por capas es:

```
── Capa 1: helpers base (sin deps entre sí)
   steelhead-api.js
   host-cleanup-shared.js        ← solo wo-mover lo usa en v1

── Capa 2: helpers de segundo nivel (dependen de capa 1)
   ov-operations.js              ← depende de steelhead-api; requerido por wo-mover
   unit-autoconvert-core.js      ← dependencia pura de lógica; sin deps de red
   surtido-guard-core.js         ← lógica pura; sin deps de red

── Capa 3: applets sin dependencias propias (orden libre entre ellos)
   invoice-default-tab.js
   invoice-listing-marker.js
   receiver-date-override.js

── Capa 4: applets que usan steelhead-api (orden libre entre ellos)
   proceso-calculator.js
   report-regen.js
   cfdi-attacher.js
   invoice-auto-regen.js
   paros-linea.js
   weight-quick-entry.js
   warehouse-location-prefill.js
   create-order-autofill.js
   bill-autofill.js
   invoice-autofill.js

── Capa 5: applets que usan helpers de capa 2
   wo-mover.js                   ← después de host-cleanup-shared + ov-operations
   unit-autoconvert.js           ← después de unit-autoconvert-core
   surtido-guard.js              ← después de surtido-guard-core
```

### Script puente (ISOLATED world)

El `content.js` actual hace bridge entre extension storage y MAIN world vía data-attributes en `<html>`. En Safari Web Extension sigue siendo necesario con dos cambios menores:

1. `chrome.storage` → `browser.storage` (o polyfill `const chrome = browser`)
2. Eliminar el bloque de hash-scanner (`sa_scanning`, `auto-restart-scan`, `sa-persist-scan`) — no aplica en iPad

Los applets ya leen los data-attributes con `document.documentElement.dataset.*`; ese mecanismo no cambia.

---

## 4. Fase 2: applets con-popup

Cuatro applets de valor medio valen el esfuerzo de portar el popup:

| id | qué implica en Safari |
|---|---|
| **auto-router** | La capa autoInject (FAB + intercept fetch + rastreo de selección) entra como content_script directo igual que v1. Las acciones del popup (configurar reglas, lanzar batch) requieren un `popup.html` en la Safari Web Extension — es el mismo archivo con `browser.runtime.sendMessage` en lugar de `chrome.runtime`. El `chrome.runtime?.onMessage` con optional chaining en el content script ya es seguro. |
| **archiver** | Funciona completamente desde el popup: un formulario de filtros que lanza el script. Requiere mapear la acción del popup de Chrome (que inyecta el panel en DOM) al popup de Safari. Sin cambios en el código de archiver.js. |
| **load-calculator** | La Fase 2 (load-calculator-modal.js) es intercept fetch puro → puede subirse a v1 como "directo". La Fase 1 (Configurador de Estaciones) requiere popup. Se puede dividir: meter modal en v1, dejar Configurador para Fase 2. |
| **sensor-status-autofill** | El script inyecta FAB y modales DOM puros; el único cambio es el trigger de popup → `browser.runtime.sendMessage`. |

`report-liberator` y `wo-deadline` tienen valor bajo; no justifican el esfuerzo de Fase 2 por sí solos. Si el popup ya está portado para los cuatro anteriores, sumarlos no cuesta nada.

**Qué implica el popup en Safari Web Extension:** el `popup.html` del MV3 de Chrome funciona sin cambios de estructura en Safari Web Extension (también soporta `action.default_popup`). La única diferencia es usar `browser.*` en lugar de `chrome.*`, y que en iOS el popup aparece como hoja emergente desde el ícono de la extensión en la barra de direcciones (no hay restricción de tamaño fijo; se adapta al contenido).

---

## 5. Descartados (no-aplica)

| id | razón en una línea |
|---|---|
| carga-masiva | Carga masiva desde Excel de 10–30 min con descarga de reporte; flujo incompatible con iPad |
| hash-scanner | Herramienta de developer para capturar hashes de GraphQL; cero valor para operadores de piso |
| auditor | Auditoría batch de miles de PNs con descarga CSV/JSON vía `a.download`; no funciona en Safari iOS |
| file-uploader | Carga masiva de archivos por convención de nombres en el filesystem; flujo de escritorio |
| spec-migrator | Ciclo descargar-Excel-editar-subir CSV; depende de Excel local y `a.download` |
| inventory-reset | Operación destructiva de reinicio de inventario desde CSV; tarea de administrador en escritorio |
| po-comparator | Parseo de PDF con Claude API + `window.open` lateral; flujo de oficina sin sentido en piso |
| po-reconciler | Wizard de conciliación contable con múltiples PDFs; `a.download` no funciona en iOS |
| portal-importer | Importa XLS de portales de cliente con Claude API; tarea de oficina con `chrome.storage.local` |
| process-canon | Configuración masiva de nodos de proceso para ingeniería; genera descarga XLSX via `a.download` |
| spec-params-bulk | Ciclo descargar-editar XLSX con SheetJS + subir resultado; puro escritorio |

---

## 6. Riesgos transversales

### `a.download` + `URL.createObjectURL` (bloqueador en iOS)
Afecta a: carga-masiva, hash-scanner, auditor, file-uploader, spec-migrator, po-reconciler, process-canon, spec-params-bulk. Safari iOS ignora el atributo `download` en anclas — el navegador intenta previsualizar el blob o falla silenciosamente. Es el motivo principal por el que 8 de los 11 descartados están fuera. No hay workaround limpio en un content script (requeriría Share Sheet nativa, que no es accesible desde un content script).

### `navigator.clipboard` (requiere gesto de usuario en iOS)
Afecta a: carga-masiva, spec-migrator, report-liberator (todos fuera de v1 salvo `invoice-auto-regen` donde está solo en helpers de diagnóstico). En iOS, `clipboard.writeText` presenta un diálogo de confirmación. En `invoice-auto-regen` no está en el flujo principal; no es bloqueante para v1.

### `chrome.storage` vs `browser.storage`
El bridge `content.js` usa `chrome.storage.local` y `chrome.storage.onChanged`. En Safari Web Extension la API es `browser.storage` (Promise-based). La solución estándar es un polyfill de una línea al inicio del archivo:
```js
const chrome = typeof browser !== 'undefined' ? browser : chrome;
```
Esto cubre el bridge sin tocar ningún applet (que no usa chrome.* directamente).

### `chrome.runtime.onMessage` en content scripts MAIN world
Afecta a: wo-mover, auto-router. Ambos ya usan optional chaining (`chrome.runtime?.onMessage?.addListener?.()`), por lo que fallan silenciosamente si el canal no está disponible. En Safari Web Extension con `world: "MAIN"`, el acceso a `browser.runtime` desde el mundo MAIN está restringido (igual que en Chrome MV3 con `world: "MAIN"`); el mensaje debe ir primero al ISOLATED world y re-enviarse al MAIN world vía `window.postMessage`. Esto requiere un pequeño relay en el bridge, pero el código del applet no cambia.

### Modelo de deploy (rebuild obligatorio)
Al no poder cargar código remoto, cada cambio a un applet requiere:
1. Editar `remote/scripts/foo.js` en `main` (flujo de desarrollo existente no cambia)
2. Correr el build script → regenera el bundle Safari
3. Archivar en Xcode → subir a App Store Connect (distribución interna/MDM) o re-exportar `.ipa`
4. Distribuir vía MDM (Jamf/Apple Configurator) o TestFlight interno

El ciclo de deploy será más lento que el actual (push a gh-pages → extensión recarga en segundos). La recomendación es hacer releases por lote: agrupar 3–5 fixes/features antes de un nuevo build. Esto implica mantener un `CHANGELOG-safari.md` o usar tags git (`safari/v1.0`, `safari/v1.1`) para trackear qué versión tiene qué applets.

No hay sincronización posible desde `remote/scripts` al estilo remote-loader; el bundle es estático por requerimiento de Apple (Guideline 2.5.2).

---

## 7. Arquitectura del bundle: recomendación concreta

### Opción recomendada: build script que genera el bundle desde `config.json`

Mantener `remote/scripts/*.js` y `remote/config.json` como única fuente de verdad. Agregar un script de build:

```
tools/build-safari.sh
```

que haga lo siguiente:

1. **Lee `config.json`** y extrae los `scripts[]` de los applets marcados como portables (lista blanca en el propio script o en una sección `safari` del config).
2. **Resuelve el orden topológico** de scripts (la lista de capas de §3 puede codificarse como lista ordenada de exclusión de duplicados).
3. **Concatena** en un único `safari-extension/Resources/main-bundle.js`, wrapeando cada script de applet en un IIFE:
   ```js
   // === BEGIN: surtido-guard.js ===
   (function() { /* contenido del script */ })();
   // === END: surtido-guard.js ===
   ```
   Los helpers compartidos (steelhead-api.js, host-cleanup-shared.js, etc.) van sin IIFE porque definen globals (`window.SteelheadAPI`, `window.SteelheadHostCleanup`) que los applets posteriores consumen.
4. **Escribe el `manifest.json`** de Safari Web Extension con dos entradas en `content_scripts`:
   - ISOLATED world → `bridge.js` (el content.js adaptado con `browser.*`)
   - MAIN world → `main-bundle.js`

```json
"content_scripts": [
  {
    "matches": ["https://app.gosteelhead.com/*"],
    "js": ["bridge.js"],
    "run_at": "document_idle"
  },
  {
    "matches": ["https://app.gosteelhead.com/*"],
    "js": ["main-bundle.js"],
    "world": "MAIN",
    "run_at": "document_idle"
  }
]
```

5. **Bumpa la versión** en el `Info.plist` del target Xcode (o la lee del `config.json`).

### Por qué no un loader empaquetado

Un loader empaquetado que en runtime evalúe los scripts del bundle (p.ej. un array de strings + `eval`) seguiría violando la Guideline 2.5.2 porque Apple revisa el comportamiento, no solo la fuente de los scripts. La revisión del App Store detecta patrones de code evaluation dinámico. El bundle estático concatenado es el único camino seguro.

### Por qué no un `content_scripts` por applet

Tener 16 entradas separadas en `content_scripts` fragmentaría el bundle sin beneficio real (Steelhead es un SPA; todos los applets responden al mismo `matches: https://app.gosteelhead.com/*`). La concatenación en un solo archivo es más simple de mantener y evita problemas de orden de inyección.

### Estructura de directorios propuesta

```
SteelheadAutomator/
├── remote/scripts/          ← fuente de verdad (sin cambios)
├── remote/config.json       ← fuente de verdad (sin cambios)
├── extension/               ← extensión Chrome existente (sin cambios)
├── safari-extension/        ← NUEVO
│   ├── SteelheadAutomator/  ← Xcode target Swift (wrapper vacío)
│   │   └── AppDelegate.swift
│   ├── SteelheadAutomator Extension/
│   │   ├── Resources/
│   │   │   ├── manifest.json        ← generado por build-safari.sh
│   │   │   ├── bridge.js            ← content.js adaptado (edición manual)
│   │   │   ├── main-bundle.js       ← generado por build-safari.sh
│   │   │   ├── popup.html           ← para Fase 2
│   │   │   └── icons/
│   │   └── SafariWebExtensionHandler.swift
│   └── SteelheadAutomator.xcodeproj
└── tools/
    ├── build-safari.sh      ← NUEVO
    ├── deploy.sh            ← existente
    └── ...
```

### Incógnitas que quedan por validar

- **`world: "MAIN"` en Safari iOS 16+**: confirmado en el POC de surtido-guard para iPadOS, pero hay que verificar la versión mínima de iPadOS que se quiere soportar (si es iPadOS 15, `world: "MAIN"` en content_scripts no está disponible).
- **`browser.storage` en MAIN world**: en Chrome MV3, `chrome.storage` no está disponible en `world: "MAIN"` (por eso el bridge con data-attributes). En Safari aplica la misma restricción. Los applets de v1 ya no usan `chrome.storage` directamente; el bridge los alimenta vía data-attributes. Confirmado OK.
- **Rendimiento de `main-bundle.js` en iPads A12 y anteriores**: el bundle concatenado de 16 applets más helpers puede pesar ~300–500 KB. Hay que perfilar el tiempo de parse en el modelo objetivo antes de dar v1 por bueno.
- **Distribución interna**: si el uso es exclusivamente interno (Ecoplating), la vía más rápida es MDM + distribución de empresa (requiere Apple Developer Enterprise Program a $299/año) o TestFlight interno (más lento por revisión de Apple, pero gratis con Developer Program estándar). Definir esto antes de empezar el Xcode wrapper.