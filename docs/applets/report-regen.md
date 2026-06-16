# Applet: `report-regen` (Regenerar Reportes)

**Versión actual:** 0.2.0
**Archivo:** `remote/scripts/report-regen.js`
**Tipo:** `autoInject` + acción de popup. Inyecta un botón en el header secundario de Steelhead.
**Permiso requerido:** `MANAGE_REPORTING` (gating en runtime, no sólo popup).

## Qué hace

Steelhead refresca su base de reportes (DuckDB) cada noche, pero también se puede forzar
manualmente — sólo que el botón nativo está enterrado 3-5 clicks. Este applet expone un
botón **♻️** en la barra de breadcrumb (junto a los iconos play ▶ y correo ✉) que dispara la
regeneración con un click, muestra el progreso, y arranca un timer de enfriamiento.

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

## Plan de validación en vivo (PENDIENTE)

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
