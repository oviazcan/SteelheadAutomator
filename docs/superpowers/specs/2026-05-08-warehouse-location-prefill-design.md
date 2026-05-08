# Spec: warehouse-location-prefill applet

**Fecha**: 2026-05-08
**Estado**: Diseño aprobado, pendiente de plan e implementación
**Versión target**: 0.5.69

## Objetivo

Inyectar un campo "Ubicación inicial:" en el header del modal **"Receive Parts from Customer" / "Recibir piezas del cliente"** de Steelhead. Cuando el usuario selecciona una ubicación, todos los lotes del recibo heredan esa ubicación al momento de guardarse, sin necesidad de tocar el combobox per-line de cada renglón.

Default del combobox del header filtra solo ubicaciones con "Aduana" en su path, con escape para mostrar el catálogo completo.

## Motivación

Hoy el usuario tiene que abrir el combobox "Initial Location:" de cada lote individualmente y buscar la ubicación. Cuando un recibo tiene 5-15 lotes con la misma ubicación (caso común con clientes Aduana), eso son 5-15 interacciones idénticas con react-select. Este applet centraliza la decisión en el header.

## Arquitectura

### Patrón

Applet **separado** de `receiver-date-override`, con el mismo patrón "intercept-and-mutate" sobre `window.fetch`:

- `remote/scripts/warehouse-location-prefill.js` (~250 líneas estimadas)
- Entrada en `remote/config.json` con toggle independiente
- Handler en `extension/background.js`
- Propagación del flag en `extension/content.js`

### Dependencias

- **Sí** depende de `SteelheadAPI` (`scripts/steelhead-api.js`) para invocar `SearchLocationsOnPath` desde el typeahead del combobox del header.
- **No** depende de `receiver-date-override` (cero acoplamiento — cada applet con su propio toggle, su propio fetch patch, su propio sibling de `.css-xd9ivb`).

### Estado por modal (WeakMap)

```js
modalStates = {
  modal → {
    selectEl, inputEl, dropdownEl,
    selectedLocation: { id, path } | null,
    aduanaFilterActive: true,
    aduanaCache: [...],
    fullCache: [...] | null,
    rowObserver,        // MutationObserver del tbody
    removalObserver
  }
}
```

## UX

### Layout

Insertar el campo como sibling de `.css-xd9ivb` (mismo patrón que el date applet), **debajo** del campo de fecha. Cada applet ocupa su propio renglón:

```
┌──────────────────────────────────────────────┐
│ [Customer | Receiver Comments | Custom Inputs]│
├──────────────────────────────────────────────┤
│ Fecha real de recibido: [date] [time] [chips]│  ← receiver-date-override
├──────────────────────────────────────────────┤
│ Ubicación inicial:      [combobox  ▾] [✕]    │  ← este applet
└──────────────────────────────────────────────┘
```

### Combobox del header

El combobox es **custom** (no react-select), construido con HTML/CSS estándar para evitar pelearnos con estado interno de la librería. Tres estados:

#### Estado 1 — Filtro Aduana activo (default al abrir el modal)

- Al detectar el modal: query `SearchLocationsOnPath` con `searchText: '%Aduana%'`, `archivedIsNull: true`, `first: 100`.
- Click en el input abre dropdown listando esos N matches (típicamente 2-5 para Ecoplating).
- Última fila del dropdown: `🔄 Mostrar todas las ubicaciones` (italic, color tenue, separator arriba).
- Si el usuario teclea: filtra **client-side** sobre `aduanaCache` (sustring case-insensitive sobre el `path`).

#### Estado 2 — Sin filtro Aduana (después de click en sentinel)

- Query `SearchLocationsOnPath` con `searchText: ''`, `first: 200`, `offset: 0`.
- Si la respuesta tiene 200 nodos exactos, paginar lazy en el scroll del dropdown (`offset += 200`); si el catálogo total ya cabe en una página, ya quedó.
- Typeahead client-side sobre `fullCache` mientras el usuario escribe.
- Sentinel "Mostrar todas" desaparece de la lista.

#### Estado 3 — Selección hecha

- Input muestra el `path` completo (ej. `Ecoplating.N3.A3.Aduana.Toluca`).
- Botón `✕` a la derecha para limpiar la selección.
- Al limpiar → vuelve al Estado 1 (resetea `aduanaFilterActive = true`, refresca el cache si está stale).

#### Edge: 0 matches de Aduana

- Dropdown muestra "No se encontraron ubicaciones con 'Aduana'" + el sentinel "Mostrar todas".

### Default sin pre-selección

El campo arranca **vacío**. El usuario tiene que afirmativamente elegir una ubicación. Si no toca el campo, comportamiento legacy de Steelhead (rows libres).

### Reset por modal

