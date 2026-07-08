# pn-specs-column — Specs + parámetros numéricos en el dashboard de Números de Parte

**Versión:** 0.1.1 — **DEPLOYADO**. Core 15/15 golden + validado en vivo. **0.1.1** corrige 2 bugs del primer run real del usuario (ver §Fixes 0.1.1). **0.1.0** deploy inicial (config 1.7.85).
**Categoría:** Números de Parte · **autoInject:true** · ruta: `/PartNumbers` (index, NO la ficha `/PartNumbers/:id`)

## Qué hace

En el dashboard `https://app.gosteelhead.com/PartNumbers`, agrega una **columna "Specs / Params num."** a la tabla y, con un **toggle persistente en el header** (junto a "NUEVO NÚMERO DE PARTE"), enriquece cada NP visible con:

- las **specs asociadas** al NP (`E27550 (Plata)`, …), y
- bajo cada una, sus **parámetros NUMÉRICOS** (`specField.type === 'NUMBER'`) con **nombre + rango + unidad** (ej. `Espesor 1.27–3.5 µm`).

Excluye BOOLEAN / DROPDOWN / TEXT (el usuario pidió explícitamente **numéricos**) y los parámetros/specs **archivados**.

## Decisión de diseño (respuesta a la pregunta original del usuario)

> «¿`AllPartNumbers` ya trae el dato para no hacer doble query?»

**No.** Verificado 2026-07-08 contra los payloads reales (`docs/api/Payload: *.txt`):

- `AllPartNumbers` (el query del dashboard) **NO trae specs ni parámetros**. Sus 98 `"SPEC"` son texto libre en `customInputs.NotasAdicionales`.
- `GetPartNumberForPartNumberPage` (liviano) tampoco: solo id/name/customer/labels.
- **Solo `GetPartNumber`** (pesado, 504 campos) expone el árbol de specs.
- Son **persisted queries** (el shape lo fija el server) → no se le pueden "agregar" campos a `AllPartNumbers`. **Sí o sí un 2º query por NP.**

Por eso el enriquecimiento es **opt-in** (toggle) y con memory-hardening completo: con el toggle ON se hace 1 `GetPartNumber` por cada NP visible (~50/página).

## Modelo de datos (dónde vive cada cosa en `GetPartNumber`)

```
data.partNumberById
  .partNumberSpecsByPartNumberId.nodes[]            ← specs asociadas
     { archivedAt, specBySpecId: { id, name } }
  .partNumberSpecFieldParamsByPartNumberId.nodes[]  ← parámetros
     { archivedAt,                                    (node: histórico si != null)
       specFieldParamBySpecFieldParamId: {
         minimumValue, maximumValue, targetValue,
         unitByUnitId: { name },                      ("µm (micrómetro, micra)")
         specFieldSpecBySpecFieldSpecId: {
           specFieldBySpecFieldId: { name, type },    (type: NUMBER|BOOLEAN|DROPDOWN|TEXT)
           specBySpecId:      { id, name } } } }
```

- `specField.name` = nombre del parámetro (**Espesor**), NO `specFieldParam.name` (ese es el rango, `"1.27 - 3.5 µm"`).
- `specField.type` = discriminador numérico/booleano.
- Variables usadas: `{ partNumberId, usagesLimit: 0, usagesOffset: 0 }` — `usagesLimit:0` aligera el response (no necesitamos los usos del PN).

### GOTCHA clave — `archivedAt` (duplicados)

Los params vienen **DUPLICADOS**: en el PN de referencia (44068-205-01), 5 archivados + 5 activos idénticos. Filtramos `node.archivedAt == null`; eso además **deduplica**. Dedup extra defensivo por `(specId, fieldName, min, max, target)`.

## Arquitectura

| Archivo | Rol |
|---|---|
| `remote/scripts/pn-specs-column-core.js` | Motor puro (sin DOM/red): `isPartNumbersIndexPath`, `parsePartNumberId`, `unitSymbol`, `fmtNum`, `formatRange`, `extractSpecsWithNumericParams`, `formatCellText`. Dual node/browser. |
| `remote/scripts/pn-specs-column.js` | Glue DOM: toggle persistente, columna en la MUI table, MutationObserver, pool de `GetPartNumber`, memory-hardening. |
| `tools/test/pn-specs-column-core.test.js` | 14 golden tests. |

- **Toggle persistente**: `localStorage['sa_pn_specs_col_enabled']` = `'1'`/`'0'`, **default OFF** (no sorprender con 50 queries pesados). Toggle DOM en el header + acción de popup (`PnSpecsColumn.toggleFromPopup`).
- **Columna**: `<th>` + `<td>` por fila insertados **antes de la última columna** (Acciones). Marcados `.sa-pnspec-cell` para idempotencia. `partNumberId` sale del `<a href="/PartNumbers/:id">` de la celda Nombre.
- **React/MUI**: la tabla es `MuiTable-root` controlada por React. Un `MutationObserver` (debounce 160ms) re-inyecta la columna al paginar/ordenar/filtrar. **Validado en vivo:** insertar `<td>` extra al final de cada `<tr>` **sobrevive** el render de React (50/50 celdas persisten).
- **Estilo**: toggle/toast en **dark-mode** (UI nuestra, regla de diseño); la columna se integra a la tabla clara de SH pero **marcada con acento verde** (`border-left:3px #13a36f`) para señalar que es enriquecimiento de la extensión. Render con `textContent` (no innerHTML de datos → no XSS con nombres de spec).

