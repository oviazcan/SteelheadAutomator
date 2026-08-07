# SteelheadAutomator

## Qué es
Extensión de Chrome MV3 que automatiza carga masiva de cotizaciones y números de parte en Steelhead ERP (app.gosteelhead.com). Usa arquitectura de "remote script loader": la extensión es un cascarón que carga lógica desde GitHub Pages.

## Estructura
- `extension/` — Extensión Chrome (se publica en Chrome Web Store como Unlisted)
- `remote/` — Scripts y config servidos por GitHub Pages (se actualizan con git push)
- `tools/` — Scripts de mantenimiento local (scraping de hashes, etc.)
- `skills/` — Skills reutilizables para Claude sobre la API de Steelhead
- `docs/` — Specs de diseño, bitácoras por applet (`docs/applets/`), playbooks de API (`docs/api/`) y patrones de arquitectura (`docs/architecture/`)

## Carga de contexto bajo demanda
Este archivo es **índice + reglas globales**, y está dimensionado para eso: todo lo que se lee en
cada arranque de sesión se paga en tokens cada vez. Las narrativas detalladas viven en satélites
que se cargan **cuando hacen falta**. Los tres niveles, del más barato al más caro:

1. **Este archivo** — reglas que gobiernan cualquier tarea + la versión viva de cada applet.
2. **[`docs/applets/README.md`](docs/applets/README.md)** — estado detallado de los applets
   (lecciones, versiones de config, hallazgos, pendientes). Ábrelo cuando la versión no baste.
3. **`docs/applets/<applet>.md`** — bitácora profunda por versión. **Antes de tocar un applet,
   lee la suya.** Es la fuente de verdad.

**Al agregar una lección nueva, va al satélite (nivel 2/3), no aquí.** Aquí solo entra lo que
cumple el criterio de la regla global: *no conocerlo causa un bug y no hay momento natural para
ir a buscarlo.*

## Deploy a producción
La extensión es un cascarón: en runtime fetchea scripts y `config.json` desde GitHub Pages (rama `gh-pages`). **Editar `remote/` en `main` no afecta a usuarios** hasta hacer el deploy a `gh-pages`.

### Layout
- `main` rama de desarrollo. Scripts viven en `remote/scripts/*.js`, config en `remote/config.json`
- `gh-pages` rama publicada. **Estructura aplanada**: `remote/scripts/foo.js` (main) → `scripts/foo.js` (gh-pages); `remote/config.json` (main) → `config.json` (gh-pages)
- `gh-pages` debe quedar en sync byte-a-byte con el contenido de `remote/` de `main` (verificable con `git diff HEAD:remote/scripts/foo.js gh-pages:scripts/foo.js`)

### Procedimiento — usa `tools/deploy.sh` (NO lo hagas a mano)
Edita tus archivos bajo `remote/` **en el worktree de `main`** y luego corre:
```bash
tools/deploy.sh "fix(applet-x): descripción" --check applet-x
# bump patch + commit main + espejo gh-pages + push ambas + check-deploy
# flags: --minor | --set X.Y.Z | --check <script> | --zip
```
`deploy.sh` hace TODA la danza de forma atómica y **self-healing** (re-espeja `main:remote/` → `gh-pages`, así que corrige cualquier drift previo). Solo deploya scripts **referenciados en `config.apps[].scripts`** (los `.js` dev-only de `remote/scripts/` no se empujan).

**Antes de razonar "¿esto ya está vivo?"** corre `tools/deploy-status.sh` — imprime la versión de tu rama, `main`, `gh-pages` y el sitio **EN VIVO**, y verifica el invariante byte-a-byte. **Nunca concluyas el estado de deploy mirando el `config.json` de una rama de trabajo** (puede estar desfasada respecto a `main`/`gh-pages`).

⚠️ **«EN VIVO desfasado» NO siempre es lag: puede ser el build de Pages ROTO, y
`deploy-status.sh` los reporta IGUAL.** El 2026-08-06 el sitio se quedó clavado en `1.11.96`
mientras git decía `1.11.99`; el mensaje «⏳ GH Pages publicando (~30-60s + caché CDN)» invitaba a
esperar, y se perdieron ~30 min esperando algo que no iba a pasar solo. La verdad estaba a una
llamada:
```bash
gh api repos/oviazcan/SteelheadAutomator/pages/builds --jq '.[0:3][] | "\(.status) \(.commit[0:8]) \(.error.message // "")"'
```
Salían dos `errored` («Page build failed») y uno atascado en `building`. **La cura es RE-DEPLOYAR
con bump** (`tools/deploy.sh "chore(pages): repush"`), que es lo que el propio `pre-push` sugiere:
funcionó a la primera y publicó `1.11.100`. Un commit VACÍO en `gh-pages` **no sirve** — el
`pre-push` exige que la versión suba, así que el repush pasa por `deploy.sh` o no pasa.
Regla: **si el vivo no alcanza a git en ~2 min, mira los builds antes de seguir esperando.**
Nota adicional: el sitio **no tiene `.nojekyll`**, así que Jekyll procesa TODO el árbol (incluidos
los 3 paquetes de docs) y un archivo que no le guste puede tumbar la publicación completa — no
sólo la suya. Es candidato a arreglo de fondo si los fallos se repiten.

**Candado:** el hook `pre-push` (`.githooks/pre-push`, instalar una vez con `tools/install-hooks.sh`) **bloquea** pushear `gh-pages` si no espeja `main:remote/`. Si te topas el bloqueo, usa `deploy.sh`.

**`deploy.sh` NO publica los `.xlsm` de `templates/`** (hace `git add scripts config.json`): van en commit aparte y **antes** del config —si el puntero sale primero el botón da 404— pero **en el mismo push** que el deploy (el `pre-push` valida el espejo antes de eximir a los push «solo-docs»).

#### Deploy DESDE el worktree `workbench` — usa `tools/wb-deploy.sh`
Si tu sesión vive en `workbench` (no en `main`), **NO** lleves el script a mano con
`git show workbench:remote/… > <main>/remote/…` + `deploy.sh`: `deploy.sh` hace `git add remote/` en
el worktree de `main` y **arrastraría dentro de tu commit la WIP sin commitear de la otra sesión**
(pasó el 2026-06-24: casi commitea el WIP de `load-calculator` en un deploy del auto-router).
Síntoma a reconocer: `git -C <main> status` muestra archivos `remote/…` modificados que no son tuyos.

```bash
SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh <script-sin-.js> "<mensaje>" [--minor|--set X.Y.Z]
```
Es atómico y resguarda la WIP de `main` (patch + `git stash`, con trap de recuperación). El
`SH_ALLOW_DEPLOY=1` es **obligatorio** (el guard `~/.claude/sh-workbench-guard.sh` bloquea
push/checkout de `main` desde workbench sin él). Es **un script por corrida**. Si necesitas cambiar
`config.json` más allá del bump (hashes nuevos), eso NO lo cubre: hazlo en el worktree de `main`.
**`wb-deploy` publica script + config, NO la doc** — la bitácora se queda en tu rama.

⚠️ **Antes de deployar desde un worktree, compara su `config.version` contra `main`.** El 2026-08-03
`workbench` estaba **47 commits atrás** (1.11.47 vs 1.11.62) y deployar de ahí habría **revertido 15
versiones ajenas**; se resolvió con cherry-pick quirúrgico, no con merge.

### Notas
- Commits de `gh-pages` siguen formato `deploy: <qué cambió> + bump <version>`.
- Rollback: `tools/rollback.sh <tag>` (`deploy.sh` crea tag `vX.Y.Z` por bump; los tags son el
  CHANGELOG). **NO revierte el `.zip`** — hay que republicarlo con el manifest anterior.
  Ver [`docs/architecture/rollback.md`](docs/architecture/rollback.md).
