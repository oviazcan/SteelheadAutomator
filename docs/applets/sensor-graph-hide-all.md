# `sensor-graph-hide-all` — Auto-ocultar sensores en la gráfica

## Qué hace
Al **entrar** a un Sensor Dashboard (`/Domains/<id>/Maintenance/SensorDashboards/<idInDomain>`),
esconde automáticamente **todos** los sensores de la gráfica (deja todos los "ojitos" tachados)
para que el operador solo **destache el que quiere ver**. Sin esto, cada dashboard abre con
14+ series encimadas y hay que tachar una por una a mano en cada visita.

## Versión
- **0.1.0** (Fase 1) — **VALIDADO en vivo end-to-end** (config 1.7.73). Auto-esconder todos al entrar.
- **0.2.0** (Fase 2, config 1.7.77) — **combo para AISLAR un sensor NUMBER** en ambas vistas. Core 20/20 golden.
  Isolate validado en vivo (14→1); combo/intercepción validados por tests + anclas DOM (ver §Validación Fase 2).
Config `sensor-graph-hide-all` con `autoInject:true`. Scripts: `sensor-graph-hide-all-core.js` + `sensor-graph-hide-all.js`.

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

## Fase 2 — Combo para aislar un sensor (v0.2.0)
Un combo dark-mode (`<select>`) que lista **solo los sensores NUMBER** (excluye BOOLEAN). Al elegir uno,
**muestra solo ese y esconde los demás** (mismo mecanismo de ojitos). Aparece en **ambas vistas** (inline + modo gráfica).

- **Fuente de datos:** `{name, station, measurementType}` por sensor, de `SensorDashboardQuery` (`Core.parseSensorDashboard`).
  El `?type=NUMBER` nativo filtra la GRÁFICA pero **NO la tabla/ojitos** (verificado: con `type=BOOLEAN` siguen los 14 ojitos),
  por eso el tipo por-sensor hay que sacarlo de la query, no de la URL. **Dos vías:**
  1. **Intercepción** (`patchFetch`): oportunista, capta refetches (Refresh/date/type/navegación).
  2. **Replay** (`ensureSensorMeta` → `SteelheadAPI.query('SensorDashboardQuery', {idInDomain, after, before, measurementType:'NUMBER'})`):
     **GARANTIZADO**. El hook se pierde la query de la **carga inicial** (se dispara ANTES de que el applet inyecte `patchFetch`)
     → el combo se quedaba en "cargando sensores…" (bug confirmado en run real 2026-07-07). El replay lo resuelve: los *members*
     (nombres+tipos) NO dependen del rango de fechas, así que pedimos una ventana de 1h (mediciones mínimas, member list completa).
     Requiere `steelhead-api.js` en el app + el hash correcto en config. **El hash estaba ROTADO** (`bde56bd6…` viejo → actualizado
     a `038f4822…` del scan 2026-07-07); sin eso el replay daría "Must provide a query string".
- **Ancla (ambas vistas):** `button[value="NUMBER"]` (bloque "Measurement Types") → `.closest('.MuiPaper-root')` → inserta la
  barra del combo después. Semántico y a prueba de idioma. En modo gráfica hay 2 anclas (inline + diálogo) → un combo c/u.
- **Aislar:** `getEyeRows()` mapea ojito → `closest('tr')` → nombre (link de la fila); `Core.planIsolation` decide show/hide;
  poll acotado (clicar NO actualiza el DOM síncrono). Al aislar un numérico, si la gráfica está en `type=BOOLEAN` clickea NUMBER.
- **Sincronía:** `Core.deriveComboValue(visibles, todos, numéricos)` recalcula el valor del combo desde el estado real de los
  ojitos (0→Ninguno, todos→Todos, 1 numérico→ese, mezcla→placeholder). Los 2 combos reflejan lo mismo.
- **Anti-loop del observer:** `populateCombos` sólo reconstruye opciones si cambia la firma (`dataset.saSig`); `syncCombos` setea
  `sel.value` (propiedad, no muta el DOM). Un `MutationObserver` debounced inyecta/sincroniza; teardown al salir del dashboard.
- **Blindaje:** la Fase 2 en `init` va en `try/catch` — un bug del combo NO tumba la Fase 1 ni al resto del app (además el
  `try/catch` interno de `injectAppScripts` aísla errores de runtime del resto de apps auto-inyectados).
- **Etiqueta:** por estación (`sensorLabel` → `stationByStationId.name`, ej. "T203-TI00-011 Plata Silvrex (B-1)"). Opciones:
  `— elige sensor —` / `Todos` / `Ninguno` / cada sensor NUMBER. `textContent` (no innerHTML → sin XSS).

### Validación Fase 2 (2026-07-07)
- **Core 20/20 golden**: `filterNumericSensors`, `sensorLabel`, `deriveComboValue`, `planIsolation`, `normalizeName`,
  **`parseSensorDashboard` contra la forma real** de SensorDashboardQuery (NUMBER+BOOLEAN) + pipeline parse→filterNumeric.
- **DOM en vivo (síncrono)**: ✓ ancla `button[value="NUMBER"].closest('.MuiPaper-root')` existe + inserción del combo OK;
  ✓ **aislar 1 sensor → exactamente ese visible (14→1)**, mapeo ojito→nombre correcto.
- **No-regresión**: mi Fase 2 **no rompe el loop de auto-inject** — los breaks observados fueron transitorios en
  índices ANTES de mi app (`create-order-autofill@28`, etc.), por warming del CDN / lifecycle del SW MV3, no por mi código.
- **Pendiente (limitación de entorno)**: la intercepción real de `SensorDashboardQuery` (poblar el combo con NUMBER),
  el observer que auto-inyecta el combo y el `<select>` visual **no** se ejercieron en vivo porque la tab de automatización
  está `document.hidden` → Chrome throttlea timers **y fetch/microtasks** (async se cuelga). El parser está testeado contra
  data real; falta el **run en primer plano** del operador: abrir un Sensor Dashboard → ver el combo poblado → elegir un
  sensor → confirmar que la gráfica muestra solo ese (inline y en modo gráfica).

## Pendientes
1. ~~Confirmar el fix de población~~ ✅ **CONFIRMADO en vivo por el usuario (2026-07-07, config 1.7.78)**: el combo puebla
   con los sensores NUMBER (vía replay), aislar + Todos/Ninguno funcionan. Fase 2 operativa end-to-end.
2. Considerar persistir el toggle en `chrome.storage` (`sensorGraphHideAllEnabled`) si se quiere que OFF sobreviva reloads.
3. Opcional: recordar el último sensor visto y dejarlo destachado por default (hoy esconde TODOS; el combo elige).
4. (Bundle Safari/iPad) si se quiere la versión iPad, integrar vía `safari-bundle-sync`.
5. (Deuda ajena) el loop de auto-inject de `background.js` hace `break` si un fetch de script no es 200; tras cualquier
   deploy (bump de versión) TODOS los scripts hacen cache-miss `?v=X` y algún fallo transitorio corta la cadena de apps
   siguientes. Se auto-sana al calentar el CDN. Hardening: try/catch por-app en el loop (requiere republicar extensión).
