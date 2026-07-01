# Steelhead Automator — Safari Web Extension (iPad)

Bundle de applets de Steelhead empaquetados como **Safari Web Extension** para iPad (Chrome iOS no soporta
extensiones). Generado desde la **fuente única** (`remote/scripts/` + `config.json`) por `tools/build-safari.sh`.
Pasos de build/firma/instalación en **`docs/deploy-safari.html`**.

## Estado
- **POC del candado de surtido VALIDADO en vivo (Safari iPad, 2026-06-30):** `world:"MAIN"` intercepta
  `fetch`, el login OAuth funciona y el bloqueo de una pieza no programada quedó confirmado (no se necesitó
  el plan B).
- **Bundle v0.3.0 — 20 applets:** los 16 "directo" del inventario + `vale-almacen` (FAB) + 3 "con-popup"
  (`archiver`, `sensor-status-autofill`, `load-calculator`) lanzables desde el popup. Para agregar/quitar,
  edita `bundle.json` (inventario en `docs/architecture/ipad-applets-inventory.html`).

## Applets con interfaz (lanzadores del popup)
Algunos applets no se auto-inyectan con botón flotante: se **lanzan desde el popup** (sección "Acciones").
En Chrome el service worker inyecta el script y llama su función; en Safari **todos los applets del bundle ya
están cargados**, así que el popup solo dispara la función de entrada. El canal reusa el puente de storage que
ya usan los toggles:

```
popup.js  → browser.storage.local.set({ saCommand: {action, nonce} })   (botón "Acciones")
bridge.js → storage.onChanged detecta saCommand → postMessage {type:'command', action}   (mundo aislado)
sa-dispatcher.js → resuelve action → función global del applet y la invoca   (MAIN world, concatenado)
```

- **Allowlist:** `safari/sa-dispatcher.js` mapea `message → función` (`LAUNCH_FN`). Un `postMessage` forjado solo
  puede invocar funciones de esa lista (defensa en profundidad; el applet igual vive en el MAIN world).
- **Agregar un lanzador:** (1) mete el applet a `bundle.json`; (2) agrega `{message,icon,label,sub}` a `LAUNCHERS`
  en `safari/extension/popup.js`; (3) agrega `'message':'Global.fn'` a `LAUNCH_FN` en `safari/sa-dispatcher.js`.
  El test `tools/test/build-safari.test.js` verifica que la cadena quede consistente (popup→dispatcher→applet).
- **auto-router** queda pendiente: su acción de popup no está cableada ni en Chrome (usa FAB + intercept del modal).

## Estructura
```
safari/
├── bundle.json                ← lista blanca de applets del bundle (por id) + meta
├── extension/                 ← "source" de la Safari Web Extension (entra al converter)
│   ├── manifest.json          ← GENERADO por build-safari.sh (MV3, content_scripts world:"MAIN")
│   ├── main-bundle.js         ← GENERADO: applets concatenados (cada uno en IIFE), helpers deduplicados
│   ├── manifest.fallback.json ← plan B (sin world:MAIN; inyecta main-bundle.js vía <script>)
│   ├── sg-inject.js           ← plan B: loader del bundle al MAIN world
│   └── icons/                 ← icon16/48/128.png
├── sync-scripts.sh            ← DEPRECADO → redirige a tools/build-safari.sh
└── README.md
tools/build-safari.sh          ← genera main-bundle.js + manifest.json (modo --check para deploy.sh)
```

**Diferencias clave vs la extensión Chrome** (y por qué importan):
- **Sin remote-loader**: Apple prohíbe descargar/ejecutar código remoto (Guideline 2.5.2). El bundle es
  estático y empaquetado → actualizar = re-correr `build-safari.sh` + recompilar en Xcode, no `git push`.
- **Sin background re-inyector**: los scripts se inyectan declarativamente una sola vez (el bug del toggle del
  candado en Chrome ni aplica aquí).
- El código de cada applet es **idéntico** al de Chrome (mismo `remote/scripts/`); solo cambia el empaquetado.

## Pasos en tu Mac (lo que NO puedo hacer yo: GUI de Xcode + firma + iPad)

### 0. Requisito previo
Instala **Xcode completo** desde la App Store (~7 GB). Hoy solo tienes Command Line Tools; el converter
de Safari necesita Xcode. Verifica:
```bash
xcrun --find safari-web-extension-converter   # debe imprimir una ruta
```