- Si solo cambia `extension/`, no hace falta tocar `gh-pages`.
- `extensionVersion` en `config.json` solo se bumpea cuando cambia el código de `extension/` y se republica el `.zip`.
- Procedimiento manual de fallback (si `deploy.sh` falla): bump `version` + `lastUpdated` →
  **RE-SELLAR la firma y los hashes** → commit en `main` → `git show main:… > …` sobre `gh-pages` →
  push ambas → verificar con `tools/check-deploy.sh`. GitHub Pages publica en ~30-60s.

  ⚠️ **El re-sellado NO es opcional y este procedimiento lo omitía** (incidente 2026-08-05): se
  bumpeó `config.json` a mano y **`1.11.90` se publicó con la firma y los hashes de `1.11.89`**.
  Como la verificación es **fail-closed**, una firma que no corresponde **bloquea a quien ya
  actualizó el zip** — y nada en el bump lo delata: `deploy-status.sh` compara **versiones**, no
  firmas, así que decía "✅ todo alineado" con el config roto. Lo cazó otra sesión
  (`fix(integrity): re-sella el config`, dos commits). **Comprobación explícita** —la que sí
  contesta la pregunta— con la pública REAL (no la primera cadena base64 que aparezca en el
  archivo, error cometido el mismo día):
  ```bash
  PUB=$(node -e "globalThis.self={};require('./extension/integrity-pubkey.js');process.stdout.write(self.SA_INTEGRITY_PUBKEY||'')")
  node tools/verify-config-sig.mjs <config.json servido> <config.sig servido> "$PUB"
  ```

- **Si el worktree de `main` tiene WIP de OTRA sesión, `deploy.sh` se niega** (hace `git add remote/`
  y la arrastraría). **No stashees trabajo ajeno.** La vía limpia: `git add` selectivo de tus
  archivos + commit, y el espejo a `gh-pages` desde un **worktree temporal**
  (`git worktree add <tmp> gh-pages` → copiar `main:remote/…` → commit → push → `git worktree
  remove` + `git worktree prune`). El `pre-push` valida el espejo igual. **Removerlo siempre**: un
  worktree huérfano de `gh-pages` bloquea TODO deploy posterior (ver §Trabajo paralelo).

## API de Steelhead
- Endpoint: `POST https://app.gosteelhead.com/graphql`
- Usa Apollo Persisted Queries (solo hashes SHA256, no queries en texto)
- Apollo client version: `"4.0.8"` (obligatorio en headers)
- Auth: cookies de sesión del navegador (no headers de auth)
- Hashes actuales en `remote/config.json`
- Documentación complementaria en `CLAUDE_CODE_CONTEXT.md`

**⚠️ El `/graphql` se cuelga bajo ráfaga (~40-45 requests), sin 429 ni error, y NO se recupera al
recargar la pestaña: el límite es por SESIÓN, no por pestaña — y tumba también la pantalla nativa.**
No subir la concurrencia; al validar contra el ERP productivo, **una búsqueda a la vez**.

**Playbooks específicos:**
- [`docs/api/portal-importer-ov-creation.md`](docs/api/portal-importer-ov-creation.md) — flujo de creación de OV y gotchas
- [`docs/api/persisted-queries-playbook.md`](docs/api/persisted-queries-playbook.md) — diagnóstico de hashes rotados vs deprecados (HTTP 400 `"Must provide a query string."`)
- [`docs/api/hash-coverage-multirepo.md`](docs/api/hash-coverage-multirepo.md) — cobertura y autohealing multi-repo
- [`docs/api/spec-measurement-model.md`](docs/api/spec-measurement-model.md) — el modelo de mediciones
  de specs en DOS EJES (**dónde** se mide vs **bajo qué criterio**). Es la causa estructural detrás de
  los casos de `wo-spec-params`: **un campo sin nodo que lo declare nunca se pide.**
  El **eje 1 no existe en la base de reportes** y se extrae del ERP con
  [`tools/extract-process-tree.mjs`](tools/extract-process-tree.mjs) — un `GetProcessNode` por proceso
  RAÍZ trae el árbol completo con los specFields embebidos (~260 peticiones, no ~6000). Alimenta los
  3 CSV de `Reportes SH/eje1_specfields/`. **Al re-correr esa auditoría hay que refrescar los DOS
  ejes**: el 1 con este script y el 2 con `regenerate_duckdb.py`; con uno solo fresco el avance se
  lee mal (medido: 79.3% cuando el real era 82.1%).

## Reglas de desarrollo
- JavaScript vanilla (sin React, sin frameworks, sin bundlers)
- Documentación y UI en español; código y variables en inglés
- Los hashes de persisted queries cambian cuando Steelhead actualiza — usar siempre los de `config.json`
- Constantes de dominio (IDs, schemas) van en `config.json`, no hardcodeadas
- Batching de PNs en grupos de 20 para SaveManyPNP

### Ruta de regeneración de hash: OBLIGATORIA por applet
Todo applet nuevo que introduzca un hash de persisted query DEBE documentar la **ruta exacta de
auto-captura headless** de cada hash en `tools/hash-autopilot/route-catalog.json` (queries) o
`sentinels-config.json` (mutations: ciclo centinela, o **captura-y-aborta** `sink.abortOps` para
escrituras que no deben persistir). Sin esa ruta, el `hash-autopilot` no puede regenerar el hash
cuando Steelhead lo rote. **Un hash sin ruta de regeneración es deuda.**

**La regla se VERIFICA:** `tools/test/hash-regen-coverage.test.js` mide la cobertura real y funciona
como **TRINQUETE** — falla si el número de huérfanas **sube**, y si baja obliga a actualizar la línea
base en el mismo commit. Línea base al **2026-08-05**: **53 huérfanas** (queries **115/122**, mutations
**29/75** — el hueco siguen siendo las mutations, cada una necesita su centinela). Bajó de 58 ese día por
DOS vías distintas, y la diferencia entre ellas importa: la familia de parámetros de spec ganó **ruta
real** (entidad `partNumberSpecParams`, 3 ops en un ciclo), y aparte se **retiraron del catálogo** 2
hashes MUERTOS que no consumía nadie. Reducir deuda documentándola y reducirla borrando lo que sobra son
cosas distintas; el trinquete cuenta igual las dos, así que el commit debe decir cuál fue.
El caso que destapó la falta de verificación: `CreateUpdateDeleteRoutes`, LA mutation del auto-ruteador,
vivió sin ruta desde su fase 1. **Cobertura de doc: 45/45 apps con bitácora e índice (2026-08-05).**

El validador y el autopilot cubren las **3 fuentes** con hashes propios (extensión, Reportes SH,
PowerTools); cuando un hash externo rota, el autopilot lo captura, valida, **escribe, commitea y
pushea el otro repo automáticamente**. Ver `tools/hash-autopilot/README.md` y el slash command
`/nuevo-applet` (vive en `.claude/commands/nuevo-applet.md`, **no** es una skill: los commands son
**de este repo** y no existen desde otro cwd — desde `SteelheadPowerTools` no se puede invocar).

### Reglas de robustez (cada una nació de un bug de producción)
- **La UI de ENTRADA de un applet se monta SIEMPRE que la ruta aplique.** El toggle/barra/botón que
  ENCIENDE un applet no puede estar detrás de su propio gate de estado (`if (!isEnabled()) return`
  antes del `ensureToggle()`): si no se monta, el operador no tiene cómo encenderlo. Solo el trabajo
  pesado va detrás de ese gate. Corolario: **no asumas que el DOM ya está pintado cuando corre tu
  `init()`** — ten un reintento (MutationObserver) que NO esté capado por el estado del applet.
  Ver [`docs/architecture/applet-load-gating.md`](docs/architecture/applet-load-gating.md).
