# Audit bilingüe — inputs pendientes del usuario

Los fixes de labels de traducción confiable YA se aplicaron y deployaron (config 1.7.100).
Lo que sigue son los **gates/labels mono-idioma que necesitan evidencia** del string en el
OTRO locale antes de anclar (regla "no adivinar" de `CLAUDE.md §"Trabajo con UI / DOM"`).

**Cómo responder (lo más fácil):** cuando puedas, cambia una sesión de Steelhead al idioma
contrario y pásame el HTML (o solo el texto) de cada modal/label de abajo. O, si ya lo sabes,
**confirma o corrige mi conjetura** en la columna de la derecha — con eso los cierro en un commit.

**Nota:** todos estos fixes son **aditivos** (agregar `|otro-idioma` al regex NO rompe el
locale actual), así que en cuanto tenga el string correcto es un cambio de bajo riesgo.

---

## 🔴 Prioridad ALTA — gates (si SH renderiza en el otro idioma, el applet/candado queda inerte)

| Applet | String que tengo | Idioma | Conjetura del otro idioma (CONFIRMAR) |
|---|---|---|---|
| **price-confirm-guard** | `"Part Number Price"` (título modal, gate maestro del candado de precio) | EN | ¿"Precio de Número de Parte"? / ¿"Precio del NP"? |
| **bill-autofill** | `"Create Bill"` / `"Edit Bill"` (heading, detección modal) | EN | ¿"Crear Cuenta por Pagar"? / ¿"Crear Factura de Proveedor"? |
| **invoice-autofill** | `"Creating Invoice for"` / `"Editing Invoice for"` (heading, detección + extrae cliente) | EN | ¿"Creando Factura para"? / ¿"Editando Factura para"? |
| **cfdi-attacher** | `"Send Invoice Email"` / `"Send Invoices"` (heading, detección modal) | EN | ¿"Enviar Correo de Factura"? / ¿"Enviar Facturas"? |

## 🟠 Prioridad MEDIA — labels de campo / sección

| Applet | String que tengo | Idioma | Conjetura del otro idioma (CONFIRMAR) |
|---|---|---|---|
| **unit-autoconvert** | `"Per Part Count Unit Definitions:"` (heading, ancla el toggle) | EN | ¿"Definiciones de Unidad por Pieza:"? |
| **unit-autoconvert** | `"/ Part:"` (sufijo de label, ×2) | EN | En tu HTML se ve `"/ Part:"` incluso con UI en español → **¿SH lo deja en inglés siempre?** Si sí, no hay deuda. Confirmar. |
| **unit-autoconvert** | `"Parts /"` (adorno recíproco Panel B) | EN | Igual que arriba — ¿se queda `"Parts /"` en español? Confirmar. |
| **create-order-autofill** | `"Enviar a:"` (ship-to) | ES | ¿"Ship To:"? |
| **surtido-guard** | `"Tareas Programadas:"` (label tarjeta) | ES | ¿"Scheduled Tasks:"? |
| **surtido-guard** | `"Proceso:"` (+ WO:) | ES | ¿"Process:"? |
| **proceso-calculator** | `"Default Process:"` | EN | ¿"Proceso por Defecto:"? / ¿"Proceso Predeterminado:"? |
| **cfdi-attacher** | `"Logo"` / `"Attach PDFs"` / `"Visible to Others"` (labels de opción) | EN | ¿"Logo"? / ¿"Adjuntar PDFs"? / ¿"Visible para Otros"? |

---

## Ya resuelto (deployado 1.7.100, no requiere input)
Vendor/Proveedor, Divisa/Currency (bill + invoice), Name/Nombre, Line Items/Líneas,
Cliente/Customer, Línea/Line, NUEVO NÚMERO DE PARTE/NEW PART NUMBER, Terms/Términos, Modo/Mode.

## Contexto
- Reporte completo del audit: `scratchpad/audit-bilingue.html`.
- Regla + estado: `CLAUDE.md §"Trabajo con UI / DOM"`, Task #1 del tracker.
- 29 de 39 applets están limpios (0 deuda). Solo estos 10 tienen anclajes mono-idioma;
  la mayoría de su deuda ya se cerró — arriba está solo lo que falta evidencia.