### 1. Convertir el "source" a proyecto Xcode
```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
xcrun safari-web-extension-converter safari/extension \
  --project-location safari/xcode \
  --app-name "Candado Surtido" \
  --bundle-identifier com.ecoplating.candadosurtido \
  --no-open
```
Genera un proyecto Xcode (app contenedora + extensión). El `--no-prompt`/`--no-open` evita que abra solo;
quítalos si prefieres que abra Xcode automáticamente.

### 2. Firmar (Apple ID gratis = 7 días)
1. Abre `safari/xcode/Candado Surtido/Candado Surtido.xcodeproj`.
2. En cada target (la app y la extensión) → **Signing & Capabilities** → marca *Automatically manage signing*
   y elige tu **Personal Team** (tu Apple ID). No requiere cuenta de pago para sideload de 7 días.
3. Cambia el Bundle Identifier si Xcode marca conflicto (usa algo único, p. ej. `com.tuusuario.candadosurtido`).

### 3. Instalar en el iPad
1. Conecta el iPad por cable y selecciónalo como destino (arriba en Xcode).
2. **Product → Run** (▶). Se instala la app contenedora en el iPad.
3. En el iPad: **Ajustes → Apps → Safari → Extensiones** (o **Ajustes → Safari → Extensiones**) → activa
   "Candado Surtido".
4. En Safari, primera vez en `app.gosteelhead.com`: toca el botón de extensiones (junto a la barra de URL)
   → **Permitir** en este sitio (o "Permitir siempre").
5. La primera vez, en **Ajustes → General → VPN y gestión de dispositivos**, confía en tu certificado de
   desarrollador (perfil de tu Apple ID).

### 4. Probar el bloqueo
1. Inicia sesión en Steelhead en Safari del iPad (valida que el OAuth funcione con la extensión activa).
2. Ve al board de **Preparación de Surtido** (`/Domains/344/Workboards/6234`), step "Preparando Surtido en Almacén".
3. Intenta mover una pieza **NO programada** → debe **bloquearse** (toast rojo del candado).
4. Una pieza **programada** → se mueve normal.

> Diagnóstico en el iPad: si tienes una Mac con el iPad conectado, **Safari de la Mac → Desarrollo → [tu iPad]**
> abre el Web Inspector de la pestaña del iPad. Ahí, en consola: `window.SurtidoGuard._getState()` debe mostrar
> `scheduled > 0` y `surtido` con el recipeNodeId. Si salen vacíos, el candado está en fail-safe (no bloquea).

## Si `world:"MAIN"` no funciona en el Safari del iPad (plan B — YA INCLUIDO)
`world:"MAIN"` en `content_scripts` requiere Safari/iPadOS reciente (17+). Si el candado no intercepta
(el `_getState` no se puebla o no bloquea), usa la variante **plan B**, ya lista en este repo:

- `extension/manifest.fallback.json` — manifest sin `world:"MAIN"`; inyecta vía content script aislado +
  `web_accessible_resources`.
- `extension/sg-inject.js` — loader que corre en el mundo aislado y mete `main-bundle.js` como
  `<script src>` en el MAIN world.

**Cómo activarlo** (no toca la lógica del candado):
```bash
cd safari/extension
mv manifest.json manifest.world-main.json   # respalda la variante A
mv manifest.fallback.json manifest.json      # activa el plan B
```
Luego vuelve a correr el converter (paso 1) y recompila. Para volver a la variante A, invierte el rename.

> Diferencia de timing: el plan B inyecta los scripts asincrónicamente en `document_start`; el candado se
> auto-gestiona (parchea `fetch` en su `init`), así que sigue interceptando los fetch del board, que ocurren
> mucho después de la carga. Es ligeramente más frágil que `world:"MAIN"` pero funciona en iPadOS más viejos.

> **Plan B no trae popup** (`default_popup` ausente en `manifest.fallback.json`), así que los **lanzadores del
> popup no están disponibles** ahí: solo corren los applets con botón flotante (vale-almacén, paro de línea) y
> el candado de surtido. El relay del comando sí funciona (plan B carga `bridge.js`); lo que falta es la UI del
> popup. Si algún día se necesitan los lanzadores en iPadOS viejo, agrega `action.default_popup` + iconos al
> `manifest.fallback.json`.

## Mantener al día
Cuando cambie la lógica de un applet del bundle en `remote/scripts/` (o agregues applets en `bundle.json`):
```bash
tools/build-safari.sh    # regenera main-bundle.js + manifest.json
# luego recompila en Xcode (paso 3)
```
`tools/deploy.sh` corre `build-safari.sh --check` y avisa si el bundle quedó desactualizado.