El estado del combobox (filtro Aduana, selección, caches) se reinicia cada vez que se abre un modal nuevo. No persiste entre recibos distintos.

## Disabling de los combos per-line

### Identificación robusta

Cada lote vive en un `<tr class="MuiTableRow-root css-1g7kc6q">` dentro del `<tbody>` de la tabla `<table class="MuiTable-root css-1owb465">`. La 4a columna ("Assignments") contiene el combobox de "Initial Location:".

Heurística por **placeholder text**:

```js
function findLocationCombos(modal) {
  const combos = [];
  const placeholders = modal.querySelectorAll('[id^="react-select-"][id$="-placeholder"]');
  for (const p of placeholders) {
    if (/^(?:search\s+locations|buscar\s+ubicaciones)/i.test(p.textContent.trim())) {
      const control = p.closest('[class*="-control"]');
      if (control) combos.push(control);
    }
  }
  return combos;
}
```

Esto descarta los otros combos del lote (Sales Order, Quote, Part Group, Container Type, filter de Part Numbers) que tienen placeholders distintos.

### Mecanismo de disable: overlay CSS

```js
function disableCombo(control, locationPath) {
  if (control.dataset.saWlpDisabled === 'true') return;
  control.dataset.saWlpDisabled = 'true';
  control.style.pointerEvents = 'none';
  control.style.opacity = '0.55';
  control.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'sa-wlp-row-overlay';
  overlay.textContent = locationPath;
  overlay.title = 'Heredada del header. Limpia el campo de arriba para editar este renglón.';
  control.appendChild(overlay);
}

function enableCombo(control) {
  if (control.dataset.saWlpDisabled !== 'true') return;
  control.dataset.saWlpDisabled = 'false';
  control.style.pointerEvents = '';
  control.style.opacity = '';
  control.querySelector('.sa-wlp-row-overlay')?.remove();
}
```

**Por qué overlay y no `disabled` attribute:** react-select re-renderea agresivamente sus internals; setear `disabled` en el `<input>` se pierde en el siguiente render. Un overlay CSS sobre el `.css-qpe0ht-control` es independiente del ciclo React, sobrevive re-renders, y comunica visualmente la razón (tooltip "Heredada del header").

**Limitación honesta:** el overlay impide clicks pero no impide que un script externo cambie programáticamente el valor. La garantía dura es el interceptor del payload; el disabling es señal visual.

### Sincronización

1. **Header gana valor** → `findLocationCombos(modal).forEach(c => disableCombo(c, path))`.
2. **Header se limpia** → `findLocationCombos(modal).forEach(enableCombo)`.
3. **Líneas nuevas** (botón "+" del modal o "Copy Row") → MutationObserver sobre `tbody.MuiTableBody-root` detecta `childList` adds y aplica `disableCombo` si el header tiene valor.
4. **Líneas eliminadas** ("Delete Row") → MutationObserver detecta el remove; nada que hacer (el combo ya no existe).

## Interceptor del payload

### Trigger

Intercept de `window.fetch` para `POST /graphql` con `operationName === 'CreateReceiverChecked'` (mismo patrón que `receiver-date-override`).

### Captura de intent

```js
const modal = document.querySelector('[data-sa-wlp-attached="true"]');
const state = modal && modalStates.get(modal);
if (!state?.selectedLocation) return origFetch.apply(this, args);
const targetLocationId = state.selectedLocation.id;
```

### Mutación del payload

Path verificado contra dump real (ver "Validación pendiente"):

```js
const items = bodyObj.variables?.receiverPayload?.receiverBomItems || [];
let mutated = 0;
for (const item of items) {
  const accounts = item?.inventoryTransferEvent?.debitAccounts?.accounts || [];
  for (const acc of accounts) {
    if (acc && 'locationId' in acc) {
      acc.locationId = targetLocationId;
      mutated++;
    }
  }
}
if (mutated > 0) {
  args[1] = { ...opts, body: JSON.stringify(bodyObj) };
  console.log(LOG_PREFIX, `Override de ubicación: ${mutated} accounts → ${targetLocationId}`);
}
return origFetch.apply(this, args);
```

### Sin follow-up mutation

A diferencia del date applet (que necesita `UpdateReceiver` porque el server siempre setea `receivedAt = NOW()` ignorando el campo en el create), aquí editamos el request original. Más limpio y atómico.

### Coexistencia con `receiver-date-override`

Cada applet patcha `window.fetch` con su propio guard (`window.__saWlpFetchPatched`). Como ambos modifican campos distintos del mismo body (`receivedAt` no, `locationId` sí), no chocan. Se cadenan: el último que parcheó es el primero en correr, ambos llaman `origFetch.apply(this, args)` y el flujo termina con un solo POST al server.

## Validación pendiente antes de implementación

