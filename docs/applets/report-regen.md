# Applet: `report-regen` (Regenerar Reportes)

**Versión actual:** 0.3.5
**Archivo:** `remote/scripts/report-regen.js` (+ núcleo compartido `mui-icon-anchor-core.js`)
**Tipo:** `autoInject` + acción de popup. Inyecta un botón en el header secundario de Steelhead.
**Permiso requerido:** `MANAGE_REPORTING_SETTINGS` (gating en runtime, no sólo popup).

## 0.3.5 (2026-08-03) — SH quitó los `data-testid`, y el ancla al ▶ era un bug nuestro

**Reporte de piso: «el que no me carga es el botón de regenerar reportes».** Llegó justo después de arreglar el modal de recepción, y resultó ser **el mismo despliegue de SH** con otra cara.

- **El gate de permisos NO era la causa, y esta vez se supo en la primera medición.** El applet ya expone `debug()` —justo la lección que dejó la 0.3.4: *cuando tres arreglos plausibles no mueven el síntoma, deja de proponer arreglos y haz OBSERVABLE el estado interno*— y dijo de inmediato: `allowed: true`, `booted: true`, `observer: true`, **`anclaEncontrada: false`**. Tres cuartas partes del árbol de causas se cortaron con una sola llamada. **Esa inversión se pagó sola.**
- **Causa raíz: Steelhead publicó un build que ELIMINA los `data-testid` de los iconos MUI.** Medido en tres pantallas distintas, todas cargadas y con contenido real: `/Reporting/View` (189 svg), `/Receiving/CustomerParts` (159 svg) y la lista de reportes → **0 `[data-testid]`** en cada una (los `data-steelhead-component-id` **siguen vivos** — 38 en la ficha de OT, 40 en la de NP; decir que también los eliminaron fue una sobregeneralización corregida el mismo día). Los únicos dos testid que sobreviven en toda la app (`sentinelStart`/`sentinelEnd`) los pone **react-virtuoso**, no SH.
- **Es el MISMO evento que rehasheó las clases de emotion** y tumbó a `receiver-date-override` y `warehouse-location-prefill` el mismo día: un solo despliegue de SH que se llevó **dos de los tres niveles de anclaje estructural** del repo.
- **El modo de falla vuelve a ser mudo, y aquí por una razón de diseño legítima:** `findAnchor()` devolviendo `null` significa «esta vista no tiene el header», que es el caso normal en casi toda la app. Así que el applet no tenía por qué quejarse — y no se quejó. Ahora hay un `warnOnce` para el caso en que falte el core.
- **EL FIX ANCLA AL CORREO, NO AL PLAY — y eso corrige un bug ANTERIOR al cambio de SH.** El diseño inicial de este fix seguía exigiendo el ▶, hasta que el operador corrigió el modelo: **«el botón de play a veces cambia por uno de pausa, cuando tienes un timer activo; mejor ánclalo al del correo o al de ver documentos, más estable»**. Tenía razón, y la consecuencia es retroactiva: el `findAnchor` original exigía `PlayArrowIcon`, así que **el botón ya desaparecía cuando había un timer corriendo**, desde antes. Un bug latente que sólo se ve desde el piso, no desde el código.
- **Se ancla por la FORMA del icono (`path d`), con el `data-testid` como primera opción.** Un anclaje no se cambia, se **AMPLÍA**: si SH repone los testid, el applet los usa; si no, cae a la forma. Lo que SH no puede quitar sin cambiar lo que el operador VE es el dibujo del icono. El `by` (`'testid'` \| `'shape'`) se devuelve y se puede leer desde `debug()` — así se sabe **por qué** se encontró, y se detecta el día que SH reponga o vuelva a quitar los atributos.
- **El correo es requisito; breadcrumb y play/pausa sólo CONFIRMAN.** Medido: hay **un solo sobre en toda la página**, así que identifica el header sin ambigüedad. La confirmación evita montar el botón en cualquier header que tenga un sobre, y usa `nav[aria-label="breadcrumb"]` — valor técnico que SH **no traduce** (verificado con la UI en español). Ninguna de las dos señales puede NEGAR: si faltan ambas no se monta (fail-safe), pero un ⏸ en lugar de ▶ ya no apaga nada.
- **El path del ⏸ es el canónico de MUI, NO medido en vivo** (al inspeccionar no había ningún timer corriendo). Por eso el pausa entra sólo como señal que afirma: si su path fuera otro, el breadcrumb sostiene el anclaje igual. Queda anotado como lo único de este fix que no se verificó contra el DOM real.
- **VALIDADO END-TO-END EN VIVO con el código deployado** (config 1.11.54, tag `v1.11.54`): `version: 0.3.5 · allowed: true · anclaEncontrada: true · botonEnDOM: true`, **`by: 'shape'`** (confirmando que el testid ya no está y que es el fix lo que lo salva), botón visible de 62×20 con su countdown real `02:22` y el tooltip *«Última regeneración: 03 ago 2026, 05:29 p.m. (hace 12 min)»*. Orden final del header: `NAV │ Ver Documentos │ ▶ │ NUESTRO │ ✉ 99+`. Núcleo `mui-icon-anchor-core.js` **15 golden**; suite 92 archivos verdes. Bundle iPad **0.6.21** (verificado en el artefacto; falta recompilar en Xcode).

