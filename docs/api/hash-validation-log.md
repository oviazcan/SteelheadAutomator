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

