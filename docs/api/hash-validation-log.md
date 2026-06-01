# Bitácora de validación de hashes

Append-only. Cada corrida del cron `steelhead-hash-validator` (lun-vie 8am)
agrega una entrada con timestamp + diff de hashes rotados.

Si una entrada lista `0 rotado(s)` → todo OK ese día.

Cuando aparece una entrada con rotados:
1. Confirmar en el navegador con el applet `hash-scanner`
2. Bumpear `remote/config.json` con los hashes nuevos + `version`
3. Deploy a `gh-pages` (procedimiento en `CLAUDE.md`)
4. Verificar con re-corrida manual de `tools/validate-hashes.py`

---

## 2026-05-23 — Setup inicial + primera rotación detectada

**Corrida**: manual (cron aún no agendado).

**Resultado**: 152 ok / 0 stale / 2 skipped / 0 unknown / 0 auth (config v1.4.26).

### Hashes rotados (detectados + reparados en la misma sesión)

| Operación | Hash viejo | Hash nuevo | Detectado por | Capturado por |
|---|---|---|---|---|
| `GetReceivedOrder` | `c8b31fbc…c151e4f7` | `a286ac8f…f743b8dd5` | validador (Must provide a query string) | hash-scanner navegador (pantalla Receiver Edit) |
| `GetAddPartsReceivedOrder` | `88063397…cda765467` | `f42b08f4…2134ac9f` | validador (Must provide a query string) | hash-scanner navegador (pantalla Add Parts) |

Deploy: `gh-pages` bump 1.4.26, byte-exact verificado con `tools/check-deploy.sh`.

### Whitelist (falsos positivos confirmados)

- `CurrentUser` → hash idéntico en config y scan; 61 invocaciones browser OK;
  responde "Must provide a query string" sólo a scripts externos.
- `GetPurchaseOrder` → mismo patrón; 12 invocaciones browser OK en pantalla Bills.

Diagnóstico: Steelhead distingue browser-Apollo vs cliente-externo para
estas dos ops sensibles a sesión. La validación confiable de éstas es
sólo vía `hash-scanner` en navegador, no este script.

## 2026-05-25 08:35 — 0 rotado(s) (config v1.4.31)

## 2026-05-26 08:41 — 0 rotado(s) (config v1.5.4)

## 2026-05-27 11:05 — 0 rotado(s) (config v1.6.1)

## 2026-05-28 08:35 — 0 rotado(s) (config v1.6.11)

## 2026-06-01 13:30 — 1 stale + 3 reparados en sesión (config v1.6.23)

**Corrida**: manual, disparada junto al deploy del applet `wo-mover`.

**Resultado validador**: 155 ok / 1 stale / 2 skipped / 0 unknown / 0 auth (~99s).

### Rotaciones reparadas en esta sesión (capturadas vía hash-scanner del flujo wo-mover)

| Operación | Hash viejo | Hash nuevo | Nota |
|---|---|---|---|
| `GetReceivedOrder` | `a286ac8f…f743b8dd5` | `4fa89e55…17a7f2bc` | el nuevo query trae workOrders + partTransforms + partAccountsNotAssignedToReceivedOrder en una pasada; ya no requiere Pass 2 (`GetAddPartsReceivedOrder`) |
| `ActiveReceivedOrders` | `4f06f3cb…03aec54b1d` | `495ddfd6…47914890` | **CAMBIÓ variables**: sin `domainId`; ahora `includeArchived`/`receivedOrderStatusFilter`/`searchQuery`. Root key `pagedData`. Actualizado en `po-reconciler.js` + `ov-operations.js` |
| `AllLabels` | `2b16b142…4aa3073c` | `4323ade0…05bef94e` | variables compatibles, solo hash |

Nuevas queries registradas: `WorkOrderDialogQuery`, `GetPartsTransferAccountAssociationData` (flujo de mover OT / asociar partes).

### STALE pendiente de captura

| Operación | Usado por | Acción |
|---|---|---|
| `GetDomain` | `bill-autofill`, `invoice-autofill` (tipo de cambio: `customInputs.TipoCambio` / `currentExchangeRate`) | Correr hash-scanner en la pantalla de facturación que dispare `GetDomain`, capturar el hash nuevo, actualizar `config.json` + redeploy. **Mientras tanto, el tipo de cambio en facturación puede fallar.** |

