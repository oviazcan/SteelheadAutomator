# Auditoría de montaje: ¿qué applets se quedan sin reintento?

**Levantada el 2026-08-07**, después de que un reporte de piso —*«falla en los equipos Windows de
menor desempeño»*— destapara el mismo defecto en cinco applets seguidos. Cubre los **nueve**
restantes que tocan modales y corren **sin poll**, revisados uno por uno con el mismo criterio.

## El criterio

La pregunta NO es «¿tiene poll?». Es esta cadena de tres:

1. **¿De qué depende el disparo?** — `debounce` (se posterga con cada ráfaga y puede vencer con el
   DOM a medias) vs **`throttle`** (corre a los N ms del PRIMER disparo, pase lo que pase) vs
   reintentos escalonados.
2. **¿El contenedor se abre de golpe y se queda quieto?** — un **modal** sí; un **listado** no
   (paginar, filtrar, ordenar y hacer scroll mutan sin parar, así que el observer despierta solo).
3. **Si el montaje falla, ¿alguien reintenta?** — un latch que marca el **INTENTO** congela el
   fallo; uno que marca el **ÉXITO**, o una idempotencia **por presencia del nodo**, se auto-sana.

La medición que fija el marco (producción, 2026-08-07, `/Domains/344/SalesOrders` y
`/Receiving/CustomerParts`): con un modal ABIERTO hubo **0 mutaciones de `childList` en el
`document.body` durante 6 segundos**, incluso tecleando dentro del modal. **El `MutationObserver`
no vigila: dispara en eventos discretos.** Por eso el punto 3 es el que decide — si el único
disparo cae mal y nadie reintenta, el applet no vuelve a mirar nunca.

## Veredicto de los nueve

| Applet | Disparo | Si el montaje falla | Veredicto |
|---|---|---|---|
| `surtido-guard` | throttle **rAF** + `kickDecorate()` a **[0, 150, 400, 900, 1800, 3000] ms** + re-arranque por URL | `decorateCards` es un toggle idempotente | **SANO** — el patrón más completo del repo |
| `packing-slip-drawings` | observer sin debounce | latch **tri-estado** `'pending'/'1'/'0'`; el guard rechaza `'1'` y `'pending'` pero **no `'0'`** ⇒ reintenta | **SANO** |
| `invoice-auto-regen` | throttle 500 ms; las esperas son `_waitForElement` **con timeout** que resuelve `null` | banner auto-sanador (`!document.getElementById(BANNER_ID)`) | **SANO** |
| `wo-listing-columns` | **throttle** (`if (obsTimer) return`) | re-inyecta en cada sync; es un listado | **SANO** |
| `schedule-batch-group` | observer + `onUrlChange` que re-arranca | por id; es el board, que muta de continuo | **SANO** (nota: depende de que el widget de `schedule-batch-highlighter` monte antes) |
| `cfdi-attacher` | observer **sin debounce** (dispara en cada mutación) + chequeo one-time al init | idempotencia por presencia de `#sa-cfdi-toggle` ⇒ auto-sanador | **RIESGO BAJO** |
| `wo-schedule-button` | **throttle 120 ms** + listener de URL | `ensureInline` idempotente. `data-sa-loading` sí marca el intento, pero un fallo de red **se muestra** (`renderError`), no queda en silencio | **RIESGO BAJO** |
| `invoice-autofill` | **debounce 500 ms** (el más largo del repo) + `focusin` | scan inmediato detrás del latch del observer | **CORREGIDO** (0.5.68) |
| `bill-autofill` | **debounce 500 ms** | idem | **CORREGIDO** (0.1.1) |

## Lo que se corrigió, y por qué solo eso

`invoice-autofill` y `bill-autofill` **no necesitan poll**: son de página, y la pantalla sigue
mutando mientras el operador llena el formulario. Pero caían en la **otra mitad** del mismo error:

