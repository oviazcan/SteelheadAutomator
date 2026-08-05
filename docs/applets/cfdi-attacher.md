# `cfdi-attacher` — Adjuntar CFDI

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Facturación

> **Nota de procedencia (2026-08-05).** Esta bitácora se escribió *a posteriori*: el applet
> llevaba tiempo vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener
> bitácora**. Salió a la luz al rastrear qué se rompía con la rotación de
> `InvoiceByIdInDomain` — el hash del que depende su función central. Un applet indocumentado
> no es sólo un hueco de documentación: **es un applet cuya rotura nadie sabe atribuir.**
> El contenido de abajo está derivado de leer `remote/scripts/cfdi-attacher.js` (329 líneas)
> y su entrada en `config.json`, no de memoria.

## Qué hace

Al enviar por correo una factura desde Steelhead, **adjunta automáticamente el XML del CFDI**
(el comprobante fiscal mexicano) además del PDF que manda el ERP. Sin él, el operador tendría
que descargar el XML y adjuntarlo a mano en cada envío.

Añade al modal de envío una fila propia — **«Adjuntar XML(s) CFDI»**, encendida por default —
y **delata en ámbar** las facturas del lote que **no tienen XML disponible**
(`⚠ Factura(s) #… sin XML CFDI disponible`). Es la aplicación de la regla del repo *marca la
excepción, no la norma*: no confirma las que sí lo traen, avisa de las que no.

## Cómo funciona (dos intercepciones de `fetch`)

El applet **parcha `window.fetch`** (con latch `window.__saCfdiFetchPatched` para no
re-parchar en bumps de versión) y opera en dos direcciones:

1. **Entrante — cachear.** Intercepta las respuestas de **`InvoiceByIdInDomain`** y guarda en
   un `Map` por `idInDomain` el `writeResult` de la factura: `XmlBase64File` (el XML en
   base64) y `CustomInput.linkxml` (de donde deriva el nombre del archivo).
2. **Saliente — inyectar.** Intercepta la mutation **`SendEmailChecked`** *antes* de que
   salga: lee `variables.linkInfo[]` para saber **qué facturas** se están mandando, sube cada
   XML cacheado a **`/api/files`** como binario (`FormData`, con el `fetch` ORIGINAL para no
   reentrar en su propio parche) y añade los adjuntos resultantes a `variables.attachments`.

**Fail-closed en el envío:** si la subida del XML truena, el applet muestra un `alert` y
**relanza la excepción para CANCELAR el envío**. Es la decisión correcta para este dominio —
una factura que sale sin su CFDI es un problema fiscal, y es preferible que el operador
reintente a que el correo se vaya incompleto en silencio.

## Anclaje del modal (idioma-independiente)

Identifica el modal de envío por **estructura**, no por texto: **≥2 filas `<tr>` con
`MuiSwitch`** (Logo / Attach PDF / Visible to Others) **+ un icono Send o Email**, resuelto vía
`window.MuiIconAnchorCore` (`SendIcon`, `EmailOutlinedIcon`). El match por encabezado
(`/send\s+invoice\s+email/i`) queda como red de seguridad, no como señal única.

**Deuda conocida:** `EmailOutlinedIcon` ya tiene forma medida en el catálogo; **`SendIcon` NO**,
así que hoy lo sostiene el `aria-label` bilingüe. Cuando se mida su `path`, sube un nivel en la
jerarquía de anclaje del repo.

Para insertar su fila **hereda las clases MUI del vecino vivo** (`lastToggleRow.className`, y las
de su `<td>`/`<p>`) en vez de escribirlas a mano — justamente lo que manda la regla de no
anclarse a clases `css-<hash>`.

## Dependencias

| Qué | Detalle |
|---|---|
| Hashes | **`InvoiceByIdInDomain`** (cachear) · **`SendEmailChecked`** (inyectar) |
| Scripts | `steelhead-api.js`, `mui-icon-anchor-core.js` |
| Endpoint | `POST /api/files` (subida binaria del XML) |
| `urlPatterns` | `/Domains/\d+/Invoices(?:/\|$)` |
| Permisos | `READ_INVOICING` |
| Toggle | `data-sa-cfdi-enabled` en `<html>` · acción `toggle-cfdi-attacher` |

## Historial

- **2026-08-05** — `InvoiceByIdInDomain` rotó con el release `BB7C5204` de Steelhead
  (`06a51d03…` → `6535d82a…`). Con el hash muerto, la intercepción entrante deja de cachear y
  **el applet no adjunta nada**. Peor: su deploy correctivo fue **uno de los tres que quedaron
  atorados** sin llegar al sitio en vivo, así que estuvo roto en producción mientras el repo
  decía que estaba corregido. De ahí salió el blindaje de verificación en vivo del
  `hash-autopilot` (ver `tools/hash-autopilot/README.md`).
- **2026-08-03** — Steelhead eliminó los `data-testid` de los iconos MUI; el anclaje pasó a
  `MuiIconAnchorCore` (forma del icono + aria bilingüe).

## Pendientes

- [ ] Medir el `path` de `SendIcon` para el catálogo de formas y quitarle el peso al `aria-label`.
- [ ] Sin cobertura de test propia (no tiene núcleo puro extraído). La lógica candidata a
      extraer y testear es `cacheInvoiceData` (parseo del `writeResult`) y la selección de
      `idsToProcess` desde `linkInfo`.