- **Todo nodo que inyectemos en una tabla de React lleva DE QUIÉN ES, y se revalida en cada pasada.**
  React **recicla los `<tr>`** (archivar/filtrar/ordenar/paginar): reusa el nodo y le cambia el
  contenido, así que preguntar si nuestra celda EXISTE la deja con el id y el dato de la entidad
  anterior. Síntoma: **la celda nativa muestra la entidad correcta y las nuestras otra**, coherentes
  entre sí; recargar lo "arregla", lo que despista hacia un problema de caché. Y si el applet reparte
  los fetch por atributo, el atributo stale hace que la respuesta de la entidad ANTERIOR se pinte
  sobre la fila NUEVA: la mentira se refresca sola. La decisión va al core (`isStaleNode(attr, id)`,
  pura y testeada). **Regla de fondo: un guard de idempotencia que pregunta «¿ya lo hice?» en vez de
  «¿sigue siendo del mismo dueño?» no ahorra trabajo, conserva una mentira.**
- **Un latch de idempotencia marca el ÉXITO, no el INTENTO.** Si el latch se pone *antes* de montar,
  un fallo transitorio de montaje **se congela para siempre** (síntoma: «desapareció», no «tardó un
  render»). La función de montaje debe devolver si logró montar, y el latch ponerse solo entonces;
  si no montó, el observer reintenta (con el `warn` acotado a uno por modal).
  **Y un latch protege UN recurso.** Cuando un solo `if (yaEstá) return` guarda DOS arranques, el
  segundo hereda el ciclo de vida del primero: en `create-order-autofill` el `startDetectPoll()`
  vivía tras el latch del observer, y como el observer no se desconectaba al salir de la pantalla,
  al **regresar por navegación SPA** el poll ya no arrancaba — medido en producción: 4 ticks/3.5 s
  en la primera visita, **0 al volver**. Cada recurso se enciende y se apaga por SU propio estado.
  Corolario: **lo que se apaga al salir de una ruta, alguien lo tiene que volver a encender**, y el
  `MutationObserver` no sirve de respaldo — medido en el mismo modal: **0 mutaciones de `childList`
  en 6 s**, incluso tecleando. Dispara en eventos discretos, no vigila. **Todo applet que monte UI
  en un MODAL necesita poll de re-detección** (el mismo bug salió 5 veces: `weight-quick-entry`,
  `create-order-autofill`, `receiver-date-override`, `proceso-calculator`/`unit-autoconvert`,
  `warehouse-location-prefill`); trinquete: `tools/test/modal-detect-poll-coverage.test.js`. Los que
  inyectan en LISTADOS no lo necesitan —ahí paginar/filtrar/ordenar mutan sin parar—. **Y si el tick
  es caro, lleva presupuesto**: un poll que barre el documento entero cada segundo no es una red, es
  el siguiente reporte de piso (`unit-autoconvert`: 5 intentos por diálogo y se calla).
- **Verifica RELEYENDO cuando la mutation no devuelve el dato.** Varias mutations responden
  `{clientMutationId:null}` — ni el valor ni el id — así que un `await` sin excepción **NO prueba que
  se escribió**. Relee saltando caches y compara el valor (para fechas, el **instante**, no la cadena).
- **Ante dato faltante, degrada explícito; no inventes un default.** Sin `partsPerRack`, asumir «1
  pieza por carga» convierte 141 min en ~112 días. Muestra `?`, nombra el hueco y di dónde se corrige.
  Para un candado: «no tengo el dato» **jamás** puede significar «prohibido» (fail-safe), y el
  fail-safe **se dice** en la UI (nota ámbar «no pude verificar», distinta del rojo de bloqueo).
- **El juez de un formato es la app que lo consume, no tus verificaciones.** Se editó la hoja
  `Ayuda` de las plantillas reescribiendo su XML dentro del `.xlsm`, y **Excel abrió los archivos
  como dañados** —«¿Deseas que intentemos recuperar el máximo de contenido posible?»— después de que
  pasaran SEIS comprobaciones: zip íntegro, XML válido, `vbaProject.bin` byte a byte, 1 entrada
  modificada de 33, macros intactas y `verify-template-layout` en 10/10. Ninguna contestaba *«¿Excel
  lo acepta?»*; todas contestaban *«¿esto es coherente con lo que yo esperaba?»*. **Un `.xlsm` no se
  edita por XML — tampoco "solo una hoja"**: la vía es emitir el contenido y pegarlo en Excel
  (`--text`). Corolario general: cuando la única prueba que falta es la que no puedes correr,
  **ésa es la que bloquea la publicación**, no una nota al pie. (Causa concreta: tocar el `<pane>`,
  fuera de `<sheetData>`, que era lo único que había que tocar.)
- **Una fuente que viene FILTRADA solo puede AFIRMAR, nunca negar.** Si una query se pide con un
  filtro en las variables, la ausencia de un registro no prueba que no exista: prueba que no está
  *en ese filtro*. Antes de investigar por qué una fuente «no llega», mira **con qué variables se
  pide** — un vacío consistente suele ser una respuesta legítima a una pregunta que no era la tuya.
- **Un fail-safe que existe y no se conecta es un fail-safe que no existe.** Pasó con un `found:true`
  hardcodeado en el glue: la rama de degradación estaba escrita y jamás se activó.
- **AUSENTE ≠ VACÍO, y ante la duda se MUESTRA.** Una lista vacía **no es conocimiento**: es la forma
  que toma el dato cuando falla la consulta o cuando el ERP renombra el campo. El icono de *Ajuste
  Masivo de Specs* desapareció del menú sin que nadie tocara su config porque `[]` viajaba como si
  fuera una lista real de permisos (`Array.isArray(p)?p:[]` en el background convertía «no sé» en «no
  tiene»; `x || null` en el popup lo dejaba pasar porque **`[]` es truthy**) y
  `req.every(p => [].includes(p))` escondía **toda** app con `requiredPermissions`, en silencio y
  sobreviviendo a las recargas. La asimetría decide el default: el gate del menú es **cosmético** —el
  servidor valida cada mutación al ejecutarla— así que un falso «sí» cuesta un error visible al hacer
  clic, y un falso «no» deja al operador sin herramienta **y sin explicación**. Decisión en el módulo
  puro [`extension/permission-gate.js`](extension/permission-gate.js) (`tools/test/permission-gate.test.js`).
  **Y un dato que no pudimos LEER no es un dato ausente — menos aún se cachea.** `create-order-autofill`
  guardaba el `null` de un timeout (90 s) como si fuera la respuesta del ERP: el panel acusaba en ámbar
  «el cliente no tiene `DatosFactura`» —con liga para ir a capturar algo ya capturado— y el veneno duraba
  **toda la sesión**, porque el reintento leía el caché en vez de reintentar. Un fallo de red convertido
  en dato dura mil veces más que el fallo.

### Reglas de diseño
- **UI propia en DARK MODE.** Todo modal, panel, popover o tooltip que inyecte la extensión va en
  tema oscuro (base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento verde `#13a36f`) para que el
  operador distinga **de un vistazo** que es UI de la extensión y NO una pantalla nativa de Steelhead
  (que son CLARAS). Excepción: cuando *enriquecemos* un componente nativo (p. ej.
  `board-metal-tooltip.js` inyecta en el popover de SH), ahí sí se respeta el estilo de SH.
- **El popup NUNCA debe pedir más de 600px de alto.** Chromium ajusta el popup a lo que pide el
  documento con un tope duro de **800×600**; si el alto se pasa, **deja de ajustar el ancho al
  preferido y abre la ventana al MÁXIMO** (body a la izquierda, ~460px oscuros a la derecha porque el
  `background` del body se propaga al canvas). El esquema de topes en px falló TRES veces porque **el
  cromo de una vista no es constante** — la barra de progreso es HERMANA de las vistas y suma 33px a
  cualquiera al ejecutar. **Ahora la aritmética la hace el navegador**: documento topado a 590px +
  columna flex. **Contrato: toda vista nueva necesita un contenedor `.view-scroll`** (es lo único que
  se encoge). Trinquete `tools/test/popup-sizing.test.js`. **Al medir, `document.body.scrollHeight` ya
  NO sirve** (con `overflow:hidden` reporta el contenido recortado) — lee el `getBoundingClientRect()`.
  Ver [`docs/architecture/popup-sizing.md`](docs/architecture/popup-sizing.md).
