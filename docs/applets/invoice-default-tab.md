# `invoice-default-tab` — Tab por defecto en Invoices

**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Facturación

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Al entrar a `/Invoices` **sin** parámetro `mode=` en la URL (link directo, recarga o entrada por menú), navega solo al tab **Packing Slips**.

## Por qué existe

El tab por defecto de Steelhead no es el que usa la operación; cada entrada costaba un clic extra, decenas de veces al día.

## Lo que hay que saber antes de tocarlo

**Respeta la elección del operador**: si éste navega manualmente a otro tab, Steelhead añade `?mode=…` y el applet ya no interviene. Es el diseño correcto para un automatismo de navegación — actúa solo ante la ausencia de una decisión explícita. Es el applet más pequeño del repo (92 líneas) y **no declara permisos** (no lee ni escribe datos: solo navega).

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/invoice-default-tab.js` (92 líneas) |
| Inyección | sí |
| `urlPatterns` | `/Domains/\d+/Invoices/?$` |
| Permisos | — |
| Acción en el popup | Tab por defecto Invoices |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
