# Por qué el popup se abre ancho y medio vacío (tope 800×600 de Chromium)

**Medido el 2026-08-03**, a raíz del reporte del operador: el panel de la extensión aparecía
como una ventana enorme y oscura con el contenido apretado en una columna a la izquierda.
**Reabierto el mismo día**: *«ya no en la pantalla principal, pero sí cuando doy clic a un
submenú interno»* — el arreglo del menú funcionaba y quedaban dos vistas sin contar.

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

## Las tres veces que falló el esquema de topes en px

El primer arreglo (2026-08-03, mañana) le puso a cada lista larga un `max-height` en píxeles,
calculado **a mano** contra el cromo fijo de su vista. Funcionó para las dos vistas que se
midieron y falló en todo lo demás:

| # | Fecha | Vista | Alto pedido | Por qué se escapó |
|---|---|---|---|---|
| 1 | 2026-07-29 | Acciones de `Ajuste Masivo de Specs` | 646 px | Pasó de 5 a 7 acciones y `.app-actions` era la única lista sin tope |
| 2 | 2026-08-03 | **Configuración** (editor de permisos, 44 applets) | **838 px** | Nunca se contó — no tenía tope de ningún tipo |
| 3 | 2026-08-03 | Acciones + **barra de progreso** | **609 px** | La barra es **hermana** de las vistas: suma 33 px a *cualquiera*, justo al dar clic a una acción |

Medidas del cromo fijo (2026-08-03):

| Pieza | Alto |
|---|---|
| `.header` | 73 px |
| `.status-bar` | 38 px |
| `.app-view-header` (vistas internas) | 38 px |
| `.footer` | 28 px |
| `#update-banner` (solo si hay versión nueva) | 104 px |
| `#progress-container` (solo mientras corre una acción) | 33 px |

El caso 3 es el que mejor explica por qué el esquema no podía sostenerse: `.app-actions`
estaba dimensionada correctamente (400 + 177 = 577), y aun así se pasaba, porque **el cromo
de una vista no es constante** — le crece una pieza cuando el operador ejecuta algo. Cada
combinación nueva (vista × banner × progreso) era una cuenta más que alguien tenía que
acordarse de hacer.

## El arreglo: que la aritmética la haga el navegador

El documento se topa a **590 px** y se reparte como **columna flex**:

```css
html { max-height: 590px; }
body {
  width: 340px; max-height: 590px;
  display: flex; flex-direction: column; overflow: hidden;
}
body > * { flex: 0 0 auto; }              /* el cromo nunca se encoge */
.view.active { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.view-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
```

La lista larga de cada vista lleva la clase **`.view-scroll`** y es la única que se encoge.
Agregar acciones, permisos, applets o piezas fijas ya **no obliga a rehacer ninguna cuenta**:
el que reparte es el navegador.

Dos detalles que no son opcionales:

- **`min-height: 0`** en cada eslabón. Sin él, un hijo flex no baja de su tamaño de
  contenido y el documento vuelve a estirarse. Aplica también a los intermediarios
  (`.app-menu-wrap`, que se interpone entre `#view-menu` y la lista).
- **`.view.active` tiene que ser `flex`, no `block`.** Si la cadena se corta en la vista,
  la lista de adentro crece libre aunque tenga `.view-scroll`.

### El error que costó una vuelta

El primer intento puso `.view.active { display: flex }` **antes** de la regla original
`.view.active { display: block }`. Misma especificidad ⇒ **gana la última**, y el modelo
quedó desactivado sin ningún síntoma: el CSS era válido, no hubo error en consola, y el
popup se veía prácticamente igual con poco contenido. Solo al medir con las 44 apps salió
el desastre (menú en lista: **1799 px**). *Una regla CSS derrotada por orden de cascada no
avisa; hay que medirla.* El test `popup-sizing.test.js` fija justamente eso: la **última**
declaración de `display` para `.view.active` debe ser `flex`.

## Resultados medidos (2026-08-03, config vivo con 44 applets)

