# Escalamiento hash-autopilot → Claude

Cuando el motor no logra capturar una op (la receta dejó de disparar la query
porque Steelhead movió la UI), escribe `tools/.hash-autopilot/needs-attention.json`
y manda correo. Un **cron condicional de Claude** atiende esa señal para
re-descubrir la receta — SOLO cuando existe (no gasta tokens en días limpios).

## Crear el cron (una vez)

Correr en una sesión de Claude Code con el skill `steelhead-hash-validator`
disponible. Usa `CronCreate` (durable) con este prompt:

```
Revisa si existe el archivo tools/.hash-autopilot/needs-attention.json en
/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator.
- Si NO existe → termina sin hacer nada (no gastes tokens).
- Si existe:
  1. Invoca la skill steelhead-hash-validator.
  2. Para cada op listada, abre Steelhead con claude-in-chrome (o el motor de
     hash-autopilot en headed) e instala el interceptor de fetch; navega para
     re-descubrir la MÍNIMA secuencia que dispara esa op (1 intento acotado,
     tope de ~15 acciones de browser).
  3. Si la encuentras: actualiza tools/hash-autopilot/click-recipes.json con la
     receta nueva, corre `node tools/hash-autopilot/hash-autopilot.mjs` (sin
     --dry-run) para que regenere/deploye si rotó, y manda correo "reparado"
     (tools/hash-autopilot/autopilot-notify.sh exito ...).
  4. Si NO la encuentras: manda correo "necesito ayuda: cambió el shape/UI de X"
     (autopilot-notify.sh fallo ...).
  5. Borra tools/.hash-autopilot/needs-attention.json al terminar (en ambos casos).
```

Programar poco después del launchd horario del motor (que corre a :23). Ej.
`CronCreate` a :53 de cada hora, durable.

## Formato de needs-attention.json

```json
{
  "date": "2026-07-03",
  "ops": [
    { "op": "GetPurchaseOrder", "recipeTried": null, "steps": null,
      "observed": "la receta no disparó la op (0 capturas)" }
  ]
}
```

Si `recipeTried` es null, la op ni siquiera tiene receta en `click-recipes.json`
(hay que crearla desde cero). Si trae `steps`, la receta existía pero dejó de
funcionar (la UI cambió) — usa esos steps como punto de partida.