## Qué hace

Steelhead refresca su base de reportes (DuckDB) cada noche, pero también se puede forzar
manualmente — sólo que el botón nativo está enterrado 3-5 clicks. Este applet expone un
botón **♻️** en la barra de breadcrumb (junto a los iconos play ▶ y correo ✉) que dispara la
regeneración con un click, muestra el progreso, y arranca un timer de enfriamiento.

## v0.3.4 (2026-07-27) — LA CAUSA RAÍZ: Steelhead fragmentó el permiso ✅ VALIDADO EN VIVO

> **El operador confirmó que el botón ♻️ volvió a aparecer** tras el deploy de config 1.7.225.
> Cierra el reporte "de pronto dejó de aparecer".

Con el `debug()` de la v0.3.3 el operador reportó:

```
allowed: false · permsConocidos: true · capturedPerms.perms: Array(245)
isAdmin: false · isSuperUser: false · anclaEncontrada: true · gateTimedOut: true
```

O sea: la lista **real** de permisos llegó completa (245) y `MANAGE_REPORTING` **no estaba**.
El veredicto `false` era **correcto**. El gate llevaba días diciendo la verdad; lo que estaba
mal era **el permiso que exigía**.

Verificado contra el catálogo vivo (`/Users/Access/PermissionsReference`, 262 permisos):

| | |
|---|---|
| `MANAGE_REPORTING` | **ya no existe** |
| `MANAGE_REPORTING_SETTINGS` | *"Admin-level reporting actions: **regenerate the reporting database**, view and change reporting settings."* ← el correcto, y el operador SÍ lo tiene |

Steelhead **fragmentó** `MANAGE_REPORTING` en cinco permisos granulares
(`_CONFIGURATIONS`, `_CUSTOM`, `_DASHBOARDS`, `_FILTER_SETS`, `_SETTINGS`) y retiró el viejo.
**Esa es la causa real del "de pronto dejó de aparecer"**: no fue una carrera ni el DOM ni el
Apollo cache — fue un permiso fantasma. Un permiso que no existe nunca se cumple, así que el
botón quedó invisible para todos, **en silencio e indistinguible de "no tienes permiso"**.

El mismo barrido encontró otros dos: `report-liberator` (mismo permiso) y `bill-autofill`
(`READ_ACCOUNTS_PAYABLE`, hoy `READ_BILLS`).

**Prevención:** el catálogo quedó versionado en
[`docs/api/permissions-catalog.json`](../api/permissions-catalog.json) y
`tools/test/permissions-catalog.test.js` pone rojo cualquier `requiredPermissions` que no
exista en él. La próxima vez que Steelhead renombre algo, se re-captura el catálogo y el test
señala exactamente qué applet quedó pidiendo un fantasma.

**Lección.** Las v0.3.1–0.3.3 arreglaron cosas reales (el `false` espurio desde `Profile`, el
fail-closed sin veredicto, el observer tardío) pero **ninguna era la causa**. Lo que cerró el
caso no fue otra hipótesis: fue **exponer el estado interno** (`debug()`) y mirarlo. Cuando
tres arreglos plausibles seguidos no mueven el síntoma, deja de proponer arreglos y haz
observable el estado.

## v0.3.2 (2026-07-27) — la causa REAL: "no sé qué permisos tiene" se leía como "no tiene"

