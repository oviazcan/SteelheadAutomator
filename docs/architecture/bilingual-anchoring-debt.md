# Deuda de anclajes bilingües ES+EN — estado verificado (re-auditado 2026-07-17)

Barrido repo-wide de `remote/scripts/*.js`. Regla del repo: **todo anclaje a texto visible de
la UI de Steelhead debe matchear ES+EN** (SH cambia de idioma por usuario/config, a veces
mixto). Un anclaje mono-idioma se rompe **silenciosamente** al cambiar el locale.

**Estado (2026-07-17):** ~7 clusters **cerrados** desde el mapa viejo; **8 anclas de deuda
real** restantes (4 P2 + 4 P3), todas bloqueadas por evidencia (string del otro locale o
wrapper HTML). Cero falla de seguridad activa (surtido-guard aclarado). Ver detalle abajo.

> **Por qué esta re-auditoría.** El mapa original (2026-07-15, commit `069ebab`) quedó
> **desfasado**: entre el 07-16 y el 07-17 se deployaron ~7 clusters de anclaje bilingüe/
> idioma-indep que ese mapa no reflejaba, y además **exageraba** la severidad de surtido-guard
> (lo marcaba P1 "no bloquea"; en realidad el bloqueo es idioma-indep — ver abajo). Este
> archivo verifica **contra los archivos**, no contra el mapa viejo.

## ⚠️ Regla dura: NO adivinar traducciones ni estructura DOM

El CLAUDE.md prohíbe (a) inventar la traducción del otro locale, y (b) adivinar la estructura
DOM en vez de pedir el wrapper HTML. Para cerrar cada fila restante hace falta **evidencia
real**: el string del idioma faltante (observado en SH con el locale cambiado) **o** el
**wrapper HTML** del bloque (para reanclar por `data-testid`/`id`/estructura, que es
idioma-indep). Las hipótesis de traducción abajo son **solo pistas a confirmar**, NO valores a
codificar. Barrido repo-wide 2026-07-17: **ninguna** de las traducciones faltantes existe ya
como ancla bilingüe en otro applet → no hay atajo por evidencia interna.

---

## ✅ CERRADO desde el mapa viejo (verificado en archivo + commit)

| Cluster | Antes (mapa viejo) | Cómo quedó anclado ahora | Commit |
|---|---|---|---|
| **price-confirm-guard** gate | `/Part Number Price/i` (título modal, EN) | `[id^="root_DatosPrecio"]` — schema RJSF idioma-indep | `24e9f1c` |
| **invoice-autofill** gate/heading | `/…new invoice for/i` (EN) | gate por `root_DatosContables_*` + `HEADING_RE` bilingüe + "invoice for/factura para" | `f48c7df` |
| **invoice-auto-regen** ×4 | `Invoices`, `CREAR FACTURA`, `confirmar`, `Close` (mezcla mono) | `invoices\|facturas`, `CREAR FACTURA\|CREATE INVOICE`, `confirmar\|confirm`, `close\|cerrar` | `98fa9fc` |
| **cfdi-attacher** gate + inserción | `/send invoice email/i`, filas por texto EN | `data-testid` SendIcon/EmailOutlinedIcon + fila por `.MuiSwitch-root` (texto EN solo fallback muerto) | `c567310` |
| **create-order-autofill** ship-to | `/enviar a:/i` (ES) | `Enviar a:`/`Ship To:` bilingüe (label EN observado) | `1fc1d8c` |
| **unit-autoconvert** Panel B + modo | `"/ Part:"` recíproco, `Modo` (mono) | recíproco por **POSICIÓN** (idioma-indep) + `modo\|mode` bilingüe | `3a09516`, `7c067d5` |
| **surtido-guard** BLOQUEO | (mapa lo marcaba P1 "no bloquea") | el bloqueo NO es text-anchored — ver corrección abajo | (ya estaba) |

### 🔧 Corrección de severidad: surtido-guard NO tiene falla de seguridad en inglés

