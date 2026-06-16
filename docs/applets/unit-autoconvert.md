# Applet: `unit-autoconvert` — Auto-conversión de Unidades

**Versión actual:** 0.1.0 (código completo; **pendiente validación en vivo**)
**Archivo:** `remote/scripts/unit-autoconvert.js` (+ `unit-autoconvert-core.js` puro, golden tests en `tools/test/unit-autoconvert-core.test.js`)
**Global:** `window.UnitAutoConvert` · estado por sesión en `window.__saUac`

## Qué es
Al editar un NP, Tab en un campo de unidad → calcula los demás pares del mismo tipo físico:
- **Peso:** KGM ↔ LBR · **Longitud:** LM ↔ FOT · **Superficie:** CMK ↔ DMK ↔ FTK · (LO se ignora).

Híbrido: pares con campo/fila visible → DOM (setter nativo + `InputEvent`); pares sin campo
(DMK, o ausentes en Panel B) → API (`CreateInventoryItemUnitConversion`/`Update…`, reusando
el patrón de `weight-quick-entry`) + aviso de recarga.

## Pantallas
- **Panel A:** modal Edit Part Number → FACTORES Y PRECIO → "Per Part Count Unit Definitions"
  (7 campos default: KGM, LBR, FTK, CMK, FOT, LM, LO; **DMK no tiene campo** → solo por API).
- **Panel B:** modal "Definir Unidades Para <PN>" (tabla Unidad | Unidades/Parts | Parts/Unit).

## Decisiones
- Sobrescribe siempre · 4 decimales (trim) · toggle visible default ON **por sesión**
  (`window.__saUac.enabled`) · kill-switch global `config.unitAutoConvertEnabled`.

## DOM (selectores verificados contra HTML real)
- Panel A: input dentro de `.MuiFormControl-root`; `<p>` hermano termina en "/ Part:" → código = primer token del label.
- Panel B: `<tr.MuiTableRow-root>`; `td[0] p` = nombre (primer token = código); input Unidades/Parts
  = el del `<td>` cuyo adorno NO empieza con "Parts /" (el recíproco Parts/Unit se descarta y Steelhead lo recalcula solo).

## API
- `factor` de la conversión = valor "Unidades / Parts" (number, igual que `weight-quick-entry`). Hashes en `config.json`:
  `GetAvailableUnits`, `CreateInventoryItemUnitConversion`, `UpdateInventoryItemUnitConversion`,
  `SearchUnits` (para resolver id de DMK; no está en `domain.unitIds`).
- `inventoryItemId`: cacheado por interceptor de fetch (scan recursivo de `inventoryItemByPartNumberId.id`),
  fallback `GetPartNumber` por pnId.
- Llamadas API serializadas (cola en `S.apiQueue`) para que blurs concurrentes no dupliquen conversiones.

## Riesgo #1 a validar en vivo (BLOQUEANTE antes de exponer)
- **SAVE del modal vs conversiones sin campo (DMK creado por API):** ¿el SAVE del modal hace
  **merge** (DMK sobrevive) o **replace** (DMK se borra)? Probar: CMK→Tab crea DMK por API → SAVE →
  recargar y verificar si DMK persiste. <RESULTADO: pendiente validación en vivo> — <acción tomada>.

## Watch-items de validación en vivo (salieron en code review)
- **Scope modal vs ficha (eco de `proceso-calculator` v0.1.3/0.1.4):** `findPeerInput` Panel A escanea
  `document.querySelectorAll('p.MuiTypography-root')` sin acotar a un contenedor. Si la ficha detrás del
  modal monta campos "/ Part:" duplicados, podría escribir en el input equivocado. Confirmar en vivo;
  si pasa, acotar `findPeerInput` al root del panel del input editado.
- **`parseFloat` y decimales con coma:** si Steelhead alguna vez muestra valores con coma decimal
  (`1,234`), `parseFloat` truncaría. Hoy los inputs son numéricos sin formato locale (consistente con
  `weight-quick-entry`). Vigilar.
- **`findPeerInput` Panel A** asume que el `<p>` label y su `.MuiFormControl-root` comparten wrapper
  (verificado en el HTML provisto). Loguear `peerInput` en la 1ª validación para confirmar.

## Pendientes
- Pinear `DMK` en `config.steelhead.domain.unitIds` (id confirmado: <PENDIENTE confirmar en vivo vía SearchUnits>).
- Confirmar permisos: operador no-admin escribiendo `CreateInventoryItemUnitConversion`.
- Deploy a `gh-pages` + bump `config.version` (Task 7 del plan, tras validación).
