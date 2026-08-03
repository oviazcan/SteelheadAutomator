# Escalamiento Nivel B — re-descubrimiento de recetas rotas

Cuando el motor no logra capturar una op (la receta dejó de disparar la query
porque Steelhead movió la UI), escribe `tools/.hash-autopilot/needs-attention.json`
y manda correo. El **Nivel B** intenta re-descubrir esa receta **solo** y, falle o no,
manda un correo con el **trace detallado** de cada acción intentada (para mejorar el
sistema). Diseño completo: `docs/superpowers/specs/2026-07-17-nivel-b-escalacion-design.md`.

## Mecanismo (launchd local, NO CronCreate)

- `tools/launchd/com.ecoplating.steelhead-escalation.plist` corre `tools/run-escalation.sh`
  **a :53** (30 min después del motor, :23). Local porque el re-descubrimiento necesita el
  navegador, los tokens ROCP y el repo — todo en la Mac (un cloud agent no los tiene).
- `run-escalation.sh` hace **gate**: si no hay `needs-attention.json` → sale en <1s (cero costo
  en días limpios). Marca idempotente diaria (`escalation-tried-<fecha>`) para no re-loop.
  Refresca el ROCP (fail-ruidoso) y corre `claude -p` con `escalation-prompt.md`.

**Activar (una vez, paso manual del operador tras una prueba supervisada verde):**
```bash
cp tools/launchd/com.ecoplating.steelhead-escalation.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ecoplating.steelhead-escalation.plist
launchctl list | grep escalation
```

## Flujo por capas (intenta auto → escala rico)

El agente (`claude -p`, prompt en `escalation-prompt.md`):
1. Lee `needs-attention.json` (enriquecido: op + receta vieja completa `module`/`steps`/`captures`).
2. Re-descubre con Playwright headless (infra del motor), **tope ~15 acciones/op**, registrando
   cada intento en el trace.
3. **Si halla la receta:** actualiza `route-catalog.json`, corre la suite, deja que
   `hash-autopilot.mjs --only=<op>` capture+deploye (con sus candados). Correo "reparado".
4. **Si no:** correo "necesito ayuda" con el trace detallado + diagnóstico. NO toca recetas.

**Guardrails:** read-only sobre SH (nunca confirma escrituras) · nunca edita `config.json` ·
tests antes de deployar · idempotente · auth fail-safe.

## El trace (requisito del operador)

`tools/.hash-autopilot/escalation-trace-<fecha>.json` + resumen en el correo. Cada acción:
`{ op, step, action, target, selectorTried, observed, opFired, screenshot }`. Módulo puro
`escalation-trace.mjs` (`newTrace`/`addAction`/`summarizeForEmail`/`outcomeByOp`). Es la pieza
que hace el sistema mejorable: cada fallo documentado afina el prompt/heurísticas.

## Formato de needs-attention.json

```json
{
  "date": "2026-07-17",
  "ops": [
    { "op": "SensorDashboardQuery", "recipeTried": "maintenance-sensordashboards-detail",
      "module": "Maintenance", "steps": [ ... ], "captures": ["SensorDashboardQuery"],
      "observed": "la receta no disparó la op (0 capturas)" }
  ]
}
```
`recipeTried`/`steps` null = la op ni tenía receta (crear desde cero).

## Prueba supervisada (antes de cargar el launchd)

Fabrica un `needs-attention.json` con una op cuya receta SIGA funcionando y corre
`tools/run-escalation.sh` a mano en una sesión supervisada; verifica: gate deja pasar →
claude re-descubre/confirma → trace escrito → correo con el resumen → la marca idempotente
evita el segundo run. Borra el needs-attention de prueba al terminar.

## Actualización 2026-07-27 — el `observed` que llega al Nivel B ahora dice la verdad

`buildNeedsAttention()` escribía siempre el genérico *"la receta no disparó la op (0 capturas)"*.
El 2026-07-24 `SaveManyPartNumberPrices` escaló con ese texto cuando en realidad su **ciclo
centinela había abortado por IDENTIDAD** (el load no reconoció el quote centinela). Son dos
diagnósticos y **dos reparaciones distintas** — *"desarchiva/renombra el centinela"* vs
*"re-descubre la receta"* — y el agente del Nivel B arrancó buscando la equivocada.

Ahora la razón real del ciclo viaja en `observedByOp` (op → `"ciclo centinela abortó: <razón>"`).
Sin entrada declarada se conserva el genérico de siempre (retrocompatible, con test).

## Actualización 2026-07-28 — la captura de rebote: por qué `recipeTried` puede mandar a la pantalla equivocada

