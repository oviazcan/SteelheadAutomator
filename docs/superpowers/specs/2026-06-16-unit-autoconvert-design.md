# Unit Auto-Convert — Spec de diseño

## Estado: Diseñado (pendiente plan + implementación), 2026-06-16

## Contexto

En la edición de un Número de Parte, Steelhead expone las "conversiones de unidad por
parte" (cuántas unidades de cada tipo equivalen a 1 parte) en **dos pantallas distintas**:

1. **Modal "Edit Part Number" → pestaña FACTORES Y PRECIO → "Per Part Count Unit
   Definitions"** (Panel A): bloque de la derecha con **7 campos fijos por default** —
   `KGM Kilogramo / Part`, `LBR Libra / Part`, `FTK Pie Cuadrado / Part`,
   `CMK Centímetro Cuadrado / Part`, `FOT ft Pie / Part`, `LM Metro Lineal / Part`,
   `LO Lote / Part`. Cada uno es un input `type=number` con sufijo "/ Part".
2. **Modal "Definir Unidades Para <PN>"** (Panel B): tabla `Unidad | Unidades/Parts |
   Parts/Unit | Eliminar`, con su propio toggle "Modo: Edición Directa | Medir" y un
   react-select "Add new unit…". Solo muestra las conversiones ya definidas como filas.

El operador hoy captura cada unidad a mano y la convierte mentalmente (kg→lb, cm²→ft², etc.).
Es repetitivo y propenso a error.

## Objetivo

Cuando el operador escribe un valor en un campo de unidad y da **Tab**, calcular y
rellenar/crear automáticamente las **otras unidades del mismo tipo físico** (peso, longitud,
superficie). Con un **toggle visible, default ON**, para desactivarlo fácil. Funciona en
**ambas pantallas**.

Las unidades que deben quedar creadas son las del modal (Panel A) que vienen por default,
pero el cálculo aplica en cualquiera de las dos pantallas.

## Decisiones (cerradas con el usuario)

- **Sobrescritura:** al dar Tab, el campo editado es la fuente de verdad → **se recalcula y
  reemplaza siempre** el par, aunque ya tuviera valor.
- **Precisión:** valores calculados a **4 decimales fijos**, con trim de ceros finales.
- **Toggle:** **visible, default ON, estado por sesión** (en memoria; arranca ON en cada
  recarga dura; persiste durante navegación SPA). Apagarlo desactiva el cálculo al instante.
- **Roster de unidades (completo):**
  - **Peso:** KGM Kilogramo · LBR Libra
  - **Longitud:** LM Metro Lineal · FOT ft Pie
  - **Superficie:** CMK Centímetro Cuadrado · DMK Decímetro Cuadrado · FTK Pie Cuadrado
  - **LO Lote:** conteo suelto, **sin conversión** (se ignora).
- **Unidades sin campo (DMK y pares ausentes en Panel B):** se **crean/actualizan por API**
  (persisted query), evitando pelear con el react-select; se avisa "recarga para verlas".

## Modelo de conversión (módulo puro + golden tests)

Cada grupo define una base canónica y, por unidad, su **factor = (unidades de esa unidad) por
1 unidad base**. El valor "X / Part" que el usuario escribe **ES** el `factor` per-part de esa
unidad (mismo número que guarda la API). La conversión es lineal sin offset.

| Tipo | Base | Unidad → factor vs base (unidad/base) |
|---|---|---|
| Peso | kg | KGM = 1 · LBR = 2.2046226218 |
| Longitud | m | LM = 1 · FOT = 3.280839895 |
| Superficie | cm² | CMK = 1 · DMK = 0.01 · FTK = 0.001076391041670972 |

Algoritmo `computePeers(code, value)`:
1. Localiza el grupo de `code`. Si no está en ningún grupo (p.ej. `LO`) → `[]`.
2. `base = value / factor[code]`.
3. Para cada `peer ≠ code` del grupo: `peerValue = round4(base × factor[peer])`.
4. Devuelve `[{ code, value }]` (excluyendo el editado).

`round4(x)` = redondea a 4 decimales y recorta ceros finales (`6.2832`, `7.6048`, `0.8186`).

Verificación de referencia:
- KGM 2.85 → LBR **6.2832**
- CMK 760.48 → DMK **7.6048** · FTK **0.8186**
- LM 0.38 → FOT **1.2467**

El módulo se expone para test en Node (patrón `bulk-upload-parse.js`): tabla `UNIT_GROUPS` +
`computePeers` puros, sin DOM ni red.

## Arquitectura

### Script: `remote/scripts/unit-autoconvert.js`

- IIFE → `window.UnitAutoConvert`, auto-init.
- Dependencia: `SteelheadAPI` (`scripts/steelhead-api.js`).
- `autoInject: true` (data-driven desde `config.apps[]`, sin tocar `background.js`).

