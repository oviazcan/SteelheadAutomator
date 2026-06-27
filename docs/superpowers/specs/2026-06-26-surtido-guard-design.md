# Diseño — applet `surtido-guard` ("Candado de Surtido Programado")

> Fecha: 2026-06-26
> Estado: **diseño aprobado** (Enfoque A). Pendiente: capturas Fase 0 + plan de implementación.
> Tipo: nuevo applet de la extensión SteelheadAutomator (remote script loader).

## Problema

En el Workboard **"Preparación de Surtido"** (`/Domains/<id>/Workboards/6234`), step
**"Preparando Surtido en Almacén"** (columna derecha), el operador puede mover piezas al
siguiente proceso aunque la orden de trabajo (WO) **no esté programada** en producción.
Control solicitado por planeación/operaciones:

1. **Bloquear** que se muevan piezas al siguiente proceso si la WO **no está programada**.
2. **Marcar en verde** las tarjetas cuya WO **sí** está programada (= sí se puede mover).

### Definición de "programada"
Una WO está **programada** cuando tiene una **fecha fija en el programa** de producción.
El agrupador "Scheduled" del board es solo una vista; el **estado real vive en la WO**.
(Confirmado con el usuario: las opciones "estado del board" y "fecha de programación" son
lo mismo — la programada da una fecha fija.)

### Dos rutas de movimiento (ambas deben quedar cubiertas)
- **(a) Botón de flechas (⇄) → modal "Mover Piezas".** El modal muestra
  `Desde Nodo: Preparando Surtido en Almacén`, `Tipo de Transferencia: Paso`,
  `A Nodo: T109 Recibo de Orden`, y dos botones rojos: `MOVER (N)` e `IMPRIMIR Y MOVER (N)`
  (+ `CANCELAR`). Aquí: **agrisar los botones rojos + mensaje** "no se puede mover, no está programada".
- **(b) Arrastrar la tarjeta a la derecha.** A veces reabre el modal, pero **en ocasiones toma
  valores default y mueve en silencio**, solo avisando que ya movió. Aquí: **detectar e impedir**
  el movimiento.

La conclusión de diseño: el corazón del control es **interceptar la mutación de movimiento**
(cubre las dos rutas, incluido el drag silencioso); encima va la capa cosmética del modal.

## Enfoques considerados

- **A (elegido): Interceptor de `fetch` (lee + bloquea) + capa de modal + marcado verde.**
  Un único punto de enforcement a nivel de red cubre **ambas** rutas de movimiento, porque las
  dos terminan disparando la misma mutación. Reusa el patrón probado de `auto-router.js`
  (envuelve `window.fetch`, lee `operationName` + `variables`).
- **B (solo DOM): agrisar botones + cancelar el drop por eventos del DOM.** Descartado: el drag
  silencioso ya tiene la mutación en vuelo cuando el DOM se entera → no garantiza el bloqueo,
  selectores frágiles, bypasseable.
- **C (intercept de clicks sin tocar fetch).** Mismos huecos que B para el drag silencioso.
  Descartado.

## Arquitectura (Enfoque A)

Cinco capas; el interceptor de `fetch` es compartido (un solo wrap idempotente con latch propio,
encadenado al `window.fetch` previo, como ya hacen otros applets).

### 1. Mapa de "programada" (lectura)
El interceptor lee la **respuesta** del query que llena las tarjetas del board y construye
`Map<workOrderKey → { programada: boolean, fechaPrograma: string|null }>`. WO programada = trae
fecha fija de programa. Alimenta el marcado verde **y** la decisión de bloqueo.
- Clave del mapa: `workOrderId` o `partLocationId` — **a confirmar en captura Fase 0** según lo
  que traiga el query del board y lo que use la mutación de mover (deben poder cruzarse).

### 2. Enforcement (bloqueo)
El interceptor inspecciona el **request** de la mutación de mover. Bloquea si **todas** se cumplen:
- `enforcementEnabled === true` (toggle ON), **y**
- nodo origen = "Preparando Surtido en Almacén" y tipo de transferencia = *Paso*, **y**
- la WO objetivo **no** está programada (según el mapa).