Escalaron 3 ops (`AllSensorDashboards`, `Customer`, `SensorDashboardQuery`). **Dos eran falsa
alarma** (blip de sesión/red en la corrida de las 07:36: probe 5/5 auth-unknown, ProductUpdates
con `bodyLen=60`, los dos `clickFirst` en cero, y el refresh ROCP tronando a las 07:53 y 09:00);
sus recetas capturaron sin tocar nada al primer intento. **La tercera sí estaba rota, desde hacía
6 días, y nadie lo vio.**

`AllSensorDashboards` estaba declarada en **tres** rutas (`home-list` = goto `/`,
`sensor-dashboards` = `/Dashboards`+clic, `sensordashboards-list` = goto a la lista). `selectRoutes`
es set-cover greedy: `home-list` cubría 2 pendientes (`AllSensorDashboards` + `CurrentUser`) y
ganaba **siempre** → las otras dos nunca corrían. El home **dejó de dispararla el 2026-07-22**
(0/41 ese día y 0 en las ~126 corridas siguientes; el 07-21 iba 26/35) y aun así la op salía
**✓ vigente todos los días**: el paso 0 de `maintenance-sensordashboards-detail` visita la misma
lista y **el sink es COMPARTIDO entre rutas**, así que la capturaba **de rebote**. El día que esa
ruta falló por el blip, las dos cayeron juntas.

**Dos lecciones para el Nivel B:**
1. **Una captura declarada en una ruta que NO la dispara no falla ruidosamente** — la absorbe otra
   ruta y el catálogo miente en silencio. Es el modo de falla que ya documentaba
   `route-catalog-coherence.test.js`; la defensa es atar la op a UNA sola ruta verificada
   (`_manualRouteOps` + EXPECTED en el test).
2. **`recipeTried` del `needs-attention` es la receta que ELIGIÓ el planificador, no la que de
   hecho dispara la op.** Aquí mandaba a re-descubrir el home cuando la pantalla real era
   `/Domains/{d}/SensorDashboards`. Antes de dar por rota una receta, **prueba también las otras
   rutas que declaran la misma op**.

Mejora de motor pendiente (no se hizo aquí, es cambio de motor y no de receta): avisar cuando una
ruta seleccionada **no captura una op que declara**, aunque otra la capture de rebote.

## Actualización 2026-07-31 — el MISMO falso positivo dos veces: la corrida sin datos no es una receta rota

Escalaron `AllSensorDashboards` y `SensorDashboardQuery`. **Las dos capturaron al PRIMER intento
con la receta del catálogo intacta**, hash idéntico al de `config.json` → vigentes. Segunda falsa
alarma en cuatro días, por la misma causa: **la red se cayó a media corrida**.

Evidencia (corrida de las 17:23, log del launchd):
- Las 3 primeras rutas capturaron (`app-home`, `customer-detail`, `customers-list`); fallaron las
  **2 últimas en orden de ejecución** — `maintenance-sensordashboards-detail` y
  `sensordashboards-list`. El corte es por POSICIÓN en la corrida, no por pantalla.
- Probe directo: **0 vigentes / 5 auth-unknown** (un día sano da 5/5 vigente; la corrida de las
  16:23, una hora antes, capturó las dos ops sin novedad).
- A las 17:59 `validate-hashes.py` registró **59 UNKNOWN por `NameResolutionError` de DNS** contra
  `app.gosteelhead.com`, y el refresh ROCP ya había tronado a las 00:46 y 15:27 contra
  `auth.gosteelhead.com`. El DNS de la Mac estuvo intermitente todo el día.

**Fix de motor (este sí se hizo):** `isProbeSessionDegraded()` en `probe-classify.mjs` — si TODAS
las ops probadas dan `auth`/`unknown` (mínimo 3), la corrida **no tiene datos** y sus `unconfirmed`
dejan de escalar. Es la regla que el repo ya pagó en `surtido-guard` 0.4.0 y `report-regen` 0.3.2:
**«no tengo el dato» ≠ «no existe el dato»**. Acotado a propósito:

- **nunca toca `stale`** — un `stale` exige que el server haya contestado *"Must provide a query
  string"*, o sea que la sesión SÍ respondió; las rotaciones reales siguen escalando siempre;
- **no pierde detección, la aplaza**: el motor corre cada hora, una rotación real sobrevive al
  siguiente tick y un blip de red no;
- **el fail-safe se DICE** (lección `surtido-guard` 0.4.0): el log lo grita y el correo sigue
  reportando la sección *"❓ NO CAPTURADAS, PROBE NO CONCLUYENTE"*. Lo único que se suprime es la
  escalación cara (`needs-attention.json` → un `claude -p` completo).

