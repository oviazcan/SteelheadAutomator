# Candado de Surtido — Safari Web Extension (POC iPad)

POC para portar el applet **`surtido-guard`** (Candado de Surtido Programado) a iPad vía
**Safari Web Extension**, ya que Chrome iOS no soporta extensiones. Objetivo del POC: validar
con costo $0 (sideload de 7 días con Apple ID gratis) lo más incierto, **antes** de invertir en
cuenta Apple Developer y distribución.

## Qué valida este POC
1. **`world:"MAIN"` intercepta `fetch` en Safari de iPadOS** — el corazón del candado parchea
   `window.fetch` en el contexto de la página para bloquear la mutación `CreateManyPartsTransfersChecked`.
2. **El login OAuth de Steelhead funciona** con la extensión activa (Safari normal, no WebView).
3. **El bloqueo real**: mover una pieza NO programada en "Preparando Surtido en Almacén" queda bloqueado.

> Alcance deliberadamente mínimo: **solo el candado, sin popup ni toggle** (default ON). El toggle se
> agrega en la siguiente iteración una vez validado lo crítico. Es un POC en UN iPad de prueba, no producción.

## Estructura
```
safari/
├── extension/                 ← "source" de la Safari Web Extension (entra al converter)
│   ├── manifest.json          ← MV3, content_scripts world:"MAIN", sin background ni remote-loader
│   ├── surtido-guard-core.js  ← COPIA de remote/scripts/ (no editar aquí; usar sync-scripts.sh)
│   ├── surtido-guard.js       ← COPIA de remote/scripts/ (íntegra, 0 cambios de lógica)
│   └── icons/                 ← icon16/48/128.png reutilizados de la extensión Chrome
├── sync-scripts.sh            ← recopia el candado desde remote/scripts/ (fuente única, anti-divergencia)
└── README.md
```

**Diferencias clave vs la extensión Chrome** (y por qué importan):
- **Sin remote-loader**: Apple prohíbe descargar/ejecutar código remoto (Guideline 2.5.2). Los scripts van
  empaquetados. Trade-off: actualizar la lógica = **recompilar en Xcode**, no `git push`.
- **Sin background re-inyector**: los scripts se inyectan declarativamente una sola vez. El bug del toggle
  que se arregló en Chrome (re-inyección que duplicaba instancias) **aquí ni existe**.
- El candado en sí es **idéntico** (mismo `surtido-guard*.js`).

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
- `extension/sg-inject.js` — loader que corre en el mundo aislado y mete `surtido-guard-core.js` +
  `surtido-guard.js` como `<script src>` en el MAIN world, en orden (core → glue).

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

## Mantener sincronizado
Cuando cambie la lógica del candado en `remote/scripts/`:
```bash
safari/sync-scripts.sh   # recopia a safari/extension/
# luego recompila en Xcode (paso 3)
```
