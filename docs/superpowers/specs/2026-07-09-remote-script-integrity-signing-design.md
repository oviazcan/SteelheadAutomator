# Integridad de scripts remotos por firma criptográfica — Design

**Fecha:** 2026-07-09
**Estado:** Aprobado (diseño) — pendiente plan de implementación
**Ítem que cierra:** Seguridad pre-producción #1 (ALTO) — `extension/background.js` ejecuta `new Function(c)()` sobre código traído de GitHub Pages sin verificar.

## Problema

La extensión es un "cascarón": en runtime fetchea scripts de GitHub Pages (`gh-pages`) y los ejecuta con `new Function(code)()`. Hay **3 sitios de ejecución** de código remoto en `extension/background.js`:
1. El loop principal de `injectAppScripts` (línea ~80) — cada script de `config.apps[].scripts`.
2. Inyección de `scripts/lib/xlsx.full.min.js` en `run-csv` (~332).
3. La misma lib en `update-catalogs` (~551).

Todos obtienen el código vía `fetchScriptCode(scriptPath)` (línea ~30). **Ese es el chokepoint.**

**Riesgo:** quien controle `gh-pages` (compromiso de cuenta/repo de GitHub) corre código arbitrario en la sesión autenticada de Steelhead de los operadores, que tiene **acceso de escritura al ERP**. HTTPS cubre el tránsito; no cubre un compromiso del origen.

## Decisión de modelo de amenaza (resuelta con el usuario)

El plan original ("SHA-256 por script en `config.json`") **no detiene la amenaza declarada**: si el atacante controla gh-pages, edita el script **y** su hash en `config.json`. Hashes-en-config es *integridad* (anti-corrupción/manipulación-parcial), no *autenticidad*.

**Decisión: firma criptográfica.** La raíz de confianza vive en la extensión (firmada por el Web Store, inmutable para un atacante de gh-pages). Se mantiene el loader remoto (hot-update de código) — el usuario eligió esta opción sobre empacar los scripts.

Se asume y acepta explícitamente: esto **no** resuelve la política MV3 de "no remote code" (sigue habiendo código remoto). Para una extensión Unlisted interna ese riesgo se considera bajo. Empacar los scripts (convergir con el bundle Safari) queda como alternativa documentada, no elegida hoy.

## Arquitectura

### Modelo de confianza
- **Par de llaves ECDSA P-256 / SHA-256.** Elegido sobre Ed25519 por soporte universal de `crypto.subtle` en el service worker sin flags. Node firma con `dsaEncoding: 'ieee-p1363'` para producir la firma raw de 64 bytes que WebCrypto espera (NO DER).
- **Llave privada:** `~/.config/steelhead-automator/signing-key.pem` (fuera del repo, solo en la máquina de deploy). Nunca se commitea. Path configurable vía env `SA_SIGNING_KEY` (fallback al default).
- **Llave pública (SPKI base64):** embebida en la extensión (`extension/integrity-pubkey.js` → `self.SA_INTEGRITY_PUBKEY`). Es pública; se commitea. Se publica una vez con bump de `extensionVersion`.

### Qué se firma
- **`config.json` es el manifiesto raíz firmado.** Se le agrega:
  ```json
  "scriptIntegrity": { "scripts/steelhead-api.js": "<sha256-hex>", "scripts/foo.js": "<sha256-hex>", … }
  ```
  con el hash SHA-256 (hex) de cada script servido (los referenciados en `config.apps[].scripts` ∪ `config.scripts` ∪ libs referenciadas como `scripts/lib/xlsx.full.min.js`).
- **La firma va en un archivo separado `config.sig`** (base64 de la firma ECDSA sobre los **bytes exactos** de `config.json` tal como se sirven). Archivo aparte = se firma el byte-exacto servido, sin canonicalización de JSON (evita bugs de orden de llaves/espacios).
- **Cadena:** `config.sig` valida `config.json` con la pública → `scriptIntegrity` queda confiable → cada script se valida contra su hash. Una sola firma que administrar; los hashes por-script no necesitan firma propia porque el config que los contiene ya está firmado.

