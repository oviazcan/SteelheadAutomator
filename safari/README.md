# Steelhead Automator — Safari Web Extension (iPad)

Bundle de applets de Steelhead empaquetados como **Safari Web Extension** para iPad (Chrome iOS no soporta
extensiones). Generado desde la **fuente única** (`remote/scripts/` + `config.json`) por `tools/build-safari.sh`.
Pasos de build/firma/instalación en **`docs/deploy-safari.html`**.

## Estado
- **POC del candado de surtido VALIDADO en vivo (Safari iPad, 2026-06-30):** `world:"MAIN"` intercepta
  `fetch`, el login OAuth funciona y el bloqueo de una pieza no programada quedó confirmado (no se necesitó
  el plan B).
- **Bundle v0.6.39 — 34 applets (2026-08-07):** corrige `warehouse-location-prefill` (**0.6.5**) y
  **reemplaza a 0.6.38**, que en el iPad habría dejado el mismo hueco que se reportó en escritorio
  («se quebró WLP, no aparece el campo»). El combo «Ubicación inicial:» vuelve a montarse **ANTES**
  del cableado del modal: al introducir las dos marcas en 0.6.4 quedó detrás de
  `applyUnusedFieldStatesWithRetry`, `evaluateSaveGate` y `watchLineRows` —tres funciones que tocan
  el DOM y que, si tiran, se llevan por delante lo único que el operador ve—. Cada paso del cableado
  va ahora en su propio `try`, y el candado se sigue instalando aunque el combo no monte. Verificado
  en el **artefacto**: `primeraVez` 0 → 3, `saWlpFieldMounted` ×3, 76 bloques `BEGIN`/`END`
  simétricos, `node --check` OK, trinquete 10/10. Peso **1.95 MB**.
- **Bundle v0.6.38 — 34 applets (2026-08-07):** sin applets nuevos; lleva al iPad el **fix del
  DISPARO** en los **cinco** que montan UI dentro de un modal: `create-order-autofill` (0.1.8),
  `receiver-date-override` (0.5.82), `warehouse-location-prefill` (0.6.4), `proceso-calculator`
  (0.1.5) y `unit-autoconvert` (0.1.1). **Medido en producción:** con un modal abierto hubo **0
  mutaciones de `childList` en el `body` durante 6 s**, incluso tecleando — el `MutationObserver`
  dispara en eventos discretos, **no vigila**, así que un montaje que falla (o que ocurre con el DOM
  a medias) no tenía quién lo reintentara. Todos llevan ya poll de re-detección, con tick barato.
  **Importa más aquí que en escritorio:** el iPad es el dispositivo del piso —el almacén recibe y
  surte desde ahí— y es la CPU más lenta del parque, justo el perfil donde el bug se manifiesta; el
  reporte que lo destapó fue «falla en los equipos Windows de menor desempeño». En WLP el arreglo
  además destrabó un latch que marcaba el **intento**: un fallo de anclaje se congelaba para siempre.
  Verificado en el **artefacto**: símbolos nuevos 0 → 6/5/3/6/5/3, `DETECT_POLL_MS` ×12, 76 bloques
  `BEGIN`/`END` simétricos, `node --check` OK, trinquete 10/10. Peso **1.95 MB** en bytes reales
  (+24 KB; el log del build dijo «1 903 531» porque cuenta **caracteres**, no bytes — la trampa de
  siempre).
- ⚠️ **Hueco de bitácora:** las versiones **0.6.36 y 0.6.37** se construyeron y commitearon
  (`a67df32`, `f653630`) pero **no se registraron en esta lista**. Sus mensajes de commit son la
  única descripción que quedó.
- **Bundle v0.6.35 — 34 applets (2026-08-06):** **fix** de `driver-licenses`, el segundo del
  día. Leer la carpeta paginaba **los 23,147 archivos del ERP** (~460 peticiones) y **tumbaba la
  sesión**: el `/graphql` se cuelga a las ~40-45 y el límite es **por sesión**, así que se caían
  también las pantallas nativas. En el iPad eso es peor que en escritorio — una sesión caída deja
  al almacén **sin recibir ni surtir**, y es justo el dispositivo donde se toma la foto de la
  identificación en el andén. Ahora filtra el **servidor** con `searchQuery` (medido: `totalCount`
  23,147 → 1) en dos etapas, con presupuesto duro de 24 peticiones: **~460 → ~10**. Suma el candado
  `looksLikeFailedSearch` (una lectura vacía ya no puede publicarse como bajas y borrar el catálogo)
  y la miniatura de la foto. Verificado en el **artefacto**: símbolos nuevos 0 → 3/3/3/5/2, el
  barrido viejo en **0** dentro de su bloque, `node --check` OK, trinquete 10/10. Peso **1.87 MB**.
