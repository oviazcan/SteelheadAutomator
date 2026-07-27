# `po-listing-filters` — Buscador global de OC + Toggle de empresa

**Versión:** 0.1.0 · **Pantalla:** `/Domains/<d>/Purchasing/PurchaseOrders` · **`autoInject: true`**
**Estado:** implementado y testeado (42/42 golden). **Pendiente: deploy y validación en vivo.**

Diseño completo en [`docs/superpowers/specs/2026-07-27-po-listing-filters-design.md`](../superpowers/specs/2026-07-27-po-listing-filters-design.md).

## Qué resuelve

La pantalla de Órdenes de Compra está partida en **5 vistas** y el buscador nativo solo mira la
que tienes abierta, así que hay que pasearse por las cinco para hallar un documento. Y hay un
agravante que descubrí midiendo, no suponiendo:

> **El `searchQuery` nativo NO busca por proveedor.** `searchQuery:'ATOTECH'` devuelve **0**
> resultados aunque existe la OC #1873 de "ATOTECH DE MEXICO". Solo matchea el PO#
> (`'1911'` → 1 resultado). El proveedor únicamente es alcanzable por el filtro `vendorIdFilter`,
> que es otro control de la barra.

Y el filtro de Dirección de Facturación es single-select en la UI, así que no deja marcar
Ecoplating y el dominio de un jalón.

## Las 5 vistas

| Vista | URL | Variables de `PurchaseOrders` |
|---|---|---|
| Draft | `?category=Draft` (o sin params) | `{issuedAt:true, fulfilledCondition:false}` |
| Issued Open | `?category=Issued` | `{issuedCondition:true, billingOpen:true}` |
| Issued Closed | `?billing=Closed&category=Issued` | `{issuedCondition:true, billingOpen:false}` |
| Fulfilled Open | `?billing=Open&category=Fulfilled` | `{fulfilledCondition:true, billingOpen:true}` |
| Fulfilled Closed | `?billing=Closed&category=Fulfilled` | `{fulfilledCondition:true, billingOpen:false}` |

> **Ojo con Draft:** el front manda `issuedAt: true`, no un `draftCondition`. Nombre
> contraintuitivo del backend (significa "sin issuedAt"). **No lo renombres** al tocar el core.

## Widget A — Buscador global

Se inyecta **después del buscador nativo** (anclado por `svg[data-testid="SearchIcon"]`, no por
el placeholder, que sí cambia con el locale) → queda antes de los filtros "Creado Por"…

Fan-out por término, **acotado a 7 consultas** (`MAX_QUERIES_PER_SEARCH`), con pool ≤2:

1. `FilterSearch(vendorIdFilter, q)` → proveedores — **1 consulta**
2. `PurchaseOrders` × 5 vistas con `searchQuery`, `first:5` — **5 consultas**
3. `SearchBills(searchQuery)` → facturas — **1 consulta**

**Por qué NO hay un segundo fan-out por proveedor.** La versión inicial expandía los ids del
proveedor a las 5 vistas otra vez → **12 consultas por búsqueda**. Con el endpoint cayéndose
alrededor de las 40 (ver §Lección operativa), 3-4 búsquedas seguidas dejan al operador **sin la
pantalla nativa**. El proveedor se entrega como **resultado clickeable** que lleva a sus OCs
(`buildResultHref` → `?vendorIdFilter=<id>`), así que el valor se conserva —encuentras al
proveedor que el nativo esconde y de un clic ves sus órdenes— pagando **1 consulta en vez de 5**.

`planSearchQueries` devuelve el plan como descriptores (no promesas) para que el conteo sea
**verificable sin red**; hay 5 tests que fijan el invariante, incluido uno que truena si alguien
reintroduce el fan-out por proveedor.

> **`vendorIdFilter` CONFIRMADO** por el operador (2026-07-27): el filtro nativo de Proveedor
> genera `?category=Issued&offset=0&vendorIdFilter=89855`, y `89855` es exactamente el
> `identifier` que devuelve `FilterSearch` para "ATOTECH DE MEXICO". El nombre de la variable y
> el id son los correctos.

Panel dark-mode con secciones **PROVEEDOR / ÓRDENES DE COMPRA / FACTURAS**; cada renglón lleva
badge de tipo y **en qué vista vive**. Render incremental: los proveedores pintan en cuanto
llegan, sin esperar al resto.

## Widget B — Toggle triple de empresa

Se inyecta **después del botón "New Purchase Order"** (anclaje **bilingüe** ES+EN).
`Ecoplating | Ambos | Proquipa`, centro por defecto, no persistente.

### Por qué funciona

`billToLocationIdFilter` **es un array con semántica OR** — verificado en vivo:

| Filtro | Total en Issued·Open |
|---|---|
| sin filtro | 129 |
| `[Ecoplating]` | 0 |
| `[Proquipa]` | 50 |
| `[Ecoplating, Proquipa]` | **50** ← la unión, no la intersección |

