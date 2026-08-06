# hash-autopilot

Job desatendido que **valida y regenera** los hashes session-sensitive de Steelhead
— las ops que `validate-hashes.py` no puede validar desde Python porque dan
falso-stale al cliente externo (idp-token). Ver diseño:
`docs/superpowers/specs/2026-07-03-hash-autopilot-design.md`.

> **Nota de nomenclatura (2026-07-23).** El marcador de los objetos de prueba en el ERP se llama
> **«Centinela»** (español correcto; antes estaba mal escrito como «Sentinela»). El código acepta
> **solo** `/centinela/i` (`isSentinel` en `sentinels.mjs`) y los objetos del ERP se renombraron a
> «Centinela» (verificado en vivo: el ciclo encontró la cotización «Centinela» #288). Los
> identificadores en **inglés** (`isSentinel`, `formatSentinelAlert`, `SENTINEL_MARKER`) se quedan en
> inglés por convención. **`cleanup-sentinela-ovs.mjs` conserva su nombre de archivo heredado a
> propósito** (renombrarlo arriesga romper su invocación) — su contenido y el objeto que toca sí son «Centinela».

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

## Fase C: mutations vía ciclos centinela (2026-07-08 ✅)

Las MUTATIONS rotadas no se capturan navegando (no hay "receta" pasiva): hay que
EJECUTARLAS. El motor corre ciclos **centinela** headless sobre objetos de prueba
(nombre "Centinela", `sentinels-config.json`) — fail-closed (verifica identidad antes
de mutar), reversible (restaura/limpia SIEMPRE en `finally`), con journal idempotente.
Deps DOM en `mutation-deps.mjs`, orquestador en `mutation-runner.mjs`. Tras el loop de
queries, corre un ciclo por mutation stale con centinela declarado; las capturadas entran
al mismo pipeline de deploy + al MISMO correo.

Mutations cubiertas por ciclo centinela (validadas end-to-end):

| Mutation | Centinela | Acción que la dispara (¡el sink es el juez!) |
|---|---|---|
| `UpdatePartNumber` | PN #3770957 | toggle del checkbox **"Archived"** del PN (NO el Save del modal → ese es `SavePartNumber`) |
| `UpdateQuote` | quote #288 | editar **External Notes** de la cotización (NO archivar → eso es `ArchiveUnArchiveQuote`, ni está en config) |
| `CreateReceivedOrder` | OV nueva | **crear** una OV "Centinela" (modal Nueva OV) + archivarla después (create-capture-cleanup) |
| `CreateMaintenanceEvent` | nodo #55 | **New Maintenance Event → Node → combobox "Centinela" → Save & Begin** |
| `CreateMaintenanceEventComment` | nodo #55 | escribir en **"Write a comment…" → Submit** (dentro del evento) |
| `UpdateMaintenanceEvent` | nodo #55 | toggle del checkbox **"Archived" del EVENTO** (NO completar el evento; el toggle además limpia) |
| `AddPartsToWorkOrders` | OV #1603 → OT #13678 | **CAPTURA-Y-ABORTA** (escritura): modal **"Ajustar Cantidad de Piezas de OT"** (icono IsoIcon) → cambiar el *Conteo Deseado* → **Guardar**. El Save dispara **SOLO** `AddPartsToWorkOrders`; `MovePartsToRecipeNodeId`/`SearchLocationsOnPath` son queries de **preview** del modal (no del Save, no escriben). Cero persistencia (OT sigue 1/1). |

Los 3 de mantenimiento se capturan en **un solo flujo** (crear evento → comentar → archivar) sobre el nodo centinela ACTIVO; el sink es compartido, así que si las 3 están stale, el 1er ciclo captura las 3 y los siguientes hacen no-op. El nodo #55 **debe quedar activo (no archivado)** para que el combobox lo encuentre — el deep-link a un nodo archivado NO hidrata.

**Dominio:** `344` es **TLC (Toluca)**, NO MTY — MTY es otro dominio sin datos aún. Todos los centinelas viven en 344/TLC.

Lecciones (todas costaron corridas):
- **El sink es el juez**: la acción "obvia" casi siempre dispara OTRA mutation. `SA_DBG=1` imprime el sink tras cada ciclo → así se descubre la acción real.
- **Idioma**: el headless corre en INGLÉS aunque el usuario vea español → selectores estructurales (ids RJSF `root_*`, `data-testid` de iconos) o bilingües (`/Guardar|Save/`).
- **Deep-links no hidratan**: `/Quotes/<id>` y dashboards con `searchQuery` en la URL salen vacíos o en "Loading…" → navegación client-side (clic desde el dashboard) o reintento esperando que "Loading…" desaparezca.
- **React controlled inputs**: `fill` normal falla; usar el editor real (Markdown textarea) o `getByRole` falla con botones que tienen `startIcon` (usar `has-text`/estructural).
- Flags: `--only=<Mutation>` aísla un ciclo; `SA_DBG=1` verbose + screenshots; `--no-deploy` corre los ciclos sin tocar config (el correo se suprime en modo prueba).

## Uso

- Dry-run (clasifica, NO deploya ni notifica): `npm run dry-run`
- Real (auto-deploya + notifica): `npm start`  (o `node hash-autopilot.mjs`)
- Flags: `--dry-run`, `--domain=344`, `--domain-nano=1NFxmF`, `--only=<Op>`, `--date=YYYY-MM-DD`,
  `--mass-brake=N` (**manual**, ver §Freno de masa)
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

**Segundo launchd — Nivel B (escalación de recetas rotas):**
`tools/launchd/com.ecoplating.steelhead-escalation.plist` corre `tools/run-escalation.sh`
**a :53** (30 min después del motor). Cuando una receta deja de capturar (`needs-attention.json`),
intenta re-descubrirla sola vía `claude -p` y manda correo con el trace detallado. Gate por
señal → cero costo en días limpios. Ver `ESCALATION.md`. Carga = paso manual del operador.

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
- **Mutation de precios** (`SaveManyPartNumberPrices`): por ciclo **centinela** sobre la
  COTIZACIÓN `quotePrice` #288 (handler `savePartsQuoteAborted`), **validado end-to-end
  headless 2026-07-17**. Steelhead **unificó** las dos variantes en un solo hash (`72946d4d…`);
  el andamiaje del modal individual (`partNumberPrice` id:0) se **retiró** (2026-07-17).

## Endurecimiento de rutas de descubrimiento — cierre (2026-07-17, 2ª pasada)

Follow-ups de la sesión que cerró `AddPartsToWorkOrders` y `SaveManyPartNumberPrices`. Estado
tras la revisión contra el CÓDIGO (varios ya estaban resueltos en el código pero no en la doc):

1. **Navegación CLIENT-SIDE al resto de queries — ✅ HECHO + VALIDADO EN VIVO 3/3 (2026-07-17).**
   `recipe-runner.mjs` ya tiene los pasos client-side (`clickFirst`/`clickButton`/`selectFirstOption`:
   clic REAL en el `<a>`/botón sin re-bootstrapear el SPA). Las 3 del "objetivo norte" ya usan
   `clickFirst`: `purchasing-po-detail`, `maintenance-sensordashboards-detail`,
   `invoices-packingslips-addinvoice`. **Validación headless (2026-07-17): las 3 CAPTURAN con
   `responseOk`, hashes == config (vigentes).** El objetivo norte ya no cae en captura manual.
2. **`evaluate().click()` → Playwright `click({force})` — ✅ HECHO (verificado).** Auditado
   `mutation-deps.mjs`: `click({force})` es la ruta PRIMARIA en `savePartsQuoteAborted` (Edit this
   Part + Save Parts) y `saveWoPartCountAborted`. El único `page.evaluate(()=>el.click())` que queda
   es un **fallback** dentro de un `.catch()` (correcto). Nada que migrar.
3. **Probe de SHAPE por op — DECISIÓN: YAGNI documentado (no se implementa).** El riesgo que lo
   motivó (dos variantes de `SaveManyPartNumberPrices`) YA lo cubren tres salvaguardas: (a) `responseOk`
   para queries; (b) `abortProbeVigente` **+ config MUERTO** para captura-y-aborta (no se auto-deploya
   el liveHash si el config sigue vivo → no pisa la variante viva); (c) freno de masa. Un probe de shape
   del *input* exigiría un catálogo frágil de inputs por-applet (se rompe cuando el applet cambia) para
   un beneficio marginal. Se reabre solo si aparece un caso que las 3 salvaguardas no cubran.
4. **Ops con MÚLTIPLES variantes — ✅ HECHO.** `SaveManyPartNumberPrices` unificó batch+individual en
   `72946d4d…`; el andamiaje redundante `partNumberPrice` id:0 (+ handler `savePriceCentinelaAborted`)
   se **retiró** de `sentinels-config.json` y `mutation-deps.mjs`. Test `masked-ops-coherence` blinda
   que no reaparezca. El hardening "auto-deploy solo si el cfg está MUERTO" sigue cubriendo variantes.
5. **Alerta de centinela declarado archivado — ✅ HECHO.** Módulo puro `sentinel-health.mjs`
   (`classifyCycleOutcomes`/`formatSentinelAlert`, 6 tests): cuando un ciclo aborta por identidad
   (centinela ARCHIVADO → read-only → `isSentinel`=false), el motor lo reporta como sección
   **🚨 CENTINELA ROTO/ARCHIVADO** en el correo (antes: abort silencioso a consola) con la acción
   de desarchivar. Cuenta como pendiente en el asunto.
6. **Nivel B — `claude -p` REAL + auth del cron — 🔶 PARCIAL (a/b hechos; c = corrida real).**
   (a) ✅ **BUG encontrado y corregido:** en el entorno del launchd `claude` NO resolvía (PATH sin
   `~/.local/bin`; `claude` es una FUNCIÓN shell del `.zshrc` que el cron no carga). `run-escalation.sh`
   ahora antepone `~/.local/bin` al PATH → el binario real resuelve. `claude -p` confirmado autenticado.
   (b) ✅ **Anti-colisión:** en vez de un worktree con estado compartido (el `needs-attention.json` es
   local/gitignored a `main`), si `worktree-lock.sh occupied` detecta una sesión interactiva en `main`
   el wrapper **pospone al próximo tick** (sin marcar idempotente → reintenta en 1h; `ESCALATION_FORCE=1`
   lo salta en pruebas). El binario directo no respeta el worktree-lock, así que este gate lo suple.
   El wrapper además **notifica** si `claude -p` sale != 0 (antes fallaba en silencio).
   (c) ✅ **Corrida real supervisada — HECHA 2026-07-17.** Se disparó con un `needs-attention.json`
   de prueba (`SensorDashboardQuery`, op vigente; correo solo a un buzón). El agente re-descubrió la
   op reusando la infra del motor, confirmó que la receta dispara (hash == config), escribió el
   **trace**, mandó **un** correo, borró el needs-attention y **respetó los guardrails** (read-only,
   sin editar recetas, sin deploy, **cero git** → no pisó la sesión interactiva de `main`). Dos
   hallazgos que solo la corrida real reveló: (1) el binario `claude` no resolvía en el entorno del
   cron (fix del PATH, arriba); (2) `claude -p` moría con `Credit balance is too low` — una
   `ANTHROPIC_API_KEY` sin saldo tomaba precedencia → el wrapper ahora la `unset`-ea para usar el
   login **claude.ai** (`SA_KEEP_API_KEY=1` lo invierte). Ambos corregidos y re-validados en vivo.

**7. Auto-limpiar `needs-attention.json` al recapturar — ✅ HECHO (hallazgo de la corrida real).**
   El motor escribe `needs-attention.json` solo cuando hay algo que escalar, así que si un tick
   recaptura ✓ una op previamente escalada, el archivo VIEJO persistía → el Nivel B gastaba una
   corrida confirmando algo ya resuelto. `pruneNeedsAttention` (puro, 4 tests) + integración: al
   final del run se podan las ops resueltas (✓ vigente o deployadas); si queda vacío se borra.

## Watchdog de latido (heartbeat externo) — resuelve el GAP-1 de autonomía

El sistema era **ciego a su propia muerte**: todas las alertas son reactivas (el motor avisa
CUANDO corre). Si el cron local dejaba de correr —Mac apagada/dormida, launchd descargado,
wrapper muerto antes de empezar— nadie se enteraba. El watchdog cubre eso y **vive FUERA de la
Mac** (en GitHub) por diseño: si viviera en el mismo launchd, moriría con lo que debe vigilar.

- **Latido:** `run-hash-autopilot.sh` (`emit_heartbeat`) empuja AL INICIO de cada corrida un
  commit huérfano con timestamp a la rama `ops/heartbeat` (plumbing `commit-tree` +
  `push --force --no-verify` → NO toca main/working-tree/índice). Best-effort. Refleja "el
  launchd disparó", independiente de si la captura luego tiene éxito (una auth caída ya la
  avisa el motor por su cuenta).
