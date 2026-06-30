# Guía de build/deploy — Candado de Surtido en Safari/iPad (POC)

Paso a paso para convertir el "source" de `safari/extension/` en una app instalable en iPad y probar el
candado. Pensado para que lo siga **alguien que nunca tocó Xcode**. No se crea proyecto a mano ni se clona
otro repo: el converter de Apple **genera** el proyecto Xcode a partir de `safari/extension/`.

```
safari/extension/ (web, ya hecho)  →  xcrun ...converter  →  safari/xcode/ (proyecto Xcode)  →  firmar  →  iPad
```

> Estado del POC: `safari/extension/` ya está listo (manifest MV3, `surtido-guard*.js`, iconos, y la variante
> plan B). Lo único que falta es lo que requiere la GUI de Xcode + un iPad físico. ~1-3 h la primera vez.

---

## Paso 0 — Instalar Xcode (una vez)
Hoy la Mac solo tiene Command Line Tools; el converter necesita **Xcode completo**.
1. App Store → instala **Xcode** (~7 GB).
2. Apúntalo y acepta licencia:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```
3. Verifica que el converter exista (debe imprimir una ruta):
   ```bash
   xcrun --find safari-web-extension-converter
   ```

## Paso 1 — Generar el proyecto Xcode con el converter
```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
xcrun safari-web-extension-converter safari/extension \
  --project-location safari/xcode \
  --app-name "Candado Surtido" \
  --bundle-identifier com.ecoplating.candadosurtido \
  --ios-only \
  --copy-resources \
  --no-open
```
- `--ios-only`: solo target iPad/iPhone (no macOS). Si luego quieres probar en Mac, regeneras sin este flag.
- `--copy-resources`: copia los `.js`/`manifest` dentro del proyecto (autocontenido). **Ojo divergencia**: si
  cambias el candado, hay que re-sincronizar (ver "Mantener al día").
- Al terminar imprime un resumen. **Es esperado que advierta `world … not supported by your current version
  of Safari`** — es el *validador del converter*, que no reconoce la clave `world`; Safari reciente sí la
  soporta en runtime, y el proyecto Xcode se genera igual. **No cambies nada todavía:** termina el build
  (Pasos 2-3) y **prueba en el iPad** (Paso 5). **Solo si NO intercepta** (el `_getState` no se puebla / no
  bloquea) pasa al **plan B** (abajo). El warning por sí solo no prueba que falle.

`safari/` y `safari/xcode/` ya están en `.gitignore` para los artefactos de build; el *source* (`safari/extension/`)
sí se versiona. (Si el proyecto generado no debe subirse, confirma el `.gitignore` — ver "Notas de repo".)

## Paso 2 — Abrir y firmar
```bash
open "safari/xcode/Candado Surtido/Candado Surtido.xcodeproj"
```
En Xcode, panel izquierdo → selecciona el proyecto (ícono azul arriba). Verás **2 targets**:
`Candado Surtido` (la app) y `Candado Surtido Extension` (la extensión). Para **CADA** target:
1. Pestaña **Signing & Capabilities**.
2. Marca **Automatically manage signing**.
3. **Team** → elige tu Apple ID (aparece como *(Personal Team)*). Si no aparece:
   Xcode → **Settings → Accounts → "+" → Apple ID** e inicia sesión. *No* necesitas cuenta de pago para el POC.
4. **Bundle Identifier** único. Si Xcode marca conflicto, cambia a algo tuyo, p. ej.
   `com.TUNOMBRE.candadosurtido` (y la extensión queda `com.TUNOMBRE.candadosurtido.Extension`).

> Apple ID gratis (Personal Team) = la firma vale **7 días**: suficiente para el POC. Para producción se usa
> cuenta Apple Developer ($99) + TestFlight o MDM (ver `docs/architecture/ipad-surtido-guard-decision.md`).

[captura pendiente: pantalla Signing & Capabilities de cada target]

## Paso 3 — Instalar en el iPad
1. Conecta el iPad por cable. En el iPad, toca **Confiar** ("Trust This Computer").
2. En Xcode, barra superior: selecciona el **destino** = tu iPad (no un simulador), y el **esquema** = la app
   `Candado Surtido`.
3. **Product → Run** (▶). Compila e instala la app contenedora en el iPad.
4. Primera vez, el iPad bloquea apps de desarrollador sin firmar por una tienda: ve a
   **Ajustes → General → VPN y gestión de dispositivos → [tu Apple ID] → Confiar**.

[captura pendiente: selector de destino (iPad) y botón Run]

## Paso 4 — Activar la extensión en Safari (iPad)
1. **Ajustes → Apps → Safari → Extensiones** (en iPadOS viejos: **Ajustes → Safari → Extensiones**) → activa
   **Candado Surtido**.
2. Abre Safari → entra a `app.gosteelhead.com`. Toca el ícono **ᴀA** / extensiones en la barra de direcciones
   → **Gestionar extensiones** → activa, y concede **Permitir** en este sitio (o *Permitir siempre*).

## Paso 5 — Probar el candado
1. Inicia sesión en Steelhead en Safari del iPad (valida que el **login OAuth funciona** con la extensión activa).
2. Ve al board de surtido: `/Domains/344/Workboards/6234`, step "Preparando Surtido en Almacén".
3. Intenta mover una pieza **NO programada** → debe **bloquearse** (toast rojo).
4. Una pieza **programada** → se mueve normal.

### Diagnóstico (Web Inspector remoto)
Safari del iPad no tiene consola en el dispositivo. Para inspeccionar:
1. En la Mac: **Safari → Ajustes → Avanzado → "Mostrar funciones para desarrolladores web"**.
2. En el iPad: **Ajustes → Safari → Avanzado → Inspector web → ON**.
3. iPad conectado por cable → en la Mac, **Safari → menú Desarrollo → [tu iPad] → [pestaña de Steelhead]**.
4. En la consola: `window.SurtidoGuard._getState()` → debe mostrar `scheduled > 0` y `surtido` con el
   recipeNodeId. Si salen vacíos, el candado está en **fail-safe** (no bloquea) → revisa que los queries del
   board hayan cargado, o que `world:"MAIN"` esté interceptando (si no, **plan B**).

---

## Plan B — si `world:"MAIN"` no funciona en tu iPadOS
Requiere iPadOS 17+. Si el `_getState` no se puebla o no bloquea:
```bash
cd safari/extension
mv manifest.json manifest.world-main.json   # respalda variante A
mv manifest.fallback.json manifest.json       # activa el loader <script>-tag
```
Vuelve al **Paso 1** (regenera con el converter) y al Paso 3. Para volver a la variante A, invierte el rename.

## Mantener al día (anti-divergencia)
La fuente única del candado es `remote/scripts/`. Cuando cambie su lógica:
```bash
safari/sync-scripts.sh                 # remote/scripts → safari/extension
# regenera el proyecto Xcode (Paso 1, agrega --force para sobreescribir) y recompila (Paso 3)
```
`tools/deploy.sh` ya avisa si `safari/extension/*.js` quedó desincronizado de `remote/scripts/`.

## Notas de repo
- Versiona `safari/extension/` (el source). El proyecto generado `safari/xcode/` es artefacto de build —
  conviene **no** versionarlo (agrégalo a `.gitignore` si el converter lo dejó dentro del repo).
- Para el bundle multi-applet (varios applets en una sola app Safari) ver la sección de escalamiento en
  `docs/architecture/ipad-surtido-guard-decision.md`. Esta guía cubre solo el POC del candado.
