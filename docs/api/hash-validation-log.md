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
