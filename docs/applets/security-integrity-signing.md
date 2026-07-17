# `security-integrity-signing` — bitácora

Firma criptográfica del loader remoto para cerrar el pendiente de seguridad **#1 (ALTO)**:
`extension/background.js` ejecutaba `new Function(code)()` sobre scripts traídos de GitHub
Pages **sin verificar**. Ahora la extensión verifica una firma ECDSA P-256 sobre `config.json`
y el hash SHA-256 de cada script **antes** de ejecutarlo, con **fail-closed**.

- **Spec:** [`docs/superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md`](../superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md)
- **Plan:** [`docs/superpowers/plans/2026-07-09-remote-script-integrity-signing.md`](../superpowers/plans/2026-07-09-remote-script-integrity-signing.md)
- **Runbook KMS (Fase 0):** [`docs/deploy-signing-setup.md`](../deploy-signing-setup.md)

## Arquitectura
- **`config.json` es el manifiesto raíz firmado.** Lleva `scriptIntegrity: { "scripts/foo.js": "<sha256-hex>" }`. La firma va en **`config.sig` separado** (base64 de la firma raw P1363, sobre los bytes exactos del config).
- **Raíz de confianza:** la **pública embebida** en la extensión (`extension/integrity-pubkey.js` → `self.SA_INTEGRITY_PUBKEY`), firmada por el Web Store → un atacante con acceso a gh-pages no puede forjar firma sin la **privada, que vive en GCP KMS** del proyecto del cliente (nunca en el repo).
- **Cadena:** `config.sig` valida `config.json` con la pública → `scriptIntegrity` queda confiable → cada script se valida contra su hash.

## Archivos
| Archivo | Rol |
|---|---|
| `extension/integrity-verify.js` | Módulo puro `SAIntegrity` (verify firma + sha256 + verify hash), compartido SW + tests. |
| `extension/integrity-pubkey.js` | `self.SA_INTEGRITY_PUBKEY` (placeholder `''` hasta Fase 2). |
| `extension/background.js` | `importScripts` + `loadConfig` verifica firma (fail-closed) + `fetchScriptCode` verifica hash + break-glass. |
| `tools/seal-config.mjs` | Deploy: calcula `scriptIntegrity` + firma (backend `kms` prod / `ephemeral` test) → `config.sig`. |
| `tools/lib/der-to-p1363.mjs` | Convierte la firma DER de KMS a raw 64 bytes (lo que WebCrypto espera). |
| `tools/verify-config-sig.mjs` | Verificador standalone (hook + smoke-check). |
| `tools/deploy.sh` | Llama `seal` (si `SA_KMS_KEY`), espeja `config.sig`, smoke-check post-deploy lag-aware. |
| `.githooks/pre-push` | Backstop: bloquea push de gh-pages si `config.sig` no verifica. |

**Tests:** `tools/test/{integrity-verify,der-to-p1363,seal-config,seal-config-kms,verify-config-sig}.test.js` (CJS + dynamic import de los `.mjs`).

## Fail-closed y break-glass
- Firma inválida → `loadConfig` **no** actualiza `cachedConfig` y no inyecta nada. Hash mismatch → el script lanza, no llega a `new Function`.
- **Break-glass:** toggle en el popup (Configuración → Seguridad), flag `sa_integrity_bypass` en `chrome.storage.local`, default OFF, solo la extensión lo setea. Última línea de defensa; el arreglo real de un incidente es re-deployar una firma correcta.
- Offline: usa el config de storage **solo si** tuvo verificación previa (`config_verified_at`).

## Rollout (3 fases)
- **Fase 0 (manual):** provisionar KMS + embeber la pública. Ver runbook.
- **Fase 1:** deploy firmado → gh-pages queda con `scriptIntegrity` + `config.sig`. La extensión **actual (sin verificación) ignora los campos nuevos → nadie se bloquea**.
- **Fase 2:** republicar la extensión (pública embebida + bump `extensionVersion`) → verificación fail-closed activa para quien actualice.

Mientras `SA_INTEGRITY_PUBKEY=''`, TODO se comporta idéntico al actual (fail-open) — por eso el código pudo mergearse sin romper a nadie.

## Estado
- **Código completo** (Tasks 1-10, TDD, backend `ephemeral` en tests). Suite verde.
- **Fase 0 (KMS) HECHA (2026-07-17):** key ring `steelhead-automator` + key `config-signing` v1 (EC_SIGN_P256_SHA256) en proyecto `steelhead-ecoplating`, IAM `signerVerifier` a oviazcan@gmail.com, pública extraída. **Bug del backend corregido**: `kmsSigner` firmaba el `SHA256(mensaje)` y gcloud lo re-hasheaba (`--digest-algorithm=sha256` hashea el input) → doble hash → firma no verificaba. Fix: pasar el **mensaje crudo** a gcloud (`signDigest`→`signMessage`). Comprobado end-to-end con la llave real (seal → verify OK). Ver runbook.
- **Fase 1 HECHA (2026-07-17, config 1.7.142):** deploy firmado con KMS; `config.sig` en gh-pages, **verificado EN VIVO** con la pública real (bajado de `oviazcan.github.io/SteelheadAutomator/config.sig` → verify OK). Usuarios **sin cambios** (extensión actual ignora `config.sig` hasta Fase 2). Cron de hash-autopilot ya tiene `SA_KMS_KEY` (firma sus deploys). Pública sigue placeholder (`''`) en `integrity-pubkey.js` → smoke-check y pre-push-verify se saltan por diseño hasta Fase 2.
- **Pendiente — Fase 2 (usuario):** embeber la pública real en `integrity-pubkey.js` (está en el runbook) + bump `extension/manifest.json` version y `config.extensionVersion` + republicar el `.zip`. Al actualizar el zip, la verificación fail-closed se activa → usuarios protegidos. Debe ir con `config.sig` ya vivo (ya lo está).

## Interacción con otros sistemas
- **hash-autopilot:** su `autopilot-deploy.sh` **llama a `tools/deploy.sh`**, así que hereda el `seal` automáticamente — no se tocó por separado. Necesita acceso IAM a KMS cuando corre headless (mismo proyecto del cliente).
- **Canonicalización:** `seal` re-serializa `config.json` con `JSON.stringify(config,null,2)+'\n'`. El primer deploy con seal puede reformatearlo una vez; después es idempotente. Supera el "preserva formato" del autopilot (inofensivo).