La UI nativa manda `[22872]` aunque solo te deje elegir uno. **La limitación es del front, no
del backend.**

### Agrupación por raíz del path

Las ubicaciones de Steelhead están **anidadas por punto** y la raíz define la empresa.
`PlantaToluca` = dominio → cuenta como Ecoplating (decisión del usuario).

| display | id | → empresa |
|---|---|---|
| Ecoplating | 22872 | Ecoplating |
| Ecoplating.N2 / .N3 / .N4 / .N5 | 23345 / 23346 / 23347 / 25802 | Ecoplating |
| Ecoplating.N2.A2 | 24913 | Ecoplating |
| PlantaToluca | 24863 | dominio → **Ecoplating** |
| PlantaToluca.Externa | 28241 | dominio → **Ecoplating** |
| Proquipa | 23301 | Proquipa |
| Proquipa.N1 | 23344 | Proquipa |

**Esta tabla NO está hardcodeada.** El applet descubre las direcciones en runtime con 10 sondas
de `FilterSearch` (que topa en 10 resultados por consulta y no pagina) y las agrupa con
`rootLocationName`. Si dan de alta `Ecoplating.N6`, entra sola.

`companyOfLocation` corta en el primer punto en vez de hacer prefix-match: `'EcoplatingOtra'`
**no** es sub-ubicación de Ecoplating y debe caer en `otras`. Hay test que lo fija.

### El hueco de las OCs sin dirección — estrategia adaptativa