- **Bundle v0.6.34 — 34 applets (2026-08-06):** sin applets nuevos; toma
  **`create-order-autofill` v0.1.6/v0.1.7**, que es justo lo que el iPad necesitaba:
  (1) el autofill **arranca solo** — disparo por **poll de 1 s** copiado de `weight-quick-entry`,
  porque el `MutationObserver` no despertaba en la lista de OVs; (2) si al cliente le faltan sus
  Entradas Personalizadas, el panel lo dice y ofrece **liga a su ficha**; (3) dejó de reportar en
  rojo la Divisa que él mismo había puesto bien (verificaba con vara más estricta que la de
  escribir). Peso **1.90 MB** (+8 KB medidos **en bytes**).
  ⚠️ Recordatorio que este rebuild volvió a confirmar: `build-safari.sh` imprime **caracteres**,
  y compararlos contra los **bytes** del baseline hace ver un bundle "encogido" (1 894 857 B →
  «1 861 985» que eran caracteres; en bytes reales **creció** a 1 902 882). **Mide siempre lo
  mismo contra lo mismo.**

- **Bundle v0.6.33 — 34 applets (2026-08-06):** **fix** de `driver-licenses`. El panel **no abría
  en el iPad**: `PdfLowCode` se llamaba sin `$first`/`$offset`, que son `Int!` obligatorios, y el
  ERP contestaba **HTTP 400**. Es el mismo bug que en Chrome, pero aquí importaba más — el iPad es
  donde se toma la foto de la identificación en el andén. Recordatorio de por qué existe este
  renglón: **el bundle es estático**, así que el deploy a `gh-pages` que arregló Chrome (`1.11.92`)
  **no toca el iPad**; hace falta rebuild + recompilar en Xcode. Verificado en el **artefacto**:
  `hookQueryVariables`/`pickActiveHook` 0 → 3, patrón viejo en 0, `node --check` OK, trinquete
  `build-safari` 10/10. Peso **1.85 MB** (+3.9 KB).
- **Bundle v0.6.32 — 34 applets (2026-08-05):** entra **`driver-licenses`** (Licencias de Choferes).
  Da de alta a un chofer externo subiendo la **foto** de su identificación y publica el catálogo que
  el hook `pdf:SHIPMENT_TEMPLATE` pinta en la lista de embarque. **Por qué sí aplica el criterio:**
  su única interacción con archivos es `<input type="file" accept="image/*">` — **subir**, no
  descargar; en iPadOS eso abre la cámara directo en el andén, que es justo donde se necesita. Sin
  FAB (`autoInject:false`) ⇒ el **popup es su única puerta**, así que lleva lanzador en los tres
  archivos. Peso real **1.89 MB** (+44 KB, +2.4%). El mismo rebuild tomó los fixes de
  `create-order-autofill` v0.1.4/v0.1.5 (verificados en el ARTEFACTO, no en el log).

- **Bundle v0.6.31 — 33 applets (2026-08-05):** entra **`packing-slip-drawings`** (Planos en Remisión)
  en versión **LIGERA**, y con él un mecanismo nuevo: **`excludeScripts`** en `bundle.json`. Peso real
  **1.85 MB** (+63 KB, +3.5%). Ver la lección de abajo sobre la TERCERA VÍA de curación.

- **Bundle v0.5.9 — 29 applets (2026-07-23):** los "directo" del inventario + `vale-almacen` (FAB) + 8
  "con-popup" (`archiver`, `sensor-status-autofill`, `load-calculator`, `auto-router`, `wo-completer`,
  `wo-deadline`, `price-confirm-guard` kill-switch, `pn-lifecycle`) lanzables desde el popup. **Agregados en
  v0.5.9:** `batch-name-filter` (box inline en el Panel de Envío) y `schedule-batch-highlighter` (buscador
  inline en el Schedule Board) — ambos `autoInject:true`, sin lanzador. Para agregar/quitar, edita
  `bundle.json` (inventario y criterio de curación en `docs/architecture/ipad-applets-inventory.html`). Peso
  ~1.24 MB — perfilar en iPads A12 o anteriores.

> ### 💡 CRITERIO (2026-08-05) — la TERCERA VÍA: integrar SIN sus librerías
> Hasta ahora la curación era binaria: el applet entra o no entra. `packing-slip-drawings` obligó a una
> tercera opción, y conviene tenerla presente para los que vengan.
>
> Ese applet declara `pdf.js` y `pdf-lib` (902 KB juntas, +50% del bundle), pero además arrastraba un
> **bloqueador de política**: el worker de `pdf.js` **se descarga en runtime desde gh-pages**, y eso es
> **código remoto** — exactamente lo que prohíbe la **Guideline 2.5.2** y la razón de que este bundle
> sea estático. Empaquetarlo tal cual habría metido una violación de política en la app del piso.
>
> **Pero su flujo core no dependía de esas librerías.** Sólo la impresión combinada y las miniaturas de
> PDF. Así que entró con **`excludeScripts`** (nuevo en `build-safari.sh`): el build salta esos scripts
> aunque el applet los declare. Coste: **+63 KB en vez de +962 KB**.
>
> **Requisito para usar esta vía:** el applet debe **degradar solo** cuando la librería falta — aquí
> `hayPdfLib()` oculta el botón 🖨️ y `hayPdfJs()` no emite canvas vacíos. *Ofrecer un botón que falla
> es peor que no ofrecerlo.* El build **no valida** esto; es responsabilidad de quien integra.
>
> Y una trampa de medición que ya está documentada pero conviene repetir: `build-safari.sh` imprime
> **caracteres**, no bytes. El crecimiento real se mide en el artefacto (`ls -la`).