Al bloquear, **no reenvía** la petición; responde un error GraphQL sintético
`{ errors: [{ message: "Bloqueado: la WO #… no está programada" }] }` para que Steelhead muestre
que el movimiento falló, + un **toast** dark-mode nuestro. **Cubre el modal y el drag silencioso
por igual** (es el respaldo real, independiente del DOM).

**Política ante dato faltante = FAIL-SAFE (decidido).** Si la WO objetivo **no está en el mapa**
(p. ej. el operador movió antes de que el applet leyera el query del board), **no se bloquea** —
se deja pasar el movimiento para no frenar operación legítima por un dato que aún no cargó. Solo
se bloquea cuando hay evidencia positiva de que la WO **no** está programada.

### 3. Capa de modal (cosmética / UX)
Un `MutationObserver` detecta el modal *Mover Piezas* cuyo `Desde Nodo` = "Preparando Surtido en
Almacén". Si la WO asociada no está programada y el bloqueo está ON → **agrisa** los botones
`MOVER` e `IMPRIMIR Y MOVER` (disabled + estilo gris) y agrega un mensaje inline
"No se puede mover: la WO no está programada." `CANCELAR` sigue normal.
- Asociación modal→WO: el modal muestra Número de Parte y cantidad, pero el PN **no es único** por
  tarjeta. Estrategia: **capturar el contexto de la tarjeta al hacer clic en su ⇄** (WO/part-location)
  y asociarlo cuando el modal aparece; fallback a id embebido en el DOM del modal si existe.
  **A confirmar en Fase 0** con el HTML del modal y de la tarjeta.

### 4. Marcado verde
Las tarjetas del step cuya WO está programada reciben **acento verde** (borde izquierdo verde +
tinte de fondo sutil). **Siempre activo**, independiente del toggle (es info pasiva y útil).
Las **no programadas** llevan un **🔒 discreto** para que se vea de un vistazo por qué están
bloqueadas. Se re-aplica al re-renderizar el board (el board es virtualizado / re-render frecuente)
vía el `MutationObserver`.

### 5. Toggle (popup, no persistente)
Acción `type:"toggle"` en `config.json` → `message:"toggle-surtido-guard"` →
`fn:"SurtidoGuard.toggleFromPopup"`. El **handler genérico** de `background.js` la enruta
(busca la acción por `message`, inyecta los scripts del app, llama `window.SurtidoGuard.toggleFromPopup()`)
**sin tocar `extension/`**. Estado en memoria `enforcementEnabled`, **default ON en cada carga**;
el toggle lo voltea, regresa `{ enabled }` y muestra un toast. Recargar la página lo regresa a ON.
El marcado verde **no** se ve afectado por el toggle.

## Componentes

### `remote/scripts/surtido-guard-core.js` — módulo puro (con golden test)
Sin DOM ni red. Sigue el patrón `auto-router-engine` / `bulk-upload-parse`.
- `buildScheduledMap(boardQueryJson)` → `Map`/objeto `{ [key]: { programada, fechaPrograma } }`.
- `shouldBlockMove(mutationVars, scheduledMap, { enforcementEnabled })` → `{ block: boolean, woKey, reason }`.
- `isSurtidoStepMove(mutationVars)` → reconoce nodo origen "Preparando Surtido en Almacén" + tipo *Paso*.
- Golden test en `tools/test/surtido-guard-core.test.js` con fixtures capturados (Fase 0).

### `remote/scripts/surtido-guard.js` — glue (DOM + red)
- Latches idempotentes: `__saSurtidoGuardInit`, `__saSurtidoGuardFetchPatched`.
- Init solo en `/Domains/\d+/Workboards/\d+` (listener de cambios de URL del SPA, como `paros-linea`).
- Confirma board/nodo objetivo (por nombre de nodo en modal/mutación; opcional `WorkboardById`).
- Interceptor `window.fetch`: lee board query → llena mapa; intercepta la mutación de mover → bloquea.
- `MutationObserver` del modal + marcado verde (acotado, se desconecta al salir del board).
- Toasts dark-mode (base `#1c2430`, texto `#e6e9ee`, acento verde `#13a36f`).
- `toggleFromPopup()` → voltea `enforcementEnabled`, toast, `return { enabled }`.
- Estado expuesto en `window.SurtidoGuard`.

