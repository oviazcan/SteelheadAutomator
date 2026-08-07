# Applet: `unit-autoconvert` — Auto-conversión de Unidades

**Versión actual:** 0.1.1 (código completo; **✅ validado en vivo 2026-07-22**, confirmación del operador)

## 0.1.1 (2026-08-07) — poll de ARRANQUE: el toggle podía no montarse nunca

Corregido **preventivamente**, junto con `proceso-calculator`, tras el reporte de piso *«falla en los
equipos Windows de menor desempeño»*. El applet dependía **solo** del `MutationObserver` (debounce
300 ms): si el único disparo caía mientras el modal se montaba, el encabezado todavía no existía,
`tryInjectToggles` no encontraba dónde colgar el toggle y no había quién reintentara.

> **El hallazgo que lo motiva** (medido en producción el 2026-08-07, `/Domains/344/SalesOrders` y
> `/Receiving/CustomerParts`): con un modal ABIERTO se contaron **0 mutaciones de `childList` en el
> `document.body` durante 6 segundos**, incluso tecleando dentro del modal. El `MutationObserver`
> **no es un vigilante continuo**: dispara en eventos discretos. En estas pantallas el único evento
> que llega es el montaje del modal — y si el debounce vence mientras ese montaje va a medias (lo
> normal en un equipo lento, donde el contenido se llena con la respuesta de red), el applet mira
> cuando no hay nada que ver, falla en silencio y **nadie vuelve a llamarlo**. En una máquina rápida
> todo se monta en la misma ráfaga y el disparo cae con el DOM completo: por eso el síntoma es
> *«a mí me funciona, a ellos es intermitente»*.
>
> Trinquete de familia: [`tools/test/modal-detect-poll-coverage.test.js`](../../tools/test/modal-detect-poll-coverage.test.js).

**Con presupuesto, y no por capricho:** aquí el trabajo NO es barato — `findByText` recorre
`p, span, strong, b, h1…h6, div, label` de todo el documento **sin early exit** (busca el match más
profundo, así que no puede cortar). Correrlo cada segundo mientras hubiera cualquier modal abierto
habría cambiado el bug por un costo permanente. El poll es entonces una red de **arranque**: cubre
los primeros `INJECT_TRY_BUDGET` (5) segundos de vida de cada diálogo —la ventana donde el equipo
lento monta el contenido tarde— y después se calla; el observer vuelve a ser el único mecanismo,
como hasta hoy. La política es pura y testeada: `Core.shouldAttemptInject({hasToggle, tries, max})`.

> **Regla:** cuando la red de seguridad es cara, se le pone presupuesto y se dice cuál es. Un poll
> que barre todo el documento cada segundo no es una red — es el siguiente reporte de piso.
**Archivo:** `remote/scripts/unit-autoconvert.js` (+ `unit-autoconvert-core.js` puro, golden tests en `tools/test/unit-autoconvert-core.test.js`)
**Global:** `window.UnitAutoConvert` · estado por sesión en `window.__saUac`


**Safari/iPad:** en el bundle **0.6.38** (2026-08-07). Este fix pesa más en el iPad que en escritorio: es el dispositivo del piso y la CPU más lenta del parque — el perfil exacto donde el montaje llega tarde y el observer ya no vuelve a mirar. **Pendiente recompilar en Xcode** (`Resources/` sincronizado ≠ compilado).

## Qué es
Al editar un NP, Tab en un campo de unidad → calcula los demás pares del mismo tipo físico:
- **Peso:** KGM ↔ LBR · **Longitud:** LM ↔ FOT · **Superficie:** CMK ↔ DMK ↔ FTK · (LO se ignora).

Híbrido: pares con campo/fila visible → DOM (setter nativo + `InputEvent`); pares sin campo
(DMK, o ausentes en Panel B) → API (`CreateInventoryItemUnitConversion`/`Update…`, reusando
el patrón de `weight-quick-entry`) + aviso de recarga.

## Pantallas
- **Panel A:** modal Edit Part Number → FACTORES Y PRECIO → "Per Part Count Unit Definitions"
  (default: KGM, LBR, FTK, CMK, FOT, LM, LO; **DMK ya se agregó como unidad parts-per → ahora también tiene campo** [2026-07-09], así que se DOM-llena como los demás; el path por API queda de fallback).
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

## Riesgo #1 — RESUELTO (2026-07-09, confirmado en vivo por el usuario)
- **SAVE del modal hace MERGE, no replace:** el DMK creado por API **sobrevive** al SAVE y a la recarga. El riesgo destructivo queda descartado.
- **Además, el usuario configuró DMK como unidad "parts per" → ahora DMK SIEMPRE aparece como campo en el modal (Panel A).** Consecuencia de diseño: como el enrutamiento DOM-vs-API es **dinámico** (`onFocusOut`→`findPeerInput`: si hay campo, DOM; si no, `missing`→API), **DMK ahora se DOM-llena automáticamente, sin cambio de código.** El path por API de DMK queda como fallback (prácticamente muerto), y el pendiente de `SearchUnits`/pinear el id de DMK se vuelve **innecesario**.
- **Etiqueta DMK CONFIRMADA (2026-07-09, HTML real):** el campo renderiza `"DMK Decímetro Cuadrado / Part:"` → `unitCodeFromText`=primer token=`"DMK"` ✓ y termina en `/ Part:` ✓ → `findPeerInput('A','DMK')` **matchea → DMK se DOM-llena**. Sin cambio de código. El applet ya está **VIVO** (el toggle `sa-uac-toggle` aparece inyectado en Panel A y B en el HTML del usuario).
- **Deuda bilingüe (ver regla nueva en CLAUDE.md §"Trabajo con UI / DOM"):** los anclajes de texto están mezclados y NO bilingües: `tryInjectToggles` headingA `/^per part count unit definitions/i` (**EN-only**), modoP `/^modo:?$/i` (**ES-only**); `classifyInput`/`findPeerInput` `/ Part:/i` (**EN-only**); `isReciprocalAdornment` `Parts //i` (**EN-only**). Funciona hoy porque la UI del usuario renderiza esos textos así, pero si Steelhead cambia de locale se rompe. **Pendiente:** hardening bilingüe con evidencia de ambos locales (parte del audit repo-wide).

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
- ~~Pinear `DMK` en `config.steelhead.domain.unitIds`~~ **YA NO APLICA** (DMK ahora es campo del modal → DOM, sin API/SearchUnits).
- **Confirmar la etiqueta del campo DMK** contra `findPeerInput`/`unitCodeFromText` — pedir al usuario el HTML del wrapper del campo DMK en Panel A (y su fila en Panel B). Si el primer token de la etiqueta no es `DMK`, ajustar `Core.unitCodeFromText` o el matcher.
- Confirmar permisos: operador no-admin escribiendo `CreateInventoryItemUnitConversion` (solo relevante para el fallback API de pares realmente ausentes; menos crítico ahora).
- Validación en vivo de los conversores (Panel A/B, Superficie CMK↔DMK↔FTK ahora todo DOM) + los watch-items de code review.
- Deploy a `gh-pages` + bump `config.version` (tras validación).