> ### ⚠️ LECCIÓN OPERATIVA (2026-07-23) — el Modo de Aislamiento («modo hermético») debe quedar APAGADO
> **Verificado en piso por el operador:** con el **Modo de Aislamiento** de iPadOS (*Lockdown Mode*; el usuario
> lo llama «modo hermético») **activado, `app.gosteelhead.com` NI SIQUIERA CARGA** — no es la extensión: es el
> propio sitio, porque ese modo bloquea tecnologías web complejas (JIT de JS, WebAssembly, etc.). Además impide
> instalar apps de desarrollo y perfiles de configuración, así que **también bloquea la instalación de la app de
> Xcode**. **Conclusión: en el iPad que use Steelhead, el Modo de Aislamiento se deja APAGADO de forma
> permanente; NO reactivarlo.**
> - **Apagarlo:** `Ajustes → Privacidad y seguridad → Modo de Aislamiento → Desactivar el Modo de Aislamiento`
>   → confirmar **Desactivar y reiniciar**. **Prender/apagar ese modo SIEMPRE exige reinicio** (el cambio no
>   surte efecto sin reiniciar). Reactivarlo (misma ruta) vuelve a tumbar Steelhead hasta apagarlo de nuevo.
> - **No confundir** con el **Modo Desarrollador** (`Ajustes → Privacidad y seguridad → Modo Desarrollador`),
>   que sí hay que **activar** (iPadOS 16+, también pide reiniciar) para correr la app firmada con Apple ID.
>   Son dos toggles distintos en la misma sección de Ajustes: Aislamiento = OFF, Desarrollador = ON.
> - Guía humana completa entregada al operador (HTML): «Poner el iPad en Modo Desarrollador e instalar Candado
>   Surtido», con este hallazgo como Paso 0.

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
- **auto-router es un caso interesante:** en Chrome su trigger de popup (`chrome.runtime.onMessage`) está muerto en
  el MAIN world (MV3), así que allá solo corre por su FAB. En Safari el dispatcher usa `postMessage` (sí llega al
  MAIN world), así que sus lanzadores del popup **sí operan** — Safari lo recupera. `openPanel` pide abrir antes el
  modal de ruteo (alerta si no hay contexto); `openBatch` es autocontenido.

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
> **Antes de instalar — dos toggles en `Ajustes → Privacidad y seguridad`:**
> 1. **Modo de Aislamiento («modo hermético») = OFF.** Con él activo NO se instalan apps de desarrollo/perfiles
>    y **Steelhead ni carga** (ver LECCIÓN arriba). Desactívalo → **Desactivar y reiniciar** (obligatorio el
>    reinicio). Déjalo apagado permanentemente; no lo reactives.
> 2. **Modo Desarrollador = ON** (iPadOS 16+). Solo aparece tras conectar el iPad a Xcode (o `Window → Devices
>    and Simulators`). Actívalo → el iPad pide reiniciar → tras reiniciar, confirma **Activar**.

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

**Integrar applets nuevos al bundle:** no es automático (el bundle es una lista blanca curada). Corre el
escáner para ver qué falta y cómo clasifica cada candidato (FAB directo / lanzador de popup / no-aplica por
bloqueadores de iOS):
```bash
python3 tools/safari-bundle-scan.py      # candidatos + señales + JSON
```
El flujo completo (escanear → clasificar → integrar → rebuild → resumir) lo automatiza la skill
**`safari-bundle-sync`** (`~/.claude/skills/safari-bundle-sync/`); dile a Claude "actualiza el bundle Safari"
o "mete X al bundle". Tests: `tools/test/safari-bundle-scan.test.js` (escáner) + `tools/test/build-safari.test.js`
(cadena popup→dispatcher→applet).

> **Rotación de hashes en `config.json` NO requiere rebundle.** La advertencia de `deploy.sh` es un falso
> positivo cuando el deploy solo cambia hashes (no código de applets): `bridge.js` (mundo aislado) fetchea
> `config.json` de gh-pages en runtime y `sa-bootstrap.js` → `SteelheadAPI.init()` re-instala los hashes en
> caliente (fetch de **datos**, no código remoto → cumple Guideline 2.5.2). Verificado en vivo (2026-07-01).
> Solo rehornea el bundle cuando cambia la **lógica** de un applet en `remote/scripts/`.
