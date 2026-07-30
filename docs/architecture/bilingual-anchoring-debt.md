# Deuda de anclajes bilingües ES+EN — mapa completo (2026-07-15)

Barrido repo-wide de `remote/scripts/*.js` cerrando el pendiente del audit 2026-07-09 (que
cortó por límite de gasto). Regla del repo: **todo anclaje a texto visible de la UI de
Steelhead debe matchear ES+EN** (SH cambia de idioma por usuario/config, a veces mixto). Un
anclaje mono-idioma se rompe **silenciosamente** al cambiar el locale.

**Estado (actualizado 2026-07-28):** 23 anclajes mono-idioma en 12 applets — bajaron 2 al cerrarse
el **gate** y el **alert** de `price-confirm` con strings REALES capturados en producción (ver
§"Cierre 2026-07-27/28"). El resto del repo (la mayoría de autofills de recepción, y ~50 scripts
API-driven) está **limpio** o ya bilingüe.

> **Jerarquía (regla reescrita en `CLAUDE.md` el 2026-07-28):** este documento se llama "deuda
> bilingüe" por historia, pero la salida correcta de casi toda fila de abajo **no es traducir el
> string, es anclar por ESTRUCTURA del HTML** (`data-steelhead-component-id`, ids de schema RJSF,
> `data-testid`, posición en la tabla) y dejar el texto ES+EN como red de seguridad que solo
> AMPLÍA el match. El bilingüe puro queda para donde no hay estructura que anclar: `window.alert`,
> toasts, texto suelto.

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
- **unit-autoconvert**: `/ Part:` · `Parts /` (core `:55`, recíproco) · `Per Part Count Unit Definitions`
  → **ya hay evidencia (2026-07-27): SH NO traduce ese panel** — con la UI en español se ve literal
  «Per Part Count Unit Definitions:» y «KGM Kilogramo / Part:». No están rotos hoy; ver
  §"Evidencia colateral" abajo. Sigue siendo deuda (depender de que un vendor no traduzca es frágil),
  pero baja de prioridad.
- Resto de la tabla P2/P3 de abajo (create-order `Enviar a:`, bill-autofill `Create Bill`, proceso-calculator `Default Process:`, invoice-default-tab `Packing Slips`, load-calculator-modal `Rack Type`, etc.).

## ✅ Cierre 2026-07-27/28 — `price-confirm` (gate + alert) con strings REALES

Sesión con la UI de SH en español (dominio 344, NP 3235631). Se **midió** el gate en vivo en vez de
razonarlo, y salieron tres cosas que este documento tenía mal o como hipótesis:

| Ancla | Hipótesis que decía este doc | String REAL observado | ¿La hipótesis habría funcionado? |
|---|---|---|---|
| Título del modal de precio (`guard:15`) | «Precio de Número de Parte» | **«Precio del número de parte»** | **NO** — falta `del` y el casing difiere |
| Alert nativo tras bloquear (`core:78`) | «Error al guardar precio» | **«Error al guardar el precio»** | **NO** — un regex `/guardar\s+precio/i` no matchea el real |

**Las dos hipótesis eran incorrectas.** No "casi": un regex derivado de cualquiera de ellas habría
fallado en silencio. Es la mejor evidencia que tenemos de por qué la regla de no adivinar es dura.

**Medición del gate** (con el sub-modal de precio abierto, UI en español):
```
gatePorTitulo: false     ← /Part Number Price/i nunca matcheó
gatePorSchema: true      ← lo ÚNICO que sostenía el candado
```
O sea: el "cierre" del 2026-07-16 (fila de arriba) descansaba **entero** en el ancla estructural.
Funcionaba, pero sin saberlo — y antes de esa fecha el candado **no se disparaba** en el sub-modal
del asistente Editar NP. Corregido en **v0.1.5** (deploy config **1.7.228**, commits `1f6b6f9`
+ `a092c05`; bundle Safari **v0.6.2**): decisión pura `PriceConfirmCore.isPriceModal`, estructura
primero y título ES+EN como red de seguridad.