### `remote/config.json` — nuevo app
```jsonc
{
  "id": "surtido-guard",
  "name": "Candado de Surtido Programado",
  "subtitle": "Bloquea mover piezas no programadas en Preparación de Surtido",
  "icon": "🔒",
  "category": "Producción",
  "autoInject": true,
  "scripts": [
    "scripts/steelhead-api.js",
    "scripts/surtido-guard-core.js",
    "scripts/surtido-guard.js"
  ],
  "requiredPermissions": [],
  "actions": [
    {
      "id": "toggle-surtido-guard",
      "label": "Candado de Surtido",
      "sublabel": "Bloquear mover piezas no programadas (se reactiva al recargar)",
      "icon": "🔒",
      "type": "toggle",
      "handler": "message",
      "message": "toggle-surtido-guard",
      "fn": "SurtidoGuard.toggleFromPopup"
    }
  ]
}
```
- Más adelante: agregar el hash de la **mutación de mover** a `config.hashes` una vez capturado
  (si el applet la dispara por `SteelheadAPI`; para solo interceptar/bloquear no se requiere el hash,
  pero sí el `operationName`).

## Alcance
Solo el board "Preparación de Surtido" / nodo **"Preparando Surtido en Almacén"**, **match por
nombre de nodo** (robusto entre boards / ids). No toca otros movimientos ni otros nodos.

## Capturas pendientes (Fase 0 — al arrancar implementación)
1. **Mutación de mover**: `operationName` + shape de `variables` (cómo identifica WO/part-location,
   nodo origen y tipo "Paso"). Capturar un `MOVER` por modal **y** un drag, con Network abierto.
2. **Query de tarjetas del board**: `operationName` + dónde viene la fecha de programa por WO
   (para construir el mapa). Confirmar la clave de cruce con la mutación.
3. **HTML del modal "Mover Piezas"**: wrapper con botones, `Desde Nodo`, y id de WO/part-location
   si está embebido — para agrisar y asociar modal→tarjeta.
4. **HTML de la tarjeta** del step derecho — para el marcado verde y leer la WO / part-location.

> `CreateInventoryTransferEventGroups` (ya en config) **NO** es la mutación de mover: config la
> describe como "carga inicial de lotes", usedBy `inventory-reset`. La mutación del "Mover Piezas /
> Tipo: Paso" aún es desconocida → captura obligatoria.

## Notas de implementación
- **Memory hardening** (`memory-hardening-applets`): el applet mantiene `MutationObserver` + wrap de
  `fetch` en una página de larga vida → observer acotado, desconexión al salir del board, mapa bounded,
  parse-once. Invocar el skill durante la implementación.
- **Dark mode** (regla de diseño): toasts/mensajes propios en tema oscuro. El acento verde sobre las
  tarjetas nativas es enriquecimiento del UI de SH (como `board-metal-tooltip`), no UI nuestra de cero.
- **Interceptor de fetch**: latch propio, encadenar al `window.fetch` previo (varios applets ya lo
  envuelven; se apilan sin pisarse). Reusar la forma de `auto-router.js`.
- **Deploy**: `tools/deploy.sh "feat(surtido-guard): ..." --check surtido-guard` (bump + espejo gh-pages).
  Validación en vivo requerida antes de marcar el applet como productivo.

## Riesgos abiertos
- **Clave de cruce WO↔mutación**: si el query del board y la mutación no comparten un id directo,
  habrá que mapear vía part-location o WO# (resolver en Fase 0).
- **Drag silencioso**: confirmar que efectivamente dispara la misma mutación que el modal (Fase 0).
  Si usara un endpoint/op distinto, el interceptor debe reconocer ambos.
- **Re-render del board**: el marcado verde debe sobrevivir virtualización/scroll (observer + re-aplicar).
- **Falsos negativos del mapa**: si la WO no aparece aún en el mapa (no se ha leído el board query),
  política **FAIL-SAFE (decidida 2026-06-26)**: **no bloquear** ante duda, para no frenar operación
  legítima. Solo se bloquea con evidencia positiva de "no programada".