La v0.3.1 no bastó: el operador reportó `report-regen: '0.3.1'` con `botón ♻️: false`.

**Causa.** `onUserData` normalizaba las capacidades así:

```js
const partial = { isAdmin: !!u.isAdmin, isSuperUser: !!u.isSuperUser };
if (source === 'CurrentUser' && ...) partial.perms = u.currentManagedPermissions;
capturedPerms = Object.assign({ isAdmin: false, isSuperUser: false, perms: [] }, ...);
```

`Profile` trae `isAdmin`/`isSuperUser` pero **no** la lista de permisos. Ese `perms: []` por
defecto hacía que `evalAllowed` concluyera **`false`** para cualquier usuario no-admin: un
**"no" espurio**, porque la lista estaba **ausente**, no vacía. Y con `allowed === false` el
applet llama `removeButton()`.

**Este bug ya existía en 0.3.0** — es la causa de que el botón desapareciera. La v0.3.1 lo
**empeoró**: al persistir el veredicto, ese "no" falso quedaba grabado en `localStorage` y
bloqueaba el botón **para siempre**, en vez de solo hasta la siguiente carga.

**Fix.**
- `evalAllowed` devuelve **`null` (desconocido)** cuando no hay lista de permisos y el usuario
  no es admin/superuser. Sólo devuelve `false` con una lista **real** que no contiene el
  permiso. *Ausente ≠ vacío.*
- `onUserData` deja de inventar `perms: []`; la lista sólo existe si de verdad llegó.
- La clave de memoria se versiona a `sa_rr_perm_v2` y se **borra la vieja**, para que el "no"
  envenenado que la 0.3.1 pudo grabar no siga bloqueando el botón.

Con esto, un `Profile` de no-admin ya no descarta nada: el gate espera, y si no llega un
veredicto real, el timeout de v0.3.1 monta el botón igual.

**Lección.** Un test previo fijaba `evalAllowed: perms ausente se trata como []` → `false`.
Estaba **codificando el bug como si fuera la intención**. Un test verde no prueba que el
comportamiento sea correcto: prueba que es el que alguien escribió.

## v0.3.1 (2026-07-27) — el botón "de pronto dejó de aparecer": el gate se comía a sí mismo

Reporte del operador. Diagnóstico en vivo con el applet cargado (0.3.0):

```
applet: 0.3.0            ← carga bien
botón en DOM: false      ← pero no se monta
ancla del header: ✅      ← el ancla NO es el problema
Apollo expuesto: false   ← ¡el fallback nunca sirvió!
```

**Causa.** El gating v0.2.0 tenía dos vías para conocer los permisos, y en producción
**ninguna funciona de forma confiable**:

1. **Sniffer de `fetch`** — solo caza respuestas de `CurrentUser`/`Profile` que el front pida
   **después** de que el applet ya está montado. Pero el front las pide **al arrancar la SPA**,
   antes de que la extensión inyecte nada. La ventana casi siempre está cerrada.
2. **Apollo cache** — `window.__APOLLO_CLIENT__` **no está expuesto** en el front de producción
   (verificado en vivo). Además se intentaba **una sola vez**, sin reintentos.

Sin ninguna de las dos, `allowed` se quedaba en `null` para siempre y, siendo **fail-closed**,
el botón no se montaba nunca.

**Por qué "de pronto".** Es una carrera, y su probabilidad venía creciendo con el número de
applets: `report-regen` era el 6º de 28 inyectados **en serie**, detrás de 79 descargas y 79
verificaciones de firma ECDSA (ver [`../architecture/applet-load-gating.md`](../architecture/applet-load-gating.md)).
No dejó de funcionar de golpe: fue perdiendo la ventana cada vez más seguido. **Mismo problema
raíz que el gate de carga.**

**Fix.** Función pura `decideGate(caps, req, remembered, timedOut)` con dos apoyos que no
dependen de la carrera:

- **Memoria** (`localStorage.sa_rr_perm`): el último veredicto **real** conocido en ese
  navegador. Basta una carga afortunada para que el botón aparezca siempre desde entonces.
- **Timeout** (5s): sin ningún dato, se monta igual. Es coherente con lo que el applet **ya
  hacía al ejecutar** (`triggerFromPopup` procede con `allowed === null` tras su espera,
  *"el server valida el permiso al ejecutar"*): **la autoridad es el servidor, no este gate**.

