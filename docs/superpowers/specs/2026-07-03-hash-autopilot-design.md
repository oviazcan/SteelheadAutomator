# Diseño: `hash-autopilot` — validación + regeneración desatendida de hashes

**Fecha:** 2026-07-03
**Estado:** aprobado (brainstorming) → pendiente plan de implementación
**Autor:** Claude + Omar

## Problema

La extensión `SteelheadAutomator` usa Apollo Persisted Queries: cada llamada a
`/graphql` manda solo el `sha256Hash` del query. Cuando Steelhead deploya un
cambio, el hash "rota" y las llamadas fallan con `400 "Must provide a query
string"` hasta que actualizamos `remote/config.json`.

El validador actual (`tools/validate-hashes.py`, launchd diario) valida los
hashes **desde Python** (idp-token externo). Funciona para la mayoría, pero hay
~6 operaciones **session-sensitive** (`CurrentUser`, `GetPurchaseOrder`,
`Customer`, `AllCustomers`, `AllSensorDashboards`, `SensorDashboardQuery`) que
responden `"Must provide a query string"` al cliente Python **aunque el hash
esté vigente**. Están en `tools/hash-validator-whitelist.json` para no marcarlas
como falsos-stale.

**El gap (incidente 2026-07-03):** `AllCustomers` y `Customer` rotaron de verdad
y el validador los skipeó por la whitelist → reportó `0 rotado` mientras carga
masiva traía 0 clientes. La whitelist enmascara rotaciones reales. La única
forma confiable de validar estas ops es **capturar el hash que el frontend usa
in-page** (método del hash-scanner) — que hoy requiere intervención humana.

## Objetivo

Un job **diario, desatendido y barato** que, para las ops whitelisted:
1. Capture el hash que el frontend de Steelhead usa hoy (navegación headless).
2. Lo compare contra `config.json`.
3. Si rotó y el hash nuevo valida bien → **regenere + deploye solo** + correo.
4. Si una secuencia de captura se rompe (cambió la UI) → **escale a Claude**
   para auto-reparación de la secuencia; si Claude no puede, correo de aviso.

### No-objetivos
- No reemplaza a `validate-hashes.py` (ese sigue cubriendo las NO-whitelisted
  desde Python, barato). `hash-autopilot` cubre específicamente las
  session-sensitive que Python no puede validar.
- No re-descubre secuencias con IA en cada corrida (eso solo ante fallo real).
- No es un scanner general de todos los hashes (aunque el motor podría extenderse).

## Decisiones tomadas (brainstorming)

| Decisión | Elección |
|---|---|
| Grado de autonomía | **Autónomo total (script puro)** — cero tokens en operación normal; auto-deploya el caso feliz. |
| Ante fallo de captura (UI cambió) | **Claude auto-repara** (1 intento acotado vía cron condicional), luego avisa. |
| Ubicación del código | **Nuevo en `SteelheadAutomator/tools/`** (cohesión con validate-hashes.py, deploy.sh, launchd). Reutiliza la *técnica* de `steelhead-interceptor` copiando lo mínimo. |
| Freno de masa (auto-deploy) | Si rotan **> 6** ops en una corrida → NO deploya, correo para revisión humana. |

## Arquitectura

```
launchd (diario)
   │
   ▼
hash-autopilot.mjs  (Playwright headless, cookie inyectada)
   │  1. instala interceptor /graphql → op→sha256Hash
   │  2. corre cada receta de click-recipes.json (mínima navegación)
   │  3. compara capturado vs config.json
   │  4. por rotado: re-ejecuta hash nuevo → exige 200 + expectShape
   ▼
clasificación: { vigente[], rotadoValidado[], noCapturado[], sospechoso[] }
   │
   ├─ rotadoValidado (y ≤6, sin sospechosos) ─► auto-deploy.sh (config bump + deploy.sh) ─► correo "regeneré" + bitácora
   ├─ noCapturado ─► escribe needs-attention.json ─► correo "no pude capturar X"
   │                     │
   │                     ▼  (cron condicional de Claude, solo si existe la señal)
   │                  Claude re-descubre secuencia (1 intento acotado, tope de tokens)
   │                     ├─ logra ─► actualiza click-recipes.json + regenera + deploya + correo "reparado"
   │                     └─ no ─► correo final "necesito ayuda, cambió el shape/UI"
   └─ >6 rotados  o  auth caída  ─► NO deploya, correo de revisión humana
```