- **Una regla CSS derrotada por orden de cascada no avisa.** Un `display:flex` puesto *antes* de una
  regla vieja `display:block` queda desactivado en silencio.
- **Cuando dos flujos vecinos se parecen tanto que el operador escoge mal, el arreglo no es más
  documentación — es que el camino correcto sea el más visible desde donde ya está parado.**
- **Marca la EXCEPCIÓN, no la norma.** Resaltar lo que cumple llena la pantalla de color y no informa;
  resaltar lo bloqueado/lo raro sí. (Aprendido dos veces: `surtido-guard` y `batch-name-filter`.)

### Contratos que ningún archivo falla solo (necesitan test de cableado)
Un botón del popup es un contrato entre **TRES** archivos —`popup.js` lo pinta, `config.json` lo
declara, el script remoto lo implementa— y **ninguno falla solo**: la única señal es el clic en
producción. Toda acción `handler:"message"` necesita un `case` en el background o un campo **`fn`**
que resuelva a un método exportado; sin eso responde `Acción desconocida`. Además,
`chrome.runtime.onMessage` **no existe en el mundo MAIN**, así que un listener ahí se ve correcto y
nunca corre. Trinquetes: `tools/test/popup-actions-wired.test.js` y
`tools/test/mui-icon-core-wiring.test.js` (un applet que usa un núcleo pero no lo declara en
`config.apps[].scripts` cae al fallback **en silencio**).

## Trabajo paralelo (dos instancias de Claude)
Para correr dos sesiones sobre este repo sin pisarse, usa **git worktrees**:
```bash
tools/new-worktree.sh <feature-name> [branch-base]
# resultado: ../SteelheadAutomator-<feature-name> en rama wt/<feature-name>
```

**Hot files que NO se deben editar en paralelo:**
- `remote/config.json` (version bump + hashes compartidos)
- `CLAUDE.md` (índice de applets + reglas globales)
- rama `gh-pages` (deploy mirror — solo una sesión deploya a la vez)
- **`safari/bundle.json` + `safari/extension/main-bundle.js`** — incidente 2026-07-28: las dos
  sesiones rebundlearon el mismo día y **ambas bumpearon a v0.6.2** ⇒ choque de versión + conflicto
  en el artefacto de 1.4 MB. **Regla: `main-bundle.js`/`manifest.json` son ARTEFACTOS — su conflicto
  nunca se resuelve a mano**: se mezclan las fuentes, se corre `tools/build-safari.sh` y se verifica
  después que el artefacto traiga los cambios de AMBAS ramas.

**Reglas:**
1. Solo UNA sesión bumpea `remote/config.json` y deploya a `gh-pages` por vez.
2. Si vas a editar `config.json` o `CLAUDE.md`, hazlo en pasadas cortas (read → edit → commit → push).
3. Para deploys: la sesión que deploya hace `git stash` de su WIP antes de `checkout gh-pages`. Nunca toca el directorio del otro worktree.
4. **Si deployas DESDE `workbench`, usa `wb-deploy.sh`** (ver §Deploy).
5. Idealmente UN applet por sesión. Si tocan dos que comparten helpers (`host-cleanup-shared.js`, `process-canon.js`), coordinar.
6. **Un worktree HUÉRFANO de `gh-pages` bloquea TODO deploy, y el error no lo dice.** Síntoma:
   `ERROR: no pude checkout gh-pages`. Git no permite la misma rama en dos worktrees, así que ningún
   `checkout gh-pages` funciona mientras el registro exista. **Diagnóstico: `git worktree list`** — busca quién tiene
   `[gh-pages]`, incluidos paths en `/private/tmp/.../scratchpad` (pasó el 2026-08-03: otra sesión de
   `SteelheadPowerTools` lo creó en su scratchpad y borró el directorio sin desregistrarlo). Si el
   directorio ya no existe y su commit está en `origin`, **`git worktree prune`** lo limpia; si
   existe, es una sesión viva: coordinar, no borrar.

**Limpiar:** `git worktree remove ../SteelheadAutomator-<name>` + `git branch -D wt/<name>`.

## Trabajo con UI / DOM de Steelhead
**ANTES de escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo del
bloque relevante** (el padre cercano que contiene labels visibles E inputs/comboboxes). NO adivines
la estructura iterando deploys — una sola inspección resuelve todo en un commit. Cuando la
automatización no logra abrir un modal, **pedir el DOM al operador sale más rápido y más fiable que
insistir por CDP** (validado el 2026-08-03).

### Jerarquía de anclaje (estándar; el bilingüe es el último recurso, no el primero)
1. **Anclas estructurales del HTML** — ids de schema RJSF (`root_<Grupo>*`), **la FORMA del icono**
   (`svg path[d]`), `data-steelhead-component-id`, posición en la tabla/fila, relación padre/hijo. No
   dependen del idioma y **son las únicas que sirven en un candado**, donde un gate que no matchea
   **se apaga en silencio**.
   - ⚠️ **`data-testid` YA NO es confiable (2026-08-03): SH publicó un build que lo ELIMINA.** Se
     sigue buscando primero (si SH lo repone, sirve), pero **ninguna decisión puede depender solo de él**.
   - ✅ **`data-steelhead-component-id` SIGUE VIVO**, pero vive en **fichas de detalle, no en
     listados** (38 en la ficha de OT, 40 en la de NP). Los ids RJSF `root_*` también siguen vivos.
   - La alternativa que aguantó: **el `d` del `<path>` del icono** — SH no lo puede cambiar sin
     cambiar lo que el operador VE. Núcleo
     [`mui-icon-anchor-core.js`](remote/scripts/mui-icon-anchor-core.js): busca por testid → por
     forma, y **devuelve `by: 'testid'|'shape'`** para ver por qué matcheó. Catálogo: **14 formas
     medidas en vivo**. **Los paths se MIDEN, no se copian del canónico de MUI** (`EditIcon` y
     `ArchiveIcon` difieren por optimización SVGO). Un icono nuevo va con la lista **vacía** antes
     que con un path adivinado: vacío degrada al estado de hoy, adivinado finge cobertura.
2. **Texto ES+EN como red de seguridad** — encima de la estructural, para que solo AMPLÍE el match.
   Nunca como única señal de un gate. **Un anclaje no se cambia, se AMPLÍA.**
   - **Un `aria-label` laxo no falla: acierta el icono EQUIVOCADO.** Con `/…|qr/i`, `QrCode2Icon`
     matcheaba «Escanear Código QR» (el botón de la CÁMARA). Exige la palabra que nombra la ACCIÓN,
     no la tecnología. Por eso el aria va **al final** de la cascada, después de la forma — y por eso
     **la FORMA va antes que el aria**: el workboard usa `PrintIcon` para «Print Job Tags» mientras la
     ficha de OT usa `QrCode2Icon` para la misma función nominal.
3. **Bilingüe puro** — únicamente cuando **no hay estructura que anclar**: `window.alert`, toasts,
   texto suelto sin contenedor identificable.
4. ⛔ **NUNCA una clase `css-<hash>`** (`.css-iyrxkt`, `.css-xd9ivb`…). Van **por debajo del texto**:
   las genera **emotion a partir del contenido del estilo**, así que el hash cambia **cuando alguien
   mueve un padding** — sin avisar y sin que el idioma tenga nada que ver. **Parecen estructura y no
   lo son**, que es lo que las vuelve peligrosas: un applet anclado a `.css-iyrxkt` *se lee* como si
   cumpliera la regla 1. La salida NO es cambiar de hash: es **SUBIR por relación estructural**
   (`parentElement`, número de labels hijos, orden de documento) partiendo del texto ES+EN, y
   **HEREDAR las clases de presentación del vecino vivo** en vez de escribirlas a mano.
   **Deuda medida (2026-08-03): 24 sitios en 9 archivos** siguen anclados a `css-*` y fallan así de
   callado (`po-listing-filters`, `proceso-calculator`, `invoice-autofill`, `load-calculator-modal`,
   `invoice-listing-marker`).

