# hash-autopilot

Job desatendido que **valida y regenera** los hashes session-sensitive de Steelhead
— las ops que `validate-hashes.py` no puede validar desde Python porque dan
falso-stale al cliente externo (idp-token). Ver diseño:
`docs/superpowers/specs/2026-07-03-hash-autopilot-design.md`.

## Cómo funciona

1. Abre Chromium **headless** ya logueado (ver Auth) y corre las recetas de
   `click-recipes.json` — la navegación mínima que hace al frontend disparar cada op.
2. Intercepta `/graphql`, captura el `sha256Hash` que usa el frontend **y su
   respuesta**.
3. Compara vs `remote/config.json` y clasifica cada op: `vigente` /
   `rotadoValidado` (difiere + el frontend obtuvo `data` sin errors) / `sospechoso` /
   `noCapturado`.
4. Auto-deploya los `rotadoValidado` (con salvaguardas) y notifica por correo.
   Si una receta no captura, deja señal para el cron de Claude (ver `ESCALATION.md`).

## Fase C: mutations vía ciclos sentinela (2026-07-08 ✅)

Las MUTATIONS rotadas no se capturan navegando (no hay "receta" pasiva): hay que
EJECUTARLAS. El motor corre ciclos **sentinela** headless sobre objetos de prueba
(nombre "Sentinela", `sentinels-config.json`) — fail-closed (verifica identidad antes
de mutar), reversible (restaura/limpia SIEMPRE en `finally`), con journal idempotente.
Deps DOM en `mutation-deps.mjs`, orquestador en `mutation-runner.mjs`. Tras el loop de
queries, corre un ciclo por mutation stale con sentinela declarado; las capturadas entran
al mismo pipeline de deploy + al MISMO correo.

Mutations cubiertas por ciclo sentinela (validadas end-to-end):

| Mutation | Sentinela | Acción que la dispara (¡el sink es el juez!) |
|---|---|---|
| `UpdatePartNumber` | PN #3770957 | toggle del checkbox **"Archived"** del PN (NO el Save del modal → ese es `SavePartNumber`) |
| `UpdateQuote` | quote #288 | editar **External Notes** de la cotización (NO archivar → eso es `ArchiveUnArchiveQuote`, ni está en config) |
| `CreateReceivedOrder` | OV nueva | **crear** una OV "Sentinela" (modal Nueva OV) + archivarla después (create-capture-cleanup) |
| `CreateMaintenanceEvent` | nodo #55 | **New Maintenance Event → Node → combobox "Sentinela" → Save & Begin** |
| `CreateMaintenanceEventComment` | nodo #55 | escribir en **"Write a comment…" → Submit** (dentro del evento) |
| `UpdateMaintenanceEvent` | nodo #55 | toggle del checkbox **"Archived" del EVENTO** (NO completar el evento; el toggle además limpia) |

Los 3 de mantenimiento se capturan en **un solo flujo** (crear evento → comentar → archivar) sobre el nodo sentinela ACTIVO; el sink es compartido, así que si las 3 están stale, el 1er ciclo captura las 3 y los siguientes hacen no-op. El nodo #55 **debe quedar activo (no archivado)** para que el combobox lo encuentre — el deep-link a un nodo archivado NO hidrata.

**Dominio:** `344` es **TLC (Toluca)**, NO MTY — MTY es otro dominio sin datos aún. Todos los sentinelas viven en 344/TLC.

Lecciones (todas costaron corridas):
- **El sink es el juez**: la acción "obvia" casi siempre dispara OTRA mutation. `SA_DBG=1` imprime el sink tras cada ciclo → así se descubre la acción real.
- **Idioma**: el headless corre en INGLÉS aunque el usuario vea español → selectores estructurales (ids RJSF `root_*`, `data-testid` de iconos) o bilingües (`/Guardar|Save/`).
- **Deep-links no hidratan**: `/Quotes/<id>` y dashboards con `searchQuery` en la URL salen vacíos o en "Loading…" → navegación client-side (clic desde el dashboard) o reintento esperando que "Loading…" desaparezca.
- **React controlled inputs**: `fill` normal falla; usar el editor real (Markdown textarea) o `getByRole` falla con botones que tienen `startIcon` (usar `has-text`/estructural).
- Flags: `--only=<Mutation>` aísla un ciclo; `SA_DBG=1` verbose + screenshots; `--no-deploy` corre los ciclos sin tocar config (el correo se suprime en modo prueba).

## Uso

- Dry-run (clasifica, NO deploya ni notifica): `npm run dry-run`
- Real (auto-deploya + notifica): `npm start`  (o `node hash-autopilot.mjs`)
- Flags: `--dry-run`, `--domain=344`, `--domain-nano=1NFxmF`, `--only=<Op>`, `--date=YYYY-MM-DD`
- Resultado de la corrida: `tools/.hash-autopilot/<fecha>.json`

## Auth (clave)

El frontend usa `react-oauth2-code-pkce` → guarda los tokens OAuth en
`localStorage` con prefijo `ROCP_`. El motor **inyecta** los tokens del cache de
`steelhead_auth` (`Reportes SH/.cache/tokens.json`, mantenidos frescos vía refresh)
en `localStorage` antes de cargar la app → arranca logueada sin el flujo OAuth
interactivo. Como usa el Apollo real del frontend, cubre también las ops
session-bound (CurrentUser, sensores) que el idp-token no resuelve. Nunca se
loguea el valor de los tokens. Si el cache venció (0 capturas), avisa "corre
steelhead_auth.py".

## Archivos