**El alert NO era cosmético.** Se creía que no suprimirlo solo era ruido; en la práctica
`window.alert` es **bloqueante**: congeló la pestaña a media investigación y hubo que cerrarlo a
mano. En iPad pesa más todavía. Ahí el bilingüe sí es la herramienta correcta — un `alert` no tiene
estructura que anclar.

### 🔎 Evidencia colateral: hay paneles que SH NO traduce

En la misma sesión, con la UI en español, el panel de unidades del modal Editar NP se veía así:

```
Per Part Count Unit Definitions:          ← encabezado EN, en una sesión en español
KGM Kilogramo / Part:                     ← label EN
LBR Libra / Part:
```

Eso **baja la prioridad** (no cierra) de tres filas de abajo: `unit-autoconvert :110`
(`/per part count unit definitions/i`), `unit-autoconvert :144/:157` (`"/ Part:"`) y
`price-confirm-core :94` (`isPerPartLabel`). **Hoy no están rotas**: SH no traduce ese panel.
Sigue siendo deuda porque depender de que un vendor NO traduzca es frágil — pero ya no son
sospechosas de estar fallando en piso, y el orden de ataque cambia.

## 🟡 Alta 2026-07-30 — `surtido-guard` 0.3.0 (filtro por línea destino)

| Ancla | archivo | ES (verificado en vivo) | EN (HIPÓTESIS, sin verificar) | Riesgo si falla |
|---|---|---|---|---|
| Barra del header del Workboard | `surtido-guard.js` `HEADER_BTN_RE` | `NUEVA TARJETA`, `ESCANEAR ETIQUETA` | `NEW CARD`, `SCAN JOB TAG` | **El box del filtro no se monta** — falla VISIBLE (el operador no ve el control), no silenciosa |

**Deuda aceptable y acotada**, por dos razones: (1) es un ancla de **UI de entrada**, no de un
gate de seguridad — si no matchea, el operador nota de inmediato que el filtro no está; (2) el
regex prueba **cuatro** textos (dos botones × dos idiomas), así que basta con que uno pegue.
**El resto del filtro es idioma-independiente**: la línea destino sale de la POSICIÓN de la celda
(`td[1]`) y de códigos `T204`/`T300` que no se traducen.

Una sola observación del Workboard en inglés cierra esta entrada.

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
| ~~price-confirm-guard~~ **CERRADO v0.1.5 (2026-07-28)** | `price-confirm-guard.js` | estructura (`root_DatosPrecio*`) **decide**; título ES+EN como red | ambos | string real: **«Precio del número de parte»** |
| cfdi-attacher | `:125`, `:133`, `:148` | `/send invoice email/i`, `/send invoice/i` | solo EN | ¿"Enviar Correo de Factura"? |
| unit-autoconvert | `:110` | `/per part count unit definitions/i` | solo EN | **encabezado NO traducido** (visto literal en sesión ES, 2026-07-27) → no roto hoy |
| unit-autoconvert | `:144`, `:157` | `"/ Part:"` | solo EN | **labels NO traducidos** («KGM Kilogramo / Part:» en sesión ES) → no roto hoy |
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
| ~~price-confirm-core~~ **CERRADO v0.1.5 (2026-07-28)** | `:78` | `/saving\s+price\|guardar\s+el\s+precio/i` | ambos | string real: **«Error al guardar el precio»** (el alert es BLOQUEANTE) |
| price-confirm-core | `:94` | `"/ part:"` | solo EN | **SH no traduce ese panel** (visto en sesión ES, 2026-07-27) → no está roto hoy; deuda de menor urgencia |
| invoice-autofill | `:1020`, `:1092`, `:1712` | `"Line #N"`, `"Line #N - PN"` | solo EN | ¿"Línea #N"? |
| invoice-autofill | `:1036`, `:1102` | `/income account/i`, `/^income$/i` | solo EN | ¿"Cuenta de Ingresos"/"Ingresos"? |
| invoice-autofill | `:2005` | `/accounts?_?receivable/i` | solo EN | constante — confirmar si SH la traduce |
| cfdi-attacher | `:167` | `/^(Logo\|Attach PDFs?\|Visible to Others)$/` | solo EN | ¿traducciones de las filas? |
| invoice-auto-regen | `:930` | `=== 'Close'` (botón) | solo EN | ¿"Cerrar"? |
| invoice-default-tab | `invoice-default-tab.js:12` | `/packing slips/i` | solo EN | ¿"Notas de Empaque"? |
| load-calculator-modal | `:251` | `/rack type/i` (título modal) | solo EN | ¿"Tipo de Rack"? |
| **warehouse-location-guard-core** `ROW_LOCATION_LABEL_RE` **(NUEVO 2026-07-29)** | `warehouse-location-guard-core.js` | `/^(?:ubicaci[oó]n\s+inicial\|initial\s+location)\s*:?$/i` | ES **verificado en vivo** («Ubicación Inicial:»); **EN es HIPÓTESIS mía** | ¿«Initial Location:»? — **no observado**, lo escribí por simetría. Ver la nota de abajo: el fallo **degrada, no apaga**. |