## Componentes

### 1. `tools/hash-autopilot/click-recipes.json` — mapa de secuencias económicas
Declarativo, **organizado por pantalla** (no por op) para cubrir varias ops con
una sola navegación (minimiza pasos = "económico"). Este archivo es el "pendiente
incremental": cada receta descubierta se anota aquí.

```jsonc
{
  "customers-list": {
    "steps": [{ "goto": "/Domains/344/Customers" }],
    "captures": ["AllCustomers"],
    "validateVars": {
      "AllCustomers": { "includeArchived":"NO","includeAccountingFields":false,
                        "orderBy":["NAME_ASC"],"offset":0,"first":5,"searchQuery":"" }
    },
    "expectShape": { "AllCustomers": ["pagedData.nodes","pagedData.totalCount"] }
  },
  "customer-detail": {
    "steps": [{ "goto": "/Domains/344/Customers" },
              { "clickFirst": "a[href*='/Customers/']", "hrefMatches": "/Customers/\\d+" }],
    "captures": ["Customer"]
  }
}
```

Tipos de paso (mínimos): `{goto}`, `{clickFirst: selector, hrefMatches?}`,
`{waitForOp: opName, timeoutMs}`. La receta termina cuando capturó todas sus
`captures` o vence un timeout.

**Interfaz:** entra un `domainId` (parametrizable, hoy 344) y sale un set de
`op→hash` capturados. Depende solo de: cookie de sesión + Playwright.

### 2. `tools/hash-autopilot/hash-autopilot.mjs` — motor Playwright desatendido
- **Auth:** inyecta `STEELHEAD_COOKIE_STRING` (del `.env` de Reportes SH) como
  cookies del contexto; `headless: true`. Alternativa de respaldo: `.browser-state`
  persistente (como steelhead-interceptor). Si la cookie no autentica → exit auth.
- **Interceptor:** `page.route("**/*graphql*")` registra
  `op → extensions.persistedQuery.sha256Hash` (idéntico a steelhead-interceptor).
- **Ejecuta recetas**, recoge `capturado[op]=hash`.
- **Compara** vs `config.json` (solo las ops target). Por cada distinto:
  **re-ejecuta** el hash nuevo con `validateVars` in-page → exige `200` +
  presencia de las llaves `expectShape`. Resultado por op:
  - `vigente` (capturado == config)
  - `rotadoValidado` (distinto + 200 + shape OK)
  - `sospechoso` (distinto pero NO valida 200/shape → no se deploya)
  - `noCapturado` (la receta no disparó la op)
- **Flags:** `--dry-run` (reporta, no deploya), `--only=<op>`, `--domain=<id>`.
- Escribe resultado en `tools/.hash-autopilot/YYYY-MM-DD.json` (gitignored).

**Módulo puro separado** (`hash-autopilot-core.mjs`, testeable): la clasificación
`classify(op, cfgHash, liveHash, http, shapeOk) → veredicto` y el *set cover*
(qué recetas cubren qué ops). Sin dependencia de Playwright.

### 3. `tools/hash-autopilot/autopilot-deploy.sh` — auto-deploy del caso feliz
Recibe la lista de `rotadoValidado`. Aplica salvaguardas (§ abajo). Si pasan:
edita `config.json` (reemplaza cada hash, bump patch, `lastUpdated`), corre
`tools/deploy.sh` (que ya hace commit main + espejo gh-pages + push + check),
append a `docs/api/hash-validation-log.md`, y dispara el correo de éxito.

### 4. Notificación — reutiliza patrón `notify-stale-hashes.sh` (osascript Mail.app)
Dos plantillas:
- **Éxito:** "hash-autopilot: rotó `AllCustomers` (66e271→8d4dfe), regenerado y
  deployado (config 1.7.58). Validado 200." + tabla.
- **Fallo/revisión:** "hash-autopilot: no pude capturar `X` con la receta
  [pasos] — posible cambio de UI" / "> 6 hashes rotaron de golpe, revisa" /
  "auth caída, repega `STEELHEAD_COOKIE_STRING`".

