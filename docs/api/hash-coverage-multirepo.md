# Cobertura multi-repo del validador de hashes (2026-07-21)

## Qué cambió

`tools/validate-hashes.py` ahora valida los persisted-query hashes de **las 3
fuentes** que consumen la API de Steelhead con hashes propios, no solo la
extensión:

| Fuente | Origen del hash | # ops |
|---|---|---|
| `extension` | `remote/config.json` | 180 |
| `reportes-sh` | `Reportes SH/scripts/steelhead_client.py` (`PERSISTED_QUERIES`) | 40 |
| `powertools` | `SteelheadPowerTools/sync/lowcode_sync.py` + `maintenance_plans_sync.py` | 22 |

Dedup por `(op, hash)` → **232 items únicos** (52 externas nuevas). Cada `stale`
reporta su `[source]`. Las fuentes externas son **opcionales** (degradan a `{}`
si el repo no existe en la máquina).

Módulo puro `tools/hash_sources.py` (`extract_py_hashes` / `infer_kind` /
`build_validation_items`) con auto-test: `python3 tools/hash_sources.py`.

10 ops están **compartidas** (mismo hash en extensión + Reportes SH, dedupeadas):
`AllPartNumbers, AllReports, ArchiveReport, CreateUpdateReportWithPermissions,
DeleteFolderById, GenerateDuckDb, GetRecomputableAt, GetStation, JobQuery,
UpdateStationInputs`.

## Hallazgo: 18 hashes ROTADOS en Reportes SH

La 1ª corrida del validador extendido detectó **18 stale, todos de
`reportes-sh`**. Confirmado que son **rotaciones REALES** (no falsos positivos
session-sensitive) por **ground-truth del frontend** (Apollo del navegador):

| Op | front (vivo) | Reportes SH (muerto) | ¿? |
|---|---|---|---|
| `GetPerspectiveDashboards` | `f09b4f99…` | `62f4eb7c…` | **rotó** |
| `GetPerspectiveDashboardFolders` | `5fcab1f8…` | `f193f682…` | **rotó** |
| `AllReports` | `1f83add2…` | `1f83add2…` | vigente (no stale) |

El método `client.call()` de Reportes SH es idéntico al probe (mismo payload,
mismos headers idp-token + cookies + apollo). Por lo tanto **`push_dashboard.py`,
`push_variable.py` y las herramientas de insights de Reportes SH están rotas
hoy** — fallarían con `PersistedQueryNotFound`. (Precedente: `GenerateDuckDb`
también estaba muerto en RSH; arreglado el mismo día, ver abajo.)

### Las 18 ops rotadas (hash viejo en Reportes SH)

| Op | hash viejo (RSH) | hash nuevo (front) |
|---|---|---|
| GetPerspectiveDashboards | `62f4eb7c…` | ✅ `f09b4f996236b6c497c56a65342237019a16bd6fa99d11f402398c42002b2f60` |
| GetPerspectiveDashboardFolders | `f193f682…` | ✅ `5fcab1f8574d6d428e01de042e18b0d3a0614733fa3b25ee6db38e377ebb5ae3` |
| GetPerspectiveDashboardComponents (*) | `6e6446f0…` | (pendiente — abrir un dashboard) |
| CreatePerspectiveDashboard | `7f0319ba…` | (pendiente — captura-y-aborta) |
| UpdatePerspectiveDashboard | `078db8ff…` | (pendiente — captura-y-aborta) |
| ArchivePerspectiveDashboard | `3cb3c5d5…` | (pendiente — captura-y-aborta) |
| CreatePerspectiveDashboardComponent | `eeaa1411…` | (pendiente — captura-y-aborta) |
| UpdatePerspectiveDashboardComponent | `cf3fe668…` | (pendiente — captura-y-aborta) |
| CreatePerspectiveDashboardFolder | `2563e9e2…` | (pendiente — captura-y-aborta) |
| ArchivePerspectiveDashboardFolder | `b2e04213…` | (pendiente — captura-y-aborta) |
| CreateReportComponent | `c8a2d186…` | (pendiente — captura-y-aborta) |
| UpdateReportComponent | `a1949041…` | (pendiente — captura-y-aborta) |
| GetInsightsReportDetails | `b87afdbf…` | (pendiente — abrir un insights report) |
| GetInsightsReportColumnConfigs | `7534a244…` | (pendiente — columnas de insights) |
| ReportVariables | `5ce0347c…` | (pendiente — editar variables de un reporte) |
| CreateReportVariable | `89efe99e…` | (pendiente — captura-y-aborta) |
| UpdateReportVariable | `68d55099…` | (pendiente — captura-y-aborta) |
| DeleteReportVariable | `7d70dc83…` | (pendiente — captura-y-aborta) |

(*) `GetPerspectiveDashboardComponents` NO salió en las 18 (validó ok con su hash
actual) — se lista aquí solo por familia; verificar.

### Estado de captura (2026-07-21)

**Arreglados (3):** `GetPerspectiveDashboards`, `GetPerspectiveDashboardFolders`
(commit RSH `9a8f3d1`) + `GenerateDuckDb` (commit `3c69434`). Los 2 dashboards se
capturaron de la carga de `/Reporting/View` y se verificaron vivos contra el
server.

**Bloqueo de la captura manual para los 16 restantes** (por qué NO se pudo vía
Claude-in-Chrome automatizado):
1. **Screenshots/read_page fallan en `/Reporting/*`**: la página nunca alcanza
   `document_idle` (polling de reportes) → `executeScript` timeout. Solo
   `javascript_tool` responde.
2. **Apollo cachea las queries de carga**: `GetPerspectiveDashboardComponents`,
   `GetInsights*` y `ReportVariables` se disparan al CARGAR la vista. El hook de
   `fetch` se instala POST-carga (no hay forma de inyectarlo pre-carga con la
   extensión) → clics client-side no re-disparan (cache) y no se capturan.
3. **Las 12 mutations** requieren disparar una escritura real (captura-y-aborta).

**Vías robustas para los 16 (elegir una):**
- **(recomendada) hash-scanner** — el operador abre Steelhead con la extensión,
  corre el applet "Hash Scanner", navega Reporting/Insights + **crea/edita un
  dashboard y una variable de prueba** (dispara queries + mutations); el scanner
  intercepta pre-carga y captura TODO. Descargar `scan_results_*.json` y
  extraer los 16 por `operationName`.
- **hash-autopilot headless** — agregar recetas para las 16 (Playwright instala
  el interceptor PRE-navegación → sí captura las queries de carga; mutations vía
  sentinelas captura-y-aborta). Es el patrón de raíz reutilizable, pero requiere
  integrar Reportes SH como fuente del autopilot (hoy solo cubre la extensión).

Luego reemplazar los 16 en `Reportes SH/scripts/steelhead_client.py`.

## Ya arreglado el 2026-07-21

- **`GenerateDuckDb`**: `8f29d420…` (muerto) → `f412b9eca03309b5ea9cfa20090b4f0c75f1e30632b6a02cda119fde3418daa0`
  (vivo, ya usado por la extensión). Commit en Reportes SH: `3c69434`.
  Arregla `regenerate_duckdb.py`.

## Nota para el cron

El validador extendido ahora sale **exit 1** mientras existan las 18 rotaciones
de Reportes SH. `notify-stale-hashes.sh` las agrupará por `source`. Al arreglar
los 18 hashes en Reportes SH, la corrida vuelve a 0 stale (asumiendo la extensión
y PowerTools vigentes).
