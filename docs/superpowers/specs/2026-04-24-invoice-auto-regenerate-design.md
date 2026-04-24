# Invoice Auto-Regenerate - Spec de Diseño

## Contexto

Después de que una factura se timbra al SAT (vía la integración personalizada CFDI, `configId: 376`), el PDF visible en Steelhead sigue mostrando la versión "Borrador" hasta que alguien hace click manual en el botón de "regenerar" (flechita curva) dentro del modal de la factura. El resultado es una fricción operacional: el usuario tiene que abrir cada factura timbrada y dar click en un botón para obtener el PDF fiscal final con UUID, sello SAT y `Estatus: Activo`.

Esta applet detecta automáticamente cuándo una factura está timbrada pero su último PDF es pre-timbre, y dispara la regeneración en background sin intervención del usuario. El trigger de detección se acopla a los refreshes naturales que el usuario ya hace (F5, botón circular de la topbar, navegación a Invoices), sin polling propio ni sesiones activas 24/7.

## Escenarios

1. **Refresh de dashboard con facturas recién timbradas**: el usuario timbra N facturas, luego refresca la vista de Invoices. Se regeneran todas en background, cada fila muestra progreso individual.
2. **Modal de factura abierta**: el usuario abre una factura timbrada cuyo PDF sigue en borrador. El modal muestra el PDF viejo momentáneamente y se auto-refresca al nuevo.
3. **Navegación a la pestaña de Invoices**: primera carga del dashboard en la sesión. Aplica el detector sobre la primera respuesta de `ActiveInvoicesPaged`.

## Diseño

### Arquitectura General

Nuevo script `remote/scripts/invoice-auto-regen.js`, cargado por `background.js` igual que los demás applets. Depende de `SteelheadAPI`. El script:

1. **Intercepta** respuestas GraphQL de `ActiveInvoicesPaged` (dashboard) y `InvoiceByIdInDomain` (modal).
2. **Detecta** facturas timbradas con PDF pre-timbre usando campos del propio response.
3. **Dispara** la mutación `CreateInvoicePdf { invoiceId }` vía `SteelheadAPI.graphql()`.
4. **Inyecta** indicadores visuales por fila en el dashboard + un indicador en el modal.

Cero polling propio: reactivo a tráfico GraphQL que Steelhead ya genera.

### Criterio de detección

Una factura necesita regeneración sii:

```
invoice.steelheadObjectByInvoiceId.writtenAt != null   // timbrada al SAT
&& invoice.voidedAt == null                             // no cancelada
&& invoice.steelheadObjectByInvoiceId.voidSuccessfulAt == null
&& max(invoice.invoicePdfsByInvoiceId.nodes[].createdAt) < steelheadObjectByInvoiceId.writtenAt
```

**Confirmación extra en modal** (red de seguridad): cuando la detección viene de `InvoiceByIdInDomain`, además se cruza con `invoice.createWriteResult.data.result.writeResult.uuid` truthy. Si el UUID del SAT no está, no se regenera (protege contra `writtenAt` espurio en integraciones que no sean CFDI).

**Nota sobre integración custom**: los campos `syncedAtV4`, `finalizedAtV4`, `manuallySyncedAt` son de las integraciones nativas de Steelhead (QuickBooks/Sage) y no son confiables en este dominio, donde la integración CFDI al SAT es un desarrollo personalizado. El campo `steelheadObjectByInvoiceId.writtenAt` sí refleja el estado del writer custom porque es el único writer activo en este dominio.

### Dedupe

Set en memoria `completedSet: Set<invoiceId>` + Map `state: Map<invoiceId, 'pending'|'running'|'done'|'error'>`. Vida = pestaña (se resetea al cerrar o al recargar). No persistimos: si el usuario recarga, el criterio del detector vuelve a filtrar correctamente porque el nuevo PDF ya aparece en `invoicePdfsByInvoiceId.nodes[]`.

### Módulos internos

