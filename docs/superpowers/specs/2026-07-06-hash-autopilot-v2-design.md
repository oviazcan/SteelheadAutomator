# hash-autopilot v2 — captura selectiva por rutas

**Fecha:** 2026-07-06
**Estado:** Diseño aprobado (brainstorming). Pendiente plan de implementación.
**Predecesor:** `docs/superpowers/specs/2026-07-03-hash-autopilot-design.md` (v1, cubre solo las 6 session-sensitive whitelisted).

## 1. Contexto y problema

Los persisted-query hashes de Steelhead rotan cuando el frontend publica un release. Hoy hay **dos** sistemas desacoplados y con cobertura parcial:

- **`hash-validator`** (`validate-hashes.py` + launchd `:17`): valida desde Python las **176** ops NO-whitelisted (POST mínimo a `/graphql`; el 400 `"Must provide a query string"` = hash rotado). **Solo detecta, no corrige.** Ciego a 6 ops session-sensitive (whitelist) que dan 400 aun con hash vigente.
- **`hash-autopilot` v1** (`hash-autopilot.mjs` + launchd `:23`): navegador headless que captura y auto-deploya, pero **solo** las 6 session-sensitive (4 con receta + 2 que escalan).

Universo total en `remote/config.json` → `steelhead.hashes`: **113 queries + 69 mutations = 182 ops**.

**Gaps que este diseño resuelve:**
1. **Dos jobs, dos correos.** Se fusionan en **un solo job** con **un correo consolidado**.
2. **Sin autocorrección universal.** Hoy solo se autocorrigen 6 ops; las otras 176 se detectan pero se corrigen a mano. v2 autocorrige **cualquier** rotación (queries por navegación, mutations por ciclo sentinela).
3. **No hay mapa pantalla↔op.** El único método de descubrir el hash nuevo es interceptar el `/graphql` que el frontend dispara al usar la op (no hay manifiesto expuesto; `window.__APOLLO_CLIENT__` no está en prod). v2 construye un **catálogo de rutas** exhaustivo op → pantalla/clicks.

## 2. Objetivos y no-objetivos

**Objetivos:**
- Un solo job desatendido, gateado por release, un solo correo.
- Autocorregir la rotación de **cualquiera** de las 182 ops (queries + mutations), sin intervención humana.
- **Ejecución selectiva:** correr únicamente las pantallas/rutas de las ops que efectivamente rotaron — no un tour fijo diario.
- Mapa exhaustivo y mantenible pantalla↔clicks↔ops.

**No-objetivos:**
- No sustituir la técnica de interceptación por scraping estático de bundle (se comprobó que no hay manifiesto ni cliente Apollo expuesto).
- No tocar `extension/` salvo instrumentar el hash-scanner para el discovery (Fase B).
- No cambiar el modelo de deploy (`deploy.sh` / gh-pages mirror) — se reutiliza.

## 3. Decisiones tomadas (brainstorming 2026-07-06)

| Decisión | Elección |
|---|---|
| Relación validator ↔ autopilot | **Fusionar en 1 job** (no son sustituibles: validator cubre 176, autopilot las 6 session-sensitive; se complementan) |
| Cobertura | **Exhaustiva**: queries **y** mutations, todas las 182 |
| Ejecución | **Selectiva**: solo las rutas de las ops rotadas (+ las 6 session-sensitive siempre, por ser indetectables) |
| Mutations | **Sí**, vía **ciclo sentinela** (objetos canario archivados) |
| Autonomía mutations | **Todo desatendido**, con salvaguardas fuertes |
| Construcción del mapa | Discovery deliberado (un scan casual pesca ~9/113; no hay atajo) |

## 4. Arquitectura

Flujo del job único (`run-hash-autopilot.sh`, gateado por release vía `/version.json` `code-id`):

