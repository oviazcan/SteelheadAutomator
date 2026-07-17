# Deuda de anclajes bilingües ES+EN — mapa completo (2026-07-15)

Barrido repo-wide de `remote/scripts/*.js` cerrando el pendiente del audit 2026-07-09 (que
cortó por límite de gasto). Regla del repo: **todo anclaje a texto visible de la UI de
Steelhead debe matchear ES+EN** (SH cambia de idioma por usuario/config, a veces mixto). Un
anclaje mono-idioma se rompe **silenciosamente** al cambiar el locale.

**Estado:** 25 anclajes mono-idioma en 12 applets. El resto del repo (la mayoría de autofills
de recepción, y ~50 scripts API-driven) está **limpio** o ya bilingüe.

## ✅ CERRADOS 2026-07-16 — anclaje ESTRUCTURAL (idioma-independiente, deploy 1.7.129/1.7.132)

Reanclados por estructura/`id`/testid (NO texto), así que sobreviven traducción y el bug de caché:

| Applet | Antes (mono-EN) | Ahora (idioma-indep) |
|---|---|---|
| **cfdi-attacher** `:125/:133/:148` (gate) | `/send invoice email/i` | heading EN **O** ≥2 `tr .MuiSwitch-root` + `[data-testid=SendIcon\|EmailOutlinedIcon]` |
| **cfdi-attacher** `:167` (inserción de fila) | texto `Logo\|Attach PDFs\|Visible to Others` | última `<tr>` con `.MuiSwitch-root` (fallback al texto EN) |
| **price-confirm-guard** `:15` (gate, SEGURIDAD) | `/Part Number Price/i` | título EN **O** `[id^="root_DatosPrecio"]` (schema RJSF exclusivo del modal de precio) |
| **unit-autoconvert** `:144/:157` (Panel A) | `/ Part:` (singular) | `/ Parts?:/` (tolera singular/plural EN; el gate del toggle ya tenía respaldo bilingüe `modoP`) |

**invoice-autofill** (deploy 1.7.130): NO era deuda de anclaje sino **bug funcional** — el react-select
no amarraba la opción (AR + income). Resuelto con resaltar→verificar→`Enter` (determinista, idioma-indep).

### 🔴 Deuda restante que SÍ requiere el string del otro idioma (NO adivinar)

Para cerrar estos hace falta **observar el string traducido** (poner el navegador en el otro locale y capturar):
- **unit-autoconvert**: `/ Part:` → ¿`/ Parte:`?  ·  `Parts /` (core `:55`, recíproco) → ¿`Partes /`?  ·  `Per Part Count Unit Definitions` → ¿string ES?
- Resto de la tabla P2/P3 de abajo (create-order `Enviar a:`, bill-autofill `Create Bill`, proceso-calculator `Default Process:`, invoice-default-tab `Packing Slips`, load-calculator-modal `Rack Type`, etc.).

## ⚠️ Regla dura: NO adivinar traducciones

El CLAUDE.md prohíbe inventar la traducción del otro locale. Para hardenizar cada gate hace
falta **el string real** del idioma faltante (obsérvalo en producción con el locale cambiado,
o pásame el **wrapper HTML del modal** para anclar por `data-testid`/estructura, que es
idioma-independiente y NO necesita traducción). Las columnas "hipótesis" abajo son **solo
pistas para que las confirmes**, no valores a codificar.

## ✅ CORRECCIÓN (2026-07-16) — surtido-guard NO es riesgo de seguridad

Revisión anterior lo marcó P1 por error. Verificado en código: el **bloqueo** de surtido-guard es
**100% API-driven** — `surtido-guard.js:102-113` llama `Core().evaluateMove(vars, ctx())` comparando
el `fromAccountId` de la mutación `CreateManyPartsTransfersChecked` contra `scheduledAccountIds`
(construido de `GetRelatedScheduleData` / `BOARD_SCHEDULE_OP`, líneas 118-122). **No usa texto de UI**,
así que **el candado bloquea en cualquier idioma**. La detección de modal también es bilingüe
(`:141` "Desde Nodo:"/"From Node:", botones `:175-176`).

Las cadenas mono-ES `/Tareas Programadas:/i` (`:197`) y `/Proceso:/i` (`:207`) alimentan **solo el
marcado VERDE visual** de tarjetas programadas (`decorateCards`, Task 7). Con SH en inglés el verde no
se pinta — **cosmético, no de seguridad**. Fix opcional (P3): anclar por `data-testid`/estructura de la
tarjeta (requiere el HTML de una tarjeta con "Tareas Programadas") o agregar el label EN.

