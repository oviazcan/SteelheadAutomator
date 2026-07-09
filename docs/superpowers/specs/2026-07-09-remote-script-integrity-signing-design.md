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
- **Par de llaves ECDSA P-256 / SHA-256.** Elegido sobre Ed25519 por soporte universal de `crypto.subtle` en el service worker sin flags.
- **Llave privada: en GCP KMS (proyecto del CLIENTE), NO en un archivo local.** Decisión motivada por la **transición** (ver §"Handoff"). La privada se crea dentro de KMS (`EC_SIGN_P256_SHA256`) y **nunca sale del HSM**; no existe como archivo. Firmar = llamar `asymmetricSign`. Quién puede firmar lo controla **IAM** (rol `roles/cloudkms.signerVerifier`).
  - KMS `asymmetricSign` para EC devuelve firma **ASN.1 DER** → `seal-config` la convierte a **raw r||s (IEEE P1363, 64 bytes)** que WebCrypto espera, antes de escribir `config.sig`.
- **Backend de firma abstraído.** `seal-config` toma el firmante de una interfaz `sign(bytes)→Uint8Array`:
  - `kms` (producción): llama GCP KMS vía `gcloud kms asymmetric-sign` o el cliente Node (`@google-cloud/kms`), usando las credenciales `gcloud` ya presentes en la máquina.
  - `ephemeral` (tests): genera un par en memoria con WebCrypto y firma local — **nunca** se usa en deploy real. Permite construir/probar todo sin depender de GCP.
- **Llave pública (SPKI base64):** se obtiene una vez de KMS (`gcloud kms keys versions get-public-key`) y se embebe en la extensión (`extension/integrity-pubkey.js` → `self.SA_INTEGRITY_PUBKEY`). Es pública; se commitea. Se publica una vez con bump de `extensionVersion`. **No cambia** aunque roten las personas con acceso IAM.

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
  4. Firma los bytes finales de `remote/config.json` vía el backend `kms` (GCP KMS `asymmetricSign` → DER→P1363) → escribe `remote/config.sig`.
  - Falla ruidosamente si no puede firmar (sin acceso IAM/credenciales KMS): no debe producir un config sin firma válida.
- Se invoca en `tools/deploy.sh` tras el bump de versión. **Corrección (impl 2026-07-09):** `tools/hash-autopilot/autopilot-deploy.sh` **llama a `tools/deploy.sh`**, así que hereda el `seal` automáticamente — NO se edita por separado.
- **`config.sig` se espeja a gh-pages** junto con `config.json` (agregar al conjunto que mira `deploy.sh` y el `pre-push`).

**Tres candados contra el fail-closed global** (un deploy con firma mala apagaría los applets de TODOS los que ya actualizaron):
1. **Hook `pre-push` extendido** (`.githooks/pre-push`): además del espejo byte-a-byte + version-bump, valida que `config.sig` **verifique** contra `config.json` (con la pública, vía `tools/verify-config-sig.mjs`). Bloquea el push si la firma no cuadra — aunque un camino de deploy olvide `seal`.
2. **Smoke-check post-deploy** (en `deploy.sh`/`deploy-status.sh`): tras publicar, baja `config.json` + `config.sig` **EN VIVO de gh-pages** y verifica la firma con la pública embebida **antes** de declarar el deploy exitoso. Si no verifica → el deploy grita FALLA en la terminal (no en las pantallas de los operadores). Cierra el hueco de "subí algo que no firma bien".
3. **Break-glass** (§Flujo): toggle local por-usuario, última línea de defensa en un incidente; el arreglo real es re-deployar una firma correcta (arregla a todos de un jaque).

### Rollout (evita brickear)
- **Fase 0 — provisionar KMS (prerequisito de deploy real, NO bloquea construir):** crear el key ring + llave en el GCP del cliente, IAM a quienes deployan, sacar la pública. Todo el código y los tests se construyen antes con el backend `ephemeral`; KMS solo se necesita para el primer deploy real. Runbook en `docs/deploy-signing-setup.md`.
- **Fase 1:** agregar `seal` (backend `kms`) al deploy + deployar → gh-pages queda con `scriptIntegrity` + `config.sig`. La extensión **actual (sin verificación)** ignora los campos nuevos y sigue igual → **nadie se bloquea**. Verificar en vivo (smoke-check) que nada se rompió.
- **Fase 2:** publicar la extensión nueva (pública embebida + verificación fail-closed + break-glass en popup) con bump de `extension/manifest.json` version **y** `config.extensionVersion`. Como la firma ya está viva desde Fase 1, la verificación pasa. Quien no actualice sigue con la vieja (funciona igual, sin verificar); quien actualice, verifica. Distribuir el zip; usuarios recargan una vez.