**Al buscar un ancla, `querySelector` toma el PRIMER match y el DOM de SH duplica controles en
variantes responsive** (un botón puede existir 2×, una oculta y una visible) y repite iconos. Filtra
por visibilidad y cercanía, no por orden de documento.

### Cuando toques TEXTO: matchea ES **y** EN
La UI de SH cambia de idioma por usuario/config (y a veces es mixta: un mismo modal muestra "Modo:"
en español y "Per Part Count Unit Definitions" en inglés). Un anclaje mono-idioma se rompe
silenciosamente al cambiar el locale. **No adivines la traducción:** obtén el string real de AMBOS
locales antes de anclar; si solo tienes uno, ánclalo pero **marca la deuda** en la bitácora.
**Y no lo tumba solo el locale: un rename EN→EN mata igual un match exacto** (`Income Account` →
`Income/Liability Account` dejó a `invoice-autofill` sin ver ninguna línea). **Un applet que ancla
por texto exacto no se degrada: se APAGA** — y si lo que se apaga es la EXTRACCIÓN y no el llenado,
el panel no muestra error, muestra menos filas. Prioriza por **la decisión que el ancla gobierna**,
no por «¿SH traducirá este string?».

Cuando ni el texto ni la estructura alcancen, una **red de seguridad posicional** es aceptable solo
con **evidencia positiva** (p. ej. «la última columna, y solo si su celda trae react-select») y un
`warn` que lo delate. **El texto siempre gana sobre la posición**, y sin esa evidencia **no se
adivina**: escribir en la columna equivocada es peor que no escribir.

### Lección de método (la que más cuesta reaprender)
**«0 ocurrencias en N pantallas» NO prueba «lo eliminaron»; prueba «no está en esas N».** Para
afirmar una eliminación hay que medir **donde el atributo debería estar**. Se confirmó tres veces el
mismo día: los canónicos de `CloseIcon`, `SendIcon` y `VisibilityIcon` **eran correctos** y daban
`false` solo porque se probaron en pantallas donde esos iconos no viven. **Probar un path en la
pantalla equivocada no dice nada sobre el path.** Igual con una pantalla de permisos: el
«¡PERMISOS INSUFICIENTES!» de SH es un **falso negativo conocido** (evalúa el permiso antes de tener
el contexto; recargar lo corrige) y **no refuta nada** al medir en vivo.

**Detalle completo** —catálogo de las 14 formas, verificación applet por applet, los incidentes del
2026-08-03 e inventario de deuda— en
[`docs/architecture/steelhead-ui-anchoring.md`](docs/architecture/steelhead-ui-anchoring.md).
Patrones de extracción/inyección (label-driven extractors, react-select, MUI X DatePicker, modal
injection, cancellation tokens) y cómo **inspeccionar en vivo por automatización de Chrome** sin que
la página se congele: [`docs/architecture/dom-patterns.md`](docs/architecture/dom-patterns.md).
Deuda bilingüe por applet: [`docs/architecture/bilingual-anchoring-debt.md`](docs/architecture/bilingual-anchoring-debt.md).

## Reglas de memoria en applets de larga duración
**ANTES de tocar cualquier applet que procese >200 items, mantenga panel abierto, corra `runPool`, o
se ejecute por minutos — invoca el skill `memory-hardening-applets`**
(`~/.claude/skills/memory-hardening-applets/SKILL.md`). Cubre los dos ejes: memoria propia del applet
(slim responses, parse once, clear Maps, closePanel cleanup, seed pattern) y memoria del SPA host
(Datadog RUM stop, Apollo cache drain, mem monitor con guardrail a 88%).

Helpers compartidos en [`remote/scripts/host-cleanup-shared.js`](remote/scripts/host-cleanup-shared.js)
→ `window.SteelheadHostCleanup` (`stopDatadogSessionReplay`, `apolloCacheDrain`, `createMemMonitor`,
`makePeriodicDrain`). Importar via array `scripts` del applet en `config.json`. **NO copiar el patrón
inline** — cada copia rompe los latches `window.__sa_dd_stopped` y la idempotencia entre applets
co-residentes.

En corridas largas, **el checkpoint va a IndexedDB, no a localStorage** (no aguanta), y el slim de
resultados no es cosmético: en miles de items **esa diferencia ES el OOM**. El guardrail al 88%
**detiene y guarda** (checkpoint antes que crash). Estado de adopción y anti-patrones:
[`docs/applets/memory-hardening-audit.md`](docs/applets/memory-hardening-audit.md).

## Procesos: construcción, ordenamiento y control
Toda la documentación del modelo de procesos vive en
[`docs/processes-architecture.md`](docs/processes-architecture.md): tipos de nodos, esquema GraphQL,
canon de 9 nodos top-level, construcción del árbol para `ProcureTree`, discovery por tag, glosario de
versiones de `process-canon`. **Antes de tocar `process-canon.js` o cualquier mutación de árbol,
leerlo.**

**`TX00` tiene DOS semánticas en el repo y no se contradicen (§6.1).** En el **filtro del board**
(`surtido-guard`) y en el **ruteador** (`auto-router`), `TX00` es un **ÁREA** y lo que importa es
**distinguir** sus células (`T300-CE03` Antitarnish ≠ `T300-CE05` Limpieza Especial son destinos
rivales). En **procesos**, el mismo código es un **SATÉLITE** —proceso auxiliar— y lo que importa es
**descartarlo** para quedarse con la línea real (`getLineCode("T300 (LES)-T204 (PLA)-…")` es `T204`).
Una pregunta es *«¿a cuál célula va el material?»*, la otra *«¿de qué línea es este proceso?»*.
Cubierto por `tools/test/process-line-code.test.js` y `tools/test/line-code-area-parity.test.js`
(trinquete que ata las dos implementaciones y fija el catálogo de las 28 líneas).

## Carga de applets: gate por URL
**Problema medido el 2026-07-27** (*"cada vez tardan más en cargar"*): `background.js` inyectaba los
28 applets `autoInject` en CADA carga, en serie, bajando el mismo archivo una vez por applet y
verificando la firma ECDSA de `config.json` **79 veces** ⇒ **~237 requests, 79 verificaciones de
firma y 79 `executeScript` por carga.** Solución: módulo puro
[`extension/applet-gate.js`](extension/applet-gate.js) con gate por `urlPatterns` (**fail-open**:
sin patrón, patrón vacío o regex inválida ⇒ se inyecta como siempre), dedup de archivos, `runPool` de
concurrencia 6, caché de código verificado y `loadConfig()` con TTL. En Compras: **28→3 applets,
79→6 archivos, 79→1 `executeScript`**.

**Dos reglas que salieron de aquí:**
1. **El gate por ruta obliga a atender la navegación SPA, y `tabs.onUpdated` NO sirve.** La detección
   correcta es **`content.js` sondeando `location.pathname`** (cada 400ms) y avisando al background:
   el content script corre en mundo **AISLADO**, así que parchear `history.pushState` ahí **NO ve**
   las llamadas del front — `location` sí. Las inyecciones se **serializan por pestaña** (si no, la
   carga dura y el aviso de navegación duplican applets) y el latch de "ya cargado" vive en la PÁGINA
   (`window.__saLoadedApps`), no en el service worker (MV3 lo suspende). El diseño fail-open permite
   apagar el gate con un deploy de config (los patrones se mueven a `urlPatternsDisabled`), sin
   republicar la extensión. Se reactiva **por canario**, y la prueba que importa es llegar a la
   pantalla **NAVEGANDO**, no recargando.