```
release nuevo? ──no──▶ exit 0 (solo un curl; casi gratis)
      │ sí
      ▼
1. DETECTAR    validate-hashes.py → { rotadas: [ops con 400] }
               ∪ { las 6 session-sensitive SIEMPRE }  (validator es ciego a ellas)
      ▼
2. PLANIFICAR  route-planner(rotadas, route-catalog) → conjunto MÍNIMO de rutas
               (set-cover greedy: 1 pantalla captura N ops → economía de clics)
      ▼
3. EJECUTAR    route-runner corre SOLO esas rutas, headless:
               · query    → navegar la ruta, interceptar /graphql, capturar sha256
               · mutation → ciclo sentinela (§7)
      ▼
4. VALIDAR     hash-autopilot-core.classifyOp/hasShape → 'rotadoValidado'
               (difiere de config + el frontend obtuvo `data` sin `errors`)
      ▼
5. DEPLOY      config-io.writeConfigHashes + autopilot-deploy.sh (candado main + trap)
      ▼
6. NOTIFICAR   autopilot-notify.sh → UN correo consolidado
               (deployadas / escaladas / sin capturar)
```

**Gate por release** (invariante): los hashes solo rotan con release del frontend, así que sin `code-id` nuevo el job sale en un curl. La ejecución headless (cara) solo ocurre cuando hay release **y** hay algo que capturar.

## 5. Componentes

| Componente | Estado | Responsabilidad | Depende de |
|---|---|---|---|
| `validate-hashes.py` | ✅ existe | Detector: set de ops rotadas (queries+mutations por el 400) | auth `steelhead_auth` |
| `route-catalog.json` | 🆕 nuevo | **Fuente de verdad** del mapa `op → {type, module, steps[], captures[], sentinel?}` | — |
| `route-planner.mjs` | 🆕 nuevo (núcleo **puro**) | Set-cover: ops rotadas + catálogo → mínimo de rutas | testeable aislado |
| `route-runner.mjs` | 🔧 extiende `recipe-runner.mjs` | Ejecuta una ruta headless; intercepta `/graphql`; para mutations orquesta el ciclo sentinela | playwright, sentinels |
| `sentinels.mjs` | 🆕 nuevo | Alta/estado/identidad/rollback de objetos canario | config de sentinelas |
| `hash-autopilot-core.mjs` | ✅ existe | `classifyOp`, `hasShape`, `planDeploy`, `missingCoverage` | puro |
| `config-io.mjs` | ✅ existe | Leer/escribir hashes en `config.json` | — |
| `autopilot-deploy.sh` | ✅ existe | Auto-deploy con candado (main + stash + trap) → `deploy.sh` | — |
| `autopilot-notify.sh` | ✅ existe | Correo (Mail.app) | — |
| `run-hash-autopilot.sh` | 🔧 fusiona | Orquestador del job único | todo lo anterior |

### 5.1 Esquema de `route-catalog.json`

```jsonc
{
  "_doc": "Mapa op → ruta mínima que la dispara. Fuente de verdad del discovery (Fase B).",
  "routes": {
    "AllCustomers": {
      "type": "query",
      "module": "Customers",
      "steps": [ { "goto": "/Domains/{domain}/Customers" } ],
      "captures": ["AllCustomers", "CustomerTags"]   // ops que esta ruta dispara de paso
    },
    "SaveReceivedOrderLinesAndItems": {
      "type": "mutation",
      "module": "ReceivedOrders",
      "steps": [ { "goto": "/Domains/{domain}/ReceivedOrders/{sentinelId}" }, { "click": "..." } ],
      "captures": ["SaveReceivedOrderLinesAndItems"],
      "sentinel": {
        "entityType": "ReceivedOrder",
        "strategy": "archived-mutate-restore",   // o "ephemeral-create-destroy" para Delete*
        "mutateStep": { "click": "Guardar" },
        "restoreStep": { "click": "Archivar" }
      }
    }
  }
}
```

- **`captures`** es la clave de la economía de clics: el planificador hace set-cover sobre `captures`, no sobre `op`, así una sola pantalla resuelve varias ops rotadas.
- Ops sin ruta estable (ej. hoy `GetPurchaseOrder`, `SensorDashboardQuery`) → ausentes del catálogo → el planificador las reporta como `noCapturado` y **escalan**.

### 5.2 `route-planner.mjs` (núcleo puro)

Entrada: `(opsRotadas: Set<string>, catalog)`. Salida: `{ rutas: RouteId[], noCubiertas: string[] }`.
Algoritmo: **set-cover greedy** — mientras queden ops rotadas sin cubrir, elegir la ruta cuyo `captures` cubra más ops pendientes. Determinista (desempate por orden alfabético de RouteId para tests estables). Testeado en `tools/test/route-planner.test.js`.

