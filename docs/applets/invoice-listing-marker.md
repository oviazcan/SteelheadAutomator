# `invoice-listing-marker` — Marcadores de Facturas

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Facturación

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*, en la misma pasada que
> destapó `cfdi-attacher` y los otros 7. El applet **se mencionaba** en `CLAUDE.md` pero no tenía
> fila propia en el índice ni ficha. Contenido derivado de **leer el script y su entrada en
> `config.json`**; lo no verificable se marca como pendiente en vez de inventarse.

## Qué hace

Marca visualmente las filas del listado de facturas que **se salen de la norma**:

| Señal | Marca |
|---|---|
| Monto **cero** | fondo rojo sutil + chip «Monto Cero» |
| Monto **negativo** (nota de crédito) | fondo amarillo sutil + chip «Nota de Crédito» |
| Sin botón de cancelación | chip «Borrador» |

## Por qué existe

En una lista larga, lo que hay que ver es lo excepcional. Aplica la regla del repo: **marcar la excepción, no la norma** — resaltar lo que cumple llena la pantalla de color y no informa.

## Lo que hay que saber antes de tocarlo

Dos detalles del formato que hay que conservar:

- El total negativo llega en **formato contable**: `Total: ($1,234.56)`, con paréntesis y no con signo menos. Un parseo que solo busque `-` no ve las notas de crédito.
- «Borrador» se infiere de **qué icono está presente**: el de *Edit Invoice* en lugar del de *enviar solicitud de cancelación a Contpaq*. Por eso depende de `mui-icon-anchor-core.js` — es anclaje **por forma del icono**, que sobrevive a que Steelhead quite los `data-testid` (como hizo el 2026-08-03).

**No declara permisos**: solo lee lo que ya está pintado en pantalla y añade estilo.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/invoice-listing-marker.js` (200 líneas) |
| Scripts que carga | `mui-icon-anchor-core.js`, `invoice-listing-marker.js` |
| Inyección | sí |
| `urlPatterns` | `/Domains/\d+/Invoices(?:/|$)` |
| Permisos | — |
| Acción en el popup | Marcadores de Facturas |

## Pendientes

- [ ] **Sin cobertura de test propia** (no tiene núcleo puro extraído).
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