En Issued·Open (129): Proquipa=50 y **las otras 9 direcciones dan 0** → 79 OCs no matchean
ninguna. Decisión del usuario: **cuentan como Ecoplating** ("traen el dominio en la UI, por eso
quedan vacías").

Eso vuelve el lado izquierdo **"todo lo que NO es Proquipa"**, y `IN (…)` no expresa negación ni
`NULL`. Por eso `planCompanyFilter` **decide en runtime** en vez de asumir:

| Condición medida | Plan |
|---|---|
| `allCovered` (no hay huérfanas) | `filter` — filtro nativo puro |
| `nullAccepted` (el server acepta `null` en el array) | `filter` con `null` incluido |
| ninguna | **`annotate`** — filtra lo que sabe y **pide confirmación** diciendo cuántas OCs se ocultarían |

`annotate` es el **fail-safe**: nunca esconde OCs por un dato que no pudo resolver. El modo
Proquipa nunca es ambiguo (`filter` siempre); el centro limpia el parámetro.

## Hashes

| Op | Hash | Ruta de regeneración |
|---|---|---|
| `PurchaseOrders` | `32f823d3…` | `purchasing-list` (ya existía) |
| `SearchBills` | `e50ba3ee…` | `bills-list` (ya existía) |
| `FilterSearch` | `1cdd9e39…` | `workorders-filter-open` (ya existía) |

**Los tres nacen con auto-regeneración cubierta** — el `hash-autopilot` los recaptura solo
cuando Steelhead los rote. Cero deuda de hash.

## Lección de anclaje: el DOM de SH **duplica** controles (bug del deploy 1.7.203)

Primer deploy en vivo: **los dos widgets se inyectaron en el control equivocado.** La causa
es la misma en ambos — `querySelector` devuelve el **primer** match, que no es el correcto:

| Widget | Qué pasó | Por qué |
|---|---|---|
| Buscador | Quedó en la barra superior de SH, junto a "Buscar Todo" | Hay **4** `svg[data-testid="SearchIcon"]` en la pantalla (header global, tabla, chat…) y agarró el del header |
| Toggle | Se inyectó pero **no se veía** (`offsetParent:null`, ancho 0) | El botón "New Purchase Order" está **duplicado en dos variantes responsive**: `css-eabxx0` (solo ícono, oculta en escritorio) y `css-165nl96` (botón completo, visible). Ancló en la oculta |

**Reglas que lo arreglan** (puras y testeadas en el core, 6 tests de regresión):

- `pickVisibleCandidate(cands)` — entre variantes responsive duplicadas, quédate con la que
  tenga `offsetParent !== null` **y ancho > 0**. Un elemento puede existir y no verse.
- `pickNearestByDepth(cands)` — el `SearchIcon` de la tabla se identifica porque **comparte
  contenedor con el botón de exportar CSV** (`DownloadForOfflineOutlinedIcon`) al nivel más
  cercano. Anclaje **estructural**: ni texto (cambia con el locale) ni clases generadas
  (`css-xxxxx` cambia entre builds).

> **Generalizable a cualquier applet de este repo:** antes de anclar por `data-testid`,
> cuenta cuántos hay en la pantalla; y antes de insertar junto a un botón, verifica que ese
> botón sea el **visible**, no su gemelo responsive. Ambos fallos son silenciosos — el applet
> "se inyecta correctamente" y no se ve nada.

## Lección operativa: el `/graphql` se cuelga bajo ráfaga

Descubierto en carne propia durante la captura: **tras ~40-45 requests seguidas desde la consola,
el endpoint deja de responder**. Las peticiones quedan **colgadas sin resolver ni fallar** — no
devuelven 429 ni error, simplemente nunca vuelven — y **no se recuperan recargando la página**.

**Peor: no es solo el applet.** Con el límite activo, la **pantalla nativa de Steelhead tampoco
carga** — la tabla de OCs se queda vacía (verificado 2026-07-27 en pestaña nueva y sesión
limpia). El límite es **por sesión/cuenta**, no por pestaña. Es decir, un applet manirroto no
se rompe a sí mismo: **le tumba el ERP al operador**. De ahí que el presupuesto de consultas
(`MAX_QUERIES_PER_SEARCH`) sea un invariante testeado y no una guía.

Por eso el applet es frugal por diseño: debounce 350 ms, pool de 2, `first:5`, timeout de 12 s y
degradación a resultados parciales **sin reintento en bucle**. Si tocas este applet, no subas la
concurrencia "para que vaya más rápido": lo que se gana es que deje de funcionar.

## Estado / pendientes

- [x] Core puro + 42 golden tests · suite completa 924/924
- [x] Registro en `config.json` (hashes + app) — rutas de hash ya cubiertas
- [x] **Deploy a gh-pages** — vivo en **config 1.7.206** (tags `v1.7.203`…`v1.7.206`)
- [x] **Validado en vivo (2026-07-27):**
  1. Ambos widgets se inyectan en su lugar (tras el fix de anclajes de 1.7.204)
  2. Buscar "ATOTECH" → **encuentra el proveedor**, que es lo que el nativo NO hace (da 0).
     El panel muestra "1 resultado" y **eso es correcto**: por texto no hay OCs justamente
     porque `searchQuery` ignora al proveedor. El valor está en el clic al proveedor.
  3. `buildResultHref` genera enlaces **relativos y sin host ficticio** para los 3 tipos
     (verificado contra el core vivo tras el fix de 1.7.206)
  4. **Toggle → Proquipa aplica `billToLocationIdFilter=23301,23344`** — las **dos**
     direcciones de Proquipa de un jalón, que es exactamente lo que la UI nativa no permite.
     Confirma en vivo `discoverLocations` + agrupación por raíz + `planCompanyFilter`.
- [ ] **Pendiente de validar** (la sesión se topó con el rate-limit del endpoint):
  1. El conteo resultante del toggle (no alcancé a ver la tabla filtrada)
  2. **Clic y teclado en el panel** — rehecho en 1.7.207 (ver abajo), no validado en vivo
  3. Cuál de las 3 ramas de `planCompanyFilter` toma el lado Ecoplating en la práctica
  4. Que el toggle refleje su estado al recargar con el parámetro puesto
  5. `SearchBills` y el shape de sus nodos

## Navegación del panel: por qué son `<a href>` y no listeners (1.7.207)

La primera versión navegaba con `mousedown` + `preventDefault()` + `location.assign()`.
Es frágil de raíz:

- **Depende de que el panel siga montado** entre el `mousedown` y la navegación — y el
  render incremental **recrea los renglones** cuando llegan las OCs después de los proveedores.
- **Competía con el `blur`**, que programaba `hidePanel` con `setTimeout(…, 200)`: una carrera
  de temporizadores decidiendo si el clic alcanza a completarse.
- No funcionaba con teclado ni permitía ⌘/ctrl+clic ni clic medio (abrir en pestaña nueva).

Ahora cada renglón es un **`<a href>` real**: la navegación la hace el navegador, sobrevive al
re-render y es accesible. El `mousedown` se conserva **solo a nivel del panel** para que un clic
dentro no le quite el foco al input (que dispararía el `blur`), y por eso el `blur` ya **no
necesita timeout**: cuando ocurre, es porque el foco se fue de verdad.

Además hay **navegación por teclado**: `↑`/`↓` con wrap-around, `Enter` abre, `Esc` cierra. El
índice activo se repone tras cada re-render y se recorta si llegan menos resultados
(`moveActiveIndex`, puro, 6 tests).

> **Lección:** si la navegación de un widget depende de qué temporizador gana, no es un bug de
> timing que se arregle subiendo el `setTimeout` — es la señal de que el elemento debería ser un
> control nativo (`<a>`, `<button>`) en vez de un `div` con listeners.
- [ ] Confirmar si hay **>10 direcciones** de facturación (el descubrimiento en runtime lo
      resuelve, pero conviene saberlo; `S.capped` lo advierte en el `title` del toggle)
- [ ] Confirmar el shape exacto de los nodos de `SearchBills` (el glue lo localiza de forma
      defensiva; la primera corrida en vivo lo confirma)
- [ ] Integrar al bundle Safari/iPad si el operador lo usa desde ahí
