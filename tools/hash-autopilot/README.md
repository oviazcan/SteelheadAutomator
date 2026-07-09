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

Las 3 mutations del release 2026-07-08 (validadas end-to-end):

| Mutation | Acción que la dispara (¡el sink es el juez!) |
|---|---|
| `UpdatePartNumber` | toggle del checkbox **"Archived"** del PN (NO el Save del modal → ese es `SavePartNumber`) |
| `UpdateQuote` | editar **External Notes** de la cotización (NO archivar → eso es `ArchiveUnArchiveQuote`, ni está en config) |
| `CreateReceivedOrder` | **crear** una OV "Sentinela" (modal Nueva OV) + archivarla después (create-capture-cleanup) |

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

`tools/run-hash-autopilot.sh` (wrapper con **gate por release**: solo abre el
navegador si Steelhead publicó un build nuevo) + el plist
`tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist` (cada hora a :23).

**Activar (una vez, con el repo en `main`):**
```bash
cp tools/launchd/com.ecoplating.steelhead-hash-autopilot.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ecoplating.steelhead-hash-autopilot.plist
launchctl list | grep hash-autopilot
```
El auto-deploy exige que el worktree esté en `main` y sin WIP ajeno en `remote/`
(salvaguarda de `autopilot-deploy.sh`); si no, avisa por correo en vez de deployar.

## Estado / pendientes

- Recetas afinadas: `AllCustomers`, `Customer`, `CurrentUser`, `AllSensorDashboards`.
- Sin receta estable aún: `GetPurchaseOrder`, `SensorDashboardQuery` (el motor las
  marca `noCapturado` → escala vía `ESCALATION.md`).
- Pendiente: prueba de humo del correo real; cargar el launchd tras mergear a `main`.
