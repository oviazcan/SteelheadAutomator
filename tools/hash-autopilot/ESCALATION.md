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
