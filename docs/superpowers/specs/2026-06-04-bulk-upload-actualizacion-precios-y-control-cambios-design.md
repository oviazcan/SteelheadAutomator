# Diseño — bulk-upload: actualización de precios + Control de Cambios

**Fecha:** 2026-06-04
**Applet:** `bulk-upload` (`remote/scripts/bulk-upload.js`)
**Versión base:** 1.5.19 / config 1.6.36
**Estado:** diseño aprobado, pendiente de plan de implementación

---

## 1. Contexto y objetivo

`bulk-upload` se va a empezar a usar también para **actualizar precios** de números
de parte (PN) existentes. En ese flujo, el upload trae el **NP (número de parte) +
precio**, pero **sin etiquetas de acabado** — no porque se quiera un PN nuevo, sino
porque el operador no las conoce ni le importan para un cambio de precio.

Hoy eso produce dos problemas:

- **(A) Falso "crear nuevo".** El matcher defaultea a `NEW` cuando los acabados del
  upload difieren de los del PN en Steelhead. Con acabados **en blanco**, los trata
  como "distintos" y sugiere crear un PN nuevo, cuando lo correcto es **modificar** el
  PN existente.
- **(B) Falta de trazabilidad.** No hay rastro de que un PN se creó o modificó vía
  carga masiva. Se requiere un **log de cambios** (fecha, usuario, acción).

### Hallazgo clave (consulta en vivo del PN 3660963, dominio TLC)

El usuario **ya creó el campo del lado de Steelhead**. El schema vigente del dominio
TLC es **`inputSchemaId = 3932`** (creado 2026-06-05 por OMAR FIDEL VIAZCAN GOMEZ), y
ya incluye un campo **`ControlCambios`** dentro del schema:

```jsonc
"ControlCambios": {
  "type": "array",
  "title": "Control de Cambios",
  "items": {
    "type": "object", "title": "Evento",
    "properties": {
      "Fecha":   { "type": "string", "format": "date-time", "title": "Fecha" },
      "Accion":  { "type": "string", "title": "Acción" },
      "Detalle": { "type": "string", "title": "Detalle" },
      "Usuario": { "type": "string", "title": "Usuario" },
      "Version": { "type": "string", "title": "Version" }
    }
  }
}
```

`uiSchema` → orden de cada evento: `[Fecha, Usuario, Accion, Detalle, Version]`,
`Detalle` como textarea, y `ControlCambios` se renderiza al final de la ficha del PN.

Como el campo vive **dentro del schema**, la UI de Steelhead lo preserva y lo
renderiza — **no hay fragilidad** (a diferencia de un key fuera de schema tipo
`_bulkLog`, que un guardado manual podría borrar).

`config.json` tiene hardcodeado `inputSchemaId_PN: 3456`, que quedó **obsoleto**. La
consulta `GetPartNumbersInputSchema` del dominio TLC devuelve **un solo** schema
(id 3932). bulk-upload **ya** lo consulta (línea 3872) y ya calcula el más reciente
(línea 3874, `latestSchema`), pero solo lo usa para extraer enums; sigue mandando
3456 como `inputSchemaId` al guardar.

### Objetivo

1. **(A)** Cuando el upload no trae acabados, defaultear a **modificar el PN activo
   más reciente** (auto si hay uno solo; confirmar si hay varios).
2. **(B)** Registrar cada alta/modificación en `customInputs.ControlCambios`, usando
   el `inputSchemaId` **vigente y dinámico** del dominio (3932 hoy) en lugar del
   hardcodeado.

---

## 2. Feature A — *blank-acabados fallback* en el matcher

### Comportamiento

En `classifyOnePN` (Pase 3), cuando el upload **no trae acabados**
(`csvAcabados === ''`, ya con las labels de planta `nonFinishLabelNames` filtradas) y
existe ≥1 PN **activo** con ese **nombre + cliente**:

| # candidatos activos (mismo nombre+cliente) | Comportamiento | Resultado |
|---|---|---|
| **1** | Defaultea a MODIFICAR ese PN, **corre directo** | `existing`, decisión automática, badge "auto: NP más reciente" |
| **2+** | Preselecciona el **más reciente** (id más alto), **exige confirmar** | Pase 3 interactivo, dropdown apuntando al reciente, `userDecided: false` |

