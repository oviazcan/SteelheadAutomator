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

## Nota sobre el formato de firma de gcloud
`gcloud kms asymmetric-sign` escribe la firma **DER binaria** al `--signature-file`.
`tools/seal-config.mjs` la lee binaria y la convierte a raw r||s (IEEE P1363, 64 bytes)
con `tools/lib/der-to-p1363.mjs` — que es lo que WebCrypto verifica en la extensión.
**Verifica en la primera corrida real** que el comando exacto de tu versión de `gcloud`
produzca DER (algunas versiones tienen banderas distintas para el output); ajusta
`buildKmsArgs`/`defaultGcloudSignDigest` si hiciera falta.