## 🟡 PRIORIDAD 2 — Autofills/guards principales (dejan de dispararse)

| Applet | archivo:línea | Ancla actual | Idioma | Hipótesis a confirmar |
|---|---|---|---|---|
| invoice-autofill | `:857`, `:233` | `/creating\|editing\|create\|edit\|new invoice for/i` | solo EN | ¿"Creando/Nueva Factura para"? |
| price-confirm-guard | `price-confirm-guard.js:15` | `/Part\s*Number\s*Price/i` (título modal) | solo EN | ¿"Precio de Número de Parte"? |
| cfdi-attacher | `:125`, `:133`, `:148` | `/send invoice email/i`, `/send invoice/i` | solo EN | ¿"Enviar Correo de Factura"? |
| unit-autoconvert | `:110` | `/per part count unit definitions/i` | solo EN | ¿string ES del encabezado? |
| unit-autoconvert | `:144`, `:157` | `"/ Part:"` | solo EN | ¿"/ Parte:"? |
| unit-autoconvert-core | `:55` | `/^\s*parts\s*\//i` ("Parts /") | solo EN | ¿"Partes /"? |
| create-order-autofill | `create-order-autofill.js:231` | `/enviar a:/i` | solo ES | ¿"Ship to:"? (hay evidencia interna: `invoice-autofill.js:1822` ya ancla `ship to`↔`enviar a` — **confirmable rápido**) |
| invoice-auto-regen | `:415` | `=== 'CREAR FACTURA'` (botón) | solo ES | ¿"CREATE INVOICE"? (evidencia: `HEADING_RE` create/crear) |
| invoice-auto-regen | `:979` | `/^confirmar$/i` | solo ES | ¿/^confirm$/? |
| invoice-auto-regen | `:398`, `:409` | `=== 'Invoices'` (heading) | solo EN | ¿"Facturas"? |

## 🟢 PRIORIDAD 3 — Labels secundarios (menor impacto)

| Applet | archivo:línea | Ancla actual | Idioma | Hipótesis |
|---|---|---|---|---|
| proceso-calculator | `:241` | `/^default process:?$/i` | solo EN | ¿"Proceso Predeterminado:"? |
| bill-autofill | `:162` | `/create bill\|edit bill/i` | solo EN | ¿"Crear/Editar Factura de Proveedor"? |
| price-confirm-core | `:78` | `/saving price/i` (alert) | solo EN | ¿"Error al guardar precio"? |
| price-confirm-core | `:94` | `"/ part:"` | solo EN | ¿"/ Parte:"? |
| invoice-autofill | `:1020`, `:1092`, `:1712` | `"Line #N"`, `"Line #N - PN"` | solo EN | ¿"Línea #N"? |
| invoice-autofill | `:1036`, `:1102` | `/income account/i`, `/^income$/i` | solo EN | ¿"Cuenta de Ingresos"/"Ingresos"? |
| invoice-autofill | `:2005` | `/accounts?_?receivable/i` | solo EN | constante — confirmar si SH la traduce |
| cfdi-attacher | `:167` | `/^(Logo\|Attach PDFs?\|Visible to Others)$/` | solo EN | ¿traducciones de las filas? |
| invoice-auto-regen | `:930` | `=== 'Close'` (botón) | solo EN | ¿"Cerrar"? |
| invoice-default-tab | `invoice-default-tab.js:12` | `/packing slips/i` | solo EN | ¿"Notas de Empaque"? |
| load-calculator-modal | `:251` | `/rack type/i` (título modal) | solo EN | ¿"Tipo de Rack"? |

## Cómo cerrar la deuda (para cada fila)

1. **Preferido — anclar por estructura idioma-independiente:** si el modal/tarjeta tiene un
   `data-testid`, `id` estable o icono con `aria`/testid (como ya hacen `report-regen`,
   `sensor-graph-hide-all`, `invoice-listing-marker`), reanclar ahí. No necesita traducción.
   Requiere que me pases el **wrapper HTML** del bloque.
2. **Alternativa — texto bilingüe:** confirmar el string del otro locale (observándolo en SH
   con el idioma cambiado) y ampliar la regex a `/(es|en)/i`. NO codificar la hipótesis.

## Limpios / ya bilingües (referencia)

Autofills de recepción (`receiver-date-override`, `warehouse-location-prefill`,
`weight-quick-entry` = patrón bueno), `bill-autofill` (salvo `:162`), la mayoría de
`invoice-autofill`, `create-order-autofill` (salvo `:231`), `pn-specs-column`,
`report-regen` (ancla por testid). Los ~50 scripts API-driven no anclan texto de SH.
