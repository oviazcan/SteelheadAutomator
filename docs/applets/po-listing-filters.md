# `po-listing-filters` — Buscador global de OC + Toggle de empresa

**Versión:** 0.3.0 · **Pantalla:** `/Domains/<d>/Purchasing/PurchaseOrders` · **`autoInject: true`**
**Estado:** VIVO. Core 73/73 golden, suite 955/955.

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
varias direcciones de la misma empresa de un jalón.

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

Se inyecta en el **header, junto al toggle**, dentro de un contenedor común
(`#sa-pof-bar`) anclado tras "New Purchase Order". **Antes vivía en la barra de filtros de la
tabla, pegado al buscador nativo, y el operador lo confundía con el universal** — dos cajas de
búsqueda contiguas y casi idénticas. Agrupado con el toggle y en **dark-mode pleno** (fondo
`#141a23`, texto `#e6e9ee`, acento `#13a36f`) se lee de un vistazo como UI de la extensión.

Fan-out por término, **acotado a 7 consultas** (`MAX_QUERIES_PER_SEARCH`):

1. `FilterSearch(vendorIdFilter, q)` → proveedores — **1 consulta**
2. `PurchaseOrders` × 5 vistas con `searchQuery`, `first:5` — **5 consultas**
3. `SearchBills(searchQuery)` → facturas — **1 consulta**

### Velocidad

La primera versión se sentía lenta. Cuatro cosas la explicaban, y las cuatro están resueltas:

| Problema | Arreglo |
|---|---|
| Los proveedores se esperaban **en serie** antes de arrancar las otras 6 | Las 7 van al **mismo pool** |
| Pool de 2 → 4 rondas de latencia | **Pool de 4** → 2 rondas, mismo volumen total |
| El panel esperaba a que TODAS terminaran para pintar | **Render incremental real**: `runPool` avisa por cada consulta que vuelve y el panel se repinta |
| Debounce de 350 ms | **220 ms** (el fan-out ya está acotado, no hace falta esperar tanto) |

Además: la **vista actual se consulta primero** (`planSearchQueries(term, currentCategory)`), que
es donde el operador tiene más probabilidad de encontrar lo que busca; **caché de un slot** por
término (borrar y reescribir no vuelve a consultar); y el encabezado muestra el conteo parcial
(«Buscando… 3 hasta ahora») para poder clicar el primer resultado sin esperar el resto.

> **No subir el pool de 4.** El rate-limit de SH castiga el **volumen acumulado** (~40
> requests), no la concurrencia puntual — pero con 7 tareas, un pool de 4 ya deja el pool
> ocioso en la segunda ronda: subirlo no gana nada y sí acerca el límite.

`planSearchQueries` devuelve el plan como descriptores (no promesas) para que el conteo sea
**verificable sin red**; hay tests que fijan el invariante, incluido uno que truena si alguien
reintroduce el fan-out por proveedor, y otros que verifican que priorizar la vista actual no
duplique ni pierda vistas.

> **`vendorIdFilter` CONFIRMADO** por el operador (2026-07-27): el filtro nativo de Proveedor
> genera `?category=Issued&offset=0&vendorIdFilter=89855`, y `89855` es exactamente el
> `identifier` que devuelve `FilterSearch` para "ATOTECH DE MEXICO".

Panel dark-mode con secciones **PROVEEDOR / ÓRDENES DE COMPRA / FACTURAS**; cada renglón lleva
badge de tipo y **en qué vista vive**.

## Navegación de los resultados

| Resultado | Clic en el renglón | Flechita ↗ |
|---|---|---|
| **Proveedor** | Listado filtrado por `vendorIdFilter`, en la **primera sección con resultados**: Draft → Issued **All** → Fulfilled **All** | `/Domains/<d>/Vendors/<idInDomain>` |
| **OC** | **Su vista exacta** (una OC vive en UNA sola de las 5), filtrada por su PO# | `/Domains/<d>/Purchasing/PurchaseOrders/<idInDomain>` |
| **Factura** | Listado de facturas filtrado | `/Domains/<d>/Bills/<idInDomain>` |

**Siempre "All", nunca Open ni Closed** al saltar desde un proveedor: el operador quiere ver
todas sus OCs, no la mitad. El eje de facturación tiene un tercer estado `?billing=All` que
**omite `billingOpen`** en la query — verificado en vivo: Issued·All manda `{issuedCondition:true}`
a secas. Hay un test que falla si alguna sección de navegación fija `billingOpen`.

Los 3 conteos que resuelven la sección se consultan **al hacer clic**, no durante la búsqueda:
así el presupuesto de la búsqueda se queda en 7 y solo paga quien salta. El `<a href>` ya
apunta a `issued-all`, así que si los conteos fallan o el operador hace ⌘+clic, el enlace
sigue sirviendo.

**Las fichas usan `idInDomain`, no el id de BD.** Verificado en vivo: `/Vendors/6` abre ATOTECH
DE MEXICO, mientras que su `identifier` en `FilterSearch` es `89855`. Confundirlos abriría otro
proveedor. `parseVendorDisplay` extrae el `6` del display `"#6 - ATOTECH DE MEXICO"`. Sin
`idInDomain` no se pinta la flechita: mejor sin ella que una que abra el documento equivocado.

## Widget B — Toggle "Sólo Proquipa"

Se inyecta **después del botón "New Purchase Order"** (anclaje **bilingüe** ES+EN).
Binario on/off, apagado por defecto, no persistente.