```js
function setupPageObserver() {
  if (window.__saInvoiceAutofillObserverActive) return;   // ← el scan inmediato venía DESPUÉS
  …
  observer.observe(document.body, …);
  scanForInvoicePage();
}
```

`checkUrl` resetea el estado al salir de la ruta pero **no desconecta el observer**, así que al
regresar por navegación SPA el `return` temprano se comía la única pasada que mira la página **ya
montada**. Es el mismo defecto medido en `create-order-autofill`, en su versión leve: ahí moría el
poll, aquí muere el scan de re-entrada. **Un latch protege UN recurso.**

El fix añade una llamada y **no altera el timing de nadie** — que es justo lo que lo hace seguro.
A los otros siete **no se les tocó nada**: ninguno tiene el defecto, y el mismo día se aprendió lo
caro que sale mover el timing sin necesidad (ver abajo).

## La trampa que este ejercicio ya cobró

Arreglar el disparo de `receiver-date-override` (1.11.105) **rompió a
`warehouse-location-prefill`**: se anclan al MISMO encabezado, y darle poll al primero lo hizo
montar antes y siempre, así que el segundo —que todavía tenía el latch al INTENTO— pasó de «falla a
veces» a «falla siempre» hasta su propio fix (1.11.107). El operador lo vio en piso.

> **Regla:** *arreglar el disparo de un applet cambia el timing de sus vecinos.* Los que comparten
> contenedor se arreglan en el **mismo deploy**, o el intermedio es una regresión visible.

Corolario para esta auditoría: **la ausencia de poll no es un defecto**. Meter polls «por si acaso»
en los siete sanos habría cambiado el timing de siete pantallas para arreglar cero bugs — y este
repo ya sabe lo que eso cuesta.

## Lo que esta auditoría NO prueba

- **Nada se midió en un equipo de bajo desempeño.** Todo salió de una Mac (10 núcleos, 383 MB de
  heap): los 2.94 ms/tick, las 0 mutaciones en 6 s, las sondas del poll. El salto a «en un i3 con
  Chrome cargado esto alcanza» es razonamiento, no medición. **La prueba pendiente es abrir esas
  pantallas en uno de esos equipos** — y ya no requiere preparación: hay un diagnóstico de consola
  (versión servida, applets cargados, campos montados, núcleos de CPU y heap) **probado contra la
  pantalla real**, listo para pegárselo a quien tenga el equipo
  ([`diagnostico-equipo-lento.html`](diagnostico-equipo-lento.html) — ábrelo en el navegador, trae
  botón de copiar y cómo leer cada renglón). Con `1.11.109` en la Mac devolvió
  los 5 applets cargados y los dos campos montados; el valor está en comparar contra eso.
- **Sí se cerró, en cambio, la mitad que sí se podía**: el **candado** de
  `warehouse-location-prefill` lo probó el operador después del reorden de 0.6.5 y sigue frenando un
  renglón sin ubicación. El refactor de las dos marcas no lo desarmó.
- **`cfdi-attacher` y `wo-schedule-button` quedaron en «riesgo bajo» por lectura**, no por
  reproducción. Si aparece un reporte sobre ellos, el diagnóstico ya está escrito: llamar sus
  funciones de detección a mano distingue «no se dispara» de «no encuentra el ancla».
- **El presupuesto de `unit-autoconvert` (5 intentos ≈ 5 s por diálogo) puede quedarse corto** justo
  en el equipo más lento. Se eligió porque su barrido recorre todo el documento sin early exit; si
  el reporte vuelve por ahí, la salida es abaratar el barrido, no subir el presupuesto a ciegas.

## Trinquete

[`tools/test/modal-detect-poll-coverage.test.js`](../../tools/test/modal-detect-poll-coverage.test.js)
fija: los seis applets modal-driven llevan poll de re-detección; el candado de WLP no depende de que
su campo monte; y el scan inmediato de los dos autofill no vive detrás del latch del observer.
