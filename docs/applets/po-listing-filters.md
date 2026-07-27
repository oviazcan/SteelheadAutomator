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

Fan-out por término, con pool ≤2:

1. `FilterSearch(vendorIdFilter, q)` → proveedores. **Sus ids alimentan el paso 2**, que es
   justo lo que el buscador nativo no hace.
2. `PurchaseOrders` × 5 vistas, con `searchQuery` **y** con `vendorIdFilter`, `first:5`.
3. `SearchBills(searchQuery)` → facturas.

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

## Lección operativa: el `/graphql` se cuelga bajo ráfaga

Descubierto en carne propia durante la captura: **tras ~40-45 requests seguidas desde la consola,
el endpoint deja de responder**. Las peticiones quedan **colgadas sin resolver ni fallar** — no
devuelven 429 ni error, simplemente nunca vuelven — y **no se recuperan recargando la página**.

Por eso el applet es frugal por diseño: debounce 350 ms, pool de 2, `first:5`, timeout de 12 s y
degradación a resultados parciales **sin reintento en bucle**. Si tocas este applet, no subas la
concurrencia "para que vaya más rápido": lo que se gana es que deje de funcionar.

## Estado / pendientes

- [x] Core puro + 42 golden tests · suite completa 924/924
- [x] Registro en `config.json` (hashes + app) — rutas de hash ya cubiertas
- [ ] **Deploy a gh-pages** (`tools/deploy.sh`)
- [ ] **Validación en vivo:**
  1. Buscar "ATOTECH" → debe encontrar el proveedor **y sus OCs**, que es lo que el nativo no hace
  2. Toggle a Proquipa → 50 en Issued·Open; centro → 129; Ecoplating → según la rama que aplique
  3. Confirmar cuál de las 3 ramas de `planCompanyFilter` toma en la práctica
  4. Verificar que el toggle refleja su estado al recargar con el parámetro puesto
- [ ] Confirmar si hay **>10 direcciones** de facturación (el descubrimiento en runtime lo
      resuelve, pero conviene saberlo; `S.capped` lo advierte en el `title` del toggle)
- [ ] Confirmar el shape exacto de los nodos de `SearchBills` (el glue lo localiza de forma
      defensiva; la primera corrida en vivo lo confirma)
- [ ] Integrar al bundle Safari/iPad si el operador lo usa desde ahí