2. **`urlPatterns` solo se pone con evidencia** (26 de 28). **Dos se quedan SIN patrón a propósito**,
   con un test que se pone rojo si alguien los gatea: **`price-confirm-guard`** (es un CANDADO y la
   lista de pantallas de precio no es exhaustiva; un patrón incompleto lo apaga EN SILENCIO — los
   otros 3 de su familia sí se gatearon porque su falla es VISIBLE) y **`report-regen`** (el operador
   lo quiere en todas).

**Publicación:** requiere republicar la extensión, y el `.zip` debe ir en el **mismo commit de
gh-pages** que el config (`tools/deploy.sh --zip` valida `manifest.version == config.extensionVersion`,
empaqueta, y verifica el manifest DENTRO del zip SERVIDO). Cada máquina activa el loader nuevo al
aceptar el banner; hasta entonces usa el viejo, que ignora `urlPatterns` (retrocompatible).
Análisis completo en [`docs/architecture/applet-load-gating.md`](docs/architecture/applet-load-gating.md).

## Pendientes abiertos
Lista consolidada y **medida** de la deuda viva (hashes sin ruta, applets sin bitácora, inventario
del paquete de capacitación desfasado, propuesta del freno de masa, anclajes `css-*`, riesgos
operativos): [`docs/PENDIENTES.md`](docs/PENDIENTES.md). Levantada 2026-08-05.

## Índice de applets

**Versión viva + qué hace.** El estado detallado (lecciones, config vivo, hallazgos, pendientes) está
en [`docs/applets/README.md`](docs/applets/README.md); la bitácora profunda, en el link de cada
renglón. **Antes de tocar un applet, lee su bitácora.**

| Applet | Versión | Qué hace | Bitácora |
|---|---|---|---|
| `bulk-upload` | 1.5.42 | Carga masiva de cotizaciones y NPs desde plantilla `.xlsm` (v13: 5 rack types + Instrucciones de Empaque). El applet más grande del repo | [`bulk-upload.md`](docs/applets/bulk-upload.md) · [`v13`](docs/applets/bulk-upload-v13.md) |
| `auto-router` | 0.4.1 | Re-rutea OTs entre líneas; ruteo por grupos de piezas (pistas) y ✂️ partir/reagrupar desde el tablero | [`auto-router.md`](docs/applets/auto-router.md) |
| `surtido-guard` | 0.4.1 | Candado: bloquea mover piezas NO programadas del step de surtido + filtro por línea destino en el board | [`surtido-guard.md`](docs/applets/surtido-guard.md) |
| `wo-spec-params` | 0.6.0 | Alinea los parámetros de las specs de una OT con los del NP (5ª acción de Ajuste Masivo) | [`wo-spec-params.md`](docs/applets/wo-spec-params.md) |
| `pn-specs-column` | 0.3.3 | Columnas de specs/metal/racks/unidades al inicio del listado de NPs | [`pn-specs-column.md`](docs/applets/pn-specs-column.md) |
| `wo-listing-columns` | 0.8.2 | Columnas PN/Programación/Lote + botones de etiquetas PDF en el listado de OTs | [`wo-listing-columns.md`](docs/applets/wo-listing-columns.md) · [`pdf`](docs/applets/wo-label-pdf-buttons.md) |
| `wo-schedule-button` | 0.9.0 | Readout de programación en la ficha de OT + programar por tratamiento ancla | [`wo-schedule-button.md`](docs/applets/wo-schedule-button.md) |
| `batch-name-filter` | 0.3.1 | Selecciona de un jalón todos los lotes con un nombre exacto en el Panel de Envío | [`batch-name-filter.md`](docs/applets/batch-name-filter.md) |
| `packing-slip-drawings` | 0.3.0 | Adjunta los planos del NP al correo de la remisión (y delata en ámbar los NP sin plano) + imprime remisión y selección en un PDF | [`packing-slip-drawings.md`](docs/applets/packing-slip-drawings.md) |
| `driver-licenses` | 0.1.3 · **en producción** (`1.11.100`) · iPad `0.6.37` | Administra las identificaciones de choferes EXTERNOS y **publica el catálogo dentro del hook `pdf:SHIPMENT_TEMPLATE`** de SteelheadPowerTools (sustituye un condicional por chofer en la plantilla). Único applet que **publica código productivo**: relee del servidor, muestra diff, exige confirmación y aborta si los marcadores no están sanos. Pertenencia por **prefijo** `licencia-` en el nombre, no por carpeta (`CreateUserFile` no puede asignarla) | [`driver-licenses.md`](docs/applets/driver-licenses.md) |
| `schedule-batch-highlighter` | 0.2.0 | Resalta un lote en el Schedule Board y 📦 agrupa sus órdenes en una tarea | [`schedule-batch-highlighter.md`](docs/applets/schedule-batch-highlighter.md) |
| `po-listing-filters` | 0.4.0 | Buscador global de OC/proveedor/factura + toggle "Sólo Proquipa" | [`po-listing-filters.md`](docs/applets/po-listing-filters.md) |
| `invoice-autofill` | 0.5.67 | Autollena cliente/divisa/TC/CXC y la cuenta de ingreso por línea al crear factura | [`invoice-autofill.md`](docs/applets/invoice-autofill.md) |
| `invoice-auto-regen` | 0.5.37 | Regeneración automática de facturas | [`invoice-auto-regen.md`](docs/applets/invoice-auto-regen.md) |
| `cfdi-attacher` | 0.1.0 | Adjunta el XML del CFDI al correo de la factura (y delata en ámbar las facturas sin XML) | [`cfdi-attacher.md`](docs/applets/cfdi-attacher.md) |
| `report-regen` | 0.3.5 | Botón de regeneración de reporte con countdown, anclado al icono de correo | [`report-regen.md`](docs/applets/report-regen.md) |
| `price-confirm-guard` | 0.1.5 | Candado: exige reconfirmar el precio de un NP (tipo password) antes de guardar | [`price-confirm-guard.md`](docs/applets/price-confirm-guard.md) |
| `receiver-date-override` | 0.5.82 | Campo de fecha en el modal de recepción | [`receiver-date-override.md`](docs/applets/receiver-date-override.md) |
| `warehouse-location-prefill` | 0.6.4 | Prellena ubicación de almacén + candado que exige `locationId` en el payload | [`warehouse-location-prefill.md`](docs/applets/warehouse-location-prefill.md) |
| `weight-quick-entry` | 0.5.82 | Captura rápida de peso en todas las filas del modal de recepción | [`weight-quick-entry.md`](docs/applets/weight-quick-entry.md) |
| `load-calculator` | 0.2.0 | Calculadora de piezas por carga (cuadrícula/área/barril) + configurador de estaciones | [`load-calculator.md`](docs/applets/load-calculator.md) |
| `spec-migrator` | + `validate-duplicate-params` 0.5.5 | Bundle "Ajuste Masivo de Specs": validar duplicados, asignar pendientes, normalizar falsos pendientes | [`spec-migrator.md`](docs/applets/spec-migrator.md) |
| `spec-params-bulk` | 0.9.0 | Alta masiva de parámetros de spec | [`spec-params-bulk.md`](docs/applets/spec-params-bulk.md) |
| `pn-lifecycle` | 0.2.0 | Ciclo de vida de NPs: marcar/quitar validación, desarchivar, borrado definitivo (escanear o pegar IDs) | [`pn-lifecycle.md`](docs/applets/pn-lifecycle.md) |
| `file-uploader` | 0.5.1 | Carga masiva de fotos a NPs con convención `<PN>_<VISTA>_<num>` | [`file-uploader.md`](docs/applets/file-uploader.md) |
| `create-order-autofill` | 0.1.8 | Autollena el modal de creación de OV / Sales Order | [`create-order-autofill.md`](docs/applets/create-order-autofill.md) |
| `vale-almacen` | 0.1.0 | Vale de almacén: emite evento de mantenimiento con líneas artículo+cantidad+usuario | [`vale-almacen.md`](docs/applets/vale-almacen.md) |
| `wo-completer` | 0.1.0 | Completar/Descompletar OTs en masa | [`wo-completer.md`](docs/applets/wo-completer.md) |
| `wo-mover` | 0.2.0 | Reasigna el encabezado de OTs entre OVs (la parte/PT se asocia manual) | [`wo-mover.md`](docs/applets/wo-mover.md) |
| `archiver` | 1.0.0 | Archivado masivo con filtro por etiquetas AND/OR | [`archiver.md`](docs/applets/archiver.md) |
| `process-deep-audit` | 0.8.0 | Auditoría profunda de árboles de proceso | [`process-deep-audit.md`](docs/applets/process-deep-audit.md) |
| `proceso-calculator` | 0.1.5 | Calculadora sobre el proceso default de un NP | [`proceso-calculator.md`](docs/applets/proceso-calculator.md) |
| `unit-autoconvert` | 0.1.1 | Autoconversión de unidades por pieza en el modal de definiciones | [`unit-autoconvert.md`](docs/applets/unit-autoconvert.md) |
| `sensor-status-autofill` | 0.5.58 | Autollena estatus de sensores | [`sensor-status-autofill.md`](docs/applets/sensor-status-autofill.md) |
| `sensor-graph-hide-all` | 0.2.0 | Al entrar a un Sensor Dashboard esconde todos los sensores + combo para aislar uno | [`sensor-graph-hide-all.md`](docs/applets/sensor-graph-hide-all.md) |
| `hash-scanner` | 0.6.24 | Captura hashes de persisted queries navegando la app (degrada las muestras, no las descarta) | [`hash-scanner.md`](docs/applets/hash-scanner.md) |
| `process-canon` | varios | Canon de nodos de proceso (helper compartido) | [`processes-architecture.md`](docs/processes-architecture.md) |
| `bill-autofill` | 0.1.0 | Autollena cuenta AP, divisa, TC y cuentas de gasto al crear un Bill (aprende de selecciones previas) | [`bill-autofill.md`](docs/applets/bill-autofill.md) |
| `inventory-reset` | 0.1.0 | Archiva los lotes activos y carga inventario nuevo desde CSV | [`inventory-reset.md`](docs/applets/inventory-reset.md) |
| `invoice-default-tab` | 0.1.0 | Al entrar a /Invoices sin `mode=`, navega solo al tab Packing Slips | [`invoice-default-tab.md`](docs/applets/invoice-default-tab.md) |
| `paros-linea` | 0.1.0 | Botón flotante Andon: registra paros de línea con cronómetro y evidencia | [`paros-linea.md`](docs/applets/paros-linea.md) |
| `po-reconciler` | 0.1.0 | Rebalancea OVs temporales contra POs reales de Schneider QRO (lee los PDF) | [`po-reconciler.md`](docs/applets/po-reconciler.md) |
| `report-liberator` | 0.1.0 | Saca reportes de sus carpetas en masa (`folderId = null`) | [`report-liberator.md`](docs/applets/report-liberator.md) |
| `wo-deadline` | 0.1.0 | Cambia plazos y etiquetas de OTs en masa (script: `wo-deadline-changer.js`) | [`wo-deadline.md`](docs/applets/wo-deadline.md) |
| `auditor` | 0.1.42 | Audita NPs contra criterios de calidad + duplicados por similitud (ejemplo canónico de memory hardening) | [`auditor.md`](docs/applets/auditor.md) |
| `invoice-listing-marker` | 0.1.0 | Marca en el listado de facturas las notas de crédito, los montos cero y los borradores | [`invoice-listing-marker.md`](docs/applets/invoice-listing-marker.md) |
| `po-comparator` | 0.1.0 | Lee el PDF de la OC y lo compara línea por línea contra la OV (motor que reusa `po-reconciler`) | [`po-comparator.md`](docs/applets/po-comparator.md) |
| `portal-importer` | 0.1.0 | Importa el XLS de los portales de clientes (Hubbell y otros) y crea las OVs | [`portal-importer.md`](docs/applets/portal-importer.md) |
| `integrity-tiers` | 1.5.3 | Módulo `duplicate-tiers.js` + UI en `auditor` + tier scan | [`integrity-tiers.md`](docs/applets/integrity-tiers.md) |

