# Spec: Pull activo para detectar facturas pendientes de regen

**Fecha:** 2026-04-29
**Applet afectado:** `remote/scripts/invoice-auto-regen.js` (banner "↻ N timbradas pendientes — Regenerar PDFs")
**Bump objetivo:** `config.json` `version` 0.5.34 → 0.5.35

## Problema

El banner del header del dashboard de Invoices reporta un número de pendientes que **se acumula eternamente**: el día reportado había 25 pendientes en pantalla cuando en realidad solo se crearon 4 facturas el día anterior (1 invalidada, 3 ya regeneradas). El número correcto debió ser 0, o como mucho 3.

### Causa raíz

El detector pasivo actual (`recordPending`) usa un `Map` en memoria (`pendingByInvoiceId`) que **solo se llena, nunca se purga** salvo cuando *este mismo applet* regenera la factura. Consecuencias:

- Cada `ActiveInvoicesPaged` que pasa por el interceptor (paginación, búsqueda, filtros del UI) **agrega** facturas que cumplan `needsRegen()` sintácticamente — y ahí se quedan.
- Facturas regeneradas en otro tab, máquina o sesión nunca se enteran. El set local no se sincroniza.
- Facturas invalidadas *después* de entrar al set quedan colgadas.
- `ActiveInvoicesPaged` puede devolver facturas históricas (timbradas hace meses con PDF pre-timbre) que el usuario no piensa regenerar — todas inflan el contador.

El TTL de 24h de `recentlyRegenerated` no resuelve nada de lo anterior: solo suprime falsos positivos de eventual consistency.

## Diseño

**Decisión central:** la "fuente de verdad" deja de ser un set acumulado en memoria y pasa a ser **el resultado de una query GraphQL fresca evaluada con `needsRegen()` en el momento que el banner necesita renderizarse**.

### Arquitectura

#### Lo que se elimina
- `pendingByInvoiceId` Map.
- `recordPending(items)` y la rama del interceptor que la invocaba para `ActiveInvoicesPaged`.
- Export `_pending`.

#### Lo que se conserva
- `recentlyRegenerated` (localStorage). Se mantiene el shape; se **reduce TTL de 24h → 3 min**. Solo cubre el window de eventual consistency entre regen y siguiente query.
- `needsRegen(inv)`, `scanList`, `scanSingle`. Puros, se reusan.
- `autoRegenInOpenModal()` (auto-regen cuando el usuario abre el modal de una pendiente). Sigue disparándose desde el interceptor de `InvoiceByIdInDomain`. **Nota:** la guardia `if (!pendingByInvoiceId.has(item.invoiceId)) return` cambia a `if (isRecentlyRegenerated(item.invoiceId)) return` — la condición de "vale la pena regenerar" deja de depender de un set local; se deriva del propio `needsRegen` aplicado al payload del modal.
- Hash registry, regen DOM-driven (`testRegenInOpenModal`, `regenViaModal`), overlay+stop, banner anclado al heading "Invoices".

#### Lo que se agrega
- **`pullPendingCount()`** — query directa via `_callOp('ActiveInvoicesPaged', ...)`, paginada, ventana 7 días, evalúa `needsRegen()` por nodo, filtra por `recentlyRegenerated`. Devuelve `Array<{invoiceId, idInDomain}>`.
- **Caché de último pull:** `lastPullResult: Array | null`, `lastPullAt: number`, `_pullDegraded: boolean`, `_pullInFlight: Promise | null`. Se **sobreescribe**, no se acumula.
- **Aprendizaje pasivo de variables:** el interceptor snapshotea `bodyObj.variables` del primer `ActiveInvoicesPaged` real del UI en `window.__autoRegenLastVars.ActiveInvoicesPaged`. `pullPendingCount` lo usa como template, mutando `pageSize`, `pageNumber`, filtro de fecha y limpiando campos de filtros del UI (search/customer/etc).
- **Detección de soporte de filtro server-side por fecha:** al inspeccionar el template, si existe variable tipo `writtenAtFrom`/`dateFrom`/`from` la usamos. Si no, paginamos con orden por `writtenAt DESC` y cortamos en cuanto un nodo cae bajo el cutoff.
- **Triggers del pull:**
  - **a)** `init()`: si detecta dashboard de Invoices, dispara pull (esperando template si no existe).
  - **b)** Post-regen exitosa (banner batch o modal auto-regen): dispara pull sin throttle.
  - **c)** `visibilitychange` → `visible` con throttle 30 s (skip si `runState.active`).
  - **d)** Cada `ActiveInvoicesPaged` del UI con throttle 30 s (también actualiza el template aprendido en cada pasada).

### Data flow