| Escenario | Antes | Ahora |
|---|---|---|
| Menú (grid / lista, 44 apps) | 578 | **590** ✅ |
| Menú + banner de actualización | 578 | **590** ✅ |
| Acciones «Ajuste Masivo de Specs» (7) | 576 | **590** ✅ |
| Acciones (7) **+ barra de progreso** | **609 ❌** | **590** ✅ |
| Acciones (7) + progreso + banner | **609 ❌** | **590** ✅ |
| Acciones de un applet con 1 acción | — | **266** ✅ (se encoge) |
| Resultados (60 operaciones) | 526 | **590** ✅ |
| **Configuración + permisos (44 applets)** | **838 ❌** | **590** ✅ |
| Configuración + permisos + banner + progreso | **975 ❌** | **590** ✅ |

Ancho preferido del documento: **340 px** en todos los casos. Las 4 vistas scrollean hasta
el final (nada queda recortado sin acceso) — se verificó explícitamente, porque con
`overflow: hidden` el modo de falla contrario (contenido inalcanzable) sería peor que el
ensanchamiento.

**Alcance de cada caso** (importa para leer los reportes de piso): la vista de Configuración
solo la ven **admins o quien tenga `WRITE_USER_PERMISSIONS`** — es la condición que monta el
editor de permisos, y sin él la vista pide 461 px y nunca se pasó. El caso de la barra de
progreso, en cambio, **le pegaba a todos** y se dispara en el gesto más común del popup: entrar
a un applet y darle clic a una acción.

### Qué se verificó y qué no

- ✅ Las 9 combinaciones medidas sobre el `popup.html` **real** (no una réplica), con el config
  vivo de 44 applets, servido por HTTP.
- ✅ El zip **servido** (`steelhead-automator.zip` de gh-pages) trae `manifest 1.7.3`, y su
  `popup.html` pasa los 10 casos del trinquete — se descargó y se corrió el test contra él.
- ⚠️ **No se abrió el popup REAL instalado en Chrome.** Toda la medición usa el proxy de la
  página servida. Es el mismo proxy que predijo bien el síntoma (618/646 px) y el arreglo
  (578/576 px) de la vuelta anterior, así que la confianza es alta — pero el ciclo end-to-end
  lo cierra el operador al instalar 1.7.3.

**VIVO:** zip `1.7.3` + config 1.11.52, tag `v1.11.52`, firmado KMS. Commits `c44842d` (fix,
test y doc) y `fed6f70` (bump del config). No requiere rebundle de Safari/iPad: ese bundle
tiene su propio popup y `extension/` no viaja ahí.

## Regla

**El popup nunca debe pedir más de 600 px de alto.** Ya no hay cuentas que rehacer, pero sí
un contrato que respetar: **toda vista nueva necesita un contenedor con `.view-scroll`**, y
toda pieza fija va como hijo directo del `body` (hereda `flex: 0 0 auto`). El trinquete
`tools/test/popup-sizing.test.js` lo verifica —10 casos, validados con 6 mutaciones que debe
detectar— y se pone rojo si alguien agrega una vista sin lista scrollable, repone un
`max-height` en px, o invierte el orden de la cascada.

## Cómo medirlo sin instalar nada

```bash
cd extension && python3 -m http.server 8777 --bind 127.0.0.1
```

Abrir `http://127.0.0.1:8777/popup.html` (`popup.js` truena sin las APIs `chrome.*`, así que
las listas se llenan a mano), fijar `document.documentElement.style.width = '800px'` y leer
el alto. El ancho preferido sale poniendo el `documentElement` en `width: max-content`.

⚠️ **`document.body.scrollHeight` ya NO es el medidor válido.** Con `overflow: hidden` en el
`body` sigue reportando el **contenido recortado**, no lo que pide el documento: durante esta
sesión marcó 3606 px cuando el documento medía 590. Hay que leer el **rect**:

```js
Math.max(
  Math.ceil(document.documentElement.getBoundingClientRect().height),
  Math.ceil(document.body.getBoundingClientRect().height)
)
```

Dos notas del arnés, ambas costaron tiempo: los `fetch` de una pestaña automatizada que
queda oculta **se congelan** (el `Runtime.evaluate` revienta a los 45 s) — servir el JSON
en local y leerlo con `XMLHttpRequest` síncrono lo evita; y si el renderer ya se trabó, una
recarga lo destraba.