**Tools standalone (DevTools, NO son la extensión — se pegan en consola una vez):**

| Tool | Versión | Qué hace | Bitácora |
|---|---|---|---|
| `marcar-usepartcount-productos` | 1.0.0 | Marca `usePartCountForQuantity` en los 83 Productos (GLOBALES, no por dominio) | [`marcar-usepartcount-productos.md`](docs/applets/marcar-usepartcount-productos.md) |
| `archive-inventory-batch-statuses` | 1.0.0 | Archiva estatus de lote + detector de lotes en uso | [`archive-inventory-batch-statuses.md`](docs/applets/archive-inventory-batch-statuses.md) |
| `wb-produccion-access` | 1.0.0 | Da acceso al WB Producción por unión con el acceso actual | [`wb-produccion-access.md`](docs/applets/wb-produccion-access.md) |
| `dual-source-recovery` | 1.0.2 | Recuperación dual-source preservando Title Case | [`dual-source-recovery.md`](docs/applets/dual-source-recovery.md) |
| `audit-incomplete-pns` | fix-2026-05-25 | Auditoría de NPs incompletos + tier scan | [`audit-incomplete-pns.md`](docs/applets/audit-incomplete-pns.md) |

**Power Tools / Low-Code (`.ts`) — YA NO viven aquí.** Se movieron el 2026-06-16 al repo dedicado
**`SteelheadPowerTools`** (hermano de este repo; backup en `github.com/oviazcan/SteelheadPowerTools`):
hooks `.ts`, lógica pura espejada + tests, `lowcode_sync.py` y las bitácoras `powertools-*`.

## Bundle Safari / iPad
El iPad es **el dispositivo del piso**: el almacén recibe y surte desde ahí, y la planificación
también. Un applet roto en el bundle duele más que en escritorio.

Al integrar applets al bundle usa la skill **`safari-bundle-sync`**. Reglas duras:
- `safari/bundle.json` y `safari/extension/main-bundle.js` son **hot files** (ver §Trabajo paralelo).
- **`main-bundle.js`/`manifest.json` son ARTEFACTOS**: se regeneran con `tools/build-safari.sh`, nunca
  se editan ni se resuelve su conflicto a mano.
- **Verifica en el ARTEFACTO, no en el log**: `build-safari.sh` imprime **caracteres, no bytes** (un
  bundle "encogió" de 1483650 a 1462283 sin haberle quitado nada). Cuenta los símbolos nuevos con
  baseline 0 antes del rebuild, compara bloques `BEGIN/END` y corre `node --check`.
- **Criterio NO-APLICA**: un applet se excluye solo cuando su **flujo core** es la descarga de
  archivos (auditor, carga-masiva, file-uploader). Si la descarga es una función lateral y opt-in
  (p. ej. el PDF de `wo-listing-columns`), el applet **sí** va al bundle.
  **DESCARGAR ≠ SUBIR, y el criterio es sólo la descarga.** `driver-licenses` (bundle 0.6.32) toca
  archivos y aun así entra: su única interacción es `<input type="file" accept="image/*">`, que en
  iPadOS **abre la cámara** — el iPad no es un sustituto pobre del escritorio, es el mejor lugar
  para tomar la foto de la identificación del chofer, en el andén. Ver un `input[type=file]` y
  asumir NO-APLICA es el error a evitar.
- **TERCERA VÍA — integrar SIN sus librerías** (`excludeScripts` en `bundle.json`, 2026-08-05). Cuando
  lo pesado o lo prohibido está en una **librería** y no en el flujo core, el applet entra y la
  librería no. Nació con `packing-slip-drawings`: `pdf.js`+`pdf-lib` pesan 902 KB **y** el worker de
  `pdf.js` **se descarga en runtime** ⇒ **código remoto, prohibido por la Guideline 2.5.2** (la razón
  misma de que el bundle sea estático). Excluidas: **+63 KB en vez de +962 KB**, perdiendo sólo
  impresión y miniaturas de PDF. **Requisito: el applet debe DEGRADAR SOLO sin la librería**
  (`hayPdfLib()`/`hayPdfJs()` ocultan el botón y evitan canvas vacíos) — el build **no lo valida**.
  Ofrecer un botón que falla es peor que no ofrecerlo.
