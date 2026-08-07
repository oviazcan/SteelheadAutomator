# `bill-autofill` — Bill Autofill

## 0.1.1 (2026-08-07) — el scan inmediato salía detrás del latch del observer

Salió de la **auditoría de los nueve applets** que quedaron sin poll tras el reporte «falla en los
equipos Windows de menor desempeño» (ver
[`docs/architecture/modal-mount-audit.md`](../architecture/modal-mount-audit.md)). Este applet **no
necesita poll** —es de página, y la pantalla sigue mutando mientras el operador llena el
formulario— pero sí caía en la otra mitad del mismo error:

```js
if (window.__sa…ObserverActive) return;   // ← el scan inmediato estaba DESPUÉS
```

`checkUrl` resetea el estado al salir de la ruta pero **no desconecta el observer**, así que al
REGRESAR por navegación SPA el `return` temprano se comía la única pasada que mira la página **ya
montada**. A partir de ahí solo quedaba el debounce de **500 ms** —el más largo del repo— que solo
vuelve a correr si llegan más mutaciones; medido en `create-order-autofill`, con la pantalla quieta
hubo **0 mutaciones de `childList` en 6 s**.

**Fix:** el observer se crea si falta; el scan corre **siempre**. Un latch protege UN recurso.
Trinquete en `tools/test/modal-detect-poll-coverage.test.js`.


**Versión:** 0.1.0 · **Estado:** vivo en producción · **Categoría:** Facturación

> **Nota de procedencia (2026-08-05).** Bitácora escrita *a posteriori*: el applet llevaba tiempo
> vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener bitácora**. Salió a la luz en
> la auditoría que destapó `cfdi-attacher`. El contenido se derivó de **leer el script y su entrada en
> `config.json`**, no de memoria; lo que no se pudo verificar se marca como pendiente en vez de
> inventarse. Un applet indocumentado no es solo un hueco de doc: **es un applet cuya rotura nadie
> sabe atribuir** — cuando su hash rote, el correo del autopilot dirá un nombre que no le consta a nadie.

## Qué hace

Autollena **Cuenta AP, Divisa, Tipo de Cambio y Cuentas de Gasto** al crear o editar un Bill. Intercepta GraphQL para capturar los datos del PO, infiere las cuentas por nombre y **aprende de las selecciones previas** del operador (`localStorage: sa_bill_expense_mapping`).

## Por qué existe

Es el gemelo de `invoice-autofill` del lado de cuentas por pagar: los mismos datos, capturados a mano, con el mismo costo de error contable.

## Lo que hay que saber antes de tocarlo

El aprendizaje vive en `localStorage`, o sea **por máquina y por navegador**: lo que aprendió en una computadora no lo sabe la de al lado, y se pierde al limpiar el navegador. La inferencia **por nombre de cuenta** es el punto frágil — un rename en el catálogo contable la desalinea en silencio, igual que a `invoice-autofill` le pasó con `Income Account` → `Income/Liability Account`.

## Ficha técnica

| Qué | Detalle |
|---|---|
| Script | `remote/scripts/bill-autofill.js` (1279 líneas) |
| Inyección | sí |
| `urlPatterns` | `/Domains/\d+/Bills` |
| Permisos | `READ_BILLS` |
| Acción en el popup | Bill Autofill |

## Pendientes

- [ ] **Sin cobertura de test.** No tiene núcleo puro extraído; cualquier lógica de decisión
      que se le agregue debería salir a un módulo `*-core.js` con su golden test, como manda
      la convención del repo.
- [ ] Bitácora derivada del código, **no de la operación**: falta el relato de incidentes y
      decisiones que solo conoce quien lo usa en piso.
