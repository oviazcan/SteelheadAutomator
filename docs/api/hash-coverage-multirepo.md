# Cobertura multi-repo del validador + autohealing (2026-07-21 → 22)

## 1. El validador valida las 3 fuentes de hashes

`tools/validate-hashes.py` valida los persisted-query hashes de **las 3 fuentes**
que consumen la API de Steelhead con hashes propios, no solo la extensión:

| Fuente | Origen del hash | # ops |
|---|---|---|
| `extension` | `remote/config.json` | 180 |
| `reportes-sh` | `Reportes SH/scripts/steelhead_client.py` (`PERSISTED_QUERIES`) | 40 |
| `powertools` | `SteelheadPowerTools/sync/lowcode_sync.py` + `maintenance_plans_sync.py` | 22 |

Dedup por `(op, hash)` → **232 items únicos** (52 externas nuevas). Cada `stale`
reporta su `[source]`. Fuentes externas **opcionales** (degradan a `{}` si el repo
no está en la máquina). Módulo puro `tools/hash_sources.py` (`extract_py_hashes` /
`infer_kind` / `build_validation_items`), auto-test `python3 tools/hash_sources.py`.
Commit main `fe0e132`.

## 2. Autohealing SIN humanos en el loop (2026-07-22)

El hash-autopilot **captura, valida, ESCRIBE, commitea Y PUSHEA** el hash rotado
en el repo que lo usa — no solo la extensión:
- Hashes de `remote/config.json` → deploy normal (config + gh-pages, firmado).
- Hashes **externos** (`plan.external`: rotadoValidado, sin `cfgHash`) → escribe en
  `steelhead_client.py` / `sync/*.py`, `git commit` + `git push origin HEAD` en ese
  repo. Piezas: `external-sinks.json` (registro de destinos) + `external-sync.mjs`
  (`applyHashesToText` puro que reusa el regex de `writeConfigHashes`; solo reemplaza
  ops existentes; idempotente; fail-safe si el repo no está). 7 golden en
  `tools/test/external-sync.test.js`.
- Flags: `SA_NO_EXTERNAL=1` desactiva todo el sync externo; `SA_NO_EXTERNAL_PUSH=1`
  omite solo el push (deja el commit local).
- Commits main: `a5da68f` (sync) + `8ccbd28` (push automático).

**Requisito para que el ciclo sea automático de punta a punta:** que exista
receta/centinela que dispare la op headless. Las queries de dashboards/insights ya
tienen receta (`route-catalog.json`); las **12 mutations de Reporting NO tienen
centinela aún** → hoy se capturan con el hash-scanner, pero una vez capturadas el
autopilot ya las sincroniza+pushea solo. Armar esos centinelas (dashboard/folder
Centinela + reporte 4007) es el follow-up para cerrar la automatización de mutations.

## 3. Hallazgo: 18 hashes ROTADOS en Reportes SH — TODOS RESUELTOS

La 1ª corrida del validador multi-repo detectó **18 stale, todos de `reportes-sh`**.
Confirmadas rotaciones **reales** por ground-truth del frontend (Apollo). **Reportes
SH quedó 100%: las 18 aplicadas, verificadas vivas y pusheadas.**

### Queries (6) — todas vivas
| Op | viejo → nuevo | commit RSH |
|---|---|---|
| GetPerspectiveDashboards | `62f4eb7c`→`f09b4f99` | `9a8f3d1` |
| GetPerspectiveDashboardFolders | `f193f682`→`5fcab1f8` | `9a8f3d1` |
| GetInsightsReportDetails | `b87afdbf`→`e0602e22` | `2dd9e04` |
| GetInsightsReportColumnConfigs | `7534a244`→`2f60d49b` | `2dd9e04` |
| ReportVariables | (ya estaba vivo `a4c8af2b`) | — |
| ArchivePerspectiveDashboardFolder | `b2e04213`→`50bfa783` | `58e2129` |