### App en config.json

```json
{
  "id": "unit-autoconvert",
  "name": "Auto-conversión de Unidades",
  "subtitle": "Calcula las demás unidades del mismo tipo al editar un NP",
  "icon": "📐",
  "category": "Números de Parte",
  "autoInject": true,
  "scripts": ["scripts/steelhead-api.js", "scripts/unit-autoconvert.js"],
  "requiredPermissions": []
}
```

Kill-switch global `unitAutoConvertEnabled` (default true) en `config.json` para apagar el
applet a todos sin redeployar lógica (independiente del toggle visible por sesión).

### Hashes GraphQL (ya en config.json)

```json
"GetAvailableUnits": "405368babb953708532627a930e5ea1a1ca21e5518a5f0f4d8cd0757880c43c0",
"CreateInventoryItemUnitConversion": "769411466c537c059cf6fc1721e116dc42ff1d88e3a72879cc94444329a1f334",
"UpdateInventoryItemUnitConversion": "ffc8db6cd8edaa9355b904fac38f8e5fc116ce1d597f076026c38ef09420a16c",
"SearchUnits": "1961ca85600a902498898502aeda031f270ff2b1289b3ef9fe43aaaefe97ceda"
```

### Unit IDs (`config.steelhead.domain.unitIds`)

`KGM 3969 · LBR 3972 · FTK 4797 · CMK 4907 · FOT 5148 · LM 5150 · LO 5348`.
**Falta `DMK`** → se resuelve en runtime por código vía `SearchUnits` (cache por sesión) y se
pinea en `config.steelhead.domain.unitIds` cuando se confirme su id.

## DOM — selectores (verificados contra HTML del usuario)

### Panel A — "Per Part Count Unit Definitions"

Cada unidad es un wrapper `<div>` con:
- label `<p class="MuiTypography-root … css-9l3uo3">KGM Kilogramo / Part:</p>`
- `<div class="MuiFormControl-root … MuiTextField-root css-cv7rz">` → `<div class="MuiInputBase-root … css-1mexhn8">` → `<input type="number" …>`
- adorno `<div class="css-xd9ivb">/ Part</div>`

El `id` del input es de React (`:r12t:`) → **no sirve** para identificar. Identificación:
- Desde el input → `input.closest('.MuiFormControl-root')` → `.parentElement` (wrapper) →
  `wrapper.querySelector(':scope > p.MuiTypography-root')` = label.
- Código de unidad = **primer token** del texto del label (antes del primer espacio):
  `"KGM Kilogramo / Part:"` → `KGM`.
- Filtro de pertenencia: el label termina en `/ Part:` (o el input tiene adorno "/ Part") y el
  código es uno de los conocidos.

Inyección del toggle: localizar el encabezado por texto `"Per Part Count Unit Definitions"` e
insertar el toggle después; fallback = ancestro común de los wrappers de unidad (insertar al
inicio). Idempotente por `dataset.saUacToggle`.

### Panel B — modal "Definir Unidades"

Fila `<tr class="MuiTableRow-root …">`:
- `td[0] > p` = nombre de unidad (`"KGM Kilogramo"`) → código = primer token.
- `td[1]` = **Unidades/Parts** (el que escribimos): input cuyo adorno
  (`.MuiInputAdornment-root > div`) termina en `"/ Parts"` (texto tipo `"KGM Kilogramo / Parts"`).
- `td[2]` = **Parts/Unit** (recíproco): adorno tipo `"Parts / KGM Kilogramo"` → **no se toca**;
  Steelhead lo recalcula solo al cambiar Unidades/Parts.
- `td[3]` = botón eliminar.

Disambiguación robusta entre `td[1]` y `td[2]`: usar el texto del adorno (empieza con `"Parts /"`
= recíproco → excluir). Fallback: primer input del row = Unidades/Parts.

Inyección del toggle: junto al header "Modo:" (contenedor `div.css-xd9ivb` que contiene el
`<p>Modo:</p>` y el toggle Edición Directa/Medir). Idempotente por `dataset.saUacToggle`.

## Disparo y escritura

- **Listener delegado `focusout` en captura** sobre el root de cada panel (robusto ante los
  re-render de React; no se re-engancha por input). Un `MutationObserver` idempotente detecta
  la aparición de cada panel, inyecta el toggle y registra el listener una vez por root.
- Al `focusout` de un input de unidad (toggle ON + `unitAutoConvertEnabled` + valor numérico
  finito y > 0):
  1. Resolver código y grupo. `computePeers(code, value)`.
  2. Resolver `inventoryItemId` (ver abajo). Leer conversiones existentes con `GetAvailableUnits`.
  3. Para cada peer:
     - **Si tiene campo/fila presente** → escribir por DOM con **setter nativo + `InputEvent`**
       (`Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set`),
       sobrescribiendo siempre. Persiste con el SAVE propio del panel.
     - **Si NO tiene campo** (DMK, o par ausente en Panel B) → `upsertConversion()` por API
       (create/update según exista en las conversiones leídas). Marca "creado por API".
  4. Si hubo al menos un peer creado por API → mostrar aviso no bloqueante
     *"Se crearon N unidades por API · recarga para verlas"*.