| Módulo | Responsabilidad |
|---|---|
| `detector` | Aplica el criterio sobre un response. Función pura. |
| `queue` | Cola serial + dedupe. Emite eventos de transición. |
| `regenerator` | Dispara `CreateInvoicePdf`. Maneja errores y timeout (15s). |
| `rowUI` | Inyecta/actualiza íconos de estado en el DOM del dashboard y del modal. |
| `controller` | `init()`, patch de `window.fetch`, cableado entre módulos. |

Cada módulo se comunica con el controller por callbacks; ningún módulo llama a otro directamente.

### Flujo Detallado

**Flujo principal (dashboard refresh)**:

```
Usuario aprieta refresh o F5
  ↓
Steelhead fetch → ActiveInvoicesPaged
  ↓
Interceptor clona response → detector.scan(response)
  ↓
detector itera allInvoices.nodes[] aplicando criterio
  ↓
Devuelve [{invoiceId, idInDomain}, ...]
  ↓
queue.enqueue(items), descartando los que ya están en completedSet
  ↓
rowUI escucha 'enqueued' → pinta ⏱ reloj gris en cada fila
  ↓
queue.processNext() (serial, ~200ms entre items):
  estado → 'running' → rowUI pinta ↻ spinner azul
  regenerator.run(invoiceId) → CreateInvoicePdf
    ok    → 'done'  → rowUI pinta ✓ verde, fade-out a 40% opacidad en 5s
    error → 'error' → rowUI pinta ⚠ rojo, tooltip con mensaje, click reintenta 1 vez
  completedSet.add(invoiceId)
```

**Flujo de red de seguridad (modal)**:

```
Usuario abre modal de factura
  ↓
Steelhead fetch → InvoiceByIdInDomain
  ↓
Interceptor clona response → detector.scanSingle(invoice)
  ↓
Cruza writtenAt + createWriteResult.writeResult.uuid
  ↓
Si aplica y no está en completedSet:
  queue.enqueue([{invoiceId, idInDomain}])
  rowUI pinta en la fila del dashboard (si está visible) + badge en el modal al lado de "Invoice History"
```

### UX: íconos por fila

| Estado | Ícono | Color | Tooltip |
|---|---|---|---|
| pending | ⏱ reloj | gris #6b7280 | "En cola para regenerar" |
| running | ↻ spinner animado | azul #2563eb | "Regenerando factura…" |
| done | ✓ check | verde #16a34a | "Regenerada hace Xs" (fade-out a 40% a los 5s) |
| error | ⚠ warning | rojo #dc2626 | "Error: <mensaje>" (click reintenta) |