### 5. Escalamiento a Claude (fallo tipo 2)
Si hay `noCapturado`, el `.mjs` escribe `tools/.hash-autopilot/needs-attention.json`
con la op, la receta que falló y qué se observó. Un **cron condicional de Claude
Code** (CronCreate durable) corre ~30 min después del launchd y **solo si existe
la señal**: despierta, invoca la skill `steelhead-hash-validator`, re-descubre la
secuencia navegando (1 intento acotado, tope de acciones de browser), y:
- si logra capturar → actualiza `click-recipes.json`, regenera, deploya, correo "reparado".
- si no → correo final "necesito ayuda". Borra la señal en ambos casos.

### 6. Scheduling — `launchd`
Nuevo `com.ecoplating.steelhead-hash-autopilot.plist` + wrapper
`tools/run-hash-autopilot.sh` (mismo patrón que el validador). Corre después del
validador Python (ej. 8:30am) para no solaparse.

## Salvaguardas del auto-deploy ⚠️

1. **Validación estricta:** deploya un hash solo si nuevo ≠ config **Y**
   re-ejecución da `200` **Y** la respuesta trae las llaves `expectShape`. Si no
   → `sospechoso`, NO deploya, avisa.
2. **Freno de masa:** si rotan **> 6** ops en una corrida → NO deploya nada,
   correo para revisión humana (defiende contra cookie de otro dominio / sesión
   rara / captura corrupta).
3. **Respeta el candado de deploy:** antes de tocar `config.json`, si hay WIP
   ajeno en `main:remote/` → stashea (como el flujo manual del 2026-07-03) o
   aborta; nunca pisa trabajo de otra sesión. Respeta el hook `pre-push`.
4. **Auth caída** (cookie expirada) → no deploya, correo "repega cookie". No
   intenta editar el `.env`.
5. **Trazabilidad:** un commit por corrida, mensaje claro, append automático a
   la bitácora. Todo reversible por git (no hay tags/rollback aún — pendiente
   heredado del audit).
6. **Idempotencia:** si el hash nuevo ya está en config (otra sesión lo deployó),
   no re-deploya.

## Testing

- **Unit (node:test)** sobre `hash-autopilot-core.mjs`:
  - `classify()` cubre las 4 clases (vigente/rotadoValidado/sospechoso/noCapturado).
  - `expectShape` presente/ausente → shapeOk correcto.
  - freno de masa: >6 rotados → bloquea.
  - set cover: recetas mínimas cubren todas las ops target.
- **Dry-run en vivo:** correr `--dry-run` hoy contra `customers-list` /
  `customer-detail` (hashes recién deployados) → debe reportar `vigente`.
- **Prueba de fallo:** receta con selector inválido → `noCapturado` + señal escrita.

## Cobertura inicial y pendiente incremental

Arranque con las 6 whitelisted. Recetas ya descubiertas (2026-07-03):
- `customers-list` → `AllCustomers` ✅
- `customer-detail` → `Customer` ✅

Por descubrir durante la implementación (navegando, como el 2026-07-03):
- `CurrentUser` (cold-load de la app / perfil)
- `GetPurchaseOrder` (Bills → match PO)
- `AllSensorDashboards`, `SensorDashboardQuery` (Dashboards → abrir un dashboard)

**Pendiente permanente:** cada op nueva que entre a la whitelist necesita su
receta en `click-recipes.json`. El sistema mismo la reclama (escala a Claude) si
falta o se rompe.

## Riesgos / preguntas abiertas
- **Estabilidad de la cookie headless:** si `STEELHEAD_COOKIE_STRING` expira
  seguido, el job avisará pero no podrá capturar. Mitigación: el mismo mecanismo
  de refresh que usa Reportes SH; validar duración real en la implementación.
- **Deploys grandes de Steelhead** pueden rotar >6 hashes legítimamente → el
  freno de masa pedirá revisión humana (comportamiento deseado, no bug).
- **Selectores frágiles:** las recetas dependen del DOM de Steelhead; por eso el
  escalamiento a Claude es parte del diseño, no un extra.
