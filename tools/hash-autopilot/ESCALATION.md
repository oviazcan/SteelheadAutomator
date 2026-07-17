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
