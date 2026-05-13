# Receiver Date Override — Diseño

**Fecha**: 2026-05-07
**Applet ID**: `receiver-date-override`
**Status**: Approved (pendiente plan de implementación)

## Problema

En el modal "Receive Parts from Customer" de Steelhead, la fecha real de recibido (`receivedAt`) se fija automáticamente al momento del Save y no hay un campo nativo para editarla en ese mismo modal. Para corregirla, el usuario tiene que:

1. Guardar el receiver con la fecha "actual".
2. Ir a `/AllReceivers`.
3. Buscar el receiver recién creado.
4. Abrir el modal de edit.
5. Cambiar la fecha y volver a guardar.

Son 4 pasos extra solo por backdatear unas horas o un par de días. La meta es exponer el campo desde el modal de Receive Parts para que el receiver se guarde directamente con la fecha real.

## Solución

Applet nuevo `receiver-date-override` que:

1. Inyecta un campo `Fecha real de recibido:` debajo de Receiver Comments en el encabezado del modal.
2. Default value = hoy (YYYY-MM-DD); 2 chips de atajo: "Hoy" y "Ayer".
3. Trackea si el usuario tocó el campo (`userTouched`).
4. Intercepta el body de la mutación `UpdateReceiver` (los 3 botones Save disparan la misma) y, si hubo intención explícita, swappea `receivedAt` por la fecha elegida (mediodía local convertida a UTC). Si el usuario no tocó nada, deja pasar el body intacto y Steelhead pone `receivedAt = ahora` como siempre.
5. Muestra warnings inline no bloqueantes para fechas raras.

Sin llamadas extra a la API. Sin nueva persisted query. Solo intercepción del fetch existente.

## Arquitectura

Applet vanilla JS standalone (igual patrón que `weight-quick-entry`). Vive en `remote/scripts/receiver-date-override.js`. Se inyecta automáticamente vía `autoInject: true` en `remote/config.json`.

### Flujo

1. **`init()`** — patchea `window.fetch` (idempotente vía `__saRdoFetchPatched`), arranca `setupObserver()` que vigila el DOM por el heading del modal.
2. **`onModalFound(modal)`** — dispara cuando el observer detecta el heading "Receive Parts from Customer" o "Recibir Piezas del Cliente". Marca el modal con `data-sa-rdo-attached="true"` (idempotencia). Llama a `injectField(modal)` y `watchModalRemoval(modal)`.
3. **`injectField(modal)`** — localiza el wrapper de Receiver Comments por su label (`<p>Receiver Comments:</p>` → `.closest('.css-iyrxkt')`). Crea un sibling con la misma clase `.css-iyrxkt`, label `Fecha real de recibido:`, input `<input type="date">` con default = hoy, y 2 chips "Hoy"/"Ayer" al lado. Guarda en `modalStates.set(modal, { input, userTouched: false, warningEl })`.
4. **`patchFetch` interceptor** — cuando detecta `operationName === 'UpdateReceiver'`:
   - Si existe `[data-sa-rdo-attached="true"]` y su state tiene `userTouched === true` y `input.value` no está vacío:
     - Parse `YYYY-MM-DD` → `new Date(y, m-1, d, 12, 0, 0).toISOString()`.
     - `bodyObj.variables.receivedAt = nuevoIso`.
     - `opts.body = JSON.stringify(bodyObj)`.
     - `console.log('[RDO] receivedAt swapped → ...')`.
   - Si no hubo intención: deja pasar intacto.
5. **`watchModalRemoval(modal)`** — observer separado en `document.body`; cuando el modal sale del DOM, libera `modalStates.delete(modal)` y desconecta sus observers.

### Componentes