- **Vigía:** `.github/workflows/heartbeat-watchdog.yml` corre en la nube de GitHub (cron
  `17 */2 * * *`, cada 2 h). Si el latido tiene >3 h → abre/actualiza un issue con label
  `watchdog` (email al operador) y falla el job; si el latido revive → cierra el issue solo.
  `workflow_dispatch` para probar a mano.
- **Validado en vivo 2026-07-20:** los 3 caminos — fresco (success, sin issue), viejo 5 h
  (failure + crea issue), restaurado (success + cierra el issue).
- **Matiz honesto:** el cron de GitHub Actions se retrasa a veces (minutos, ocasionalmente
  >1 h); sirve para "no corrió en 2-3 h", NO para detección al minuto. El umbral de 3 h da margen.

## Estado / pendientes

- Enmascaradas recapturadas siempre (masked-ops.json): `AllCustomers`, `Customer`,
  `CurrentUser`, `AllSensorDashboards`, `SensorDashboardQuery` + mutation
  `SaveManyPartNumberPrices` (centinela `quotePrice` #288, validado end-to-end 2026-07-17).
- Mutations con ciclo centinela funcionando: `UpdatePartNumber`, `UpdateQuote`,
  `CreateReceivedOrder`, `CreateMaintenanceEvent`, `CreateMaintenanceEventComment`,
  `UpdateMaintenanceEvent`, `UpdateReceivedOrder` (7/7 — validadas headless).
- **Mutations de REPORTES por CAPTURA-Y-ABORTA — VALIDADAS 4/4 headless (2026-07-20):**
  `GenerateDuckDb` (botón "Regenerate Database" en `/Reporting/Databases`), `DeleteFolderById`,
  `CreateUpdateReportWithPermissions`, `ArchiveReport` (los 3 en `/Reporting/Edit`). Entidades
  `reportGenerateDb`/`reportFolderDelete`/`reportSaveAsNew`/`reportArchive` en sentinels-config.
  **Requisito:** una CARPETA "Centinela" + un REPORTE "Centinela" **persistentes** (activos) en
  `/Reporting/Edit` — el flujo de captura manual del operador los consume, así que deben quedar
  vivos para el ciclo. Anclaje SIN clases jss (son dinámicas): filtro "Filter queries..." +
  evaluate-mark (svg[aria-label] cuya fila innerText==="Centinela"). Gate `capture-abort` en
  `sentinels.mjs` permite correr destructivas (Delete…) y no-auto (Generate…) porque el abort da
  cero efecto. Rotaron 2026-07-20; corregidas por scan (config 1.7.149) + GenerateDuckDb 1.7.151.
- **Mutation por CAPTURA-Y-ABORTA validada headless END-TO-END: `AddPartsToWorkOrders`**
  (centinela `workOrderPartCount` = OV #1603 "Centinela" → OT #13678; handler
  `saveWoPartCountAborted` en `mutation-deps.mjs`). A diferencia de las de precios
  (`partNumberPrice`/`quotePrice`, andamiadas/bloqueadas por hidratación del quote), la OV
  **SÍ hidrata headless** → el ciclo captura de punta a punta. **AUTO-DEPLOYABLE** (2026-07-17):
  como el request se aborta no hay `responseOk`, pero el motor **prueba el liveHash capturado
  con variables vacías** (validación de tipos, **sin ejecutar la escritura**) — si el server lo
  reconoce (`classifyProbe` 'vigente') `isValidatedCapture` lo trata como OK → `rotadoValidado`
  → **auto-deploy** (mismas salvaguardas que las queries: freno de masa + `autopilot-deploy.sh`).
  Fail-safe: si el probe no confirma (stale/auth/unknown) queda 'sospechoso' → revisión humana.
  Ancla del botón idioma-independiente: `button[aria-label]:has(svg[data-testid="IsoIcon"])`.
  **Verificada en vivo**: el hash rotó `a5cc8991…`→`70d5a792…` (probe directo: el server reconoce
  `70d5a792`, `a5cc8991` da "Must provide a query string"), 1er deploy a mano (config 1.7.140) y
  el path de auto-deploy validado end-to-end (config revertido → el motor lo clasifica 🔺 ROTÓ).
- **🎯 OBJETIVO NORTE: CERO captura manual — ✅ ALCANZADO para las 3 queries de detalle
  (VALIDADO EN VIVO 2026-07-17).** Las 3 que caían en captura manual ya se auto-capturan
  headless por **navegación client-side** (clic REAL en el `<Link>`/botón dentro del SPA ya
  cargado — `page.goto` re-inicializa el SPA y no fetchea; el clic client-side sí):
  `GetPurchaseOrderDetail` (ruta `purchasing-po-detail`), `SensorDashboardQuery`
  (`maintenance-sensordashboards-detail`), `GetReceivedOrdersWithReceivedOrderLineItems`
  (`invoices-packingslips-addinvoice`). Validación headless: **3/3 capturan con `responseOk`,
  hashes == config**. El STOPGAP del hash-scanner ya NO es necesario para estas. `recipe-runner`
  soporta `clickFirst`/`clickButton`/`selectFirstOption` (navegación client-side multi-paso).
- Utilitario: `cleanup-sentinela-ovs.mjs` archiva OV "Centinela" activas rezagadas.
  Salud de centinelas: `sentinel-health.mjs` alerta si un centinela declarado quedó archivado.
- Correo real: prueba de humo ✅ hecha (2026-07-17). Launchd de escalación: ✅ cargado.
- Nivel B: ✅ **corrida real validada end-to-end 2026-07-17** (re-descubrimiento + trace + correo +
  guardrails). Wrapper corre con el login claude.ai (no la API key sin saldo). Auto-limpia el
  needs-attention al recapturar.

### Incidente + hallazgos 2026-07-20 (correo "0 corregida(s), 9 pendiente(s)")
- **Qué pasó:** rotaron 4 mutations de reportes (`ArchiveReport`, `DeleteFolderById`,
  `CreateUpdateReportWithPermissions`, `GenerateDuckDb`; las 4 dieron "Must provide a query string").
  El ciclo centinela recapturó 2 como *sospechosas* y 2 quedaron *no capturadas* → correo de las
  14:32. **Ya corregidas por scan** (config avanzó a 1.7.155) y la corrida de las **19:25 salió
  LIMPIA** (`authFailed:false`, todo "vigente", `toDeploy:[]`, `massBrake:false`). No era una alarma
  viva al momento de revisar.
- **El bounce del correo NO es del autopilot — era un DOMINIO MAL ESCRITO en el destinatario.**
  `mailer-daemon@icloud.com` rebotó SOLO a `msierra@ecoplating.com` (Status 4.3.0 "server unavailable")
  porque **ese dominio es incorrecto**: `ecoplating.com` no resuelve/no acepta correo. El correcto es
  `msierra@proecoplating.com` (mismo dominio que Ernesto). ✅ **CORREGIDO 2026-07-20** en
  `autopilot-notify.sh` (`DEST_DEFAULT`). Nota: `tools/notify-stale-hashes.sh` ya tenía el dominio
  bueno; solo el autopilot-notify quedó con el viejo. Los otros 2 destinatarios (`oviazcan@gmail.com`,
  `ernesto.sanchez@proecoplating.com`) nunca rebotaron.
- **Hallazgo A — conteo del asunto infla la percepción de gravedad.** `nPendientes` (hash-autopilot.mjs
  ~410) suma 5 categorías heterogéneas: `notCapturedEscalate + uncoveredNew + pendingMuts +
  suspicious + sentinelBroken`. Un "no concluyente por blip de red/auth" pesa igual que una rotación
  real → el número asusta de más. **Mejora sugerida (no urgente):** en el asunto distinguir
  ROTACIÓN REAL de las categorías blandas (p.ej. "N urgentes / M por revisar").
- **Hallazgo B — `needs-attention.json` puede quedar stale tras un fix por scan manual.** El motor
  auto-limpia el needs-attention SOLO para ops que resolvió en ESE run (verdict 'vigente' o
  deployadas). La corrida de las 19:25 solo probó QUERIES, no mutations; y las 4 mutations se
  arreglaron por scan MANUAL (fuera del motor) → nunca pasaron por `pruneNeedsAttentionFile`. Por eso
  `needs-attention.json` (14:32) sigue apuntando a `ArchiveReport`/`DeleteFolderById` ya vigentes. No
  es peligroso: la escalación Nivel B, al correr sobre ellas, las probará, las verá vigentes y limpiará
  (auto-sanador). Alternativa: correr el motor COMPLETO una vez (prueba mutations por probe directo y
  auto-limpia), o borrar el `needs-attention.json` a mano si se confirma que las 4 están vigentes.

**No quedan pendientes de código accionables del hash-autopilot** (los 2 hallazgos de arriba son
mejoras de UX/higiene, no bugs que rompan la autonomía).

## Rutas de interacción type-ahead + CreateInvoicePdf vigente (2026-07-24)

Los 3 hashes que el reporte diario del 2026-07-24 marcó "no autónomos" (2 queries type-ahead +
`CreateInvoicePdf`). Resultado: los 2 queries quedaron **autónomos y auto-deployados por el propio
launchd** (corrió las rutas, capturó y desplegó solo); `CreateInvoicePdf` resultó **vigente** (falso
positivo del probe). Commits: `071076f` → `5b98a7d` → `2f027c2` (config con los hashes lo deployó el
autopilot: `d2e1c52` SearchPartNumbers, `1bda4f9` FilterSearch).

- **Causa raíz de los 3:** son *interaction ops* — NO se disparan navegando; requieren teclear en un
  buscador (queries) o ejecutar una acción (mutation). Las rutas auto-generadas por pathname que los
  "listaban" nunca los disparaban.
- **`recipe-runner.mjs` — 3 capacidades nuevas** (para el flujo type-ahead multi-paso):
  - step **`typeInto`** (`{ typeInto: <sel>, text }`): teclea char-por-char en un input →
    search-as-you-type. Lo usa `SearchPartNumbers`.
  - flag **`once`** en `clickFirst` (`{ clickFirst: <sel>, once: true }`): clic ÚNICO sin re-clic —
    para pasos de setup de un modal donde la captura llega en un paso POSTERIOR (re-clicar cerraría el
    modal/menú).
  - **`clickFirstMatching` clica el primer elemento VISIBLE** (`matches.find(isVisible)`): los filtros
    de columna de Work Orders matchean DUPLICADOS ocultos → clicar uno oculto hacía timeout.
- **`workorders-filter-open` (FilterSearch):** `goto /WorkOrders` → clic en un filtro de columna
  (`div:has(> svg[data-testid="ArrowDropDownIcon"]:not(.MuiSelect-icon))`). Dispara al ABRIR, sin
  teclear. **La barra de filtros tarda ~10s en render headless** (a los 5s solo está el MuiSelect
  "Search All"). VALIDADA EN VIVO: capturó `1cdd9e39…` (== la variante LEGADA `FilterSearchInventoryBatch`
  del config; SH usa el mismo hash) → auto-deploy `1bda4f9`.
- **`uploadedfiles-pn-filter` (SearchPartNumbers):** `goto /UploadedFiles` → botón "Filtrar Archivos"
  (`button:has(svg[data-testid="FilterListIcon"])`, `once`) → combobox categoría (`[role=dialog]
  div[role=button][aria-haspopup=listbox]`, `once`) → opción `li[role=option][data-value="partNumberId"]`
  (VALOR estable, idioma-agnóstico; vive en portal MUI a nivel body, sin prefijo dialog, `once`) →
  `typeInto` en `[role=dialog] input.MuiInputBase-inputAdornedStart`. VALIDADA EN VIVO: capturó
  `e65235b5…` → auto-deploy `d2e1c52`.
- Ambas ops en `_interactionOps` (excluidas del auto-agrupamiento por pathname) y REMOVIDAS de
  `workorders-list`/`uploadedfiles-list`. Test `route-catalog-coherence` extendido (+2 ops al EXPECTED,
  ahora 16, + tests de las 2 rutas).
- **`CreateInvoicePdf` — VIGENTE, no rotada (falso positivo del probe).** El sentinel `invoicePdf`
  (entity + handler `createInvoicePdfAborted`) captura por capture-abort en `/Invoices?mode=PackingSlips`
  → flecha "Open PDF" (`OpenInNewIcon`) → modal → `RestorePageOutlinedIcon` → CONFIRMAR. Ruta VALIDADA
  por el operador. **Verificado por hash-scanner 2026-07-24:** la op dispara (status known, count 3,
  errorCount 0, hash `aafd22aa663f…` = el del config) → **el 'rotada sin capturar' del reporte diario es
  FALSO POSITIVO** (la mutation da falso-stale al probe/ciclo). **CAVEAT HEADLESS:** el modal del PDF NO
  abre confiable en Chromium headless (probado exhaustivo: 1/~10 con `click({force})`; el `OpenInNewIcon`
  no gatilla el onClick de React de forma estable) → captura autónoma de ESTE op **best-effort**. Fallback
  real cuando rote: **hash-scanner** (correr el scanner HACIENDO el regen del PDF → actualizar
  `remote/config.json` a mano; probado 2026-07-24). Centinela declarado por la regla de proceso.
  - **Callejón sin salida DESCARTADO (2026-07-24 — NO re-explorar):** intenté endurecer usando la
    **página de DETALLE** del invoice (`/Domains/{domain}/Invoices/{id}`) en vez del modal. Esa página
    **sí** muestra el `RestorePageOutlinedIcon` de forma determinista (3/3) y su popover abre — **pero su
    botón CONFIRMAR dispara `InvoiceByIdInDomain` + `GetPaymentLink` (refresh de datos), NO
    `CreateInvoicePdf`** (verificado con logger pasivo de requests, `harden-v4`). El regen de la página de
    detalle es una **acción distinta**; `CreateInvoicePdf` **solo** lo dispara el regen del **MODAL** (Open
    PDF desde la lista), y ese modal no abre confiable headless (0/3 con click real/coords/hover).
    **Conclusión:** la superficie que dispara el op no se automatiza headless y la que se automatiza
    (detalle) dispara otro op → **captura autónoma NO factible** con esfuerzo razonable (probablemente
    requiere gesto humano "trusted" o event-system no estándar). Único de ~232 hashes que no es 100%
    autónomo; los otros 6 session-sensitive **sí** lo son. El scanner es la vía para éste.
- **Falso positivo del correo SILENCIADO — pero se SIGUE PROBANDO (HECHO, commits `03d80f5` + `<este>`):**
  nueva lista `masked-ops.json` `suppressPendingReport: ["CreateInvoicePdf"]` (+ `_docSuppressPendingReport`).
  **Importante (corrección de diseño):** el motor **NO** excluye la op del intento de captura — el
  sentinel `invoicePdf` **SE SIGUE INTENTANDO en cada corrida COMPLETA** (best-effort; en `--masked-only`
  no, porque `mutationsToCapture` devuelve [] ahí). Lo que se **silencia es SOLO el REPORTE del intento
  FALLIDO**: no sale en `pendingMuts` ni suma a `nUrgentes`; el fallo queda solo en el log de consola.
  Así se **preserva la detección** (si de verdad rota Y el modal abre, se auto-deploya y sale como
  "CORREGIDA Y DEPLOYADA") **sin el cry-wolf diario** por el modal flaky. Fallback confiable si el
  best-effort no cacha la rotación: el applet `invoice-auto-regen` falla en prod, o el hash-scanner
  manual (que SÍ abre el modal). Para agregar otra op así: métela a `suppressPendingReport`.
  - **ACTUALIZACIÓN 2026-07-27 (commit `5497cd2`): el silenciamiento estaba INCOMPLETO — se cerraron
    las dos fugas que quedaban.** `suppressPendingReport` sólo actuaba sobre `pendingMuts`, así que
    `CreateInvoicePdf` seguía (a) saliendo en el correo como "❓ probe no concluyente" y (b) escribiendo
    `needs-attention.json` → **el cron del Nivel B gastaba un `claude -p` DIARIO re-descubriendo el
    callejón sin salida ya documentado arriba** (reproducido en vivo). Ahora la exclusión vive en
    `escalableNotCaptured()` (core, testeada), que es la base de la señal de atención. Y en
    `classifyCycleOutcomes()`: `invoicePdf` usa un **PSEUDO-centinela** (no apunta a ningún objeto
    Centinela — su `load` sólo comprueba que el icono de la lista rindió y devuelve un nombre
    SINTÉTICO para pasar `isSentinel`), así que cuando la lista tardaba, el ciclo reportaba "identidad"
    y se clasificaba como **centinela ROTO** → el correo pedía *"DESARCHIVA el centinela"*, consejo
    imposible de seguir (no hay objeto que desarchivar) y repetido en cada corrida completa. Van a
    `other`: el fallo queda sólo en el log, como manda `_docSuppressPendingReport`. **La detección se
    conserva intacta**: el best-effort se sigue intentando y, si captura una rotación real, sale por
    `toDeploy` ("CORREGIDA Y DEPLOYADA").
  - **ACTUALIZACIÓN 2026-07-24 (commit `8980994`): `validate-hashes.py` ahora TAMBIÉN whitelistea
    `suppressPendingReport`.** Razón: `CreateInvoicePdf` daba falso-stale PERMANENTE al probe idp-token
    (session-sensitive) y como NO es recapturable headless (callejón sin salida arriba), el gate del
    launchd (`VAL_RC=1 → motor completo`) abría el motor completo **CADA hora en vano** (medido: 88 vs 38
    corridas en el histórico; el 2026-07-24 fueron TODAS). Ahora `CreateInvoicePdf` sale `[SKIP]` en el
    validador → `VAL_RC=1` **solo en rotaciones REALES** → el motor completo deja de correr en balde
    (verificado: `235 ok / 0 stale / 1 skipped / exit 0`). **Consecuencia asumida:** una rotación REAL de
    `CreateInvoicePdf` ya NO la marca el validador (queda invisible a la CAPA 2) — se detecta por el
    fallback humano (applet truena en prod / hash-scanner). Es aceptable porque el motor tampoco la podía
    sanar headless: el scanner ERA su única vía de todos modos. Distinto de las 6 masked (queries/mutations)
    que el motor SÍ recaptura headless → esas siguen cubiertas sin hueco. El best-effort del sentinel
    `invoicePdf` sigue en `capturableMuts` (se intenta cuando SÍ corre una completa por otra rotación),
    solo que esas completas ahora son raras. **Nota operativa:** el validador necesita `/usr/bin/python3`
    (tiene `requests`), NO el `python3` de Homebrew.
- **Incidente de concurrencia 2026-07-24 (resuelto):** el launchd del autopilot corrió un auto-deploy
  mientras había WIP sin commitear + OTRA sesión editando el hash-autopilot. La danza `stash -u` +
  `checkout gh-pages` dejó el índice de main a medias, pero **se recuperó solo** (el stash se restauró).
  Producción nunca corrió peligro. Lección viva: al deployar desde workbench o con el launchd activo,
  el stash compartido + el checkout de gh-pages pueden chocar con WIP; el diseño self-healing aguantó.

## El centinela que "se archivó solo" — anclar por ID, no por posición (2026-08-05)

Durante días el ciclo de `SaveManyPartNumberPrices` abortó con **"objeto cargado NO es centinela
(identidad)"**, y el correo pedía **DESARCHIVAR** el quote #288 — que estaba perfectamente **ACTIVO**.
El diagnóstico mandaba a la reparación equivocada.

**Causa real:** la ruta buscaba el `<a>` del quote **en la LISTA**, y la lista sale paginada por
`Created At Descending`, 20 por página. El #288 **se cayó de la página 1**: hoy arranca en #321 con 167
quotes activos. El comentario del código (*"#288, reciente, aparece en la 1ª página"*) era cierto en
julio y **caducó solo** — bastó con que el negocio cotizara 33 veces más. Nadie tocó nada.

Encima, el paso previo tampoco era ya posible: el link `a[href$="/Quotes"]` del sidebar sale
`visibility:hidden` en `x=-169` (menú colapsado) y `/Domains/{d}` **redirige a `/`**.

**Fix:** `openQuoteSentinelDetail` — deep-link a `/Domains/{d}/Quotes/{id}` + espera activa a
"Centinela" **y** `[aria-label="Edit this Part"]` (hidrata en ~14 s; ~4 s con el SPA caliente). No
depende de paginación, orden, tamaño de página ni del sidebar. De paso el `load` verifica el **NOMBRE
del objeto** en vez de la mera presencia de un link: es una verificación de identidad más fuerte.

> **Lección:** un ancla que depende de *"está en la primera página"* no es un ancla, es una **carrera
> contra el uso normal del sistema**. Anclar por **ID**, no por posición. Y ojo con el modo de falla:
> no se rompió por un cambio de Steelhead ni por un deploy nuestro — **se rompió sola con el tiempo**,
> que es la clase de deuda que ningún test de regresión atrapa porque el código nunca cambió.

**Corolario para el mensaje de alerta:** el correo afirmaba una CAUSA ("quedó archivado") a partir de
un SÍNTOMA ("no pasó la verificación de identidad"). Como `isSentinel` es fail-closed, ese síntoma
cubre *todo* lo que impide llegar al objeto — archivado, renombrado, no hidratado, **o fuera de la
página**. Una alerta que nombra una sola causa manda al operador a revisar lo que no es.

## Freno de masa: qué protege de verdad y qué NO (revisión 2026-08-05)

El release `BB7C5204` de Steelhead (2026-08-05, 5:19 AM) rotó **14 queries de un jalón**. El freno
(umbral 6) se disparó 3 corridas seguidas (06:28, 07:28, 08:28) y **NO deployó nada**. Los hashes
viejos daban **STALE 4/4 estable** en el probe directo ⇒ los applets llevaban **~5 horas rotos en
producción** (specs, recepción, inventario, workboards, facturas) mientras el freno repetía el mismo
correo cada hora sin escalar el tono.

**Medición del histórico** (log 2026-07-06 → 2026-08-05, 92 corridas completas, 20 auto-deploys):
el máximo de rotados en una corrida que **sí** deployó fue **3** (14 corridas con 1, 5 con 2, 1 con 3).
El umbral de 6 **nunca estorbó en operación normal**; la única vez que actuó, bloqueó un deploy urgente.

**Su comentario dice que defiende contra "captura corrupta / cookie de otro dominio". Eso NO se
sostiene:** un hash de persisted query identifica el **texto** de la query, no los datos — es **global
al build**, no al tenant. Una sesión apuntando al dominio equivocado capturaría **exactamente los
mismos hashes**. Ese modo de falla no existe.

**Lo que SÍ protege (y por eso no sobra):** un **bug del propio motor**. Si el interceptor asociara el
hash de una op al nombre de otra, el síntoma sería justo *"rotaron 14 de golpe"* — un bug nuestro pega
parejo, mientras que Steelhead rota por partes. Es un **circuit breaker contra nosotros**, no un
detector de anomalías del ERP.

**Su defecto de diseño:** solo pondera el costo de ACTUAR, nunca el de NO actuar — y el motor **ya
tiene** la señal que falta (`probeVerdicts`: si el `cfgHash` está muerto). El criterio correcto no es
*cuántos rotaron* sino **¿el hash viejo sigue vivo?**:

| Estado del `cfgHash` | Qué significa | Acción correcta |
|---|---|---|
| **MUERTO** (probe STALE estable) | los applets YA están rotos | **corregir siempre**, sin límite de cuántos |
| **VIVO**, live distinto | rotación *de futuro* (SH puede hacer rollback) | retener y avisar — no urge |
| **VIVO** y muchos rotados | la señal genuina de bug en el motor | frenar: ESTE es el caso del freno |

Con `cfgHash` muerto, **no deployar no es la opción segura: es la que garantiza el daño**. El peor caso
de deployar es que SH revierta el release y el autopilot re-deploye los viejos en la siguiente corrida
(≤1 h de rotura) — contra las 5 h que costó frenar. **✅ IMPLEMENTADO (2026-08-05).** El freno ya NO cuenta rotados: pregunta **¿sigue vivo el hash que
tenemos?**, usando el `probeVerdicts` que el motor ya calculaba y no usaba para esto.

| `cfgHash` según el probe | Lectura | Qué hace |
|---|---|---|
| **`stale`** (muerto) | el applet **ya está roto** para el operador | **deploya siempre**, sin importar cuántos sean |
| `vigente` | rotación *de futuro* (el viejo sigue sirviendo) | cuenta para el freno |
| `auth` / `unknown` / sin probe | **no se sabe** | cuenta para el freno (**fail-safe**) |

Tres consecuencias que valen más que el cambio de umbral:

1. **El freno dejó de ser todo-o-nada.** Cuando actúa, retiene las de futuro **y deploya igual las
   muertas** (`toDeploy` + `heldBack`). Antes elegía "nada", que es la peor mitad cuando hay applets caídos.
2. **Sin probe se comporta exactamente como antes.** "No sé" nunca habilita un deploy masivo.
3. **El correo dice qué se retuvo, por qué NO urge y el comando exacto para liberarlo**
   (`--mass-brake=N`), en vez de dejar al operador deducirlo.

El flag `--mass-brake=N` sigue existiendo para el caso legítimo que queda: liberar a mano un lote de
rotaciones *de futuro* tras revisarlas. Cubierto por 6 pruebas en `hash-autopilot-core.test.js`
(incluida la reproducción del caso del 2026-08-05: 14 muertas ⇒ no frena) y 2 trinquetes de cableado
en `deploy-live-verification-wired.test.js` — verificados por mutación: al quitar `probeVerdicts` de
la llamada, la suite se pone roja.

## "Commiteé" no es "publiqué": el deploy que no llegó a producción (2026-08-05)

**Lo que pasó.** Tres deploys del autopilot quedaron atorados sin llegar al sitio. `main`
iba en `1.11.80` y GitHub Pages servía `1.11.77`, dejando **corregidos en el repo pero
ROTOS EN VIVO** a `InvoiceByIdInDomain` (applet `cfdi-attacher`), `GetStation` y
`WorkboardById`. Causa: otra sesión publicó documentación en `gh-pages` —rama
**compartida** por los deploys de la extensión y los 3 paquetes de docs— y el `git push`
del autopilot salió rechazado por **non-fast-forward**. Lo detectó el **operador a mano**,
no el sistema. El escenario es **normal, no excepcional**: el `pre-push` exime a los push
"solo-docs" de bumpear versión, así que un push de docs puede adelantarse en cualquier momento.

**Por qué fue invisible — tres agujeros, los tres verificados en el código:**

1. **El motor no mentía: se CALLABA.** El correo nunca dijo "corregida" en falso (la
   sección `✅ CORREGIDAS Y DEPLOYADAS` está tras `if (deployed && …)`). El problema era el
   contrario y es peor: con el deploy fallido **no se empujaba ninguna sección**, y como el
   correo solo sale `if (sec.length)`, un fallo de deploy con todo lo demás sano producía
   **cero correo**. El fallo vivía en un `console.log` del log de launchd que nadie lee.
   *Un vigilante que se calla al fallar es peor que uno que miente: no hay nada que contradecir.*
2. **`main` sí se pusheaba** (`deploy.sh` hace `push origin main` **antes** que
   `push origin gh-pages`). Desde la corrida siguiente, `classifyOp` comparaba el `cfgHash`
   **del repo** —ya con el hash nuevo— contra el `liveHash` capturado: **iguales ⇒ `vigente`**
   ⇒ la op **salía del radar para siempre** mientras el sitio servía el viejo. **El sistema
   se auto-convencía de estar sano.** Éste es el mecanismo del "lleva tiempo pasando sin que
   nadie se entere".
3. **`deploy-status.sh` compara la rama `gh-pages` LOCAL** (`git show gh-pages:…`), no
   `origin/gh-pages`. Con el push rechazado, local va adelante y el sitio atrás: sale
   `⚠️ Desalineado … vivo=X`, **que se lee igual que un lag del CDN** — y así se leyó en la
   sesión del incidente. *Una señal ambigua entre dos causas de gravedad opuesta no es una señal.*

> **REGLA DE FONDO:** todo el aparato de vigilancia medía el **REPO**, y lo que los
> operadores ejecutan es el **SITIO**. El heartbeat prueba que el autopilot **corrió**; el
> validador prueba que el **repo** está bien; **nadie probaba que el sitio sirve lo correcto.**
> El watchdog de latido **no cubre este caso** y nunca lo cubrirá: son preguntas distintas.

**Blindaje (núcleo puro `deploy-verify-core.mjs` + cableado):**

| Pieza | Qué hace |
|---|---|
| `verifyLiveDeploy(liveConfig, pares)` | tras deployar, confirma contra `oviazcan.github.io/…/config.json` que el sitio **sirve** los hashes. **Fail-closed:** sitio ilegible ⇒ `ok:false` («no sé» ≠ «está bien») |
| corre **fuera** del `try/catch` | el exit 0 del script **no** prueba publicación (`main` se pushea antes que `gh-pages`) |
| `detectLiveDrift(repo, origin/gh-pages)` | caza en **cada** corrida el drift **heredado** de un deploy anterior atorado (tapa el agujero 2) |
| árbitro = **`origin/gh-pages`**, no el CDN | separa *push atorado* (grave) de *lag de Pages* (inocuo) **sin depender del reloj** — si se midiera contra el sitio, cada deploy sano daría falso positivo y volveríamos al cry-wolf |
| `formatDeployNotLiveAlert` | nombra el estado **real** («corregido en el repo, **SIGUE ROTO** en vivo»), no un genérico «el deploy falló»: la acción del operador depende de esa diferencia |
| `nUrgentes += nDeployRoto` | **rompe el silencio**: el correo se manda aunque no hubiera ninguna otra categoría |
| `tipo = nDeployRoto > 0 ? 'fallo'` | un deploy no publicado es `fallo` **siempre**; que otras ops sí se corrigieran **no** lo degrada a `revision` |
| `push_con_rebase()` en `deploy.sh` | reintenta con **rebase** solo ante non-fast-forward; **conflicto ⇒ aborta** (no publica a ciegas) y **restaura la rama** (gh-pages se maneja con checkout ida y vuelta en el worktree de `main`) |

**Pruebas** (`tools/test/deploy-verify-core.test.js` 14 casos + `deploy-live-verification-wired.test.js`
9 de cableado). Se verificó que **fallan de verdad**: al quitar `nDeployRoto` del conteo, o al
neutralizar el `tipo='fallo'`, la suite se pone roja. También validado **contra producción**:
el config en vivo se lee y un hash no publicado se detecta como `ok:false`.
