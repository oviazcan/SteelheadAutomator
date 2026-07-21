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
| `AddPartsToWorkOrders` | OV #1603 → OT #13678 | **CAPTURA-Y-ABORTA** (escritura): modal **"Ajustar Cantidad de Piezas de OT"** (icono IsoIcon) → cambiar el *Conteo Deseado* → **Guardar**. El Save dispara **SOLO** `AddPartsToWorkOrders`; `MovePartsToRecipeNodeId`/`SearchLocationsOnPath` son queries de **preview** del modal (no del Save, no escriben). Cero persistencia (OT sigue 1/1). |

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
- **Mutation de precios** (`SaveManyPartNumberPrices`): por ciclo **sentinela** sobre la
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
   `72946d4d…`; el andamiaje redundante `partNumberPrice` id:0 (+ handler `savePriceSentinelaAborted`)
   se **retiró** de `sentinels-config.json` y `mutation-deps.mjs`. Test `masked-ops-coherence` blinda
   que no reaparezca. El hardening "auto-deploy solo si el cfg está MUERTO" sigue cubriendo variantes.
5. **Alerta de sentinela declarado archivado — ✅ HECHO.** Módulo puro `sentinel-health.mjs`
   (`classifyCycleOutcomes`/`formatSentinelAlert`, 6 tests): cuando un ciclo aborta por identidad
   (sentinela ARCHIVADO → read-only → `isSentinel`=false), el motor lo reporta como sección
   **🚨 SENTINELA ROTO/ARCHIVADO** en el correo (antes: abort silencioso a consola) con la acción
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
  `SaveManyPartNumberPrices` (sentinela `quotePrice` #288, validado end-to-end 2026-07-17).
- Mutations con ciclo sentinela funcionando: `UpdatePartNumber`, `UpdateQuote`,
  `CreateReceivedOrder`, `CreateMaintenanceEvent`, `CreateMaintenanceEventComment`,
  `UpdateMaintenanceEvent`, `UpdateReceivedOrder` (7/7 — validadas headless).
- **Mutations de REPORTES por CAPTURA-Y-ABORTA — VALIDADAS 4/4 headless (2026-07-20):**
  `GenerateDuckDb` (botón "Regenerate Database" en `/Reporting/Databases`), `DeleteFolderById`,
  `CreateUpdateReportWithPermissions`, `ArchiveReport` (los 3 en `/Reporting/Edit`). Entidades
  `reportGenerateDb`/`reportFolderDelete`/`reportSaveAsNew`/`reportArchive` en sentinels-config.
  **Requisito:** una CARPETA "Sentinela" + un REPORTE "Sentinela" **persistentes** (activos) en
  `/Reporting/Edit` — el flujo de captura manual del operador los consume, así que deben quedar
  vivos para el ciclo. Anclaje SIN clases jss (son dinámicas): filtro "Filter queries..." +
  evaluate-mark (svg[aria-label] cuya fila innerText==="Sentinela"). Gate `capture-abort` en
  `sentinels.mjs` permite correr destructivas (Delete…) y no-auto (Generate…) porque el abort da
  cero efecto. Rotaron 2026-07-20; corregidas por scan (config 1.7.149) + GenerateDuckDb 1.7.151.
- **Mutation por CAPTURA-Y-ABORTA validada headless END-TO-END: `AddPartsToWorkOrders`**
  (sentinela `workOrderPartCount` = OV #1603 "Sentinela" → OT #13678; handler
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
- Utilitario: `cleanup-sentinela-ovs.mjs` archiva OV "Sentinela" activas rezagadas.
  Salud de sentinelas: `sentinel-health.mjs` alerta si un sentinela declarado quedó archivado.
- Correo real: prueba de humo ✅ hecha (2026-07-17). Launchd de escalación: ✅ cargado.
- Nivel B: ✅ **corrida real validada end-to-end 2026-07-17** (re-descubrimiento + trace + correo +
  guardrails). Wrapper corre con el login claude.ai (no la API key sin saldo). Auto-limpia el
  needs-attention al recapturar.

### Incidente + hallazgos 2026-07-20 (correo "0 corregida(s), 9 pendiente(s)")
- **Qué pasó:** rotaron 4 mutations de reportes (`ArchiveReport`, `DeleteFolderById`,
  `CreateUpdateReportWithPermissions`, `GenerateDuckDb`; las 4 dieron "Must provide a query string").
  El ciclo sentinela recapturó 2 como *sospechosas* y 2 quedaron *no capturadas* → correo de las
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