```
init → ¿estamos en dashboard? → pullPendingCount() → updateBanner(lastPullResult)
                                       ↑
visibilitychange (visible, throttle 30s) ─┤
ActiveInvoicesPaged interceptor (throttle 30s, también actualiza template) ─┤
post-regen (sin throttle) ─┘

startRun → for each item in lastPullResult: regenViaModal → markRegenerated → pullPendingCount → updateBanner
modal-abierto-auto-regen → markRegenerated → pullPendingCount → updateBanner
```

### Paginación y guardrails

- Page size: 50.
- Loop hasta: (a) página vacía, (b) último nodo con `writtenAt < ahora-7d`, o (c) 5 páginas (250 facturas) — guardrail anti runaway.
- Secuencial. Sin paralelización.
- `_pullInFlight` evita pulls concurrentes: si 3 triggers disparan a la vez, comparten el mismo Promise.

### Manejo de errores

| Caso | Respuesta |
|------|-----------|
| Pull falla 1 vez (red, 5xx, timeout) | Log warning. `lastPullResult` se conserva. Próximo trigger refresca. |
| Pull falla 3 veces consecutivas | `lastPullResult = null`, `_pullDegraded = true`. Banner se oculta. Log claro indicando posible deprecación de hash. |
| Hash deprecado (HTTP 400 "Must provide a query string") | Mismo manejo, mensaje específico en log. Recovery automático cuando `ActiveInvoicesPaged` del UI vuelva a pasar (re-arma template + reset degraded). |
| Eventual consistency post-regen | `recentlyRegenerated` (TTL 3 min) suprime. Pasados los 3 min, si sigue listada, se considera regen fallida y vuelve al banner — comportamiento intencional. |
| `runState.active` en curso | Triggers (c) y (d) saltan el pull. Trigger (b) lo dispara al final del batch. |
| Sin template aprendido al hacer init | Pull se difiere hasta que el primer `ActiveInvoicesPaged` del UI llegue (~1-2 s). Banner aparece ligeramente tarde — aceptable. |
| Múltiples tabs abiertos | Cada uno corre su pull. `recentlyRegenerated` (localStorage) se comparte → regen en tab A se refleja en pulls subsecuentes de tab B. |

### Cambios en API expuesta

- `_state()`: deja de exponer `pending` y `pendingIds` desde el Map. Expone `lastPullResult.length`, `lastPullResult` IDs, `lastPullAt`, `_pullDegraded`.
- `_pending` (export del módulo) se reemplaza por `_lastPullResult`. No hay consumers externos documentados; es solo diagnóstico de consola.

### Migración / cleanup de estado persistido

- `localStorage['sa_autoregen_recently_regenerated']`: el shape no cambia. El cambio de TTL (24h → 3 min) se aplica en `_hydrateRecent`: entradas con timestamps > 3 min se purgan al cargar. **Sin breaking, sin migración manual.**

## Plan de testing manual

1. Cargar dashboard → banner muestra número correcto (basado en facturas reales con `writtenAt > maxPdfAt` en 7d).
2. Regenerar 1 factura → banner decrementa al terminar.
3. Cerrar y reabrir el tab → banner refleja estado real, no acumula valores anteriores.
4. Regenerar en otro tab/máquina → siguiente pull aquí ya no la lista.
5. Invalidar una factura listada → siguiente pull la quita.
6. Inducir falla (mockear network drop o degradar hash localmente) → log warning, banner conserva último valor; tras 3 fallas, banner se oculta. Recovery cuando vuelve la conectividad.
7. Mantener tab abierto > 30 s, navegar fuera y volver → `visibilitychange` dispara pull, banner refresca.
8. Cold start: cargar applet en pestaña fresh donde aún no pasó `ActiveInvoicesPaged` → banner aparece tras la primera query del UI.

## Versionado y deploy

- Bump `config.json`: `version` 0.5.34 → 0.5.35, `lastUpdated` 2026-04-29.
- Commit `main`: `fix(invoice-auto-regen): pull activo de pendientes en lugar de set acumulado en memoria (0.5.35)`.
- Sync a `gh-pages` siguiendo procedimiento documentado en CLAUDE.md.
- Push ambas ramas, verificar publicación, recargar la extensión.

## Lo que queda fuera del scope

- Refactor del banner UI o de los triggers visuales (look & feel se mantiene).
- Cambios al flujo `regenViaModal` o `testRegenInOpenModal` (mecánica DOM-driven intacta).
- Reemplazar `recentlyRegenerated` por algo más sofisticado (ej. detección server-side de "factura ya regenerada"). Solo se ajusta el TTL.
- Polling periódico en background — descartado: triggers (a)+(b)+(c)+(d) cubren los momentos relevantes sin generar carga ociosa.