Antes de hardcodear el path `variables.receiverPayload.receiverBomItems[].inventoryTransferEvent.debitAccounts.accounts[].locationId` en el interceptor, **verificar con un dump real**: durante la tarea de validation, instrumentar temporalmente el patch para hacer `window.__saWlpLastPayload = JSON.parse(JSON.stringify(bodyObj))` y pedir al usuario que dispare un recibo real. Confirmar que:

1. `receiverBomItems` existe y tiene un entry por lote del modal.
2. Cada entry tiene `inventoryTransferEvent.debitAccounts.accounts[]`.
3. Cada `account` tiene una key `locationId` (o cómo se llama exactamente).

Si el shape difiere de lo asumido, ajustar el path antes de cerrar la implementación.

## Integración

### `remote/config.json`

Nueva entrada en `applets[]` después de `receiver-date-override`:

```json
{
  "id": "warehouse-location-prefill",
  "name": "Ubicación de Recibo",
  "subtitle": "Prefil de ubicación inicial en el modal de Receive Parts",
  "icon": "📦",
  "category": "Recibo",
  "scripts": ["scripts/steelhead-api.js", "scripts/warehouse-location-prefill.js"],
  "autoInject": true,
  "requiredPermissions": ["READ_RECEIVING"],
  "actions": [
    { "id": "toggle-warehouse-location-prefill", "label": "Ubicación de Recibo", "sublabel": "Prefil de ubicación inicial al recibir", "icon": "📦", "type": "toggle", "handler": "message", "message": "toggle-warehouse-location-prefill" }
  ]
}
```

Actualizar `apiKnowledge.queries.SearchLocationsOnPath.usedBy` para incluir `warehouse-location-prefill`.

Bump `version` (`0.5.68 → 0.5.69`) y `lastUpdated`.

### `extension/background.js`

Agregar handler `toggle-warehouse-location-prefill` espejando el patrón existente de `toggle-receiver-date-override`.

### `extension/content.js`

Propagar el flag `data-sa-warehouse-location-prefill-enabled` al `documentElement.dataset` igual que el date applet.

## Edge cases y degradación

1. **Header vacío al guardar** → interceptor pasa el body sin tocar (path legacy de Steelhead).
2. **Header con valor pero `receiverBomItems` vacío** → log `WARN`, no aborta el save.
3. **Path del payload distinto al esperado** (escenario futuro: Steelhead cambia el shape) → log `WARN` con `mutated=0`, body intacto, save procede.
4. **Líneas eliminadas con "Delete Row"** mientras el header tiene valor → MutationObserver detecta el remove; no requiere acción.
5. **Línea copiada con "Copy Row"** → el row nuevo se trata como línea agregada; aplica `disableCombo`.
6. **`SearchLocationsOnPath` falla** → dropdown muestra "Error cargando ubicaciones, reintentar" con botón retry.
7. **>200 ubicaciones sin filtro Aduana** → paginar lazy en scroll del dropdown.
8. **Usuario apaga el toggle con modal abierto** → los rows ya disabled quedan disabled hasta cerrar el modal (no cleanup retroactivo). Aceptable.
9. **Coexistencia con `receiver-date-override`** → cada applet su propio fetch patch + flag dataset; sin colisión.

## Testing manual

1. **Path feliz**: abrir modal con 3 lotes, elegir una ubicación Aduana, guardar → todos los lotes deben quedar con esa ubicación al verificar en el receiver creado.
2. **Header vacío**: abrir modal, agregar ubicación per-line manual a un lote, guardar → ubicación per-line preservada (legacy behavior).
3. **Cambio de header**: abrir modal, elegir Aduana A, agregar nueva línea, cambiar a Aduana B, guardar → todos los lotes (incluido el nuevo) con Aduana B.
4. **Limpiar header**: elegir Aduana, luego clickar ✕ → rows re-habilitados, save sin override.
5. **Mostrar todas**: click en sentinel → catálogo completo, typeahead funciona, sentinel desaparece.
6. **Sin matches Aduana**: simular catálogo sin "Aduana" → mensaje "No se encontraron" + sentinel funcional.
7. **Coexistencia con date applet**: ambos toggles ON, llenar fecha y ubicación, guardar → receiver con `receivedAt` custom Y todos los lotes con ubicación elegida.
8. **Toggle off durante modal**: apagar applet con modal abierto → rows quedan en su estado actual; al reabrir modal, sin disabling.

## Out of scope

- Persistencia de la última ubicación elegida entre recibos (decidido reset per-modal).
- Override por línea individual con botón "Personalizar" (decidido: si el usuario quiere mezclar ubicaciones, deja el header vacío).
- Pre-selección automática si solo hay UNA Aduana (decidido: arranque siempre vacío).
- Aplicar la misma lógica a otros modales (ej. Manual Inventory Adjustment) — fuera del alcance de este applet.