## 6. Detección selectiva (matiz de las session-sensitive)

- **176 ops detectables:** `validate-hashes.py` las valida por el 400. El planificador solo corre las **rotadas**.
- **6 session-sensitive** (`CurrentUser`, `GetPurchaseOrder`, `Customer`, `AllCustomers`, `AllSensorDashboards`, `SensorDashboardQuery`): dan 400 aun vigentes → **indetectables por Python**. Sus rutas se incluyen **siempre que haya release nuevo** (no cada corrida: el gate por release las limita). La verdad de si rotaron se resuelve al capturar in-page (`classifyOp`: si el hash capturado == config → `vigente`, no se deploya).

Consecuencia: por release se ejecutan las rutas de `{queries/mutations rotadas detectadas}` ∪ `{6 session-sensitive}`, deduplicadas por el planificador.

## 7. Ciclo sentinela para mutations (subsistema crítico)

Disparar una mutation requiere ejecutarla; hacerlo en producción exige contención total. Modelo **desatendido con salvaguardas fuertes**:

### 7.1 Estrategias por tipo de mutation
- **`archived-mutate-restore`** (Save/Update/Archive, reversibles): desarchivar el sentinela → aplicar la mutación (dispara el hash) → capturar → re-archivar/restaurar al estado base.
- **`ephemeral-create-destroy`** (`Delete*`, irreversibles): **no** sobre sentinela archivado → crear un objeto efímero marcado → capturar el `Delete` → confirmar borrado. Si no hay forma segura de crear el efímero → op marcada `no-auto` y **escala** (no se fuerza).

### 7.2 Salvaguardas (invariantes de seguridad)
1. **Identidad inequívoca:** cada sentinela lleva marca `__SA_SENTINEL__` (en nombre/tag/campo canónico). El runner **rechaza mutar cualquier objeto cuya identidad no verifique como sentinela** (fail-closed). Defensa primaria contra deriva a datos reales.
2. **Allowlist de entidades:** solo los `entityType` declarados en el catálogo pueden entrar al ciclo. Nada fuera del set.
3. **Reversibilidad con journal:** `try/finally` + journal en `tools/.hash-autopilot/sentinel-journal.json`. Si el proceso muere entre *mutar* y *restaurar*, el **siguiente run repara** el sentinela sucio ANTES de cualquier otra acción (idempotente). Un sentinela en estado "dirty" bloquea nuevas mutaciones sobre esa entidad hasta reparar.
4. **Verificación post-ciclo:** confirmar que el sentinela volvió a su estado base (archivado); si no → alerta y no se deploya el hash de esa op.
5. **Límite de blast radius:** el ciclo aborta si detecta que tocaría más de 1 objeto, o un objeto con dependencias/relaciones no esperadas.
6. **Solo lo rotado:** el ciclo sentinela de una mutation corre **únicamente si el detector la marcó rotada** (minimiza ejecuciones de mutación en prod).

### 7.3 Provisión de sentinelas
Un registro `sentinels-config.json`: por `entityType`, el `{id, marca, estado-base}` del objeto canario. Alta manual una vez (o helper de creación), documentada. `sentinels.mjs` valida su existencia y estado base al inicio; si falta o está sucio, esa familia de mutations escala en vez de ejecutarse a ciegas.

## 8. Discovery del catálogo (Fase B, trabajo pesado)

**No se usa video ni correlación manual.** Hoy el scanner guarda `url` = `/graphql`, no la pantalla, así que un video obligaría a alinear a mano timestamps con `firstSeen`/`lastSeen` — frágil y sin capturar el click. En su lugar se **instrumenta el scanner** para que él mismo registre el contexto de origen.

**Orquestación confirmada (5 pasos):**

