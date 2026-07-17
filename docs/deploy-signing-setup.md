# Setup de firma de integridad (GCP KMS) — one-time (Fase 0)

La extensión verifica que `config.json` (y el hash de cada script remoto) esté firmado
antes de ejecutarlo. La **llave privada vive en GCP KMS del proyecto del cliente** (nunca
en el repo ni en un laptop); la **pública va embebida** en la extensión. Ver el spec:
`docs/superpowers/specs/2026-07-09-remote-script-integrity-signing-design.md`.

**Este runbook es one-time.** Después, los deploys firman solos (`tools/deploy.sh` llama a
`tools/seal-config.mjs` si `SA_KMS_KEY` está seteada). Requiere `gcloud` autenticado con
permisos de KMS Admin en el proyecto.

## 1. Crear key ring + llave de firma
```bash
PROJ=<proyecto-del-cliente>
gcloud kms keyrings create steelhead-automator --location=global --project="$PROJ"
gcloud kms keys create config-signing \
  --location=global --keyring=steelhead-automator \
  --purpose=asymmetric-signing --default-algorithm=ec-sign-p256-sha256 \
  --project="$PROJ"
```

## 2. Dar permiso de firmar (tú + el equipo del cliente)
```bash
gcloud kms keys add-iam-policy-binding config-signing \
  --location=global --keyring=steelhead-automator --project="$PROJ" \
  --member="user:<correo>" --role="roles/cloudkms.signerVerifier"
```
Repite por cada persona que vaya a deployar. **Este es el único paso que cambia en el
handoff:** al salir alguien, se le quita con `remove-iam-policy-binding` (paso 5). No se
re-genera la llave ni se republica la extensión.

## 3. Recurso de la llave (para `SA_KMS_KEY`)
```
projects/<PROJ>/locations/global/keyRings/steelhead-automator/cryptoKeys/config-signing/cryptoKeyVersions/1
```
Exporta esto en tu shell antes de deployar:
```bash
export SA_KMS_KEY="projects/<PROJ>/locations/global/keyRings/steelhead-automator/cryptoKeys/config-signing/cryptoKeyVersions/1"
```

## 4. Sacar la pública y embeberla (habilita la Fase 2)
```bash
gcloud kms keys versions get-public-key 1 \
  --location=global --keyring=steelhead-automator --key=config-signing \
  --project="$PROJ" --output-file=/tmp/pub.pem
# PEM SPKI → base64 de una sola línea:
openssl pkey -pubin -in /tmp/pub.pem -outform DER | base64 | tr -d '\n'
```
Pega el resultado en `extension/integrity-pubkey.js`:
```js
self.SA_INTEGRITY_PUBKEY = '<base64-de-una-línea>';
```
Mientras esté vacío (`''`), la verificación está **desactivada** (fail-open) — nadie se
bloquea. Al embeber la pública real y republicar la extensión (bump de
`extension/manifest.json` + `config.extensionVersion`), la verificación pasa a
**fail-closed** para quien actualice.

## 5. Al salir un colaborador (handoff)
```bash
gcloud kms keys remove-iam-policy-binding config-signing \
  --location=global --keyring=steelhead-automator --project="$PROJ" \
  --member="user:<correo-que-sale>" --role="roles/cloudkms.signerVerifier"
```
Eso es todo: sin re-key, sin transferir archivos, sin republicar la extensión.

## Deploy firmado (día a día)
```bash
export SA_KMS_KEY="projects/.../cryptoKeyVersions/1"
tools/deploy.sh "fix(applet-x): descripción"   # seal + smoke-check automáticos
```
Si `SA_KMS_KEY` no está seteada, `deploy.sh` avisa y deploya **sin firmar** (útil pre-Fase-0).
El hook `pre-push` + el smoke-check post-deploy son los candados que evitan publicar una
firma mala.

## Nota sobre el formato de firma de gcloud — ✅ RESUELTO (2026-07-17, primera corrida real)
`gcloud kms asymmetric-sign` escribe la firma **DER binaria** al `--signature-file`.
`tools/seal-config.mjs` la lee binaria y la convierte a raw r||s (IEEE P1363, 64 bytes)
con `tools/lib/der-to-p1363.mjs` — que es lo que WebCrypto verifica en la extensión.

**Bug encontrado y corregido en la primera corrida real:** el backend `kmsSigner`
pre-calculaba `SHA256(mensaje)` y le pasaba ese digest a gcloud con `--digest-algorithm=sha256
--input-file=<digest>`. Pero gcloud con `--digest-algorithm` **hashea él mismo el input-file**,
así que firmaba `SHA256(SHA256(msg))` (doble hash) → la firma **no verificaba**. Comprobado en
vivo: firmar el **mensaje crudo** → `verify=true`; firmar el digest → `verify=false`. Fix:
`defaultGcloudSign` escribe el **mensaje** al `--input-file` (no el digest) y deja que gcloud
haga el sha256. Contrato de `kmsSigner` cambió de `signDigest` → `signMessage`. Tests
actualizados; seal real verifica de punta a punta.

## Pública real (proyecto steelhead-ecoplating) — para embeber en Fase 2
Key ring `steelhead-automator`, key `config-signing` v1 (`EC_SIGN_P256_SHA256`):
```
SA_INTEGRITY_PUBKEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhoH81jmmh5d0Lg+GBmqlMMm39gLEyMJDRX+fKcGYNfsg/Uc9uUT9ri+CK/7aKF0gt9MPKqj/yH6Y4P6XGqFayw=='
```
`SA_KMS_KEY = projects/steelhead-ecoplating/locations/global/keyRings/steelhead-automator/cryptoKeys/config-signing/cryptoKeyVersions/1`

## ⚠️ Orden de rollout y dependencia del cron (leer antes de activar)
La Fase 1 (primer deploy firmado, deja `config.sig` en gh-pages) sólo debe activarse cuando
**TODOS los que deployan tengan `SA_KMS_KEY` en su entorno** — incluido el **cron de
hash-autopilot** (corre `deploy.sh`, hereda el seal). Si el autopilot deploya **sin**
`SA_KMS_KEY` después de que exista `config.sig`, dejará `config.sig` inconsistente y el
`pre-push` (backstop) **bloqueará su push** → el autopilot fallaría. Coordinar con esa sesión:
exportar `SA_KMS_KEY` en el entorno del cron **antes** de la Fase 1.
- **Embeber la pública** (`extension/integrity-pubkey.js`) + republicar el `.zip` = **Fase 2**,
  y va **DESPUÉS** de Fase 1: si se republica con la pública embebida y aún NO hay `config.sig`
  en gh-pages, la extensión nueva verificaría un config sin firma → **fail-closed bloquea todo**.