### Módulo puro compartido de verificación
`extension/integrity-verify.js` → `self.SAIntegrity` (y `module.exports` para tests):
- `async verifyConfigSignature(configText: string, sigB64: string, pubKeyB64: string): Promise<boolean>` — importa SPKI, `crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, key, sig, bytes(configText))`.
- `async sha256Hex(text: string): Promise<string>` — `crypto.subtle.digest('SHA-256', …)` → hex.
- `verifyScriptHash(code: string, expectedHex: string): Promise<boolean>` — `sha256Hex(code) === expectedHex` (comparación constante-ish; el hash no es secreto, timing no aplica).

Se usa idéntico en `background.js` y en el test (Node ≥18 trae `globalThis.crypto.subtle`).

### Flujo en `background.js` (fail-closed)
- **`loadConfig`:**
  1. Fetch `config.json` como **texto** (`response.text()`, no `.json()`), y `config.sig` como texto.
  2. `await SAIntegrity.verifyConfigSignature(text, sig, SA_INTEGRITY_PUBKEY)`.
  3. Si falla y el break-glass NO está activo → `cachedConfig` **no se actualiza**, se marca `configTrusted=false`, log `[SA] SECURITY: firma de config inválida — no se inyecta nada`, y `injectAppScripts` aborta temprano. (Fail-closed: mejor que los applets dejen de funcionar a que corra código no verificado.)
  4. Si pasa → `JSON.parse`, cache, `configTrusted=true`.
  - Fallback offline (sin red): usa el `config` de `chrome.storage.local` **solo si** venía de una verificación previa exitosa (se cachea junto con un flag `verifiedAt`). No se acepta un config almacenado sin verificación previa.
- **`fetchScriptCode(scriptPath)`:** tras `response.text()`, calcula `sha256Hex(code)` y compara con `cachedConfig.scriptIntegrity[scriptPath]`. Mismatch o ausente (y sin break-glass) → `throw new Error('integridad: <path>')`. Así **nunca** llega a `new Function`.
- **Break-glass:** flag `sa_integrity_bypass` en `chrome.storage.local`, toggle desde el popup (default OFF). Solo lo puede setear la extensión (no la página ni un atacante remoto). Con él ON, se saltan ambas verificaciones y se loguea `[SA] ⚠️ integridad DESACTIVADA (break-glass)`. Para emergencias si una firma legítima fallara.

### Deploy y candados
- **Paso `seal` compartido** — `tools/seal-config.mjs`:
  1. Lee `remote/config.json`.
  2. Recalcula `scriptIntegrity` con el SHA-256 de cada script servido (lee de `remote/scripts/**` = lo que se espeja byte-a-byte a gh-pages).
  3. Escribe `scriptIntegrity` en `remote/config.json`.
  4. Firma los bytes finales de `remote/config.json` con la privada → escribe `remote/config.sig`.
  - Falla ruidosamente si no encuentra la llave privada (no debe producir un config sin firma válida).
- Lo invocan **ambos** caminos de deploy tras el bump de versión: `tools/deploy.sh` y `tools/hash-autopilot/autopilot-deploy.sh`.
- **`config.sig` se espeja a gh-pages** junto con `config.json` (agregar al conjunto que mira `deploy.sh` y el `pre-push`).
- **Hook `pre-push` extendido** (`.githooks/pre-push`): además del espejo byte-a-byte + version-bump, valida que `config.sig` **verifique** contra `config.json` (usando la pública, vía un pequeño verificador Node). Backstop: aunque un camino de deploy olvide `seal`, el push a gh-pages se **bloquea**.

### Rollout en 2 fases (evita brickear)
1. **Fase 1:** generar llaves (`tools/gen-signing-key.mjs`, one-time) + agregar `seal` al deploy + deployar → gh-pages queda con `scriptIntegrity` + `config.sig`. La extensión **actual (sin verificación)** ignora los campos nuevos y sigue igual. Verificar en vivo que nada se rompió.
2. **Fase 2:** publicar la extensión nueva (pública embebida + verificación fail-closed + break-glass en popup) con bump de `extension/manifest.json` version **y** `config.extensionVersion`. Como la firma ya está viva desde Fase 1, la verificación pasa. Distribuir el zip; usuarios recargan una vez.