Un `false` **real o recordado siempre gana** — si se supo que el usuario no tiene el permiso,
no se monta. El peor caso pasa de *"nadie ve el botón"* a *"alguien sin permiso ve un botón que
el servidor le rechaza"*. Solo se recuerda el veredicto real, nunca la decisión del timeout.

4 golden tests nuevos (`tools/test/report-regen.test.js`, 31/31).

## El insight clave: el timer es GLOBAL del domain, server-side, sin backend propio

El cooldown **no es local ni inventado**. Steelhead lo impone server-side:

- `GetRecomputableAt` → `{ recomputableAt, transactionTime }`. `recomputableAt` es el instante
  a partir del cual el domain puede volver a regenerar. `transactionTime` es la hora del servidor.
- Cuando **cualquier usuario** del domain regenera, el servidor mueve `recomputableAt` al futuro
  **para todos**.

Por eso "todos ven el timer" se logra **leyendo ese estado del servidor por polling**, no
compartiendo estado entre navegadores. No hay Firebase ni backend propio: el estado autoritativo
ya vive en Steelhead.

## Operaciones GraphQL (persisted queries)

Hashes portados del proyecto **Reportes SH** (`scripts/steelhead_client.py`), registrados en `config.json`:

| Operación | Tipo | Variables | Respuesta usada |
|---|---|---|---|
| `GetRecomputableAt` | query | `{}` | `getDuckdbRecomputableAt.{recomputableAt, transactionTime}` |
| `GenerateDuckDb` | mutation | `{maxAttempts:3}` | `addWorkerTask.bigInt` (taskId) |
| `JobQuery` | query | `{jobId}` | `getJobStatus.{isDone, errorMessage, runAttempts, maxRunAttempts}` |
| `CurrentUser` | query | `{deviceLocationIds:[]}` | `currentSession.userByUserId.{isAdmin, isSuperUser, currentManagedPermissions}` |

Hashes (al 2026-06-15):
- `GenerateDuckDb`: `8f29d420…65eaa0`
- `GetRecomputableAt`: `2da42344…6618e`
- `JobQuery`: `e287b88e…6b36e`

## v0.3.0 — tooltip "última regeneración" en el hover del botón

Al pasar el mouse por el botón ♻️, el `title` nativo muestra —además del texto del estado— la
**fecha-hora de la última regeneración del domain** y su antigüedad relativa
(ej. `Última regeneración: 02 jul 2026, 03:45 p.m. (hace 2 h)`). Es el dato **server-side real**,
no local: se lee de `JobQuery` (persisted query que el applet ya usa), en el campo
`currentSession.userByUserId.domainByDomainId.latestDuckdbFileCreatedAt` (el mismo que consume
`regenerate_duckdb.py` de Reportes SH en `read_state`).

- **Cómo se obtiene sin job propio:** `JobQuery({ jobId: null })` → `extractLatestGeneratedAt` lee
  `latestDuckdbFileCreatedAt`. Se guarda en `lastGeneratedAt`. Cuando hay job propio activo, el
  `pollJobOnce` existente ya trae ese campo en la misma respuesta (no se duplica la llamada).
- **Costo de red:** en estado `available` (poll cada 60s) se agrega 1 `JobQuery({jobId:null})` por
  poll → 2 queries/min, trivial. En `regenerating`/`cooldown` se reusa el `JobQuery` del job.
- **Fecha absoluta** vía `toLocaleString('es-MX', …)` (horario local del operador); **antigüedad
  relativa** anclada al reloj del servidor (`Date.now()+skewMs`) con `formatRelativeAge`
  (buckets min/h/d). Ambas puras y testeadas (`formatLastGenerated`, `formatRelativeAge`,
  `extractLatestGeneratedAt` en `_internals`; 8 tests nuevos).
- **Fail-safe:** si la respuesta no trae el campo (o la query falla transitoriamente), el tooltip
  simplemente omite la línea de última regeneración — no rompe el botón ni su estado.
- **Por qué `title` nativo y no una tooltip dark-mode propia:** el botón YA comunica todos sus
  estados vía `btn.title`. Un `title` sobre NUESTRO propio botón no es UI que se pueda confundir con
  la nativa de SH (la regla de dark-mode aplica a modales/paneles/popovers inyectados). Se mantiene
  la consistencia con el resto del applet.