El mapa viejo decía "con SH en inglés el candado no marca verde **ni bloquea**". **Falso.**
Verificado en `surtido-guard.js`:

- **El bloqueo real es API-driven / idioma-indep.** `modalShouldBlock()` (:146) decide con
  `surtidoNodeIds` y `scheduledAccountIds`, sets construidos desde las respuestas GraphQL
  (`GetRelatedScheduleData`, `BOARD_RECIPENODES_OP`). El agrisado del modal `applyModalGuard()`
  ancla el diálogo con `findMoveDialog()` (:141) que **ya es bilingüe** (`Desde Nodo:`/`From
  Node:`, `Mover Piezas`/`Move Parts`) y los botones con `mover`/`move`, `imprimir y mover`/
  `print and` (:175-176). **Con SH en inglés, el candado sigue bloqueando.**
- **Lo único mono-idioma ES es el marcado verde cosmético** (`decorateCards()` :195-212), que
  ancla `/Tareas Programadas:?/i` (:197) y `/Proceso:/i`+`/WO:/i` (:207) solo para pintar un
  acento verde en las tarjetas programadas. Si SH está en inglés, las tarjetas **no reciben el
  tinte verde**; el bloqueo no se afecta. → **Deuda real: P3 cosmético**, no P1 seguridad.

---

## 🔴 Deuda real restante (verificada, mono-idioma, sin evidencia interna para cerrar)

Prioridad por **impacto funcional** (deja de dispararse el autofill/guard), no por locale.

> **Falso positivo corregido (re-verificación 2026-07-17).** El grep-por-línea marcó
> `proceso-calculator:259` `/^default process:?$/i` como deuda, pero `findProcessControl()`
> (:255) **ya ancla idioma-indep como PRIMARIO** por `[data-steelhead-component-id=
> "CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS"]` (:257); el texto es solo fallback. **NO es
> deuda.** Lección: verificar la función completa, no la línea aislada del grep. → quedan **8**
> anclas reales.

### 🧩 El patrón de cierre que ya usa el repo: `data-steelhead-component-id`

SH expone contenedores con `data-steelhead-component-id="…"` — atributo **idioma-indep y
estable**, ya usado en producción (`proceso-calculator` VIVO ancla `CREATE_PART_NUMBER_DIALOG_
DEFAULT_PROCESS`/`_LABELS`/`_ACCOUNTING_DIMENSIONS`; `price-confirm-guard` usa
`CREATE_PART_NUMBER_DIALOG_PER_PART_COUNT_UNIT_DEFINITIONS` y `PART_NUMBER_PAGE_UNITS`). **La
vía de cierre preferida** para las anclas de los modales *Editar NP* es reanclar por este id
(primario) con el texto como fallback, tal como `findProcessControl()`. Requiere confirmar el
id en el locale/estado real (varios aún no validados en vivo).

### P2 — el applet deja de funcionar en el otro locale

| # | Applet | archivo:línea | Ancla actual | Impacto | Cómo cerrar (evidencia/vía) |
|---|---|---|---|---|---|
| 1 | **bill-autofill** | `bill-autofill.js:162` | `/create bill\|edit bill/i` (gate por heading) | En español NO detecta el editor Create/Edit Bill → **no autollena** (divisa/TC/cuentas). El gemelo `invoice-autofill` ya migró a gate `root_DatosContables_*`. | HTML del modal Bill, **o** confirmar que `root_DatosContables_Divisa` (que bill-autofill ya lee/llena, :94/:107/:120) aparece **solo** en el editor dentro de `/Bills` → gate aditivo idioma-indep (espejo del gemelo, no regresa). |
| 2 | **invoice-autofill** | `:1089` `/^income account$/i`, `:1155` `/^income$/i` | columna/label "Income Account" | En español no ubica la columna de cuenta de ingreso → **no llena** ingreso/descuento por línea. | invoice-autofill NO usa `component-id`/`testid` (verificado) → necesita el **string ES** de "Income Account" y "Income". |
| 3 | **unit-autoconvert** | `:110` heading (Panel A), `:147` `/\/\s*parts?:?\s*$/i` | encabezado + label "/ Part:" del Panel A | En español el toggle del Panel A no se inyecta / no llena. (El Panel B ya es idioma-indep; el Panel A no tiene par de inputs para discriminar por posición.) | **Vía concreta:** reanclar `tryInjectToggles` al contenedor `[data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_PER_PART_COUNT_UNIT_DEFINITIONS"]` (el mismo que ya usa price-confirm-guard) como **fallback aditivo** del heading de texto. Falta validar el id en un locale full-ES. El `/ Part:` de `:147` (routing de auto-fill) aún necesitaría string ES o HTML. |