1. **Instrumentar `hash-scanner.js`** para registrar, por op capturada: `location.pathname` + **breadcrumb de clicks** (la secuencia de botones/links que la disparó). Sin romper la sanitización key-level existente (el breadcrumb captura selector/texto de control, nunca payloads).
2. **Guion de navegación por módulo:** Claude prepara una checklist ordenada ("abre Clientes → abre un cliente → abre Órdenes Recibidas → abre una OV → …") que cubre sistemáticamente cada módulo del ERP.
3. **El operador navega una vez** siguiendo el guion con el scanner corriendo. El `scan_results` sale **ya mapeado**: `op → pantalla → click-path`.
4. **Auto-generar `route-catalog.json`** procesando ese scan (la "economía de clics" emerge: se toma la ruta más corta observada por op; el click-path es directamente replicable por el runner headless).
5. **Medir cobertura** (`missingCoverage`) → lista de ops de las 182 que no se pescaron → **segunda pasada dirigida** solo a esas.

Evidencia del tamaño: el scan casual del 2026-07-02 (49 MB) solo capturó 37 ops (9/113 queries, 0/69 mutations) → el discovery debe ser deliberado y por módulo, no oportunista.

**Mutations:** navegar normal NO las dispara (0/69 en el scan casual). Su ruta se mapea **ejecutando la acción** (Guardar/Archivar/Borrar) sobre objetos de prueba, lo que se hace en la pasada de **Fase C** junto con el sembrado de sentinelas — no en la primera pasada de queries. Ahí se identifica también el `entityType` y la acción disparadora → alimenta el campo `sentinel` del catálogo.

## 9. Fases de implementación

- **Fase A — Fusión + selectividad de queries.**
  Un job (`run-hash-autopilot.sh` fusionado), `route-planner.mjs` + tests, `route-runner.mjs` para queries, `route-catalog.json` inicial con las queries **críticas** ya conocidas (bulk-upload, portal-importer, invoice, create-order, sensores), correo consolidado. Descargar el plist del validator viejo (queda subsumido). *Valor inmediato, bajo riesgo, reutiliza el core existente.*

- **Fase B — Discovery exhaustivo.**
  Instrumentar el hash-scanner (pathname + breadcrumb). Sesiones de mapeo por módulo → completar las 113 queries y las rutas/`entityType` de mutations en `route-catalog.json`. Medición de cobertura vía `missingCoverage`.

- **Fase C — Ciclo sentinela (mutations).**
  `sentinels.mjs` + `sentinels-config.json`, estrategias `archived-mutate-restore` y `ephemeral-create-destroy`, journal/rollback, verificación de identidad. Runner de mutations. Completar las 69 mutations. *Subsistema riesgoso, al final, sobre A+B ya probados.*

## 10. Testing

- `route-planner.test.js` — set-cover determinista (varios escenarios: solape de captures, ops sin ruta, dedup).
- `hash-autopilot-core.test.js` — ya existe; extender casos de `classifyOp` para el flujo selectivo.
- `sentinels.test.js` — máquina de estados del ciclo (base→dirty→restore), reparación idempotente desde journal, fail-closed ante objeto sin marca.
- Prueba de humo end-to-end en dry-run (`--dry-run`): planifica y navega sin deployar ni notificar.

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Sentinela deriva a dato real | Marca `__SA_SENTINEL__` + fail-closed + allowlist + blast-radius ≤1 |
| Crash a mitad de ciclo mutación | Journal + reparación idempotente en el siguiente run |
| `Delete*` irreversible | Estrategia efímero create-destroy; si no es seguro → escala |
| Auth vencida (0 capturas) | Reutiliza cache `steelhead_auth`; si vence, correo "corre steelhead_auth.py" (ya en v1) |
| Op sin ruta estable | Ausente del catálogo → `noCapturado` → escala vía correo/`ESCALATION.md` |
| Deploy erróneo de hash | Salvaguardas de `autopilot-deploy.sh` (candado main, WIP ajeno, trap) — sin cambios |
| Falso `rotadoValidado` | `classifyOp` exige `data` sin `errors` (hasShape); solo deploya con respuesta válida capturada |

## 12. Reutilización (no reinventar)

Se conserva y extiende lo de v1: `hash-autopilot-core.mjs`, `config-io.mjs`, `autopilot-deploy.sh`, `autopilot-notify.sh`, `recipe-runner.mjs`, el gate por release y la inyección de tokens ROCP. Lo nuevo es el **catálogo de rutas**, el **planificador selectivo** y el **ciclo sentinela**.