| Archivo | Rol |
|---|---|
| `hash-autopilot.mjs` | motor: auth + correr recetas + clasificar + deploy + notify |
| `recipe-runner.mjs` | interceptor de /graphql + ejecutor de recetas |
| `hash-autopilot-core.mjs` | núcleo PURO (classifyOp, hasShape, planDeploy, missingCoverage) — testeado en `tools/test/hash-autopilot-core.test.js` |
| `config-io.mjs` | leer/escribir hashes en `remote/config.json` |
| `click-recipes.json` | mapa op → pantalla (secuencia mínima de navegación) |
| `autopilot-deploy.sh` | auto-deploy con candado (main + stash defensivo + trap) → `deploy.sh` |
| `autopilot-notify.sh` | correo vía Mail.app (éxito/fallo/revisión) |
| `ESCALATION.md` | prompt del cron condicional de Claude para re-descubrir recetas rotas |

## Agendado (launchd)

`tools/run-hash-autopilot.sh` + el plist
`tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist` (cada hora a :23). El
wrapper corre en **dos capas**: (1) refresca el ROCP + recaptura las **enmascaradas**
(`--masked-only`) **SIEMPRE**, sin gate; (2) el **escaneo completo** (validate-hashes.py
+ motor completo) solo si hay **release nuevo** (gate por code-id). Nota: el validador
NO tiene plist propio — corre embebido en la capa 2 de este wrapper (el plist
`com.ecoplating.steelhead-hash-validator.plist` de `tools/launchd/` está huérfano).

**Activar (una vez, con el repo en `main`):**
```bash
cp tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-autopilot.plist
launchctl list | grep hash-autopilot
```
El auto-deploy exige que el worktree esté en `main` y sin WIP ajeno en `remote/`
(salvaguarda de `autopilot-deploy.sh`); si no, avisa por correo en vez de deployar.

## Refresh-siempre de enmascaradas (2026-07-15)

Las ops "enmascaradas" (session-sensitive) rotan **sin dejar señal para el validador
Python** (el idp-token da falso-stale intermitente) → antes solo se detectaban cuando
truenan (p.ej. `AllCustomers` el 2026-07-03: carga masiva con 0 clientes, validador
reportó "0 rotado"). Ahora se **recapturan SIEMPRE**, desacopladas del gate por release:

- **Fuente ÚNICA de verdad:** `masked-ops.json` (5 queries + 1 mutation de precios).
  El validador Python (`validate-hashes.py`) skipea EXACTAMENTE esta lista; el motor
  la recaptura → sin huecos. Elimina el desajuste histórico entre la vieja
  `hash-validator-whitelist.json` y el array `SESSION_SENSITIVE` hardcodeado, y purgó
  la op muerta `GetPurchaseOrder`.
- **Modo `--masked-only`:** recaptura solo las enmascaradas, sin depender del validador
  ni de stale. Lo corre `run-hash-autopilot.sh` en CADA tick, ANTES del gate por
  release (el escaneo completo sigue tras el gate). Validado en vivo 2026-07-15:
  capturó las 5 queries, probe 5 vigentes / 0 stale.
- **Mutation de precios** (`SaveManyPartNumberPrices`): por ciclo **sentinela**
  (`partNumberPrice` en `sentinels-config.json`, hoy **id:0 = andamiaje inactivo**).
  Para activar: crear un PN "Sentinela" con precio, poner su id, y completar el handler
  DOM `partNumberPrice` en `mutation-deps.mjs` (hoy `mutate`/`restore` fail-closed).

## Estado / pendientes

- Enmascaradas recapturadas siempre (masked-ops.json): `AllCustomers`, `Customer`,
  `CurrentUser`, `AllSensorDashboards`, `SensorDashboardQuery` + mutation
  `SaveManyPartNumberPrices` (sentinela andamiado, pendiente PN Sentinela).
- Mutations con ciclo sentinela funcionando: `UpdatePartNumber`, `UpdateQuote`,
  `CreateReceivedOrder`, `CreateMaintenanceEvent`, `CreateMaintenanceEventComment`,
  `UpdateMaintenanceEvent`, `UpdateReceivedOrder` (7/7 — validadas headless).
- **🎯 OBJETIVO NORTE: CERO captura manual — todo debe auto-recuperarse headless sin
  intervención humana.** Hoy 3 queries se quedan `noCapturado` porque el `page.goto`
  directo NO hidrata el detalle y las listas no rinden filas en headless:
  `GetPurchaseOrderDetail` (`/Purchasing/PurchaseOrders/<id>`), `SensorDashboardQuery`
  (`/Maintenance/SensorDashboards/<id>`), `GetReceivedOrdersWithReceivedOrderLineItems`
  (Invoices→PackingSlips→"Crear Factura"). **STOPGAP temporal** (NO la meta): capturarlas
  con el hash-scanner en el navegador y deployar. **PENDIENTE real**: que el motor las
  capture solo. Diagnóstico: las queries de detalle solo disparan por **navegación
  client-side** (clic en `<Link>` de React Router dentro del SPA ya cargado) — `page.goto`
  re-inicializa el SPA y no fetchea. Camino candidato: extender `recipe-runner` para
  navegación client-side multi-paso (home hidratado → clic real en la fila/link) +
  resolver la flakiness de hidratación headless. Es infra real, no un ajuste de receta.
- Utilitario: `cleanup-sentinela-ovs.mjs` archiva OV "Sentinela" activas rezagadas.
- Pendiente: prueba de humo del correo real; cargar el launchd tras mergear a `main`.