- **`init()`** — entry point; idempotente via flag.
- **`patchFetch()`** — hook único en `window.fetch`; gate por `operationName === 'UpdateReceiver'`.
- **`setupObserver()` + `scanForModal()`** — busca heading del modal, sube al ancestor dialog. Mismo patrón que `weight-quick-entry.js:260-289`.
- **`onModalFound(modal)`** — orquesta inyección + cleanup observer.
- **`injectField(modal)`** — DOM building del wrapper, input y chips.
- **`updateWarning(state)`** — recalcula warning cuando cambia el value del input. Renderiza/oculta el `<div>` de warning debajo del input.
- **`watchModalRemoval(modal)` / `cleanupModal(modal)`** — libera state.
- **`injectStyles()`** — CSS único para `.sa-rdo-*` clases.

### Estado

```js
const modalStates = new WeakMap(); // modal → { input, warningEl, userTouched }
```

WeakMap así el state se libera automáticamente cuando el modal sale del DOM. Cleanup manual solo para los `MutationObserver` instanciados.

### Detección del modal

Mismo regex y selectors que `weight-quick-entry.js:257-258`:
- Heading: `/receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i`
- Container: `.closest('[role="dialog"]') || .closest('.MuiDialog-paper') || .closest('[class*="MuiPaper"]') || .closest('main') || .closest('form') || parent.parent`

### Localización del wrapper Receiver Comments

```js
const labels = modal.querySelectorAll('p');
let receiverCommentsWrapper = null;
for (const p of labels) {
  if (/^receiver\s+comments:?$/i.test(p.textContent.trim())) {
    receiverCommentsWrapper = p.closest('.css-iyrxkt');
    break;
  }
}
if (!receiverCommentsWrapper) return; // defensa: layout cambió
```

Patrón del wrapper (confirmado con HTML que pasó el usuario):

```html
<div class="css-iyrxkt">
  <p class="MuiTypography-root MuiTypography-body1 css-9l3uo3" style="grid-column: 1;">
    Receiver Comments:
  </p>
  <div style="grid-column: 2;">...</div>
</div>
```

### Insertion point

`receiverCommentsWrapper.insertAdjacentElement('afterend', newWrapper)`. Queda entre Receiver Comments y el accordion de Custom Inputs (que es el siguiente sibling).

### DOM del campo nuevo

```html
<div class="css-iyrxkt sa-rdo-wrapper" data-sa-rdo-field="true">
  <p class="MuiTypography-root MuiTypography-body1 css-9l3uo3" style="grid-column: 1;">
    Fecha real de recibido:
  </p>
  <div style="grid-column: 2;" class="sa-rdo-controls">
    <input type="date" class="sa-rdo-input" value="2026-05-07">
    <button type="button" class="sa-rdo-chip" data-offset="0">Hoy</button>
    <button type="button" class="sa-rdo-chip" data-offset="-1">Ayer</button>
    <div class="sa-rdo-warning" hidden></div>
  </div>
</div>
```

### Estilos (CSS inyectado una vez)

```css
.sa-rdo-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sa-rdo-input {
  border: 1px solid #c4c4c4; border-radius: 4px;
  padding: 8.5px 14px; font: inherit; font-size: 14px;
  background: #fff; color: rgba(0,0,0,0.87);
}
.sa-rdo-input:focus { outline: 2px solid #1976d2; outline-offset: -1px; border-color: transparent; }
.sa-rdo-chip {
  border: 1px solid rgba(25,118,210,0.5); color: #1976d2; background: transparent;
  border-radius: 16px; padding: 4px 12px; font-size: 13px; cursor: pointer;
  font-family: inherit;
}
.sa-rdo-chip:hover { background: rgba(25,118,210,0.08); border-color: #1976d2; }
.sa-rdo-warning {
  flex-basis: 100%; margin-top: 4px;
  font-size: 12px; color: #ed6c02; font-style: italic;
}
```

### Validaciones (warnings inline, no bloqueantes)

Recalcular en cada `input` o click de chip:

| Condición | Mensaje |
|---|---|
| `fecha > hoy` (futuro) | `⚠️ Fecha de recibo en el futuro` |
| `(hoy - fecha) > 7 días` | `⚠️ Fecha real de recibo mayor a una semana` |
| Otro caso | (oculto) |

