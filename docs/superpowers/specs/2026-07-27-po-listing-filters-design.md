# `po-listing-filters` — Buscador global de OC + Toggle de empresa

**Fecha:** 2026-07-27 · **Pantalla:** `/Domains/<d>/Purchasing/PurchaseOrders` · **Estado:** diseño aprobado

## Problema

La pantalla de Órdenes de Compra está partida en **5 vistas** que son combinaciones de dos ejes:

| Vista | URL | Variables de `PurchaseOrders` |
|---|---|---|
| Draft | `?category=Draft` (o sin params) | `{issuedAt:true, fulfilledCondition:false}` |
| Issued Open | `?category=Issued` | `{issuedCondition:true, billingOpen:true}` |
| Issued Closed | `?billing=Closed&category=Issued` | `{issuedCondition:true, billingOpen:false}` |
| Fulfilled Open | `?billing=Open&category=Fulfilled` | `{fulfilledCondition:true, billingOpen:true}` |
| Fulfilled Closed | `?billing=Closed&category=Fulfilled` | `{fulfilledCondition:true, billingOpen:false}` |

Dos dolores, verificados en vivo (dominio 344, 2026-07-27, read-only):

1. **El buscador nativo obliga a adivinar en cuál de las 5 vistas está el documento**, y además
   **no busca por proveedor**: `searchQuery:'ATOTECH'` devuelve **0** resultados aunque existe la
   OC #1873 de "ATOTECH DE MEXICO" en Issued·Open. Solo matchea el PO#
   (`searchQuery:'1911'` → 1 resultado). El proveedor solo es alcanzable por el filtro
   `vendorIdFilter`, que es otro control.
2. **El filtro de Dirección de Facturación es single-select en la UI**, así que no se pueden
   seleccionar Ecoplating y el dominio de un jalón.

## Hallazgos que fundamentan el diseño

Todo verificado en vivo contra el dominio 344.

### `PurchaseOrders` (listado)

- Hash `32f823d324b6b91e78fe43c93ab82042b931797f5592d088c4f1563051210d84`
- Respuesta: `data.pagedData.{ nodes, totalCount }`
- Variables comunes: `includeArchived, filterDraftStageById, purchaseOrderStatusIdFilter, orderBy, offset, first, searchQuery`
- Nodo (campos útiles): `id, idInDomain, createdAt, issuedAt, deadline, vendorId,
  vendorByVendorId{id,name,idInDomain}, userByCreatorId{name}, currentStage{name,labelColor},
  customInputs, archivedAt`
- **No trae** `billToLocationId` ni los bills asociados.

### `billToLocationIdFilter` — semántica OR (clave para el toggle)

- Es un **array**: la UI nativa manda `[22872]` aunque solo deje elegir uno.
- URL: `?billToLocationIdFilter=22872&offset=0`
- **Es OR, no AND** — verificado: `[Ecoplating]`=0, `[Proquipa]`=50, `[Ecoplating,Proquipa]`=**50**
  (la unión, no la intersección). **Por eso el toggle es viable.**

### Direcciones de facturación (via `FilterSearch`, key `billToLocationIdFilter`)

Nombres **anidados por punto**; la raíz del path define la empresa:

| display | id | raíz → empresa |
|---|---|---|
| Ecoplating | 22872 | Ecoplating |
| Ecoplating.N2 | 23345 | Ecoplating |
| Ecoplating.N3 | 23346 | Ecoplating |
| Ecoplating.N4 | 23347 | Ecoplating |
| Ecoplating.N5 | 25802 | Ecoplating |
| Ecoplating.N2.A2 | 24913 | Ecoplating |
| PlantaToluca | 24863 | dominio → **cuenta como Ecoplating** |
| PlantaToluca.Externa | 28241 | dominio → **cuenta como Ecoplating** |
| Proquipa | 23301 | Proquipa |
| Proquipa.N1 | 23344 | Proquipa |

> `FilterSearch` topa en **10 resultados** y devolvió exactamente 10 → **puede haber más**.
> El applet no hardcodea esta tabla: la descubre en runtime con sondas múltiples.