**Nació como toggle triple** (Ecoplating | Ambos | Proquipa) y se redujo a binario: el lado
Ecoplating **no es expresable**. Sus OC llevan la dirección del **dominio**, que es la misma que
la asignada a la ubicación "Ecoplating", y el filtro nativo no la acepta — por eso 79 de 129 OC
no matchean ninguna de las 10 direcciones. **Es un bug de Steelhead**; el operador levantó
ticket de soporte el 2026-07-27.

Mientras tanto solo se ofrece lo que se puede filtrar de forma confiable. Cuando Steelhead
corrija el filtro, reponer el lado Ecoplating es **agregar un modo** en `planProquipaFilter`:
el descubrimiento de direcciones y la agrupación por raíz siguen clasificando ambas empresas.

El toggle se enciende al recargar **solo si el filtro de la URL es exactamente el de Proquipa**
(`isProquipaFilterActive`). Un filtro parcial o puesto a mano no lo enciende — mentiría sobre
lo que está aplicado.

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
`PlantaToluca` = dominio → cuenta como Ecoplating. La agrupación se conserva completa aunque
hoy solo se ofrezca el filtro de Proquipa (ver Widget B).

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

### El hueco de las OCs sin dirección (bug de Steelhead)

En Issued·Open (129): Proquipa=50 y **las otras 9 direcciones dan 0** → 79 OC no matchean
ninguna. Causa confirmada por el operador: esas OC llevan la **dirección del dominio**, que es
la misma asignada a la ubicación "Ecoplating", y **el filtro nativo no la acepta**.

`IN (…)` tampoco expresa `NULL` ni negación, así que "todo lo que no es Proquipa" no se puede
pedir. **Ticket de soporte levantado con Steelhead el 2026-07-27.** Hasta que lo corrijan, el
toggle solo ofrece Proquipa (ver Widget B).

## Ids: string en la URL, ENTERO en GraphQL (bug del deploy 1.7.208)

`FilterSearch` devuelve `identifier` como **string** (`"89855"`) y en la URL los filtros viajan
como texto — ambas cosas correctas. Pero el schema declara estos filtros como listas de `Int` y
**GraphQL no coacciona**: mandar `["89855"]` revienta la consulta entera con HTTP 400
`Variable "$vendorIdFilter" got invalid value`.

Síntoma en producción: los **3 conteos** que resuelven a qué sección mandar al proveedor
fallaban **todos**, así que `resolveFirstSectionWithResults` devolvía `null` y siempre se caía al
fallback (Issued All) — mandando al operador a una vista **vacía** aunque el proveedor tuviera
35 OC en Fulfilled. Se veía como "no me mueve a la sección correcta", no como un error.

`toIdList` coacciona a entero y **descarta lo no numérico** (un `NaN` rompería igual).
`coerceIdFilters` la aplica a `vendorIdFilter`, `billToLocationIdFilter` y
`purchaseOrderStatusIdFilter` antes de cada consulta.

> **Por qué no se detectó antes:** mis pruebas manuales de `billToLocationIdFilter` usaron
> literales numéricos (`[22872]`), y el toggle funciona porque va **por URL**, no por GraphQL.
> El único camino que pasa ids de `FilterSearch` directo a GraphQL es el conteo por proveedor.

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

## Estado

**VIVO en config 1.7.209** (tags `v1.7.203` … `v1.7.209`). Core 73/73, suite 955/955.
Rollback: `tools/rollback.sh v1.7.208`.

### Validado en vivo (2026-07-27)

- [x] Ambos widgets se inyectan en su lugar (tras el fix de anclajes de 1.7.204)
- [x] El buscador **encuentra el proveedor**, que es lo que el nativo NO hace (da 0).
      "1 resultado" para "ATOTECH" es **correcto**: por texto no hay OC justamente porque
      `searchQuery` ignora al proveedor. El valor está en el salto.
- [x] Enlaces **relativos y sin host ficticio** en los 3 tipos (fix de 1.7.206)
- [x] Toggle → aplica `billToLocationIdFilter=23301,23344`: las **dos** direcciones de
      Proquipa de un jalón, que es lo que la UI nativa no permite
- [x] Toggle binario "Sólo Proquipa" visible tras "New Purchase Order"; flechita ↗ en cada
      renglón; hint de teclado en el pie
- [x] Clic en proveedor produce `?category=Issued&billing=All&vendorIdFilter=…` — siempre
      la variante **All**
- [x] **Resolución de sección funcionando** tras el fix de ids enteros (1.7.209): para
      ATOTECH los conteos dan `draft=0, issued-all=0, fulfilled-all=35` → resuelve a
      **fulfilled-all**, que es donde efectivamente están sus 35 OC

### Pendientes

- [ ] Recorrido end-to-end del clic y del teclado hecho por el operador (la automatización
      del navegador no logra enfocar el input de forma confiable, y el rate-limit cortó
      varios intentos; la lógica sí quedó verificada contra el código vivo)
- [ ] Confirmar si hay **>10 direcciones** de facturación (el descubrimiento en runtime lo
      resuelve, pero conviene saberlo; `S.capped` lo advierte en el `title` del toggle)
- [ ] Confirmar el shape exacto de los nodos de `SearchBills` (el glue lo localiza de forma
      defensiva; la primera corrida en vivo lo confirma)
- [ ] **Reponer el lado Ecoplating** cuando Steelhead corrija el filtro (ticket abierto por
      el operador 2026-07-27) — es agregar un modo en `planProquipaFilter`
- [ ] Integrar al bundle Safari/iPad si el operador lo usa desde ahí