Si caen ambas (no debería, pero defensa): solo la del futuro.
Comparación a nivel de día (no de hora): construir `today = new Date(y,m,d,0,0,0)` y `picked` igual; restar y dividir entre `86400000`.

**Nunca bloquea el Save**. El warning solo informa.

### Intercepción del Save

```js
window.fetch = async function (...args) {
  const [url, opts] = args;
  if (typeof url === 'string' && url.includes('/graphql') && opts?.body) {
    let bodyObj;
    try { bodyObj = JSON.parse(opts.body); } catch { bodyObj = null; }
    if (bodyObj?.operationName === 'UpdateReceiver') {
      const modal = document.querySelector('[data-sa-rdo-attached="true"]');
      const state = modal && modalStates.get(modal);
      if (state?.userTouched && state.input.value) {
        const [y, m, d] = state.input.value.split('-').map(Number);
        const iso = new Date(y, m - 1, d, 12, 0, 0).toISOString();
        bodyObj.variables.receivedAt = iso;
        opts.body = JSON.stringify(bodyObj);
        console.log(LOG_PREFIX, `receivedAt swapped → ${iso}`);
      }
    }
  }
  return origFetch.apply(this, args);
};
```

Cubre los 3 botones Save (Save, Save and Add Parts to WO, Save and Print all). Confirmado en scan 2026-05-07: única mutation de escritura del flujo.

### Tracking de intención

```js
input.addEventListener('input', () => { state.userTouched = true; updateWarning(state); });
input.addEventListener('change', () => { state.userTouched = true; updateWarning(state); });
chip.addEventListener('click', () => {
  const offset = parseInt(chip.dataset.offset, 10);
  const d = new Date(); d.setDate(d.getDate() + offset);
  input.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  state.userTouched = true;
  updateWarning(state);
});
```

Si `userTouched === false` al momento del Save → no swappear → Steelhead pone `receivedAt = ahora` (timestamp exacto del Save, con hora). Esto es lo deseado para el caso default (recibir aquí y ahora).

## Ejemplos de comportamiento

| Acción del usuario | Resultado |
|---|---|
| Abre modal, llena cantidades, da Save (sin tocar fecha) | `receivedAt = ahora` exacto (igual que sin applet). Bullet del scanner: `2026-05-07T17:46:12.000Z`. |
| Abre modal, click "Ayer", da Save | `receivedAt = 2026-05-06T18:00:00.000Z` (mediodía CDMX → 18:00 UTC). |
| Abre modal, picker → 2026-04-25, da Save | Swap + warning visible "mayor a una semana", pero Save procede. `receivedAt = 2026-04-25T18:00:00.000Z`. |
| Abre modal, picker → 2026-05-10 (futuro), da Save | Swap + warning visible "en el futuro", Save procede. |
| Abre modal, vacía el input (raro), da Save | `userTouched=true` pero `input.value=''` → no swappear → Steelhead pone `receivedAt = ahora`. Comportamiento default. |

## Mediodía local vs UTC

`new Date(y, m-1, d, 12, 0, 0).toISOString()` construye un Date en timezone local con hora 12:00 y luego serializa a UTC. En CDMX (UTC-6 sin DST) `2026-05-05` → `2026-05-05T18:00:00.000Z`. Eso garantiza que el día se ve como "5 de mayo" en cualquier timezone donde se consulte después (no se va a día anterior por offset). Sin esto, usar mediodía UTC directo (`new Date(Date.UTC(y, m-1, d, 12))`) tendría el mismo resultado en este caso, pero atarse al timezone local es más correcto si Steelhead muestra fechas con hora local.

## Edge cases