### 🆕 2026-07-29 — el candado de `warehouse-location-prefill` 0.6.x y la deuda que sí admite

El candado del modal de recibo introdujo **anclajes por texto nuevos**, y hay que ser explícito sobre cuáles tienen evidencia y cuáles no:

| Ancla | ES | EN | Si el EN falla |
|---|---|---|---|
| `ROW_LOCATION_LABEL_RE` (label del renglón) | **verificado en vivo**: «Ubicación Inicial:» | **hipótesis**: «Initial Location:» | **Degrada, no apaga**: `rowHasLocation` cae al criterio por placeholder («Search Locations», éste sí verificado desde 0.5.x) ⇒ se pierde solo la detección del estado *«escribiendo sin elegir»*, que la capa del **payload** frena igual. |
| `SAVE_BUTTON_RE` (botones del pie) | **verificado**: «Guardar», «Guardar + imprimir todas las piezas», «Guardar y agregar piezas a OT» | `/save/i` — **subcadena**, no string exacto | Robusto por construcción: cualquier variante en inglés («Save», «Save and add…») contiene `save`. |
| `CANCEL_BUTTON_RE` (excluir Cancelar) | **verificado**: «Cancelar» | `/^cancel$/i` exacto | Si el real fuera «Cancel changes», `findFooter` no reconoce el pie y **acota al modal** (scope más amplio, sigue operando); y ese texto tampoco matchea `save`, así que **no se bloquea por error**. |

**Por qué esta deuda es aceptable donde la de `price-confirm-guard` no lo era:** ahí el texto era la ÚNICA señal de un candado, y al no matchear el candado **se apagaba en silencio**. Aquí cada anclaje por texto tiene detrás (a) un fallback estructural o de subcadena y (b) el candado del **payload**, que es idioma-independiente. La degradación es acotada y observable, no silenciosa.

**Cómo cerrarla:** una sola observación del modal con la UI en inglés basta para confirmar las tres filas. No adivinar más de lo ya adivinado.

## Cómo cerrar la deuda (para cada fila)

1. **Preferido — anclar por estructura idioma-independiente:** si el modal/tarjeta tiene un
   `data-testid`, `id` estable o icono con `aria`/testid (como ya hacen `report-regen`,
   `sensor-graph-hide-all`, `invoice-listing-marker`), reanclar ahí. No necesita traducción.
   Requiere que me pases el **wrapper HTML** del bloque.
2. **Alternativa — texto bilingüe:** confirmar el string del otro locale (observándolo en SH
   con el idioma cambiado) y ampliar la regex a `/(es|en)/i`. NO codificar la hipótesis.

## Limpios / ya bilingües (referencia)

Autofills de recepción (`receiver-date-override`, `warehouse-location-prefill` — **su
autofill sigue limpio, pero su CANDADO 0.6.x agregó anclajes por texto: ver la sección
«2026-07-29» arriba**, `weight-quick-entry` = patrón bueno), `bill-autofill` (salvo `:162`), la mayoría de
`invoice-autofill`, `create-order-autofill` (salvo `:231`), `pn-specs-column`,
`report-regen` (ancla por testid). Los ~50 scripts API-driven no anclan texto de SH.