### Handoff / transición al equipo del cliente
Objetivo del usuario: entregar el repo al equipo del cliente; primero deployan juntos, luego el usuario sale. La elección de KMS es por esto:
- La llave vive en **el GCP del cliente** desde el día 1 (no en la máquina del consultor) → la propiedad es del cliente desde el arranque.
- **Durante la transición:** el usuario y el equipo del cliente tienen IAM `signerVerifier` → ambos pueden deployar/firmar.
- **Al salir el usuario:** se **quita su acceso IAM**. Nada que transferir, **sin re-key, sin republicar la extensión** (la pública embebida no cambia — solo cambia *quién* puede firmar). Contraste con llave local: entregar el `.pem` + posible re-key + republicar a todos.
- El **hash-autopilot** headless usa las mismas credenciales GCP → sigue rotando+firmando sin la máquina del consultor.

## Componentes (archivos)

| Archivo | Tipo | Qué hace |
|---|---|---|
| `docs/deploy-signing-setup.md` | nuevo | Runbook one-time: comandos `gcloud` para crear el key ring + llave `EC_SIGN_P256_SHA256` en el GCP del cliente, dar IAM `signerVerifier`, y sacar la pública para embeber. |
| `tools/seal-config.mjs` | nuevo | Recalcula `scriptIntegrity` + firma vía backend (`kms` prod / `ephemeral` test) → DER→P1363 → escribe `config.sig`. |
| `tools/verify-config-sig.mjs` | nuevo | Verificador standalone con la pública embebida (lo usan el hook `pre-push` y el smoke-check post-deploy). |
| `extension/integrity-verify.js` | nuevo | Módulo puro `SAIntegrity` (verify + sha256), compartido con tests. |
| `extension/integrity-pubkey.js` | nuevo | `self.SA_INTEGRITY_PUBKEY = '<spki-b64>'`. |
| `extension/background.js` | editar | `importScripts('integrity-verify.js','integrity-pubkey.js')` al tope (SW clásico, MV3 `{service_worker}` sin `type:module`); `loadConfig` verifica firma; `fetchScriptCode` verifica hash; break-glass. |
| `extension/manifest.json` | editar | Bump `version` (hoy 1.6.5). No requiere `web_accessible_resources` (los helpers los carga `importScripts`, no la página). |
| `extension/popup.{html,js}` | editar | Toggle break-glass (default OFF). |
| `tools/deploy.sh` | editar | Llamar `seal-config.mjs` tras el bump; espejar `config.sig`. |
| ~~`tools/hash-autopilot/autopilot-deploy.sh`~~ | **NO se toca** | Llama a `tools/deploy.sh`, hereda `seal` automáticamente. |
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
| Sin acceso a KMS en deploy (IAM/credenciales) | `seal` falla ruidoso; deploy aborta (no publica config sin firmar). |
| Firma mala llega a gh-pages | Smoke-check post-deploy la caza en la terminal antes de "éxito"; si se colara, break-glass por-usuario + re-deploy correcto. |
| Falsa alarma en producción | Break-glass toggle en popup (local, off por default). |

## Pruebas

- **Unitarias** (`tools/test/config-signing.test.js`, Node `node:test` + WebCrypto, backend `ephemeral` — sin GCP):
  - Generar par efímero, sellar un config de prueba, verificar → OK.
  - Voltear un byte de `config.json` → verify **falla**.
  - Alterar un hash en `scriptIntegrity` sin re-firmar → verify de firma **falla**.
  - Conversión DER→P1363: una firma DER conocida convierte a los 64 bytes correctos y WebCrypto la acepta (cubre el path que usará KMS en prod).
  - `sha256Hex` determinístico contra vector conocido.
  - Script con hash correcto → `verifyScriptHash` true; alterado → false.
- **Run-real (manual):**
  - Fase 1: deploy con `seal`; confirmar que la extensión actual sigue inyectando (campos nuevos ignorados) y `deploy-status`/hook pasan.
  - Fase 2: cargar extensión nueva; confirmar applets corren; luego servir un `config.json`/script alterado localmente → confirmar **fail-closed** (no inyecta) y el break-glass revierte.

## Fuera de alcance (YAGNI)

- Empacar los scripts en la extensión (convergencia con Safari) — alternativa documentada, no elegida.
- **Revocar ACCESO** de una persona = quitar su rol IAM (inmediato, sin republicar). Cubierto por KMS. **Rotar la LLAVE** (nueva versión → nueva pública) sí requiere republicar la extensión con la nueva pública; se deja como procedimiento documentado, no automatizado. Multi-llave/overlap de rotación: fuera de alcance.
- Firmar los scripts individualmente — el config-manifiesto firmado ya encadena la integridad de todos.
- Los otros 4 ítems de seguridad (XSS innerHTML, rollback/tags, CSP, console.log) — pendientes aparte.