## Gating de permisos (lección de arquitectura)

`autoInject` **NO respeta `requiredPermissions`** — eso sólo gatea qué apps se muestran en el
popup (`popup.js:123-137`). El loop de auto-inject (`background.js:135-158`) inyecta todos los
`autoInject:true` habilitados, sin mirar permisos.

Por eso este applet **se auto-gatea en runtime**: sólo se monta (inyecta botón + arranca polling)
si el usuario tiene `MANAGE_REPORTING` (o es admin/superuser).

### v0.2.0 — gating reactivo (NO llamar `CurrentUser`)
**Lección clave:** `CurrentUser` es **session-sensitive** — rechaza el fetch de la extensión con
`400 "Must provide a query string"` aunque el hash sea válido (sólo acepta el Apollo client del front;
está en `hash-validator-whitelist.json`). v0.1.0 llamaba `CurrentUser` directo → fail-closed permanente,
el botón nunca aparecía. (Por eso el gating del popup tampoco funcionaba nunca: cae a fail-open.)

v0.2.0 **no llama `CurrentUser`**; en su lugar **intercepta la respuesta que el propio front hace**:
- Parchea `window.fetch` UNA vez (latch `window.__saRRSnifferInstalled`), siempre delegando al hook
  `window.__saRRonUser` (re-conectable por el closure actual → robusto a re-inyección/bump).
- Captura `CurrentUser` (perms completos: `currentManagedPermissions`) y `Profile` (sólo
  `isAdmin`/`isSuperUser`, llega antes — count altísimo). Merge sin pisar perms ya capturados.
- Fallback inmediato `tryApolloCache()`: si el front expone `window.__APOLLO_CLIENT__`, lee del cache.
- `reevaluateGate()` recalcula `allowed` (vía `evalAllowed`, función pura testeada) y monta/desmonta el botón.

- **Fail-closed:** mientras no se confirme el permiso, no hay botón. El front pide `CurrentUser`/`Profile`
  seguido → para un admin (vía `Profile`) llega en segundos; para no-admin con `MANAGE_REPORTING`, al llegar `CurrentUser`.
- El permiso requerido se lee de `window.REMOTE_CONFIG.apps[report-regen].requiredPermissions` (respeta overrides del popup).
- **El gating de cliente es UX, no seguridad.** El boundary real es server-side: Steelhead rechaza
  `GenerateDuckDb` si la sesión no tiene el permiso. `triggerFromPopup` espera ~3s a confirmar; si no resuelve, confía en el server.

El botón del popup queda gateado por el mecanismo existente del popup (filtra por
`managedPermissions`), que es **fail-open** si no logra leer permisos — pero `triggerFromPopup`
revalida en runtime (fail-closed) antes de disparar.

## Anclaje DOM (header secundario)

Regla: el botón aparece **siempre que play ▶ y correo ✉ aparezcan** (el usuario confirmó que son
persistentes; lo que cambia es la parte izquierda del breadcrumb).

- **Ancla:** el contenedor que tiene `svg[data-testid="EmailOutlinedIcon"]` Y
  `svg[data-testid="PlayArrowIcon"]` como hermanos (`findAnchor`). Se usan `data-testid` (estables
  de MUI) y nunca las clases `css-*` hasheadas (rotan).
- **Inserción:** justo **antes del botón de correo**, con un separador clonado del nativo
  (`emailBtn.previousElementSibling.cloneNode(true)`) para match visual sin hardcodear el `css-zaq8x8`.
  Resultado: `[play][sep][♻️][sep][correo]`.
- **Persistencia SPA:** `MutationObserver` en `document.body` (debounce 300ms) re-inyecta si el
  header se re-renderiza. Idempotente por `getElementById(BTN_ID)`.

## Máquina de estados del botón

`computeState({recomputableAt, activeJob}, serverNowMs)` → `available | cooldown | regenerating`:

- **available:** habilitado, icono ♻️. Click → `doRegen()`.
- **regenerating:** deshabilitado, spinner + "Regenerando…". Sólo lo ve **quien disparó** (es el único
  con `taskId` para pollear `JobQuery`). Los demás ven `cooldown`.
- **cooldown:** deshabilitado, muestra `mm:ss` hasta `recomputableAt`. **Este es el estado que ven
  los demás usuarios del domain** (derivado de `recomputableAt`) — cumple "todos ven timer + botón
  desactivado".