### El hueco de las OCs sin dirección

En Issued·Open (129 OCs): Proquipa=50 y **las otras 9 direcciones dan 0** → 79 OCs no matchean
ninguna. Decisión del usuario: **esas cuentan como Ecoplating** ("traen el dominio en la UI, por
eso quedan vacías").

Eso vuelve el lado izquierdo **"todo lo que NO es Proquipa"**, y `IN (…)` no expresa negación ni
`NULL`. Ver §Estrategia adaptativa.

### `SearchBills` (facturas)

- Hash `e50ba3ee7d2e694476d5180abdd978fa21f5147251c02d4cef051973b408bd8a`
- Pantalla `/Domains/<d>/Bills`; variables `{includeArchived, orderBy, offset, first, searchQuery}`
- Columnas visibles: Bill #, Vendor, Vendor Invoice #, PO #, Created By, Created, Invoice Date,
  Terms, Due Date, Total, Outstanding
- Su buscador **también** falla con "ATOTECH" (0 resultados) → mismo patrón que las OCs.

### Rate limiting (lección operativa)

El `/graphql` corta las consultas tras ~40-45 requests seguidas desde la consola: las peticiones
quedan **colgadas sin resolver ni fallar** (no devuelven 429, simplemente nunca vuelven), y no se
recuperan ni recargando la página. **El applet debe ser frugal**: debounce, pool ≤2, `first` chico,
`AbortController` con timeout, y degradar a resultados parciales en vez de reintentar en bucle.

## Arquitectura

Un applet, dos widgets (molde `wo-listing-columns`).

```
remote/scripts/po-listing-filters-core.js   módulo puro (sin DOM ni red) + golden tests
remote/scripts/po-listing-filters.js        glue (DOM + red)
tools/test/po-listing-filters-core.test.js  golden tests
docs/applets/po-listing-filters.md          bitácora
```

### Core puro — superficie

| Función | Contrato |
|---|---|
| `isPurchaseOrdersUrl(pathname)` | gate de pantalla |
| `PO_CATEGORIES` | las 5 vistas: `{key,label,urlParams,queryVars}` |
| `parseCategoryFromUrl(url)` | vista actual (para resaltar el resultado "estás aquí") |
| `rootLocationName(display)` | `'Ecoplating.N2.A2'` → `'Ecoplating'` |
| `companyOfLocation(display, cfg)` | raíz → `'ecoplating'` \| `'proquipa'` \| `'otra'` |
| `groupLocationsByCompany(items, cfg)` | `[{display,identifier}]` → `{ecoplating:[ids], proquipa:[ids], otras:[…]}` |
| `planCompanyFilter(mode, groups, coverage)` | **decide la estrategia** (ver abajo) |
| `buildCompanyFilterUrl(url, ids)` | escribe `billToLocationIdFilter` + `offset=0` |
| `parseCompanyModeFromUrl(url, groups)` | refleja el estado del toggle al recargar |
| `classifyResults(raw)` | agrupa en `PO` / `VENDOR` / `BILL` con su categoría |
| `buildResultHref(result, domainId)` | link destino de cada resultado |

### Estrategia adaptativa del lado izquierdo

El core **decide en runtime** según lo que mida el glue, en vez de asumir:

```
planCompanyFilter(mode='ecoplating', groups, coverage) →
  · coverage.allCovered           → { kind:'filter',  ids:[…Ecoplating…] }
  · coverage.nullAccepted         → { kind:'filter',  ids:[…Ecoplating…, null] }
  · si no                         → { kind:'annotate', hiddenIds:[…Proquipa…],
                                      note:'N sin dirección se muestran' }
```

- `allCovered`: la suma de OCs por dirección conocida == total sin filtro → no hay huérfanas →
  filtro nativo puro.
- `nullAccepted`: sonda única `billToLocationIdFilter:[…, null]`; si el server la acepta y el total
  crece, esa es la vía limpia.
- `annotate` (fail-safe): **nunca esconde OCs por un dato que no pudo resolver**. Filtra lo que sí
  sabe y avisa con conteo visible.

El modo `proquipa` (derecha) siempre es `{kind:'filter', ids:[…Proquipa…]}` — ahí no hay ambigüedad.
El modo `both` (centro, default) limpia el parámetro.

### Widget A — buscador global

Ancla: entre el input nativo (`svg[data-testid="SearchIcon"]`) y el bloque de filtros.

Fan-out por término, con pool ≤2:

1. `FilterSearch(vendorIdFilter, q)` → proveedores; si hay match, sus ids alimentan (2)
2. `PurchaseOrders` ×5 vistas con `searchQuery:q` **y** con `vendorIdFilter:[ids]` — `first:5`
3. `SearchBills(searchQuery:q)` → facturas

Panel dark-mode con secciones **PROVEEDOR / ÓRDENES DE COMPRA / FACTURAS**, cada renglón con badge
de tipo y la vista donde vive. Clic navega con el filtro aplicado. Render **incremental**: cada
fuente pinta al llegar, sin esperar a las demás.

### Widget B — toggle triple

Ancla: después del botón "New Purchase Order" / "Nueva Orden de Compra" (**bilingüe**).
Tres posiciones, centro por defecto, no persistente. Aplica por recarga de URL
(`location.assign`), igual que `batch-name-filter` — `pushState` no re-filtra confiable.

## Errores y fail-safes

| Escenario | Comportamiento |
|---|---|
| Hash rotado (HTTP 400) | El panel dice "no se pudo buscar (¿hash rotado?)"; el toggle no se inyecta |
| Consulta colgada | `AbortController` a 12s → resultado parcial, sin reintento en bucle |
| `FilterSearch` topa en 10 | Sondas múltiples + aviso `capped` en el panel |
| Ninguna dirección descubierta | El toggle **no se inyecta** (no puede filtrar a ciegas) |
| Empresa desconocida (`otras`) | No entra a ningún lado del toggle; se registra en consola bajo `sa_debug` |

## Convenciones del repo que aplican

- **Anclajes bilingües ES+EN** desde el inicio (regla dura del repo).
- **Hashes con ruta de regeneración** en `route-catalog.json` — sin ella el hash es deuda:
  - `purchasing-purchaseorders-list` → `goto /Domains/{domain}/Purchasing/PurchaseOrders?category=Issued` → captura `PurchaseOrders`
  - `bills-list` → `goto /Domains/{domain}/Bills` → captura `SearchBills`
  - `FilterSearch` ya tiene ruta (`workorders-filter-open`)
- **Dark mode** para el panel flotante (UI propia). Los controles inline heredan el look de la
  barra nativa con acento verde `#13a36f` — precedente `schedule-batch-highlighter`. Nota: el
  Steelhead de este usuario está en tema oscuro, así que lo que marca "esto es de la extensión"
  es el acento verde, no el fondo.
- **Sin `innerHTML`** con datos de la API (nombres de proveedor son vector cross-user) → `textContent`.
- Estado singleton en `window.__saPOF` — `injectAppScripts` re-evalúa el IIFE en cada acción del
  popup (lección `surtido-guard`/`price-confirm-guard`).

## Plan de validación

1. Golden tests del core (agrupación por raíz, `planCompanyFilter` en sus 3 ramas, construcción de
   URLs, clasificación de resultados).
2. En vivo: buscar "ATOTECH" → debe encontrar el proveedor + sus OCs, cosa que el nativo no hace.
3. En vivo: toggle a Proquipa → 50 en Issued·Open; a Ecoplating → según la rama que aplique;
   centro → 129.
4. Verificar que el toggle refleja su estado al recargar con el parámetro puesto.

## Pendientes explícitos

- Confirmar si hay >10 direcciones de facturación (bloqueado por rate-limit; lo resuelve el
  descubrimiento en runtime).
- Confirmar si `billToLocationIdFilter` acepta `null` (sonda del propio applet).
- Shape exacto de los nodos de `SearchBills` (se lee en la primera corrida).
