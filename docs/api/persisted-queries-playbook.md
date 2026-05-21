# Persisted queries deprecadas: síntoma y diagnóstico (resuelto 2026-04-27, v0.5.7)

Steelhead **deprecó server-side la operación `CurrentUser`** (hash `18c6574c…`). Síntoma: `paros-linea` rompía en cold start con `HTTP 400 {"errors":[{"message":"Must provide a query string."}]}` en cada reload, y NO había FAB. Variantes hermanas (`CurrentUserDetails`, `CurrentUserActiveSegments`, `CurrentUserQuery`) seguían vivas con sus hashes intactos.

**Diagnóstico engañoso #1**: el hash en config seguía siendo el mismo que el UI escaneado en `scan_results_*.json` con `status: known` y `responseSchema` válido — parece "está bien". Falso. Lo que pasa: el server marcó esa operación como no-aceptada (`acceptApqHashesOnly`-style); ya no acepta el hash con request hash-only ni acepta queries arbitrarias con `query` string libre. Solo deja pasar hashes de operaciones "vivas".

**Diagnóstico engañoso #2**: parece race condition (Apollo Client del UI calienta APQ después de cold start). NO ES. Reintentar con backoff `[0, 600, 1200, 1800] ms` da los 4 fallos. Y disparar **el mismo body shape desde el contexto del UI** (DevTools console, sin nuestra extensión) también devuelve 400. La operación está muerta server-side, no es timing.

**Cómo diferenciar entre "hash desactualizado" vs "operación deprecada"**:
1. Re-scanear con `hash-scanner.js` y mirar el hash de la op en `scan_results_*.json`. Si difiere del config → solo es un hash rotado, actualízalo. Si es **igual** al config (`status: known`) y la app sigue rota, es deprecación.
2. Probar el body shape en consola desde el UI vivo (con `extensions.persistedQuery.sha256Hash`). Si responde 400 también, no es nada de nuestra extensión.
3. Probar variantes hermanas con sus hashes en consola — si esas viven, el server solo mató esa operación específica.

**Actualización 2026-05-15, v0.6.24 (`OperatorMaintenanceNodeDialogQuery`, también `paros-linea`):** el mensaje `{"errors":[{"message":"Must provide a query string."}]}` **NO distingue** entre "hash rotado" y "operación deprecada". El server responde idéntico cuando el hash es desconocido, sin importar la causa (rotación silenciosa o retiro). La pista visible en el modal era "Error: HTTP 400 en OperatorMaintenanceNodeDialogQuery: {..." (truncado a 60 chars en `paros-linea.js:653` para pintar en la `<option>` del select MOTIVO). Síntoma colateral útil: `CreateMaintenanceEventDialogQuery` (que pobla el dropdown de Responsable) seguía viva, lo que indica deprecación selectiva de UN hash, no de la familia. El paso decisivo siempre es el re-scan: el scan fresco mostró la misma op con HTTP 200 y hash distinto (`2a2a6230…` → `b8527dc6f2cb864f…`), confirmando caso A (rotación). El shape de respuesta no cambió. Fix: bump del hash en config + bump de version. **Regla actualizada**: cuando veas `"Must provide a query string."`, NO asumas deprecación dura — re-scanea primero. Si la op aparece con hash distinto y 200 → es rotación. Solo si aparece con mismo hash y 400, o desaparece del UI, es deprecación.

**Playbook 60-segundos cuando un applet rompe con HTTP 400 en una persisted query** (derivado de este ciclo y de v0.5.7):
1. DevTools Network en la tab de Steelhead → filtrar `graphql` → reproducir → click en la fila 400 → tabs `Response` (para `errors[0].message`) y `Payload` (para `operationName` + `extensions.persistedQuery.sha256Hash`).
2. Si el message es `"Must provide a query string."` (firma APQ): buscar el último `~/Downloads/scan_results_*.json` y `jq -r '.scanResults["<OpName>"] | {hash, lastHttpStatus, count}'`.
3. **Hash del scan ≠ hash del config y `lastHttpStatus=200`** → rotación. Bump del hash en `remote/config.json`, bump de `version`+`lastUpdated`, sync a `gh-pages` (worktree o cp manual), push ambas, reload extensión.
4. **Hash del scan == hash del config** o **op ausente del scan** → deprecación. Buscar variantes hermanas vivas en el scan o re-scanear navegando el flujo nativo del UI; pivotar a la viva más cercana (v0.5.7: `CurrentUser → CurrentUserDetails`).
5. Validación final en prod: recargar extensión (Chrome puede cachear `config.json` ~5 min) y reproducir el flujo. **Verificado en producción 2026-05-15** por el usuario: dropdown MOTIVO se puebla correctamente al seleccionar el responsable "🧪 Laboratorio y Procesos" tras el bump 0.6.24.

**Fix pattern**: pivotar a la variante viva más cercana. `CurrentUserDetails` no trae `currentManagedPermissions` pero sí `id` e `isAdmin` — suficiente para gating ligero. `paros-linea.isAuthorized` ya tenía branch graceful (`!Array.isArray(managedPermissions) → permitido`), así que solo fue cambiar `operationName` y devolver `managedPermissions: undefined`.

**Pendiente derivado**: `extension/background.js:212` (handler `get-current-user` del popup de permisos) sigue invocando `CurrentUser`. Cuando el usuario abre la pestaña de permisos del popup, va a fallar igual. Fix futuro: mismo pivot a `CurrentUserDetails` o intento con fallback. No-bloqueante (los applets autoinyectados no dependen de ese handler).