7 tests nuevos en `probe-classify.test.js`, incluido el veredicto real de las 17:23.

## Actualización 2026-08-03 — la receta no está rota: es FLAKY, y hacen falta DOS fallas para escalar

Escaló `SensorDashboardQuery` sola. **Falsa alarma otra vez (la tercera seguida), pero por una
causa NUEVA**: no fue el DNS. En la corrida de las 07:27 las otras **4 rutas capturaron sin
novedad**, así que la sesión y la red estaban sanas. La op capturó **4 de 4 veces** al probarla y
su hash es idéntico al de `config.json` → vigente, nada que deployar, cero recetas cambiadas.

**Lo que el log ya sabía y nadie había mirado: la receta acierta 332 de 366 corridas (90.7%) y
falla ~1 de cada 5.** Fallas recientes: 08-01 23:24, 08-02 06:30, 08-02 16:28, 08-03 07:27, sin
patrón horario. **Una receta que falla el 10% de las veces no es una receta rota, y tratarla como
tal manda al Nivel B a re-descubrir una pantalla que nunca se movió.** Antes de dar por rota una
receta, cuenta cuántas veces ha capturado: el log lo dice gratis.

**Causa raíz, medida y reproducida (3 repeticiones de la MISMA receta del catálogo):** es la
**única** receta cuyo éxito depende de que el **DOM RINDA filas** (137) para poder clicar; su
vecina `sensordashboards-list` solo necesita que la **RED** conteste, y por eso capturó los cuatro
días en que ésta falló. El presupuesto es 25 s del `goto` + 25 s del `clickFirst`; cuando la lista
tarda más, no hay `<a>` que clicar y la ruta termina en cero capturas **sin error y sin ruido**.
La repetición 1 lo demostró alcanzable: a los 25 s la página seguía siendo el cascarón del SPA
(`rows=0`, `bodyLen=342`) y la captura llegó hasta los **74 535 ms**; las repeticiones 2 y 3, con
el SPA caliente, vieron el ancla a los **97 ms** y **179 ms**.

**Calibración honesta de esto último:** lo *medido* es que el modo de falla EXISTE y se alcanza; que
las 34 fallas de producción sean todas ése es la **hipótesis mejor soportada**, no un hecho
verificado — encaja con que la vecina, que no depende del render, no falló ninguno de esos días,
pero el log del motor **no registra si hubo ancla** cuando el `clickFirst` no logra clicar, así que
la atribución es inferida. **Cómo cerrarla de verdad (cambio de motor de 5 líneas):** que
`clickFirstMatching` registre `rows`/`anchors`/`bodyLen` al vencer sin clic. Con eso la PRÓXIMA
falla trae evidencia directa en vez de obligar a re-derivarla, y decide si la mejora (1) es la
correcta antes de gastarla.

**Por qué escaló HOY y no las otras tres veces — hicieron falta DOS fallas simultáneas:** además
de no capturar, el probe de confirmación **tronó** (`page.evaluate: Execution context was
destroyed` → fail-open, sin gating), así que `probeVerdicts` quedó **vacío** y, sin nadie que
confirmara el hash, la op no capturada escaló. Las otras tres veces el probe sí opinó. Ese error
del probe lleva **6 apariciones** en el log histórico. **El eslabón que debía evitar el gasto de
un `claude -p` fue justo el que lo desencadenó.**

**Mejoras de motor RECOMENDADAS, no aplicadas** (cambian el comportamiento de escalación de todo
el sistema y su trade-off lo decide el operador, no un agente desatendido):
1. `stepTimeoutMs` **por ruta** en `route-catalog.json`, ~60 s para
   `maintenance-sensordashboards-detail`. Ataca la falla de origen.
2. Que un probe que **truena** cuente como *corrida sin datos* y no habilite escalación — la misma
   regla de `isProbeSessionDegraded()` («no tengo el dato» ≠ «no existe el dato»). Trade-off: si
   el probe muere justo cuando hay una rotación real, la detección se **aplaza** al siguiente tick.

**Dato lateral que corrige un comentario del código:** el `goto` **directo** a
`/Maintenance/SensorDashboards/119` **sí** dispara la op (16 s, mismo hash), lo que refuta el
comentario de `recipe-runner.mjs` (*«page.goto sí re-bootstrapea el SPA y por eso NO fetchea»*) al
menos en esta pantalla. No se adoptó como receta: ataría la captura a un id que pueden archivar, y
la del catálogo acierta 9 de cada 10 veces.