- La rotación de hashes **no** requiere rebundle (el bridge refresca `config.json` en runtime); un
  cambio que solo toca `extension/` de Chrome tampoco (Safari tiene su propio popup).
- **Modo de Aislamiento (Lockdown Mode) de iPadOS debe quedar APAGADO** — verificado en piso: con él
  activo `app.gosteelhead.com` **ni carga**. No confundir con el **Modo Desarrollador**, que va ON.
- Tras cada rebundle queda **recompilar en Xcode** (`Resources/` sincronizado ≠ compilado).

Estado vivo, historial de versiones e inventario: [`safari/README.md`](safari/README.md) ·
[`docs/architecture/ipad-applets-inventory.md`](docs/architecture/ipad-applets-inventory.md) ·
[`docs/deploy-safari.md`](docs/deploy-safari.md).

## Paquete de documentación para clientes (`docs/training/`)
Material didáctico HTML self-contained para **Ecoplating** (Key User + Jefe de TI), 16 documentos,
generado con la skill `steelhead-docs-package`. **No es bitácora técnica** — es lo que el cliente lee.
Entrada: `docs/training/00-mapa-empieza-aqui.html`.

**`guia-plantilla-v13.html` NO se edita a mano: se GENERA** con `tools/build-guia-v13.js` desde
`guia-plantilla-v13.src.html` + **la plantilla `.xlsm` real** —encabezados, tipos, valores iniciales
y las bandas de grupo de la fila 6 se leen del archivo, no se transcriben—. Al cambiar el layout se
re-corre. Mismo principio en la hoja `Ayuda` de la plantilla (`tools/rebuild-ayuda-sheet.js --text`):
**la doc que describe un layout se deriva del layout, o se desfasa** — esa hoja llevaba versiones
describiendo el v10 dentro de las plantillas v13.

**Publicación:** los TRES paquetes de la familia viven en el `gh-pages` de ESTE repo, en carpetas
separadas — `training/` (Automator) · `reportes-sh/` · `powertools/`. Se publican **copiando el HTML
al worktree de `gh-pages`**; el `pre-push` reconoce el push solo-docs y NO exige bump de versión
(mensaje `✓ pre-push: push solo-docs`). **NO usar `tools/deploy.sh`** para esto: publica desde el
working tree de `main` y arrastraría WIP ajena bajo `remote/`.

**Documentos TRANSVERSALES (idénticos byte-a-byte en los 3 paquetes)** — al tocar uno hay que
re-copiarlo a los tres y republicar los tres: `repos-y-mantenimiento.html` ·
`manual-arquitectura.html` · `catalogo-mantenimiento.html`.

**Vigía externo del hash-autopilot (fácil de declarar inexistente por error):**
`run-hash-autopilot.sh` (`emit_heartbeat`) empuja un commit huérfano a la rama `ops/heartbeat` en
CADA corrida, y `.github/workflows/heartbeat-watchdog.yml` lo vigila **desde la nube** (cron
`17 */2 * * *`): si el latido pasa de 3 h abre un issue, y lo cierra solo al revivir. Vive fuera de la
Mac **por diseño** — un vigilante en la misma máquina moriría con lo que vigila. **`escalation` y
`weekly_snapshot` NO emiten latido**: esos sí se detienen en silencio. Detalle en
`tools/hash-autopilot/README.md § Watchdog de latido`.

**Titularidad:** de 10 dependencias externas, **5 están hoy a nombre del consultor** (repos GitHub,
GitHub Pages `oviazcan.github.io`, el workflow del vigía, la cuenta Apple del bundle iPad, y el equipo
que corre los 3 procesos programados con `launchd` y rutas `/Users/oviazcan/…`). Los avisos
automáticos —correo del autopilot e issue del vigía— llegan al consultor, no a Ecoplating. Ninguna
migración requiere reescribir código.

## Archivos scan_results
- Los `scan_results_*.json` del hash-scanner se descargan a `~/Downloads`.
- **NUNCA** copiarlos al repo — están en `.gitignore` pero además pueden incluir payloads sensibles.
- Cuando necesites analizarlos, léelos directamente desde `~/Downloads/scan_results_*.json`.
- El hash-scanner sanitiza variables (redacta tokens URL, keys sensibles, trunca strings largas),
  pero la defensa en profundidad manda: no los muevas al repo.

## Seguridad — resumen

**Implementado:** sanitización key-level recursiva en `hash-scanner` (variables, respuestas y
errores) · `.gitignore` cubre `scan_results_*.json` y `~$*.xlsm/xlsx` · historial git purgado.

**Pendientes del audit pre-producción** (detalle, evidencia y estado por ítem en
[`docs/architecture/security-status.md`](docs/architecture/security-status.md)):
1. **Integridad de scripts remotos (ALTO) — Fases 0/1/2 HECHAS.** `background.js` ejecutaba
   `new Function(c)()` sobre código de GitHub Pages sin verificar. Ahora: firma **ECDSA P-256** con la
   privada en **GCP KMS del cliente** (handoff = cambio de IAM), verificación fail-closed y pública
   embebida. **Único pendiente: rollout gradual** — cada máquina activa el fail-closed al actualizar
   el zip; las que no actualizan siguen fail-open (break-glass por popup). Bitácora:
   [`docs/applets/security-integrity-signing.md`](docs/applets/security-integrity-signing.md).
2. **XSS vía `innerHTML` (MEDIO) — HECHO.** 32 sitios de riesgo alto escapados con `escHtml` (nombres
   de PN/spec/cliente que vienen de GraphQL = vector cross-user).
3. **Plan de rollback (MEDIO) — HECHO.** Tags por bump + `tools/rollback.sh`.
4. **CSP explícito (BAJO) — HECHO** (requiere republicar el `.zip` para efecto).
5. **`console.log` en producción (BAJO) — HECHO** (gate central por flag `sa_debug`; `warn` intacto).
6. **Anclajes bilingües (audit) — MAPA COMPLETO; hardening bloqueado por evidencia.** 25 anclajes
   mono-idioma en 12 applets. **No se hardeniza sin el string real del otro locale** (regla dura: no
   adivinar). **2026-08-05: 3 salieron de la lista con evidencia MEDIDA** — `Show Spec`,
   `Archive Parameter` y `Edit Spec Field Parameter` aparecen **en inglés** en un DOM productivo con la
   UI **en español** (la misma fila trae `Cambiar Nodo de Proceso` y `Copiar arriba`): SH **no** los
   traduce, así que su anclaje mono-idioma es correcto. Que traduzca unos sí y otros no **dentro de la
   misma tabla** es la prueba de que no hay patrón que adivinar — hay que mirar.
   Ver [`docs/architecture/bilingual-anchoring-debt.md`](docs/architecture/bilingual-anchoring-debt.md).
7. **Memory-hardening audit por applet — HECHO.** 9 ADOPTADO, 5 PARCIAL, 2 NO-ADOPTADO
   (`portal-importer`, `po-comparator`).

**Los cambios de `extension/` NO se despliegan a la Chrome Web Store por diseño**: la extensión
inyecta código remoto (`new Function`), incompatible con las políticas de MV3/CWS. Quedan en el repo
sin desplegar hasta que cambie esa arquitectura; **no es un pendiente accionable hoy.**

**No aplica por arquitectura:** auth / sessions / HTTPS / DB / CORS / rate limiting / bcrypt /
backups / migrations — no hay backend propio; consumimos Steelhead GraphQL vía cookies de sesión del
navegador. Checklist completa pre-producción en `~/.claude/CLAUDE.md` (global del usuario).
