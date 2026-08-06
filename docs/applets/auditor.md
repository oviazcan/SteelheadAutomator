# `auditor` — Auditor de PNs

**Versión:** 0.1.42 · **Estado:** vivo en producción · **Categoría:** Números de Parte

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*, en la misma pasada que
> destapó `cfdi-attacher` y los otros 7. El applet **se mencionaba** en `CLAUDE.md` pero no tenía
> fila propia en el índice ni ficha. Contenido derivado de **leer el script y su entrada en
> `config.json`**; lo no verificable se marca como pendiente en vez de inventarse.

## Qué hace

Analiza los números de parte contra **criterios de calidad configurables** y reporta los que no cumplen. Incluye detección de **duplicados por similitud** de nombre.

## Por qué existe

Un catálogo de NPs sucio se paga en toda la cadena: cotizaciones mal ligadas, OTs sin spec, facturación que no cuadra. Auditar a mano decenas de miles de NPs no es viable.

## Lo que hay que saber antes de tocarlo

**Es el ejemplo canónico de memory hardening del repo** (ver `memory-hardening-applets`). El refactor de 2026-05-25 dejó tres decisiones que hay que respetar al tocarlo:

- `runPool` con **concurrencia 6** para `GetPartNumber` (antes era serial).
- **`extractAuditFlags` devuelve un shape *slim*** (booleanos y longitudes). Antes retenía los nodos completos: en miles de NPs, *esa* diferencia **es** el OOM.
- La similitud **prefiltra por diferencia de longitud** antes de calcular Levenshtein, que es lo caro.

Comparte el módulo `duplicate-tiers.js` con `integrity-tiers` — ver [`integrity-tiers.md`](integrity-tiers.md).

**Criterio de bundle iPad:** su flujo core es la **descarga del reporte**, así que **NO va al bundle Safari**.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/auditor.js` (1140 líneas) |
| Scripts que carga | `steelhead-api.js`, `host-cleanup-shared.js`, **`duplicate-tiers.js`**, `auditor.js` |
| Inyección | manual (se lanza desde el popup) |
| `urlPatterns` | — |
| Permisos | `READ_PART_NUMBERS` |
| Acción en el popup | Auditar PNs |

## Pendientes

- [ ] **Sin cobertura de test propia** (no tiene núcleo puro extraído).
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