- **Modal se cierra antes de que llegue el fetch del Save**: `[data-sa-rdo-attached]` no se encuentra (porque el cleanup ya corrió) → no swappea → body pasa intacto. Safe.
- **Dos modales abiertos** (no debería pasar en Steelhead, defensa): `querySelector` toma el primero. Aceptable: solo uno está visible a la vez.
- **Steelhead cambia las clases CSS** (`css-iyrxkt`, `css-9l3uo3`): el applet se queda sin localizar el wrapper de Receiver Comments → no inyecta nada → log warning. Comportamiento de Steelhead intacto.
- **El usuario abre el modal, lo cierra, lo vuelve a abrir**: `data-sa-rdo-attached` se queda en el DOM viejo (que ya no existe) y el observer detecta el nuevo heading → `onModalFound` corre con el modal nuevo, marca el atributo en él. WeakMap refresh automático.
- **Field vacío + chip click**: chip pone valor automáticamente, no hay caso de "vacío después de tocar".
- **Backspace + tab out** (input vacío después de tener valor): `userTouched=true` pero `input.value=''` → no swappear. Comportamiento default.

## Lo que NO hace este applet (YAGNI)

- No edita receivers ya guardados (eso sigue siendo flujo manual desde AllReceivers).
- No bloquea Save bajo ninguna condición (warnings son solo informativos).
- No persiste preferencia de "default = ayer" entre sesiones.
- No agrega más chips ("Antier", "Hace 3 días"): si se necesita, picker.
- No interactúa con Weight Quick Entry (applets independientes en el mismo modal, sin acoplamiento).
- No expone toggle por defecto en el popup más allá del estándar `autoInject + toggle action`.

## Archivos a tocar

1. **`remote/scripts/receiver-date-override.js`** (nuevo, ~150-180 líneas).
2. **`remote/config.json`**:
   - Bump `version` (`0.5.63` → `0.5.64`) + `lastUpdated`.
   - Agregar entry en `applets[]`:
     ```json
     {
       "id": "receiver-date-override",
       "name": "Fecha de Recibo",
       "subtitle": "Permite editar la fecha real de recibo desde el modal de Receive Parts",
       "icon": "📅",
       "category": "Recibo",
       "scripts": ["scripts/receiver-date-override.js"],
       "autoInject": true,
       "requiredPermissions": ["READ_RECEIVING"],
       "actions": [
         { "id": "toggle-receiver-date-override", "label": "Fecha de Recibo", "sublabel": "Editar fecha real desde el modal", "icon": "📅", "type": "toggle", "handler": "message", "message": "toggle-receiver-date-override" }
       ]
     }
     ```
   - Agregar `UpdateReceiver` a `steelhead.hashes.mutations` con valor `"005653bae4baad289db47d65857cc4e9fb89fa51e06caa78a1f0946dce7f92ec"` (aunque solo lo interceptemos, así queda registrado por si otro applet lo llama directo en el futuro).
   - Agregar entry en `knownOperations` con `{ "type": "mutation", "description": "Actualizar receiver (id, notes, receivedAt, customInputs, inputSchemaId)", "usedBy": "receiver-date-override (intercept-only)" }`.
3. **`extension/background.js`**: si tiene handler genérico para toggles `toggle-<applet>`, no requiere cambios. Si requiere registrar manualmente, agregar el handler del nuevo toggle.
4. **Deploy**: procedimiento estándar del CLAUDE.md (commit en `main`, sync a `gh-pages`, push ambas).

## Plan de testing

1. **Smoke**: abrir modal Receive Parts; verificar que aparece el campo debajo de Receiver Comments.
2. **Default Save**: dejar fecha intacta, dar Save → verificar en AllReceivers que `receivedAt = ahora` con hora exacta del Save.
3. **Chip "Ayer"**: click "Ayer", dar Save → verificar `receivedAt` = ayer mediodía local.
4. **Picker fecha vieja**: elegir 2026-04-15, dar Save → verificar swap + warning visible "mayor a una semana".
5. **Fecha futura**: elegir 2026-05-20, dar Save → verificar swap + warning "en el futuro".
6. **3 botones Save**: repetir caso 3 con "Save and Add Parts to WO" y "Save and Print all" → todos deben swappear.
7. **Convivencia con Weight Quick Entry**: llenar pesos + cambiar fecha + Save → ambas funcionalidades deben procesar sin pelearse.
8. **Cleanup**: cerrar modal sin Save, abrirlo de nuevo → state nuevo, default = hoy otra vez.