- **"Más reciente" = id más alto.** En el subset de candidatos por nombre se ordena
  por `id` **descendente** (hoy `rankCandidates` desempata por id ascendente).
- **La regla del usuario se respeta intacta:** esta rama **solo** dispara con acabados
  vacíos. Si el upload trae acabados **no vacíos** que difieren → se mantiene el
  comportamiento actual (default `NEW`). "Solo labels de planta" cuenta como vacío
  (las filtra `acabadosCanonicos`), así que también modifica.
- **Alcance:** es `classifyOnePN`, compartido → aplica en SOLO_PN y COTIZACIÓN+NP;
  el efecto se nota sobre todo en cargas solo-precio.

### Punto de inserción

`classifyOnePN`, Pase 3 (≈`bulk-upload.js:6700-6732`), **entre** el check
`if (labelsMatchFull)` y el bloque `blankCandidate` / `return NEW`:

```js
if (labelsMatchFull) {
  return { classification: 'MODIFY', pase: 3, confidence: 'name+labels-match', ... };
}

// NUEVO — blank-acabados fallback
if (csvAcabados === '' && nameCandidates.length >= 1) {
  const recent = [...nameCandidates].sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  const multiple = nameCandidates.length >= 2;
  return {
    classification: 'MODIFY', pase: 3,
    confidence: 'name+blank-csv-recent',
    targetPnId: recent.id,
    candidates: ranked,
    autoDecided: !multiple,   // 1 candidato → auto; 2+ → confirmar
    wasArchived: false,
  };
}

// (resto actual: blankCandidate → MODIFY; si no, NEW) — solo se alcanza con csvAcabados !== ''
```

### Propagación a `pnStatus` y preview

- `buildClassifiedRow` lee el nuevo campo `autoDecided`:
  - `autoDecided === true` → `userDecided: true`, `status: 'existing'`, fila no exige
    interacción pero conserva el dropdown de Pase 3 por si se quiere override.
  - `autoDecided === false` (o ausente) → `userDecided: false`, Pase 3 interactivo con
    el dropdown preseleccionado a `targetPnId`.
- En `showPreview`, las filas con `confidence === 'name+blank-csv-recent'` muestran un
  chip **"auto: NP más reciente"** (reusar estilo `dl9-unarch-chip`), con tooltip que
  explique la regla.

### Preserve-on-missing (riesgo clave)

Cuando una fila solo-precio cae en MODIFY, el pipeline re-escribe el PN completo
(Call A + Call B). El *preserve-on-missing* (`mergeCustomInputs` + `extractPNShape`,
endurecido en 1.5.9/1.5.16/1.5.18/1.5.19) garantiza que **no se blanquee** proceso,
specs, dims, notas ni custom inputs. **Debe validarse en piloto** — es justo donde han
vivido los bugs de blanqueo.

---

## 3. Feature B — Control de Cambios + inputSchemaId dinámico

### 3.1 inputSchemaId dinámico

**Problema:** los 4 `SavePartNumber` mandan `DOMAIN.inputSchemaId_PN` (3456,
obsoleto). Tocar un PN hoy lo degradaría a 3456 y sacaría `ControlCambios` del schema.

**Solución:** capturar `latestSchema.id` (ya calculado en `:3874`) en una variable de
closure del pipeline (p. ej. `runtimeInputSchemaId`) y usarla como `inputSchemaId` en
los 4 puntos de guardado:

- `:4081` (STEP 2a, mínimo NEW)
- `:5231` (Call A)
- `:5416` (Call B)
- `:5894` (cualquier otro guardado de PN)

```js
const runtimeInputSchemaId = latestSchema?.id || DOMAIN.inputSchemaId_PN; // fallback
```

Propiedades:
- **A prueba de futuro:** la próxima migración de schema se toma sola.
- **Multi-dominio:** cada dominio devuelve su propio schema vigente (TLC → 3932,
  MTY → el suyo). No hay que parametrizar config por dominio.
- **Migra los PNs viejos 3456 → 3932 al tocarlos**, lo cual es seguro porque 3932 es
  superset (mismos campos + ControlCambios).
- **Fallback:** si `GetPartNumbersInputSchema` falla, se usa `DOMAIN.inputSchemaId_PN`.
  Se **bumpea `config.json` `inputSchemaId_PN: 3456 → 3932`** para que el fallback no
  degrade en el caso TLC.