- **Sin bucles:** solo reaccionamos a `focusout` (blur del usuario); los writes programáticos
  disparan `input`/`change` pero no `focusout`, así que no re-disparan el cálculo.

### Resolver `inventoryItemId` (reusar `weight-quick-entry`)

- Intercept de red de `GetPartNumber` / queries del PN para cachear `inventoryItemByPartNumberId.id`.
- Fallback: obtener `pnId` del contexto (URL del modal o código de PN del título "Definir Unidades
  Para <PN>") → `GetPartNumber({id})` → `inventoryItemByPartNumberId.id`.
- Si no se resuelve `inventoryItemId`: los peers con campo igual se llenan por DOM; los API-only
  se omiten con aviso de error ("no se pudo resolver el PN").

### `upsertConversion` (reusado de `weight-quick-entry`)

```js
async function upsertConversion(existing, unitId, inventoryItemId, factor) {
  const hit = existing.find(c => Number(c.unitByUnitId?.id) === Number(unitId));
  if (hit) await api().query('UpdateInventoryItemUnitConversion', { id: hit.id, factor }, 'UpdateInventoryItemUnitConversion');
  else     await api().query('CreateInventoryItemUnitConversion', { unitId, inventoryItemId, factor }, 'CreateInventoryItemUnitConversion');
}
```
`factor` = el valor per-part calculado (number).

## Toggle (UI)

- Switch pequeño estilo Steelhead, etiqueta "Auto-conversión de unidades", con estado visible
  ON/OFF. **Default ON**, estado en variable de módulo (por sesión).
- Inyectado una vez por panel (Panel A junto al título; Panel B junto a "Modo:").
- `textContent` para etiquetas (sin `innerHTML` con datos externos).

## Seguridad / memoria

- Applet de interacción puntual (no procesa listas largas, no corre pools, no mantiene panel por
  minutos) → **NO requiere** `host-cleanup-shared` (regla de memory-hardening).
- Sin `innerHTML` con datos externos. Inputs propios marcados con clase distintiva
  (`sa-uac-*`) para no auto-contarse en heurísticas (lección `weight-quick-entry` 0.5.81).

## Manejo de errores

- Valor no numérico / vacío / ≤ 0 → no hace nada (no borra pares).
- Falla de API en un peer → aviso de error en el toggle/estado; los peers DOM ya escritos quedan.
- `GetAvailableUnits` falla → solo se intentan los peers con campo (DOM); API-only se omiten con aviso.
- Unidad fuera de grupo (LO u otra) → no-op.

## Plan de validación (en vivo)

1. **#1 — RIESGO PRINCIPAL: semántica del SAVE del modal vs conversiones sin campo.** Crear DMK
   por API (CMK→Tab), luego dar **SAVE** al modal y verificar con `GetAvailableUnits` si DMK
   **sobrevive** (merge) o **se borra** (replace). Si replace → ajustar UX para forzar recarga
   antes de guardar, o reescribir DMK post-SAVE. Probar ANTES de exponer a usuarios.
2. Panel A: KGM 2.85 → Tab → LBR 6.2832 (campo). CMK 760.48 → Tab → FTK 0.8186 (campo) + DMK
   7.6048 (API + aviso recarga). LM 0.38 → Tab → FOT 1.2467.
3. Panel B: con filas presentes (KGM/CMK/LM) → convertir entre presentes por DOM; par ausente →
   API + aviso. Confirmar que Parts/Unit recíproco se recalcula solo.
4. Toggle OFF → no calcula. Recarga → vuelve ON.
5. Sobrescritura: par con valor previo se reemplaza.
6. PN nuevo (sin inventoryItem aún) → comportamiento de resolución de `inventoryItemId`.

## Pendientes derivados

- Pinear `DMK` en `config.steelhead.domain.unitIds` tras confirmar su id.
- Confirmar permisos: operador no-admin escribiendo `CreateInventoryItemUnitConversion`.
- (Opcional fase 2) Auto-agregar fila en Panel B vía react-select si se prefiere ver sin recargar.
- Bitácora `docs/applets/unit-autoconvert.md` al implementar.

## YAGNI (excluido)

- No se persiste el estado del toggle (es por sesión, por decisión).
- No se crea ningún catálogo nuevo ni almacenamiento propio (usa las conversiones nativas del PN).
- No se toca `LO Lote` ni se inventan unidades fuera del roster cerrado.
