# Nivel B — Escalación autónoma de recetas rotas (hash-autopilot)

**Fecha:** 2026-07-17
**Estado:** diseño aprobado (enfoque "por capas"), pendiente spec-review + plan de implementación.

## 1. Problema

El hash-autopilot cubre el **Nivel A** (un hash rota → el motor lo detecta, captura y auto-deploya). El **Nivel B** es el caso raro donde **Steelhead mueve la UI** y una *receta* (la secuencia de navegación que hace al frontend disparar una op) deja de funcionar → **0 capturas** → el motor escribe `tools/.hash-autopilot/needs-attention.json` + manda correo.

Hoy el correo **solo notifica**: nadie repara la receta automáticamente. Requiere que un humano (o una sesión de Claude) la re-descubra a mano. Hubo un `needs-attention.json` sin atender días (se limpió el 2026-07-17).

## 2. Objetivo

Cuando una receta se rompe, **intentar re-descubrirla sola**; si no se logra en un presupuesto acotado, **escalar con diagnóstico rico**. En AMBOS casos, producir un **trace detallado de las acciones intentadas** para que el operador mejore el sistema iterativamente (requisito explícito del operador 2026-07-17).

Enfoque elegido: **por capas** (intenta auto → fallback rico). El re-descubrimiento a ciegas es la parte frágil; el fallback garantiza que nunca se quede atascado sin avisar, y el trace permite afinar las heurísticas con el tiempo.

## 3. Mecanismo de agendado — launchd LOCAL

- **Local, no cloud.** El re-descubrimiento necesita el navegador, los tokens ROCP (`Reportes SH/.cache/tokens.json`) y el repo — todo en la Mac del operador. Un cloud agent no los tiene. Corre en el mismo host que el hash-autopilot.
- **launchd, no CronCreate.** CronCreate es por-sesión (moriría al cerrar Claude); launchd corre sin sesión abierta (autónomo, igual que el motor).
- **A :53 de cada hora** — 30 min después del motor (:23), para que el needs-attention del ciclo ya esté escrito.
- **Condicional (gate):** si no existe `needs-attention.json` → termina en <1 s. Cero costo en días limpios (que son casi todos).

## 4. Flujo del agente (`claude -p` headless)

1. **Gate:** si no hay `needs-attention.json` → salir.
2. **Auth:** refrescar el ROCP (force) como `run-hash-autopilot.sh`; fail-ruidoso si no se puede.
3. **Por cada op rota** en `needs-attention.json`:
   a. Tomar la receta vieja (`steps`) como punto de partida (si existe; si `recipeTried` es null, desde cero).
   b. **Re-descubrir** la secuencia mínima que dispara la op, con **tope de ~15 acciones de browser**. Registrar CADA acción en el trace (§6).
   c. **Si la halla:** actualizar `route-catalog.json` (o `click-recipes.json`), correr `tools/run-tests.sh`, y dejar que `hash-autopilot.mjs` capture+deploye (con sus propias salvaguardas).
   d. **Si no:** marcar el intento; NO tocar recetas.
4. **Notificar** (un correo por corrida, a los 3 destinatarios):
   - Reparadas: `autopilot-notify.sh exito` con el trace resumido + el diff de la receta.
   - No reparadas: `autopilot-notify.sh fallo` con el trace detallado + diagnóstico (op, receta vieja, screenshot, dónde se atascó).
5. **Idempotencia:** marcar cada op como "intentada hoy" para no re-loop en el siguiente tick; borrar `needs-attention.json` sólo cuando todas las ops se resolvieron o se escalaron.

## 5. Re-descubrimiento — cómo

Claude maneja **Playwright headless reusando la infra del motor** (`recipe-runner.installInterceptor` + una page autenticada con el ROCP inyectado), NO `claude-in-chrome` (que exige Chrome + extensión + sesión interactiva, ausentes en un cron con el operador away).

Bucle exploratorio acotado:
- Instala el interceptor de `/graphql` (captura qué ops se disparan).
- Prueba una secuencia candidata (parte de la receta vieja; varía un paso: nuevo selector, nuevo texto de botón bilingüe, un clic intermedio).
- Observa: ¿se disparó la op objetivo? ¿apareció el elemento esperado? Toma screenshot.
- Ajusta y reintenta hasta capturar la op o agotar el presupuesto (~15 acciones).

## 6. El TRACE detallado (requisito del operador)

Cada corrida produce `tools/.hash-autopilot/escalation-trace-<fecha>.json` (+ resumen legible en el correo). Por cada acción intentada:

```json
{ "op": "SensorDashboardQuery", "step": 3, "action": "clickButton",
  "target": "add invoice|crear factura", "selectorTried": "span[aria-label='Add Invoice'] button",
  "observed": "botón no encontrado (la UI ahora usa aria-label 'Nueva Factura')",
  "opFired": false, "screenshot": "escalation-3-SensorDashboardQuery.png" }
```

- **Se guarda** (archivo) para revisión — permite ver qué estrategias de re-descubrimiento funcionan/fallan y afinar el prompt/heurísticas con el tiempo.
- **Se resume en el correo** — el operador ve "qué intentó" sin abrir el repo.
- Es la pieza que hace el sistema **mejorable**: cada fallo documentado es una lección para la próxima iteración del prompt.

## 7. Guardrails

- **Tope de acciones** (~15) por op → no gasta tokens/tiempo sin fin.
- **Solo toca recetas** (`route-catalog.json`/`click-recipes.json`), NUNCA `config.json` directo — el deploy de hashes lo hace el motor con sus candados (firma, freno de masa, `autopilot-deploy.sh`).
- **Tests antes de deployar** — si la receta nueva rompe la suite, no se publica.
- **Idempotente** — no re-intenta la misma op en loop el mismo día.
- **Auth fail-safe** — si el ROCP no refresca, avisa y NO abre el navegador.
- **Read-only sobre datos de SH** — el re-descubrimiento solo NAVEGA y captura (lecturas); nunca dispara escrituras. Para ops que son mutations, se limita a abrir el modal sin confirmar (como las rutas de captura seguras del catálogo).

## 8. Componentes nuevos / modificados

| Componente | Rol |
|---|---|
| `tools/launchd/com.ecoplating.steelhead-escalation.plist` | agenda a :53 (nuevo) |
| `tools/run-escalation.sh` | wrapper: PATH, ROCP refresh, gate por needs-attention, corre `claude -p`, ensambla el trace + correo (nuevo) |
| `tools/hash-autopilot/ESCALATION.md` | actualizar: prompt de re-descubrimiento + formato del trace (existente) |
| `hash-autopilot.mjs` (`writeNeedsAttention`) | enriquecer `needs-attention.json` con la receta vieja completa + screenshot del último estado (existente) |
| El prompt del agente | instrucciones de re-descubrimiento + registro obligatorio del trace (nuevo, embebido en el wrapper o archivo) |

## 9. Fragilidad reconocida y mitigación

El re-descubrimiento automático de una UI que cambió es genuinamente frágil (Claude explorando a ciegas). No se pretende que resuelva el 100% de los casos. La mitigación es el **diseño por capas**: cuando falla, el escalamiento rico + el trace dejan al operador a un paso de cerrarlo, y cada fallo alimenta la mejora del prompt. El valor es "resuelve los casos fáciles solo + acelera los difíciles", no "cero humanos para siempre".

## 10. Fuera de alcance (YAGNI)

- No re-descubre ops que nunca tuvieron receta y requieren conocimiento de negocio (esas escalan directo).
- No modifica el modelo de datos ni los handlers de mutations centinela (eso es trabajo humano deliberado).
- No corre en cloud (requiere el entorno local).