### P3 — degradación menor / fail-safe

| # | Applet | archivo:línea | Ancla actual | Impacto | Evidencia que falta |
|---|---|---|---|---|---|
| 4 | **surtido-guard** | `:197` `/Tareas Programadas:/i`, `:207` `/Proceso:/i` | marcado verde de tarjetas | Cosmético: sin tinte verde en inglés (el bloqueo funciona). | HTML de una tarjeta con "Tareas Programadas" para anclar por estructura/testid. |
| 5 | **price-confirm-core** | `:77` `/saving price/i`, `:95` `/\/ part:/i` (Panel A) | suprimir alert nativo + parseo de factor | Fail-safe: en español el factor DOM se salta y **degrada a la API** (no bloquea). El contenedor ya es idioma-indep (`data-steelhead-component-id`). | Strings ES: alert "Error saving price" y adorno "/ Part:". |
| 6 | **invoice-autofill** | `:1058`, `:1797` | `"Line #N"` (parseo header + idempotencia) | En español no reconoce el header de línea → riesgo de doble-inserción / no parsea. | String ES de "Line #N" (¿"Línea #N"?). |
| 7 | **invoice-default-tab** | `invoice-default-tab.js:12` | `/^packing slips$/i` (tab) | En español no autoclickea el tab (el usuario lo hace a mano). El gate de redirección ya es idioma-indep (URL + `?mode`). | String ES "Packing Slips" (¿"Notas de Empaque"?) **o** HTML del tab (para anclar por href/`mode`). |
| 8 | **load-calculator-modal** | `:251` `/rack type/i` | anclar el modal de Rack Types | En español no encuentra el modal → no calcula. Se dispara por `CreateEditPartsPerRackTypeQuery` (API, idioma-indep); solo el `findModal()` depende del texto. `h2#form-dialog-title` (el id) ya es idioma-indep. | HTML del modal para reanclar por `#form-dialog-title` + estructura sin el texto "rack type". Revisar si el modal expone `data-steelhead-component-id` (varios modales de NP lo hacen). |

### No es deuda (aclaración)

- `invoice-autofill.js:711` `/receivable/i` **no** ancla texto de UI: filtra el enum
  `acctAccountTypeByTypeId.category` de la API (no lo traduce el locale del usuario).

---

## Cómo cerrar cada fila (recordatorio de método)

1. **Preferido — anclar por estructura idioma-indep** (`data-testid`, `id` estable, icono con
   `aria`/testid, o **posición** cuando hay par de inputs). No necesita traducción. Requiere el
   **wrapper HTML** del bloque.
2. **Alternativa — texto bilingüe:** confirmar el string del otro locale observándolo en SH con
   el idioma cambiado y ampliar la regex. **NO codificar la hipótesis.**

## Cómo entregar la evidencia (para el usuario)

Lo más rápido para cerrar varias de un jalón: con SH en el **locale contrario** al de tu cuenta,
manda para cada pantalla el **wrapper HTML** del bloque (el padre cercano con labels + inputs).
Prioriza por impacto: **P2 #1–#4** primero. Un solo HTML por modal cierra la fila en un commit.
