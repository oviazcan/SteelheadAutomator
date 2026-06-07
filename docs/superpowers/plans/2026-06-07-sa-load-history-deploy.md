# Deploy de fin de semana — `sa_load_history → IndexedDB` (rama `sa-load-history-idb`)

**Por qué es un deploy aparte:** este cambio toca `extension/background.js`, que se empaqueta en el
**`.zip`** de la extensión (no se sirve por gh-pages como los `remote/scripts/`). `bulk-upload.js`
(que escribe el historial a IndexedDB) y `background.js` (que lo lee) **deben desplegarse juntos**:
si solo se publica `bulk-upload.js` a gh-pages sin republicar el `.zip`, el `background.js` viejo
(que lee de `localStorage`) no vería las cargas nuevas (que ya van a IDB) → el Historial de Cargas
se vería vacío hasta actualizar la extensión.

**Estado:** todo listo y commiteado en la rama `sa-load-history-idb`. `version 1.6.47`,
`extensionVersion 1.6.4`. 69 golden tests verdes. Sin desplegar a producción.

## Qué incluye el cambio
- `bulk-upload.js`: historial en IDB (`saIdbGet`/`saIdbSet`), migración one-shot localStorage→IDB,
  expone `window.BulkUpload.getLoadHistory()`.
- `extension/background.js`: `view-load-history` y `download-load-csv` leen de IDB (`sa_storage`/`kv`)
  con fallback a `localStorage` (usuarios pre-migración), sin depender de cargar los scripts del applet.
- `config.json`: `version` 1.6.47, `extensionVersion` 1.6.4.

## Procedimiento (ejecutar en fin de semana)

1. **Merge la rama a main:**
   ```bash
   cd "/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator"
   git checkout main && git pull
   git merge sa-load-history-idb        # o cherry-pick del commit si hay divergencia
   ```

2. **Deploy de `remote/` a gh-pages** (procedimiento estándar de CLAUDE.md, vía worktree para no tocar el working tree):
   ```bash
   git worktree add /tmp/ghp-saload gh-pages
   git show main:remote/scripts/bulk-upload.js > /tmp/ghp-saload/scripts/bulk-upload.js
   git show main:remote/config.json           > /tmp/ghp-saload/config.json
   git -C /tmp/ghp-saload add scripts/bulk-upload.js config.json
   git -C /tmp/ghp-saload commit -m "deploy: sa_load_history a IndexedDB + 1.6.47 + extensionVersion 1.6.4"
   git worktree remove /tmp/ghp-saload
   ```
   Verificar byte-exact: `tools/check-deploy.sh bulk-upload.js`.

3. **Reempaquetar y publicar el `.zip`** (la pieza que `background.js` necesita):
   ```bash
   # Empaquetar extension/ → steelhead-automator.zip
   ( cd extension && zip -r ../steelhead-automator.zip . -x '*.DS_Store' )
   # Subir el .zip a gh-pages (extensionZipUrl = .../steelhead-automator.zip)
   git worktree add /tmp/ghp-zip gh-pages
   cp steelhead-automator.zip /tmp/ghp-zip/steelhead-automator.zip
   git -C /tmp/ghp-zip add steelhead-automator.zip
   git -C /tmp/ghp-zip commit -m "deploy: .zip extensión 1.6.4 (background.js lee sa_load_history de IDB)"
   git worktree remove /tmp/ghp-zip
   rm steelhead-automator.zip
   ```
   Si la extensión también vive en **Chrome Web Store (Unlisted)**, subir ahí el `.zip` nuevo y publicar.

4. **Push de ambas ramas:**
   ```bash
   git push origin main && git push origin gh-pages
   ```

5. **Actualizar la extensión instalada** (cada usuario del equipo):
   - Si es por `.zip`: descargar el nuevo `steelhead-automator.zip`, recargar la extensión desempaquetada (`chrome://extensions` → reload), o reinstalar.
   - Si es por Chrome Web Store: esperar la propagación del update (o forzar update en `chrome://extensions`).

## Validación post-deploy
- Recargar la extensión → abrir **Historial de Cargas** → debe mostrar las cargas (migradas de localStorage + nuevas en IDB).
- Correr una carga chica → confirmar que aparece en el Historial.
- **Descargar CSV** de una carga del historial → debe generar el CSV (lee de IDB).
- Confirmar en DevTools que `localStorage` ya no tiene `sa_load_history` (migrado y removido).

## Rollback
- Revertir el commit de `gh-pages` (`bulk-upload.js` + config) **y** el `.zip` al anterior. El fallback
  a localStorage en `background.js` viejo sigue funcionando con el historial pre-migración.