### Reloj y countdown
El countdown corre local con un tick de 1s, **anclado al servidor**: al pollear se guarda
`skewMs = transactionTime − Date.now()`. El restante = `recomputableAt − (Date.now() + skewMs)`.
Correcto aunque el reloj del cliente esté desfasado (`computeSkewMs` + tests de skew).

### Polling adaptativo (así se propaga el timer global)
- **available** → resync `GetRecomputableAt` cada 60s (detecta que otro usuario disparó; ~60s de latencia máx.).
- **cooldown** → resync cada 30s; tick local de 1s para el countdown fluido.
- **regenerating** → `JobQuery(taskId)` cada 10s hasta `isDone`.

El tick de 1s sólo corre cuando hay countdown que pintar (cooldown/regenerating); idle no consume.

## Popup

Acción `trigger-report-regen` con `fn: "ReportRegen.triggerFromPopup"`. Usa el **handler genérico**
de `background.js` (`default` case, línea 1357): inyecta el app y llama la función en MAIN world.
**No requiere tocar `extension/`** → deploy 100% en `remote/` vía `deploy.sh`. Devuelve
`{started, message}` en éxito o `{error}` en cooldown/sin-permiso (formas que `popup.js:293-316` maneja).

## Memoria / ciclo de vida

Applet de larga duración (polling indefinido) pero **trivial**: 1 query pequeña por minuto, sin Maps
ni acumulación. No requiere `host-cleanup-shared` (no es de la clase de bulk-upload/spec-migrator).
El único riesgo es duplicar timers/observers en re-inyección → cubierto por:
- **Singleton guard** por `APPLET_VERSION` + `destroy()` de la versión previa.
- `destroy()` limpia `pollTimer`, `tickTimer`, `debounceTimer`, observer y remueve el botón.

## Deploy

`config.json` ya trae los 3 hashes + el app entry. Deploy:
```bash
tools/deploy.sh "feat(report-regen): botón de regeneración de reportes en header (v0.1.0)" --check report-regen
```

## Plan de validación en vivo — ✅ COMPLETADO (run real OK operador 2026-07-17, confirmado 2026-07-22)

1. **Permiso:** confirmar que el botón aparece para un usuario con `MANAGE_REPORTING` y NO aparece para
   uno sin él. Validar que `CurrentUser.currentManagedPermissions` sigue devolviendo el array (el control
   de permisos "tenía mucho sin validarse").
2. **Disparo:** click → `GenerateDuckDb` devuelve `taskId` → spinner "Regenerando…" → al `isDone` pasa a
   cooldown con countdown.
3. **Solo-cookie:** verificar que `GenerateDuckDb` funciona sin el header `x-steelhead-idp-token` (toda la
   extensión hace mutations con solo-cookie; muy probable que sí). **Plan B si falla:** capturar el header.
4. **Timer global:** disparar desde una sesión y confirmar que **otra** sesión/usuario ve el cooldown en
   ≤60s (sin recargar).
5. **Cooldown real:** medir cuánto da `recomputableAt − transactionTime` (el usuario estima ~15 min; lo
   dicta el servidor, no se hardcodea).
6. **Anclaje:** confirmar inserción correcta antes del correo en varias vistas (PN, OV, dashboard).

## Riesgos / gotchas

- **Hashes pueden rotar** cuando Steelhead actualiza. Están vivos en Reportes SH hoy. Si truena con
  HTTP 400 "Must provide a query string", recapturar (ver `docs/api/persisted-queries-playbook.md`).
- **`GenerateDuckDb` regenera el domain de la tab activa** (TLC o MTY según dónde esté el usuario). Correcto
  y deseable — el `domainNanoId` se infiere de la sesión del navegador.
- Si `GetRecomputableAt` falla transitoriamente, el applet mantiene el último estado y reintenta en el
  siguiente poll (no rompe el botón).

## Lecciones

- El "estado global compartido entre usuarios" no necesitó backend: bastó leer el timestamp autoritativo
  del servidor por polling. Antes de construir infra de sincronización, checar si el servidor ya expone el
  estado.
- `autoInject` ≠ gated. Cualquier applet autoInject que necesite restringirse por permiso debe auto-gatearse
  consultando `CurrentUser` (el gating de `requiredPermissions` sólo aplica al popup).
