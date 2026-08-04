# `marcar-usepartcount-productos` — bitácora

Tool standalone (`tools/marcar-usepartcount-productos.js`) que se pega en la consola de
DevTools sobre `app.gosteelhead.com` e inyecta un panel flotante dark-mode para marcar el
check **`usePartCountForQuantity`** en **todos los Productos** de la instancia. NO es parte
de la extensión: corre ad-hoc en la sesión del navegador (cookies same-origin), no se
deploya a `gh-pages` ni entra a `config.json`.

**Estado: VALIDADO EN PRODUCCIÓN 2026-08-03** — el operador lo corrió y confirmó
(«ya quedó»). Commit `08bc733` en `main`. One-shot: cumplió su propósito; se conserva por
si el check hay que reponerlo o extenderlo a otro campo de Producto.

## Qué resuelve

`usePartCountForQuantity` ("usar el conteo de piezas para la cantidad") es un dato maestro
por Producto que gobierna cómo el ERP calcula cantidades. Había que activarlo en los 83
Productos y la UI solo lo permite uno por uno, entrando a la ficha de cada uno.

## Coordenadas (del scan `scan_results_2026-08-03_122131.json`)

| Cosa | Valor |
|---|---|
| Inventario | `SearchProductsComprehensive` — hash `b3e2b9c63285487866fe098c936cd37e60ffff373a9fa9e30296574cffcfbba0`, variables `{searchQuery, first, offset}` |
| Lectura | `GetProduct` — hash `6793c31b4b4875e57fb7de47764b233e7c23dfd825c1d21757cdc98f12a0bc0b`, variables `{id}` |
| Escritura | `UpdateProduct` — hash `112b85d79559a83a07ea11f43048369ecf51289166bc708fa9a63d0fb697a870`, variables `{id, usePartCountForQuantity}` |
| Universo medido | **83 Productos**, `totalCount:83`, **cero archivados** |

El scan capturó el **ciclo completo en vivo** sobre el producto 14501 "Cromado Decorativo":
`GetProduct` → `false`, `UpdateProduct`, `GetProduct` → `true`. No hubo que inferir el
payload: está observado.

**Los Productos son GLOBALES de la instancia**, no por dominio — su ruta es `/Products` y
`/Products/<id>`, **sin** el prefijo `/Domains/<id>/` que llevan las demás entidades, y
`SearchProductsComprehensive` no recibe `domainId`. Consecuencia operativa: el tool se corre
**una sola vez**, no una por dominio (TLC/MTY).

`UpdateProduct` es una mutation **PARCIAL**: `{id, usePartCountForQuantity}` toca solo ese
campo; no reenvía nombre, grupo, cuenta contable ni precios, así que no hay riesgo de
borrar datos por omisión (a diferencia de los `Save*` que reemplazan arrays).

## Los hashes NO se metieron a `config.json` — a propósito

Van hardcodeados en el tool. Meterlos al config obligaría a darles ruta de regeneración en
el `hash-autopilot` (regla: *un hash sin ruta de regeneración es deuda*) y a cargar con
ellos en el trinquete de cobertura, a cambio de nada: es un one-shot que no vive en runtime.
Si rota alguno, el tool avisa explícitamente («HASH ROTADO») y se re-escanea.

## Tres decisiones que sostienen el tool

### 1. Verifica releyendo — la respuesta no prueba nada

`UpdateProduct` responde `{updateProductById:{clientMutationId:null}}`: ni el valor nuevo ni
el id. Un `await` sin excepción **no** prueba que se haya escrito — el mismo modo de fallo
del load-before-save del auto-ruteador y de `wo-schedule-button` 0.7.0. Por eso cada
escritura se relee con `GetProduct` y el reporte **solo cuenta como OK lo que se leyó en
`true`**. El banco de pruebas simula una escritura fantasma (HTTP 200 que no persiste) y
exige que se reporte como fallo.

Señal de que era el camino correcto: el propio front dispara `GetProduct` justo después del
`UpdateProduct` (visible en el `eventLog` del scan).

### 2. Ritmo bajo, escrituras en serie

Lecturas en pool de **3**, **escrituras en SERIE**, pausa de 120 ms entre requests (+250 ms
entre escrituras) y retry con backoff exponencial en 429/5xx. Es por el incidente ya
documentado en `po-listing-filters`: el `/graphql` se cuelga bajo ráfaga (~40-45 requests
sin espera), **sin 429 ni error**, no se recupera al recargar la pestaña, y **el límite es
por SESIÓN, no por pestaña** — tumba también la pantalla nativa. Una corrida completa son
~250 requests, así que el ritmo es la restricción de diseño principal, no un detalle.

### 3. NO salta trabajo por checkpoint

La fuente de verdad es el **análisis**, que relee el estado real de cada producto justo
antes de escribir. El `localStorage` (`sa_upcfq_run`) se usa **solo** como registro de lo
cambiado, para poder DESHACER.

Saltar productos porque el checkpoint dice "ya lo hice" conservaría una mentira si alguien
desmarcó algo a mano entre corridas — el mismo anti-patrón que costó `pn-specs-column`
0.3.3 y `wo-listing-columns` 0.8.2: **un guard que pregunta «¿ya lo hice?» en vez de
«¿sigue siendo cierto?» no ahorra trabajo, conserva una mentira**. La reanudación real la
da volver a ANALIZAR.

## Salvaguardas

- **Dry-run obligatorio**: ANALIZAR lista los productos exactos que cambiarían y no escribe
  nada. MARCAR se habilita solo después, y pide confirmación nombrando el número de
  productos y que es producción.
- **Solo escribe lo pendiente**: los que ya están en `true` no se tocan.
- **Archivados excluidos** por default (checkbox para incluirlos), y el conteo se reporta.
- **Reversible**: guarda el valor previo por producto; DESHACER regresa a `false` **solo**
  lo que esa corrida cambió. Si el valor previo era `null` se revierte a `false` (el campo
  se observó como booleano, no nullable, en la respuesta real).
- Nombres de producto escapados con `esc()` antes de ir al `innerHTML` (vienen de GraphQL =
  vector cross-user).

## Verificación

**13/13** en un banco de pruebas que carga el archivo **REAL** con `new Function(readFileSync(...))`
—no una copia— contra un `/graphql` simulado y un DOM mínimo: paginación de 2 páginas,
dry-run sin escrituras, clasificación pendientes/ya-marcados, exclusión de archivados,
escritura fantasma detectada como fallo, 429 reintentado hasta persistir, **cero escrituras
de más**, y revert que devuelve el estado exacto (incluido el `null` previo → `false`).

El harness vivió en el scratchpad de la sesión (no se versionó: el tool es one-shot y la
suite del repo no cubre `tools/*.js` standalone). Si se retoma el tool, reconstruirlo es
barato y el patrón está descrito aquí.

Suite del repo tras el commit: **verde, 89 archivos, 0 rojos**.

## Pendientes

Ninguno. El objetivo se cumplió y el operador lo confirmó en producción. Si en el futuro hay
que marcar otro campo booleano de Producto, este tool se clona cambiando `FIELD` y el hash
de escritura sigue siendo el mismo (`UpdateProduct` es parcial y genérico).