**Punto a validar en piloto:** el schema 3932 tiene
`DatosAdicionalesNP.required: ['BaseMetal']`. Migrar un PN viejo sin BaseMetal: el
backend tolera (validación `required` es solo UI/RJSF), pero se confirma en piloto.

### 3.2 Estructura de la entrada de ControlCambios

Nombres **exactos** del schema 3932:

```js
{
  Fecha:   new Date().toISOString(),      // "2026-06-05T04:06:09.232Z"
  Usuario: currentUserName,               // "OMAR FIDEL VIAZCAN GOMEZ" o "(desconocido)"
  Accion:  "<ALTA|PRECIO|ENRIQUECIMIENTO[, …]>",
  Detalle: "<texto breve>",
  Version: configVersion                  // "1.6.37" (versión de config.json)
}
```

**`Accion`** (cortos en mayúsculas, combinables por coma):

| Token | Cuándo |
|---|---|
| `ALTA` | fila clasificada `NEW` (PN creado) |
| `PRECIO` | la fila trae `precio` (se agregó un precio nuevo al PN) |
| `ENRIQUECIMIENTO` | la fila cambió specs / dims / proceso / labels / notas |

Si una corrida combina varios → `Accion: "PRECIO, ENRIQUECIMIENTO"`. Una **sola
entrada por corrida por PN**.

**`Detalle`** (texto breve, best-effort):
- `PRECIO` → `"12.50 → 13.80 USD"` (precio anterior best-effort desde el
  `GetPartNumber` de enrich; si no está disponible, solo el nuevo: `"13.80 USD"`).
- `ALTA` → `"PN creado vía carga masiva"`.
- `ENRIQUECIMIENTO` → lista breve de campos tocados (p. ej. `"specs, proceso"`).

**`Version`** = versión de `config.json` (consistente con las 2 entradas de prueba que
ya existen en el PN 3660963, que usan `"1.6.36"`).

### 3.3 Cuándo se appendea

**Solo si hubo cambio real.** Se calcula un flag `didChange` por fila:
- `status === 'new'` → ALTA.
- `part.precio != null` → PRECIO.
- enrich aplicó algo (specs/dims/proceso/labels/notas no vacíos) → ENRIQUECIMIENTO.

Si `Accion` queda vacía (la fila no cambió nada) → **no se appendea** ningún evento.

### 3.4 Identidad del usuario

- Una sola llamada a **`CurrentUserDetails`** (hash `f966e56c…`, ya en `config.json`,
  ya usada por `paros-linea.js`) al **inicio** del pipeline; el resultado
  (`currentSession.userByUserId.name`) se cachea en una variable de closure.
- Si falla → `Usuario: "(desconocido)"`, **no se aborta** la corrida.

### 3.5 Punto de enganche (append no-destructivo)

El objeto `mergedCI` (customInputs mergeado, deep-cloned del existente) está disponible
en `bulk-upload.js:5179`, antes de construir Call A (`:5226`) y Call B (`:5412`).
Justo ahí:

```js
let mergedCI = mergeCustomInputs(existingPnNode?.customInputs ?? pn.customInputs, part);
// NUEVO:
if (didChange) {
  if (!mergedCI) mergedCI = {};   // altas / PN sin customInputs: mergeCustomInputs devuelve null
  const entry = buildControlCambiosEntry({ accion, detalle, user: currentUserName, version: configVersion });
  appendControlCambios(mergedCI, entry);   // mergedCI.ControlCambios = [...(existente||[]), entry]
}
```

- **`mergedCI` debe ser reasignable** (`let`, no `const`): si era `null` se inicializa a
  `{}` antes del append, y los Call A/B deben leer **esa misma referencia** (no una
  copia previa) para que la entrada viaje en el payload.
- `appendControlCambios` hace push sobre el array existente (ya deep-cloned por
  `mergeCustomInputs`) — preserva el historial previo, incluidas las entradas que el
  usuario o la UI de Steelhead hayan creado.
- **Sin cap** de entradas por ahora (es el audit oficial; historial completo). Si en
  el futuro crece demasiado, se evalúa un cap alto.
- Como `mergedCI` se referencia por variable en Call A y Call B, la entrada se propaga
  a ambos automáticamente.