## Componentes (archivos)

| Archivo | Tipo | Qué hace |
|---|---|---|
| `tools/gen-signing-key.mjs` | nuevo | One-time: genera par ECDSA P-256, escribe privada al path local, imprime la pública SPKI base64 para embeber. |
| `tools/seal-config.mjs` | nuevo | Recalcula `scriptIntegrity` + firma → escribe `config.sig`. |
| `tools/verify-config-sig.mjs` | nuevo | Verificador standalone (lo usa el hook `pre-push`). |
| `extension/integrity-verify.js` | nuevo | Módulo puro `SAIntegrity` (verify + sha256), compartido con tests. |
| `extension/integrity-pubkey.js` | nuevo | `self.SA_INTEGRITY_PUBKEY = '<spki-b64>'`. |
| `extension/background.js` | editar | `importScripts('integrity-verify.js','integrity-pubkey.js')` al tope (SW clásico, MV3 `{service_worker}` sin `type:module`); `loadConfig` verifica firma; `fetchScriptCode` verifica hash; break-glass. |
| `extension/manifest.json` | editar | Bump `version` (hoy 1.6.5). No requiere `web_accessible_resources` (los helpers los carga `importScripts`, no la página). |
| `extension/popup.{html,js}` | editar | Toggle break-glass (default OFF). |
| `tools/deploy.sh` | editar | Llamar `seal-config.mjs` tras el bump; espejar `config.sig`. |
| `tools/hash-autopilot/autopilot-deploy.sh` | editar | Llamar `seal-config.mjs` antes de pushear. |
| `.githooks/pre-push` | editar | Validar `config.sig` vs `config.json`; incluir `config.sig` en el espejo. |
| `remote/config.json` | editar | Nuevo campo `scriptIntegrity` (lo escribe `seal`). |
| `remote/config.sig` | generado | La firma (se commitea + espeja). |
| `tools/test/config-signing.test.js` | nuevo | Round-trip firma→verifica + tamper→falla. |
| `docs/applets/…` / `CLAUDE.md` | editar | Bitácora + mover el ítem #1 de seguridad a "en progreso/resuelto". |

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| `config.sig` no verifica | No se actualiza cachedConfig; no se inyecta nada; log SECURITY; popup puede mostrar "⚠️ integridad". |
| Script hash mismatch | Ese script lanza; el applet falla; log SECURITY. |
| Sin red | Usa config de storage **solo si** tenía verificación previa (`verifiedAt`). |
| Falta la llave privada en deploy | `seal` falla ruidoso; deploy aborta (no publica config sin firmar). |
| Falsa alarma en producción | Break-glass toggle en popup (local, off por default). |

## Pruebas

- **Unitarias** (`tools/test/config-signing.test.js`, Node `node:test` + WebCrypto):
  - Generar par efímero, sellar un config de prueba, verificar → OK.
  - Voltear un byte de `config.json` → verify **falla**.
  - Alterar un hash en `scriptIntegrity` sin re-firmar → verify de firma **falla**.
  - `sha256Hex` determinístico contra vector conocido.
  - Script con hash correcto → `verifyScriptHash` true; alterado → false.
- **Run-real (manual):**
  - Fase 1: deploy con `seal`; confirmar que la extensión actual sigue inyectando (campos nuevos ignorados) y `deploy-status`/hook pasan.
  - Fase 2: cargar extensión nueva; confirmar applets corren; luego servir un `config.json`/script alterado localmente → confirmar **fail-closed** (no inyecta) y el break-glass revierte.

## Fuera de alcance (YAGNI)

- Empacar los scripts en la extensión (convergencia con Safari) — alternativa documentada, no elegida.
- Rotación de llaves / múltiples llaves / revocación — una sola llave por ahora; si se compromete la privada, se regenera y se republica la extensión.
- Firmar los scripts individualmente — el config-manifiesto firmado ya encadena la integridad de todos.
- Los otros 4 ítems de seguridad (XSS innerHTML, rollback/tags, CSP, console.log) — pendientes aparte.