**Render**:
- SVGs inline vía `document.createElementNS`, no `innerHTML` (alinea con el pendiente #2 del security audit).
- Wrapper con clase `.sa-auto-regen-badge`, insertado a la izquierda del ícono del banco (integración) en la columna de acciones.
- Selector de fila: `data-invoice-id` si Steelhead lo expone; fallback por texto `#<idInDomain>` dentro de la row (verificar en implementación).
- `MutationObserver` liviano sobre el contenedor de la tabla para re-inyectar el badge si Steelhead re-renderea una fila (evento de paginación, filtro, etc.).

**Modal**: badge equivalente al lado del header "Invoice History" (esquina superior derecha del modal).

### Interacción con `CreateInvoicePdf`

Llamada vía `SteelheadAPI.graphql()` con el hash actual de `config.json` (`aafd22aa…`). Variables: `{ invoiceId: <number> }`. La respuesta devuelve `{ createInvoicePdf: { invoicePdf: { id, nodeId } } }`; no necesitamos consumir el output — solo confirmamos éxito por ausencia de errors.

Serial, no paralelo: si hay 10 facturas pendientes, se disparan una a una con ~200ms de espaciado. Evita bursts que podrían pegarle al backend y no aporta velocidad perceptible al usuario.

### Errores y edge cases

**Red / GraphQL**:
- Timeout >15s o HTTP ≥400 → estado `error`, tooltip, 1 reintento automático, luego ⚠ fijo hasta el próximo refresh.
- Errors en el body `{errors: [...]}` → mismo tratamiento; se muestra el mensaje en el tooltip.

**Race conditions**:
- Dos `ActiveInvoicesPaged` seguidos → `completedSet` + `state` map previenen duplicar; nuevas adiciones se mergean sin duplicar.
- Usuario click manual en flechita mientras nuestra regen está en vuelo → no bloqueamos; el backend recibe dos `CreateInvoicePdf`, lo que ya ocurre hoy con doble-click. Se acepta.

**Cancelación durante la cola**:
- Si una factura se cancela mientras está `pending`: no re-verificamos antes de disparar. El backend responderá ok o error; ambos aceptables.

**Edge cases de datos**:
- `invoicePdfsByInvoiceId.nodes` vacío → aplica criterio (nada < writtenAt) → se regenera → al terminar, el nuevo PDF es post-timbre → no vuelve a dispararse.
- Todos los PDFs post-`writtenAt` → ya regenerada históricamente, se ignora.
- `steelheadObjectByInvoiceId == null` → factura sin integración asociada, se ignora.

### Off-switch y compatibilidad

- Flag `document.documentElement.dataset.saAutoRegenEnabled` (default `'true'`), leído en `init()`. Si es `'false'` → return temprano y no patchea nada.
- Centinela `window.__saAutoRegenPatched` previene doble-patch entre bumps de versión.
- Logs gated detrás del flag `DEBUG` de `config.json` (cuando se introduzca como parte del pendiente #5 del security audit); mientras, logs mínimos a `console.log('[AutoRegen] …')`.

### Relación con `cfdi-attacher.js`

Ambos parchean `window.fetch`. Para evitar doble intercepción, el nuevo script sigue el mismo patrón de sentinel (`window.__saAutoRegenPatched`) y es independiente — ninguno asume orden de carga ni existencia del otro. El patch wrappea el fetch ya posiblemente parcheado por cfdi-attacher sin romperlo; ambos extractos coexisten limpiamente.

### Deploy

Sigue el procedimiento estándar del proyecto (CLAUDE.md):

1. Bump `remote/config.json` `version` + `lastUpdated`.
2. Añadir `invoice-auto-regen` al listado de scripts en `config.json`.
3. Añadir load del script en `background.js` (si aplica según el patrón actual de auto-load).
4. Commit en `main` con prefijo `feat(invoice-auto-regen): …`.
5. Sync a `gh-pages` y push de ambas ramas.

## Lo que NO hace v1

- **Sin persistencia**: no localStorage, no cookies, no history. Memoria fresca por pestaña.
- **Sin prefetch**: si el usuario abre Steelhead pero no navega a Invoices, nada se dispara.
- **Sin monitoreo cross-tab**: cada pestaña es independiente.
- **Sin UI de configuración en popup**: el off-switch es solo por dataset, a activar manualmente si hace falta. Se puede añadir al popup en v2 si se requiere.
- **Sin reintentos exponenciales**: 1 reintento y listo; el próximo refresh re-detecta si sigue aplicando.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| `writtenAt` puede llenarse por integraciones no-CFDI si algún día se activan QB/Sage | Cruce con `createWriteResult.writeResult.uuid` en modal; para dashboard, documentar el supuesto y re-evaluar si cambia el plan de integraciones. |
| Selector DOM para la fila puede cambiar con updates de Steelhead | Fallback por texto `#<idInDomain>`; validar durante implementación. |
| Dispararnos sobre facturas que el backend no permite regenerar (canceladas/archivadas) | Manejo de error explícito que no rompe la cola; se asume costo marginal bajo. |
| Burst de N mutaciones tras un refresh con muchas pendientes | Serial con ~200ms de separación. |

## Verificación durante implementación

- Inspeccionar DOM del dashboard para confirmar selector estable de fila (por `invoiceId` interno o por `idInDomain` de display — el que Steelhead exponga en atributos DOM).
- Confirmar que `CreateInvoicePdf` no requiere variables adicionales (el scan muestra solo `invoiceId`, pero el sample estaba redacted — validar con un call real).
- Capturar una respuesta cruda de `ActiveInvoicesPaged` con facturas en distintos estados para verificar el shape de `invoicePdfsByInvoiceId.nodes[].createdAt`.
