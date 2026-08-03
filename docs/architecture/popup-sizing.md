# Por qué el popup se abre ancho y medio vacío (tope 800×600 de Chromium)

**Medido el 2026-08-03**, a raíz del reporte del operador: el panel de la extensión aparecía
como una ventana enorme y oscura con el contenido apretado en una columna a la izquierda.

## El mecanismo

Un popup de extensión **no tiene tamaño propio**: Chromium lo autodimensiona al tamaño que
pide el documento, con un tope duro de **800×600 px**. Nuestro `popup.html` declara
`body { width: 340px }` y el ancho preferido del documento es, medido, **exactamente 340 px**
— nada desborda horizontalmente.

Lo que se desborda es **el alto**. Y cuando el documento pide más de 600 px de alto, el
navegador deja de ajustar la ventana al ancho preferido y la abre al **máximo: 800 px**.
El resultado es el síntoma reportado: una ventana de 800×600 con el `body` de 340 px pegado
a la izquierda y **460 px vacíos** a la derecha.

El vacío se ve oscuro —y por eso salta a la vista— porque el `background` del `body` se
**propaga al canvas** del documento: aunque el `body` mide 340 px, el color pinta la ventana
entera. En modo claro el mismo hueco pasa casi desapercibido.

## Las medidas reales (2026-08-03)

Cromo fijo del popup:

| Pieza | Alto |
|---|---|
| `.header` | 73 px |
| `.status-bar` | 38 px |
| `.app-view-header` (solo en la vista de acciones) | 38 px |
| `.footer` | 28 px |
| `#update-banner` (solo si hay versión nueva) | 104 px |

⇒ presupuesto para la lista: **461 px** en el menú, **423 px** en la vista de acciones.

Antes del arreglo:

| Vista | Alto del documento | vs. tope 600 |
|---|---|---|
| Menú principal (44 applets, lista topada a 480) | 618 px | **+18** |
| Ajuste Masivo de Specs (7 acciones, lista sin tope) | 646 px | **+46** |

`.app-menu`, `.app-grid`, `.app-list`, `.results-panel` y `.app-perms-editor` ya tenían tope
+ scroll propio. **`.app-actions` no tenía ninguno** — era la única lista que crecía libre.

## Por qué apareció ahora

`Ajuste Masivo de Specs` es **el único de los 44 applets con 7 acciones** (el segundo más
largo, `Carga Masiva`, tiene 5). Cruzó el umbral el **2026-07-29**, cuando se le agregaron
dos acciones el mismo día:

- `d160047` — «Barrer nodo forzado (todos los clientes)»
- `b6d9fc0` — «Reparar archivados sin reponer»

El menú principal ya rebasaba el tope por 18 px desde antes; con la ventana del navegador
maximizada un popup de 800 px no llama la atención, con la ventana angosta ocupa casi todo
el ancho y el hueco se hace evidente.

## El arreglo

Toda lista larga lleva **tope de altura + scroll propio**, dimensionado contra el cromo fijo:

- `.app-menu` / `.app-grid` / `.app-list`: 480 → **440 px** (139 + 440 = 579)
- `.app-actions`: sin tope → **400 px** + `overflow-y: auto` (177 + 400 = 577)
- Con el banner de actualización visible, un bloque `body:has(.update-banner.visible)`
  encoge ambas en los 104 px del banner (336 / 296) — si no, el popup se ensancha **justo
  cuando el operador lo abre para actualizar**.

Verificado tras el cambio: menú **578**, Ajuste Masivo de Specs **576**, ambos con y sin
banner. Ancho preferido del documento: **340 px**.

## Regla

**El popup nunca debe pedir más de 600 px de alto.** Al agregar acciones a un applet o
piezas fijas al popup, rehacer la cuenta: `cromo fijo + max-height de la lista ≤ 600`.
La lista es la que hace scroll; el header y el «◀ volver» se quedan quietos.

## Cómo medirlo sin instalar nada

```bash
cd extension && python3 -m http.server 8777 --bind 127.0.0.1
```

Abrir `http://127.0.0.1:8777/popup.html` (`popup.js` truena sin las APIs `chrome.*`, así que
la lista se llena a mano), fijar `document.documentElement.style.width = '800px'` y leer
`document.body.scrollHeight`. El ancho preferido sale poniendo el `documentElement` en
`width: max-content`.
