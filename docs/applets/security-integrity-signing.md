# `security-integrity-signing` — bitácora

Firma criptográfica del loader remoto para cerrar el pendiente de seguridad **#1 (ALTO)**:
`extension/background.js` ejecutaba `new Function(code)()` sobre scripts traídos de GitHub
Pages **sin verificar**. Ahora la extensión verifica una firma ECDSA P-256 sobre `config.json`
y el hash SHA-256 de cada script **antes** de ejecutarlo, con **fail-closed**.

- **Spec:** [`docs/superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md`](../superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md)
- **Plan:** [`docs/superpowers/plans/2026-07-09-remote-script-integrity-signing.md`](../superpowers/plans/2026-07-09-remote-script-integrity-signing.md)
- **Runbook KMS (Fase 0):** [`docs/deploy-signing-setup.md`](../deploy-signing-setup.md)

## INCIDENTE 2026-08-05 — la extensión ENTERA se apagó por un config sin re-firmar

El deploy de **1.11.90** corrió **sin `SA_KMS_KEY` en el entorno**. `deploy.sh` tenía un `else`
que sólo **imprimía un aviso**, así que publicó el `config.json` nuevo conservando el `config.sig`
**y los `scriptIntegrity`** de 1.11.89. Como la verificación es **fail-closed**,
`fetchConfigFresh` descartó el config completo: el popup mostró **«Sin conexión»** a todos los
usuarios y **ningún applet cargó** — no sólo el que se estaba deployando.

Medido antes de reparar:

```
gh-pages   v1.11.90  firma propia ❌   ← la firma viva validaba contra el config de 1.11.89
gh-pages~1 v1.11.89  firma propia ✅
```

Reparado re-sellando en **1.11.91** (el bump lo exige el propio pre-push: la versión es el
cache-bust). Verificado en vivo: firma válida y los dos hashes de `create-order-autofill`
coincidiendo con lo que sirve gh-pages.

### Había DOS candados y no actuó ninguno — por razones distintas

**1. `deploy.sh` degradaba a aviso.** Un `⚠️` en medio de 30 líneas de salida no frena a nadie, y
menos a una sesión que no conoce el repo. Ese `else` se escribió para «pre-Fase-0», cuando la
pública era placeholder y nadie verificaba; una vez embebida la pública real, quedó como un
camino que **sólo sirve para publicar algo que ningún cliente puede usar**.

**2. `.githooks/pre-push` SÍ valida la firma… pero el hook ACTIVO era de otra época.**
`install-hooks.sh` lo **copia** a `.git/hooks`, así que mejorar el hook versionado **no protege a
ninguna máquina** hasta que cada clon reinstale — y nada avisaba del desfase. El instalado era
del **23 de julio**, anterior a que se le agregara el paso de firma. El candado existía en el
repo y **no existía en la máquina**.

> **La lección, que es más general que este incidente:** un candado que se propaga **por copia**
> caduca en silencio. Su versión instalada es un estado más que puede driftear, y hay que
> vigilarlo igual que se vigila el espejo de `gh-pages`. «Está en el repo» no es «está activo».

### Qué se cerró

| Capa | Cambio |
|---|---|
| `deploy.sh` | **Aborta** en el pre-flight si hay pública real y falta `SA_KMS_KEY` — **antes** del bump, para no dejar el config a medias |
| `deploy.sh` | Compara `.githooks/*` con el hook instalado y **reinstala solo** si driftó |
| `wb-deploy.sh` | Mismo guard: es la OTRA vía de publicación y no pasa por `deploy.sh` |
| `tools/test/deploy-signing-required.test.js` | Trinquete de las tres cosas |

**El trinquete se verificó rompiéndolo.** Su primera versión comprobaba que el guard *existiera*
y **seguía en verde** al degradar el `exit 1` a un `echo` — el mismo defecto que causó el
incidente, reproducido en el test que debía evitarlo. Ahora lee el **cuerpo del `if`** y exige la
consecuencia (`exit 1` / `die`); con la regresión inyectada en ambos scripts, falla 2 de 6.

Y el guard se probó en sus tres casos, aislado: pública real sin llave → **aborta**; pública real
con llave → continúa; pública vacía sin llave (pre-Fase-0) → continúa.

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
- **Fase 2 HECHA (2026-07-17, config 1.7.145, ext 1.6.6):** pública real embebida en `integrity-pubkey.js`; `manifest.json` → 1.6.6 y `config.extensionVersion` → 1.6.6 (dispara el banner de actualización); zip `steelhead-automator.zip` republicado en gh-pages (manifest 1.6.6 + pública dentro, estructura raíz). **Verificado EN VIVO end-to-end:** config.sig verifica con la pública embebida (smoke-check del deploy firmado + verificación manual), y el zip servido trae manifest 1.6.6 + la pública. Ahora el smoke-check y el pre-push-verify **sí** corren (pública ya no es placeholder). **Gotcha del zip:** `deploy.sh` NO lo publica (su `git add` es sólo config+scripts); se subió con un push manual a gh-pages que bumpea version (el pre-push exige version+1) — replicando el flujo de deploy + el zip.
- **Rollout activo:** la verificación fail-closed queda ACTIVA para cada compu **al actualizar** al zip 1.6.6 (banner → descargar → recargar unpacked). Las que no actualicen siguen fail-open (sin bloqueo). Protección gradual. Break-glass disponible (toggle popup → `sa_integrity_bypass`) por si una actualización topa un problema.

## Interacción con otros sistemas
- **hash-autopilot:** su `autopilot-deploy.sh` **llama a `tools/deploy.sh`**, así que hereda el `seal` automáticamente — no se tocó por separado. Necesita acceso IAM a KMS cuando corre headless (mismo proyecto del cliente).
- **Canonicalización:** `seal` re-serializa `config.json` con `JSON.stringify(config,null,2)+'\n'`. El primer deploy con seal puede reformatearlo una vez; después es idempotente. Supera el "preserva formato" del autopilot (inofensivo).