---

## 4. Componentes nuevos / helpers

| Helper | Responsabilidad | Ubicación |
|---|---|---|
| `runtimeInputSchemaId` (var closure) | id del schema vigente del dominio | set tras `:3874` |
| `currentUserName` (var closure) | nombre del usuario logueado, cacheado | set al inicio del pipeline |
| `buildControlCambiosEntry({accion, detalle, user, version})` | arma `{Fecha,Usuario,Accion,Detalle,Version}` | función pura nueva |
| `appendControlCambios(ci, entry)` | push no-destructivo a `ci.ControlCambios` | función pura nueva |
| Rama blank-acabados en `classifyOnePN` | regla A | dentro de `classifyOnePN` Pase 3 |
| `autoDecided` en `buildClassifiedRow` | propaga decisión auto/confirmar | `buildClassifiedRow` |
| chip "auto: NP más reciente" | badge en preview | `showPreview` |

Cada helper es puro y testeable de forma aislada (entrada → salida, sin estado).

---

## 5. Manejo de errores

- `GetPartNumbersInputSchema` falla → `runtimeInputSchemaId` cae al fallback
  (`DOMAIN.inputSchemaId_PN`, bumpeado a 3932). Se loguea warning.
- `CurrentUserDetails` falla → `Usuario: "(desconocido)"`, corrida continúa.
- Precio anterior no disponible → `Detalle` con solo el precio nuevo.
- Sin candidatos activos por nombre (todos archivados) → regla A no aplica; se sigue al
  comportamiento actual (NEW). Documentado como edge case aceptable.

---

## 6. Deploy

1. Bump `config.json` `version` + `lastUpdated`; `inputSchemaId_PN: 3456 → 3932`.
2. Bump `VERSION` del applet (`bulk-upload.js`).
3. Commit en `main`, sync a `gh-pages` (`git show main:remote/... > ...`),
   push ambas ramas.
4. `tools/check-deploy.sh bulk-upload.js`.

---

## 7. Plan de validación (piloto)

Cliente de prueba (Tipsa o Schneider), 3–5 PNs, CSV **solo-precio sin labels**:

1. **Matching (A):** el preview matchea al PN correcto (no sugiere NEW); con 1
   candidato corre directo con badge; con 2+ exige confirmar y preselecciona el
   reciente.
2. **Preserve-on-missing:** tras la corrida, el PN conserva proceso, specs, dims,
   notas y customInputs (nada blanqueado).
3. **inputSchemaId:** el PN queda con `inputSchemaId = 3932` (verificar con
   `GetPartNumber`).
4. **ControlCambios:** se appendeó una entrada con `Accion: "PRECIO"`,
   `Detalle: "ant → nvo USD"`, `Usuario` correcto, `Version` = config, y **se preservó
   el historial previo** (las 2 entradas de prueba siguen ahí).
5. **Precio:** el precio se actualizó y el default quedó correcto.
6. **required BaseMetal:** migrar un PN viejo (3456) sin BaseMetal a 3932 no rompe el
   guardado.

---

## 8. Fuera de alcance (YAGNI)

- Cap / rotación de entradas de ControlCambios (se evalúa solo si crece de más).
- Rama "price-only" que salte el enrich (hoy todo MODIFY pasa por Call A+B; no se
  optimiza en este diseño).
- Log externo descargable (se descartó a favor del campo en schema).
- Parametrizar `inputSchemaId` por dominio en config (el id dinámico lo vuelve
  innecesario).
- Edición / borrado de entradas de ControlCambios desde el applet.

---

## 9. Decisiones registradas

| Tema | Decisión |
|---|---|
| Default acabados-vacíos | MODIFICAR el más reciente; auto si 1 candidato, confirmar si 2+ |
| Ubicación del footprint | `customInputs.ControlCambios` (campo del schema 3932) |
| inputSchemaId | dinámico (`latestSchema.id`); fallback bumpeado a 3932 |
| `Accion` | cortos en mayúsculas: `ALTA` / `PRECIO` / `ENRIQUECIMIENTO` (combinables) |
| `Version` | versión de `config.json` |
| Cuándo loguear | solo si hubo cambio real |
| Identidad | `CurrentUserDetails`, cacheada, fallback `(desconocido)` |
