# Hallazgos de mantenimiento del config (destapados por el discovery de Fase B)

El discovery de Fase B (cruzar los scans reales del frontend vs `remote/config.json`) reveló que el config tiene **nombres viejos, deprecaciones y rotaciones**. Esto es mantenimiento aparte de Fase B, pero importante — y en parte **limita al autopilot**.

## 1. Renames de nombre (mismo hash, config usa el nombre viejo)

El frontend/applets envían la op con un `operationName` distinto al que el config guarda, pero **el hash es el mismo** (la query no cambió). No hay problema funcional HOY, pero el config está desactualizado.

| Config (nombre viejo) | operationName real | ¿mismo hash? |
|---|---|---|
| `PNGroupSelect` | `PartNumberGroupSelect` | ✅ |
| `CustomerFinancialById` | `CustomerFinancialByCustomerId` | ✅ |
| `SaveManyPNP_Quote` | `SaveManyPartNumberPrices` | ✅ |
| `SaveManyPNP_PN` | `SaveManyPartNumberPrices` | ✅ |
| `SetPNPricesDefault` | `SetPartNumberPricesAsDefaultPrice` | ✅ |

**Acción:** renombrar en `config.json` y en los applets que los usan como `configKey` (bulk-upload, catalog-fetcher). Bajo riesgo (mismo hash).

## 2. Deprecadas (la query vieja ya no existe; hash distinto)

| Config (deprecada) | Reemplazo en el frontend hoy |
|---|---|
| `GetQuote_v71`, `GetQuote_v8` (mismo hash `353b…`) | `GetQuote` (`28ea…`) + `GetQuoteSecondary` (`546a…`) |
| `ProcessNode` (`72a7…`) | `GetProcessNode` + `GetProcessNodeParents` (ya en config) |

**Acción:** quitar las deprecadas del config; **migrar el código** de los applets que las llaman (p. ej. `bulk-upload` usa `GetQuote_v71/v8` → migrar a `GetQuote`/`GetQuoteSecondary`). Esto es un **fix de código**, no solo de hash — el autopilot NO lo cubre.

## 3. Rotaciones confirmadas (hash cambió, misma query)

_(Pendiente: completar con el resultado del validador `validate-hashes.py` contra el server. El análisis offline de scans dio falsos positivos por scans de releases previos; la lista real la confirma el validador.)_

Candidata fuerte del discovery (hash nuevo capturado con HTTP 200):
- `SpecFieldsAndOptions`: `d6faffae…` → `fc6242c2…` (la usa `catalog-fetcher`/RefrescarListas para cada spec; con el hash viejo, RefrescarListas de specs falla).

## 4. ⚠️ Punto ciego del autopilot (limitación de diseño)

Las **queries renombradas** (§1) exponen un límite: si una de ellas **rota** algún día, el validador la marca stale por el **nombre viejo** del config (ej. `PNGroupSelect`), pero el autopilot headless **no podrá capturar el hash nuevo** porque el frontend ya no dispara ese nombre — lo dispara como `PartNumberGroupSelect`. → **escala en vez de autocorregir.**

**Mitigaciones posibles (para una mejora futura del autopilot):**
- Que el config use los `operationName` **reales** (los que el frontend envía).
- Que el planner/opsToCapture **traduzca** nombre-config → nombre-real (tabla de alias).
- Medir cobertura y matchear rutas **por hash**, no por nombre.

## 5. Queries que se disparan sin pantalla (programáticas)

Varias ops se capturan **sin pathname** porque las dispara un applet, no una pantalla nativa (ej. `SpecFieldsAndOptions` en RefrescarListas, `CustomerFinancialByCustomerId` en bulk-upload). El autopilot headless **no tiene ruta** para estas (no hay navegación que las dispare) → si rotan, **escalan**; su hash nuevo hay que capturarlo corriendo el applet (RefrescarListas / una carga) con el scanner, como se hizo en el discovery.
