# Deuda de anclajes bilingües ES+EN — estado verificado (re-auditado 2026-07-17)

Barrido repo-wide de `remote/scripts/*.js`. Regla del repo: **todo anclaje a texto visible de
la UI de Steelhead debe matchear ES+EN** (SH cambia de idioma por usuario/config, a veces
mixto). Un anclaje mono-idioma se rompe **silenciosamente** al cambiar el locale.

**Estado (2026-07-17):** ~7 clusters **cerrados** desde el mapa viejo. Con la **evidencia HTML
del usuario** (2026-07-17) se recalibraron los modales contables (ver hallazgo abajo): bill-gate
**hardenizado idioma-indep**, e income/unit-PanelA/Line#/price "/ Part:" **NO son deuda real**
(SH no traduce esas etiquetas). Cero falla de seguridad activa (surtido-guard aclarado).

### 🔑 Hallazgo 2026-07-17 (evidencia HTML directa del usuario, locale ES)

En la instancia del usuario (datos en español) los **modales contables de SH renderizan las
etiquetas de UI en INGLÉS**, y solo los **datos** salen en español. Ejemplos verificados en el
HTML de los modales *Create/Edit Bill* y de la tabla de líneas de factura:

- **Etiquetas EN (no traducidas):** "Edit Bill", "Create Bill", "Vendor:", "Terms:", "Income
  Account", "Product", "Quantity", "Price", "Tax Code", "Close SO Line", "Line Item",
  "Per Part Count Unit Definitions:", "/ Part:", "/ Part", "Part Number", "Count:".
- **Datos ES (contenido del cliente):** nombres de unidad ("Kilogramo", "Libra", "Decímetro
  Cuadrado"), dimensiones custom ("Línea", "Departamento"), nodos ("Recibo de Orden",
  "Embarcando"), términos ("Contado (Pago vs. entrega)").

**Implicación:** para los anclajes que viven en estos modales contables, el "mono-idioma EN"
**no es deuda** — SH no traduce esas etiquetas (el usuario lo confirma: *"no está traducido
Income Account"*). La superficie real de traducción está en la UI de **tablero/órdenes/
scheduling** (donde SÍ se confirmaron pares bilingües: "Ship To/Enviar a", "From Node/Desde
Nodo", "Create Invoice/CREAR FACTURA"). Cautela: es UNA instancia; si algún día SH localiza
estos modales, revisitar. Aun así, donde el hardening idioma-indep es barato y sin regresión,
se aplicó de forma defensiva (bill-gate).

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
> deuda.** Lección: verificar la función completa, no la línea aislada del grep.
>
> Tras la evidencia HTML (hallazgo abajo), el conteo se redujo aún más: bill-gate
> **hardenizado**; income/unit-PanelA/price-"/Part:"/Line# **recalibrados a no-deuda** (SH no
> traduce los modales contables). Deuda genuinamente **incierta** restante: solo
> **surtido-guard** (verde cosmético), **invoice-default-tab** (tab), **load-calculator-modal**
> (título de modal) y el **alert** de price-confirm — todas P3, pendientes de evidencia del
> otro locale.

### 🧩 El patrón de cierre que ya usa el repo: `data-steelhead-component-id`

SH expone contenedores con `data-steelhead-component-id="…"` — atributo **idioma-indep y
estable**, ya usado en producción (`proceso-calculator` VIVO ancla `CREATE_PART_NUMBER_DIALOG_
DEFAULT_PROCESS`/`_LABELS`/`_ACCOUNTING_DIMENSIONS`; `price-confirm-guard` usa
`CREATE_PART_NUMBER_DIALOG_PER_PART_COUNT_UNIT_DEFINITIONS` y `PART_NUMBER_PAGE_UNITS`). **La
vía de cierre preferida** para las anclas de los modales *Editar NP* es reanclar por este id
(primario) con el texto como fallback, tal como `findProcessControl()`. Requiere confirmar el
id en el locale/estado real (varios aún no validados en vivo).

### ✅ CERRADO / recalibrado con la evidencia HTML 2026-07-17

| Applet | archivo:línea | Antes | Resolución |
|---|---|---|---|
| **bill-autofill** | `bill-autofill.js:162` | `/create bill\|edit bill/i` (gate EN) | **Hardenizado (workbench):** gate por texto + **fallback idioma-indep** `[role="dialog"] #root_DatosContables_Divisa` acotado a `/Bills` (aditivo, no regresa). El HTML confirmó que ese campo solo lo monta el editor de Bill. Sobrevive traducción **o** cambio del título. Pendiente deploy + run real. |
| **invoice-autofill** (income) | `:1089` `/^income account$/i`, `:1155` `/^income$/i` | deuda P2 | **NO es deuda.** Evidencia: la columna se llama "Income Account" en **inglés** aun con la instancia en español (el usuario confirma "no está traducido"). SH no traduce esa etiqueta. |
| **unit-autoconvert** (Panel A) | `:110` heading, `:147` `/\/\s*parts?:?\s*$/i` | deuda P2 | **NO es deuda** (mismo hallazgo: "Per Part Count Unit Definitions:" y "/ Part:" salen en inglés). El Panel A **no** expone `data-steelhead-component-id` (verificado en el HTML — price-confirm-guard lo asume; ese selector NO existe aquí). Recipe idioma-indep de reserva por si algún día se traduce: cada unidad es un `<div>` con `<p>`(code = 1er token: KGM/LBR/DMK…) + **un solo** `input[type="number"]` (sin recíproco). |

> **Ojo (deuda cruzada detectada):** `price-confirm-guard.js:145`/`:158` ancla el Panel A y la
> tabla Units por `[data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_PER_PART_COUNT_UNIT_DEFINITIONS"]`
> / `PART_NUMBER_PAGE_UNITS`, pero el HTML del Panel A **no trae** ese atributo → el DOM-fast-path
> del factor de price-confirm probablemente **no matchea** y siempre degrada a la API. No rompe
> (hay fallback API), pero conviene reanclar por estructura. Registrar en su bitácora.

### P3 — degradación menor / fail-safe

| # | Applet | archivo:línea | Ancla actual | Impacto | Evidencia que falta |
|---|---|---|---|---|---|
| 4 | **surtido-guard** | `:197` `/Tareas Programadas:/i`, `:207` `/Proceso:/i` | marcado verde de tarjetas | Cosmético: sin tinte verde en inglés (el bloqueo funciona). | HTML de una tarjeta con "Tareas Programadas" para anclar por estructura/testid. |
| 5 | **price-confirm-core** | `:77` `/saving price/i` (alert) | suprimir alert nativo post-bloqueo | Fail-safe: el `/ part:` (`:95`) queda cubierto por el hallazgo EN (no-traducido); solo el alert nativo "Error saving price" es de idioma incierto. Si SH lo traduce, el alert no se suprime (cosmético). | String ES del alert "Error saving price". |
| 6 | **invoice-autofill** | `:1058`, `:1797` | `"Line #N"` (parseo header + idempotencia) | **Probablemente NO es deuda** (hallazgo EN: el HTML muestra "Line Items"/"Line 1" en inglés en instancia ES). Confirmar en la tabla de líneas de **factura** (no bill) que "Line #N" sale en inglés. | Confirmar "Line #N" en el header de línea de factura (esperado: inglés). |
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
