# `sensor-graph-hide-all` — Auto-ocultar sensores en la gráfica

## Qué hace
Al **entrar** a un Sensor Dashboard (`/Domains/<id>/Maintenance/SensorDashboards/<idInDomain>`),
esconde automáticamente **todos** los sensores de la gráfica (deja todos los "ojitos" tachados)
para que el operador solo **destache el que quiere ver**. Sin esto, cada dashboard abre con
14+ series encimadas y hay que tachar una por una a mano en cada visita.

## Versión
0.1.0 — **VALIDADO en vivo end-to-end** (config 1.7.73, gh-pages). Core 12/12 golden.
Config `sensor-graph-hide-all` con `autoInject:true`.

## Modelo (confirmado en vivo 2026-07-07, dashboard `/SensorDashboards/117` "Concentración de Plata")
- El ojito de cada sensor en la tabla **"Current Values"** togglea si el sensor se plotea en la gráfica
  (tanto en la tabla como en "OPEN GRAPH MODE", que lee el mismo estado).
- **Es PURO estado de React — 0 mutaciones GraphQL** (verificado interceptando `fetch`: clicar el ojito
  no dispara ninguna petición). Por eso se **resetea a "todos visibles" en cada carga** → hace falta
  re-esconder al entrar. Y por eso esconder es gratis (sin 502s, sin carga al server, reversible).
- Markup del botón (a prueba de idioma vía `data-testid`, con `aria-label` como primario):
  - **Visible**: `<button aria-label="Hide this sensor in the graph.">` con `svg[data-testid="VisibilityIcon"]`
  - **Oculto**:  `<button aria-label="Show this sensor in the graph.">` con `svg[data-testid="VisibilityOffIcon"]`

## Arquitectura
- **`sensor-graph-hide-all-core.js`** (puro, testeable): `parseDashboardId`/`isDashboardPath` (regex del
  path CamelCase, acepta slug con guión por si rota) + `nextHideStep(state)` — máquina de decisión del poll.
- **`sensor-graph-hide-all.js`** (glue DOM): detección de ojitos, poll de entrada, toggle, toast dark-mode,
  listener de navegación SPA. Auto-inyectado (`autoInject:true`, molde de los guards). **No depende de SteelheadAPI.**

### Contrato "una vez por entrada" (evita pelear con el operador)
El poll esconde todo al ENTRAR (cuando la tabla renderiza) y **latchea** la entrada (`window.__saSensorHideLastKey`
= pathname). Una vez latcheada: si el operador destacha uno para verlo, o le da *Refresh Data*, **NO se re-esconde**.
Se re-arma solo al navegar a **otra** entrada (otro pathname). Decisión pura en `nextHideStep`:
`idle`(fuera/off) · `done`(ya latcheada) · `wait`(tabla sin renderizar) · `hide`(hay visibles, quedan intentos) · `latch`(0 visibles o intentos agotados).

### Por qué un poll (setInterval) y no un while-loop síncrono
**Clicar el ojito NO actualiza el DOM síncrono** — React re-renderiza async (verificado: tras `forEach` de
14 clics, el conteo inmediato en el MISMO tick sigue en 14; tras el microtask baja a 0). Un while-loop
`click→re-query` habría detectado "atorado" y roto tras 1 clic. El poll clickea todos los visibles por tick
y re-consulta fresco en el siguiente; converge en 1–2 ticks. Topes: `MAX_ATTEMPTS=8`, `POLL_MAX_TICKS=30` (~4.5s).

### Estado singleton (lección surtido-guard)
`window.__saSensorHideEnabled` / `__saSensorHideLastKey` / `__saSensorHidePoll` / `__saSensorHideInit` viven en
`window`, NO en el closure: `injectAppScripts` RE-EVALÚA el IIFE en cada acción del popup (el script no está en el
mapa `globals` de dedup). Si vivieran en el closure, una re-inyección re-escondería lo que el operador ya destachó.
Default ON solo en la primera carga (undefined); un reload limpia `window` → vuelve a ON (no persistente, por diseño).

### Toggle del popup — SIN republicar la extensión
Acción `type:"toggle"` con `fn:"SensorGraphHideAll.toggleFromPopup"`. Lo despacha el **handler genérico** de
`background.js` (`default:` ~L1380: busca la acción por `message`, inyecta scripts, ejecuta `window.<Obj>.<method>()`).
**No requiere `case` nuevo en background ni bump de `extensionVersion`** — igual que `surtido-guard`/`price-confirm-guard`.
Default ON; OFF muestra todos de inmediato (`unhideAll`) y se reactiva al recargar.

## Validación
- **Core**: `tools/test/sensor-graph-hide-all-core.test.js` — 12/12 golden (`node --test`).
- **End-to-end en vivo (2026-07-07, dashboard 117, extensión real config 1.7.73)**: ✓ la extensión **auto-inyecta**
  el app (`window.SensorGraphHideAll`/`...Core` definidos por el background), ✓ el poll corrió y dejó **14/14
  tachados** (`VisibilityOffIcon`, `visible:0`), ✓ **latcheó y detuvo el poll** (`pollStopped:true`, `lastKey` set →
  no re-esconde lo que el operador destache), ✓ **sin regresión**: los apps que van DESPUÉS en el array
  (`auto-router`, `surtido-guard`) siguen auto-inyectándose. Funcionó incluso con la tab en `document.hidden`.
- **DOM (previo)**: selectores (14 toggles), clasificación por aria-label, esconder lleva 14→0 en una pasada
  `forEach` (React re-renderiza async), clicar el ojito no dispara GraphQL (puro React).

## Lección de deploy — propagación CDN + break del loop de auto-inject
El auto-inject de `background.js` hace `break` del loop completo si `injectAppScripts` de UN app lanza, y
`fetchScriptCode` **lanza si el fetch del script no es HTTP 200** (`background.js:37`). Al desplegar un app **nuevo**,
`config.json` propaga al CDN de GitHub Pages ANTES que los `.js` nuevos (~1-2 min de lag). Durante esa ventana, el
background ve el app en config pero su fetch del script da 404 → throw → **rompe el loop** → los apps que van
DESPUÉS del nuevo en `config.apps` NO se auto-inyectan (aquí: `auto-router`, `surtido-guard`) hasta que el CDN
propaga. **Self-healing**: se resuelve solo al recargar tras la propagación (verificado). Mitigaciones a futuro:
(a) colocar apps nuevos al FINAL de `config.apps` para minimizar el radio del break durante su ventana de propagación;
(b) hardening en `background.js`: envolver cada `injectAppScripts` del loop en try/catch para que un app no tumbe a
los demás (requiere republicar extensión — pendiente aparte).

## Pendientes
1. Considerar persistir el toggle en `chrome.storage` (`sensorGraphHideAllEnabled`) si el operador quiere que
   OFF sobreviva reloads (hoy es no persistente, como los guards). El auto-inject ya respeta esa key si se setea.
2. Opcional: recordar el último sensor visto y dejarlo destachado (hoy esconde TODOS; el operador elige uno).
3. (Bundle Safari/iPad) si se quiere la versión iPad, integrar vía `safari-bundle-sync`.
