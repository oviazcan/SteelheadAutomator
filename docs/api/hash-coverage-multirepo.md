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

### Las 18 rotadas, clasificadas por CRITICIDAD (investigación headless 2026-07-21)

Se verificó con Playwright headless (interceptor pre-carga del autopilot + tokens
ROCP) qué dispara cada op y si el hash rotó de verdad. Resultado:

**A. Queries USADAS — arregladas (2)** ✅ (commit RSH `9a8f3d1`):
- `GetPerspectiveDashboards` `62f4eb7c…`→`f09b4f99…`
- `GetPerspectiveDashboardFolders` `f193f682…`→`5fcab1f8…`

**B. Queries INOFENSIVAS — NO usadas en ningún script (4), solo definidas en
`steelhead_client.py`. Su rotación no rompe nada; baja prioridad (limpiar o
ignorar):**
- `GetInsightsReportDetails`, `GetInsightsReportColumnConfigs` — los "INSIGHTS"
  de la UI de Reporting son **Sonar chats** (`GetSonarChatChannels`), NO Insights
  Reports de datos → no hay objeto que dispare estas ops en el dominio.
- `ReportVariables` — se dispara al abrir el panel Variables del editor (interacción).
- `ArchivePerspectiveDashboardFolder` — solo definida.

**C. Mutations USADAS — rompen las herramientas (12). ESTA es la prioridad real.**
Requieren **captura-y-aborta** con sentinelas (patrón `sentinels-config.json`):

| Op | usada por | sentinela |
|---|---|---|
| CreatePerspectiveDashboard | push_dashboard.py | dashboard "Sentinela" (crear-y-abortar) |
| UpdatePerspectiveDashboard | push_dashboard.py | dashboard "Sentinela" |
| ArchivePerspectiveDashboard | push_dashboard.py | dashboard "Sentinela" |
| CreatePerspectiveDashboardComponent | push_dashboard.py | dashboard "Sentinela" |
| UpdatePerspectiveDashboardComponent | push_dashboard.py | dashboard "Sentinela" |
| CreatePerspectiveDashboardFolder | push_dashboard.py | folder "Sentinela" (crear-y-abortar) |
| CreateReportComponent | push_dashboard.py | reporte "Sentinela" (id **4007**) |
| UpdateReportComponent | push_dashboard.py | reporte "Sentinela" |
| CreateReportVariable | push_variable.py | reporte "Sentinela" |
| UpdateReportVariable | push_variable.py | reporte "Sentinela" |
| DeleteReportVariable | push_variable.py | reporte "Sentinela" |
| UpdateReportDateRange | set_date_range.py | reporte "Sentinela" |

**NOTA sobre `GetPerspectiveDashboardComponents`:** NO rotó (front `6e6446f0…` ==
RSH) — lo incluí por error en la investigación; se descarta.

### Recursos descubiertos (útiles para la captura de mutations)
- Infra headless VERIFICADA: Playwright + `installInterceptor` (soporta
  captura-y-aborta) + tokens ROCP de `.cache/tokens.json` autentican y capturan.
- Objetos reales en el dominio TLC/344: reporte **"Sentinela" id 4007**,
  dashboards (ids 157/159/160…), folders (ids 108/109/110…). Falta un **dashboard
  Sentinela** y un **folder Sentinela** (o capturar los Create con crear-y-abortar).
- **Límite headless:** el contenido de `/Reporting/*` renderiza (networkidle+8s)
  pero los formularios de edición (agregar componente, editar variable) son
  difíciles de accionar a ciegas headless → cada mutation necesita afinar su
  flujo, o capturarse con el hash-scanner en el navegador real.

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