## Memory hardening (skill `memory-hardening-applets`)

Importa `host-cleanup-shared.js`. Aplica porque el toggle ON dispara ~50 `GetPartNumber` pesados por página y se re-dispara al paginar.

**EJE A (propia):** cache **slim** por `partNumberId` (`window.__saPnSpecsCache` Map → solo `{specs, total}`, no el response de 504 campos); cache se limpia al **navegar fuera** del index; teardown de columna/observer/pool al desactivar.
**EJE B (host):** `stopDatadogSessionReplay()` al primer fetch real; `createMemMonitor` con guardrail @88% → vacía la cola de enriquecimiento + toast (checkpoint > crash); `makePeriodicDrain(25)` (Apollo) al final de cada worker; pool con `MAX_CONC=4` + `MIN_GAP_MS=130` (~7 req/s) + retry `[0,800,2500]` solo en transitorios.

## Estado de validación (2026-07-08)

- ✅ **Core**: 14/14 golden + payload real (mayo) + **datos reales de hoy** vía fetch en vivo → `44068-205-01` → `E27550 (Plata): Espesor 1.27–3.5 µm` (excluye BOOLEAN/DROPDOWN/archivados). PN sin specs (`SWB-00496986`) → celda vacía correcta.
- ✅ **Hash `GetPartNumber`**: el de config (`8e3fdb52…`) **ROTÓ** (HTTP 400 "Must provide a query string"). Capturado el nuevo del front: **`5efd689d…`** (HTTP 200 verificado). Actualizado en `config.json`.
- ✅ **DOM en vivo**: `findHeaderAnchor` encuentra el ancla; columna inyectada (th + 50 td con pnId); **sobrevive el render de React**.
- ✅ **Deploy**: config 1.7.85 en vivo; `pn-specs-column-core.js` + `pn-specs-column.js` servidos **byte-exact** (sha256 verificado vs `main:remote/`); hash `GetPartNumber` nuevo y app presentes en el config servido.
- ⏳ **Pendiente (run real integrado)**: el intento de correr el applet completo desde una tab automatizada se topó con el **throttling de Chrome en tabs sin foco** (los `fetch` a `/graphql` y a gh-pages se congelan en background) — NO es un problema del applet; las piezas (fetch `GetPartNumber` 200 + extract + DOM) se validaron por separado. **Validación final la hace el usuario en foreground**: recargar la extensión (`chrome://extensions` → reload) → `/PartNumbers` → activar el toggle **🧪 Specs num.** en el header → confirmar chips (ej. `E27550 (Plata): Espesor 1.27–3.5 µm`), paginación (observer re-inyecta) y el contador `done/total`.

## Fixes 0.1.1 (primer run real del usuario, 2026-07-08)

Dos bugs reportados con screenshots (PNs `48186-064-50*` de SCHNEIDER ELECTRIC):

**Bug #1 — la columna se desalineaba al filtrar/paginar.** El `<th>` se insertaba con `insertBefore(lastElementChild)` (posición *relativa*) una sola vez; al re-render de React el `<th>` viejo sobrevivía y React lo reposicionaba ("flotaba") mientras los `<td>` se recreaban en la penúltima → header y chips en columnas distintas. **Fix:** la columna es SIEMPRE la **última** celda (`appendChild`), **re-posicionada en cada sync** (`if (lastElementChild !== cell) appendChild`). Invariante: `<th>` y `<td>` siempre en la misma posición (última), sin importar cómo React reordene. Validado en vivo sobre la tabla MUI real (simulando re-render + flotar → `aligned:true`, índice 15/15).

**Bug #2 — una spec ARCHIVADA (RC Ag) reaparecía; inconsistente con ASTM B700.** `extractSpecsWithNumericParams` (paso 2) creaba el bucket de la spec "al vuelo" desde un param activo. Al archivar una *spec* de un PN, Steelhead NO archiva cada `partNumberSpecFieldParam` → quedan params huérfanos activos apuntando a specs archivadas. RC Ag reaparecía (tenía un Espesor activo) pero ASTM B700 no (sin param activo) → la inconsistencia. **Fix:** `partNumberSpecsByPartNumberId` es la única fuente de verdad de specs activas; un param cuya spec no está en el mapa activo se **ignora** (no se inventan buckets). Golden test `NO resucita una spec ARCHIVADA…`.

## Pendientes / Fase 2

- **Deploy** (`tools/deploy.sh` con `--check pn-specs-column`). El toggle default OFF hace el deploy seguro (nadie ve queries extra sin activar).
- Run real integrado (validar observer en paginación + guardrail de memoria con captura del mem monitor).
- El hash de `GetPartNumber` rotó → probablemente afecta **otros applets** (bulk-upload, spec-migrator, auditor…). Conviene correr el skill `steelhead-hash-validator` / hash-scanner y registrar en `docs/api/hash-validation-log.md`.
- Fase 2 posible: tooltip on-hover con TODOS los params (incl. booleanos) además de la columna numérica; recordar la última posición de scroll; incluir specs desde `partNumberSpecsByPartNumberId` aunque no tengan numéricos (ya se muestran con "sin params num.").