### Mutations (12) — todas vivas (probe final 12/12)
| Op | viejo → nuevo | commit RSH | usada por |
|---|---|---|---|
| CreatePerspectiveDashboard | `7f0319ba`→`0b94c382` | `58e2129` | push_dashboard.py |
| UpdatePerspectiveDashboard | `078db8ff`→`fa5cfa5b` | `58e2129` | push_dashboard.py |
| ArchivePerspectiveDashboard | `3cb3c5d5`→`ab770ff6` | `58e2129` | push_dashboard.py |
| CreatePerspectiveDashboardComponent | `eeaa1411`→`01a37bb0` | `58e2129` | push_dashboard.py |
| UpdatePerspectiveDashboardComponent | `cf3fe668`→`60e413a5` | `aa63b90` | push_dashboard.py |
| CreatePerspectiveDashboardFolder | `2563e9e2`→`4134f4c8` | `58e2129` | push_dashboard.py |
| CreateReportComponent | `c8a2d186`→`9c7fbbd6` | `19ed6f8` | push_dashboard.py |
| UpdateReportComponent | (ya vivo `38ae60eb`) | — | push_dashboard.py |
| CreateReportVariable | (ya vivo `076b80d5`) | — | push_variable.py |
| UpdateReportVariable | (ya vivo `800c2a98`) | — | push_variable.py |
| DeleteReportVariable | `7d70dc83`→`914379fe` | `aa63b90` | push_variable.py |
| UpdateReportDateRange | `e296b1d2`→`0ded430d` | `58e2129` | set_date_range.py |

También `GenerateDuckDb` `8f29d420`→`f412b9ec` (commit `3c69434`, arregla
`regenerate_duckdb.py`). Los hashes nuevos salieron del **hash-scanner** (scans
2026-07-22 12:13/12:15/14:14/17:37) + captura headless de las 2 queries de
dashboards; cada uno se verificó VIVO con probe idp-token antes de aplicar.

## 4. Correcciones de diagnóstico (dos errores míos, corregidos)

- **`GetPerspectiveDashboardComponents` NO rotó** (front `6e6446f0` == RSH). Lo
  incluí por error; se descarta. → los rotados reales fueron 18, no 19.
- **`CreateReportComponent` NO estaba deprecada.** Primero concluí "consolidada en
  UpdateReportComponent" porque no salía en los scans y la ⭐ solo dispara Update.
  **Falso:** `CreateReportComponent` se dispara con el botón **"+ ADD COMPONENT"**
  de la vista Perspective de un reporte (agrega otro panel/vista del mismo reporte;
  cada panel puede ir a un dashboard combinado). Firma `{reportId}` **intacta** →
  `push_dashboard.py` (`ensure_report_component`) **NO necesita cambios de código**,
  solo el hash nuevo. Lección: no concluir "deprecada" por ausencia en el scan sin
  probar el flujo correcto.
- **Insights NO son Sonar chats.** Los INSIGHTS del sidebar de `/Reporting/View`
  son reportes prefabricados de Steelhead (6 categorías). Abrir uno →
  `/Reporting/View?id=<ID>&type=insight` dispara ambas ops. Receta
  `reporting-insights-detail` en `route-catalog.json` (Nivel B).

## 5. Infra headless verificada (para automatizar mutations a futuro)

- Playwright + `installInterceptor` (soporta captura-y-aborta) + tokens ROCP de
  `.cache/tokens.json` autentican y capturan headless. El interceptor es
  **pre-navegación** → captura queries de carga (lo que el hook post-carga de la
  extensión no puede).
- Objetos reales dominio TLC/344: reporte **"Centinela" id 4007**, dashboards
  (157/159/160…), folders (108/109/110…). Para las mutations faltaría un **dashboard
  Centinela** y un **folder Centinela** (o capturar los Create con crear-y-abortar).
- Límite: los formularios de edición de `/Reporting/*` son difíciles de accionar a
  ciegas headless → por eso hoy las mutations se capturan con el hash-scanner en el
  navegador real.

## 6. Estado del cron

Con las 18 aplicadas, el validador vuelve a **0 stale** (asumiendo extensión y
PowerTools vigentes). Cuando algo rote de nuevo en cualquiera de los 3 repos, el
autopilot lo sincroniza+pushea solo (§2).
