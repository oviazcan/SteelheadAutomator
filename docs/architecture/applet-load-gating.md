# Carga de applets: por qué tarda y cómo acotarla

**Estado:** problema diagnosticado con evidencia, **solución propuesta, NO implementada**.
Reportado por el operador el 2026-07-27: *"conforme vamos agregando applets, cada vez tardan
más en cargar… en Purchasing no necesito cargar ni vales de almacén ni paros de línea"*.

## El diagnóstico

Dos causas independientes, ambas en `extension/background.js:183-207`.

### 1. Se inyectan TODOS los `autoInject` en TODAS las páginas

```js
const autoApps = (config.apps || []).filter(a => a.autoInject);
for (const app of autoApps) { … await injectAppScripts(tabId, app.id); }
```

El único filtro es `tab.url?.includes('app.gosteelhead.com')`. **No hay gate por ruta.**

Medido el 2026-07-27 sobre `remote/config.json` 1.7.213:

| | |
|---|---|
| Applets con `autoInject` | **28** de 44 |
| Archivos `.js` descargados, verificados y evaluados **en cada carga de página** | **79** |

En `/Purchasing/PurchaseOrders` se cargan `vale-almacen`, `paros-linea`,
`sensor-graph-hide-all`, `invoice-autofill`, `wo-listing-columns`, `load-calculator`… ninguno
aplica ahí.

Cada applet **ya tiene su gate por URL**, pero corre **dentro del script**, es decir **después**
de descargarlo, verificar su firma y evaluarlo. El trabajo caro ya se pagó.

### 2. La inyección es SECUENCIAL

Es un `for` con `await` dentro: cada applet espera a que termine el anterior. Con 28 applets
son 28 rondas en serie de (fetch + verificación de firma + `new Function`).

**Consecuencia directa:** el applet que se agregó al final de `config.apps[]` es el último en
aparecer. `po-listing-filters` es el más reciente → es el número 28 de 28. Por eso el operador
lo percibe justo en la pantalla donde acaba de trabajar.

## La solución propuesta

### A. Gate por URL en el config (lo que resuelve el problema de fondo)

Añadir un campo declarativo a la entrada de cada app:

```jsonc
{
  "id": "po-listing-filters",
  "autoInject": true,
  "urlPatterns": ["^/Domains/\\d+/Purchasing/PurchaseOrders"],   // ← nuevo
  "scripts": [...]
}
```

y filtrar en `background.js` **antes** de inyectar:

```js
const path = new URL(tab.url).pathname;
const autoApps = (config.apps || [])
  .filter(a => a.autoInject)
  .filter(a => !a.urlPatterns || a.urlPatterns.some(p => new RegExp(p).test(path)));
```

- **Retrocompatible:** una app sin `urlPatterns` se sigue inyectando en todas partes, igual que
  hoy. Se puede migrar applet por applet sin big-bang.
- **La fuente del patrón ya existe:** casi todos los applets tienen su regex de gate en el core
  (`PO_URL_RE`, `SHIPPING_URL_RE`, `isScheduleBoardUrl`…). Es copiar esa expresión al config.
- **Riesgo a cuidar:** el gate del config y el del applet pueden divergir. El del applet **se
  queda** (es el que protege ante SPA navigation, donde no hay recarga y el listener
  `onUpdated` no vuelve a correr). El del config es solo un filtro de carga, no de ejecución.

### B. Paralelizar la inyección

`for … await` → `Promise.allSettled` con una concurrencia acotada (4-6). `allSettled` y no
`all`: un applet que falle no debe impedir que carguen los demás — hoy tampoco lo hace, porque
el `try` envuelve todo el bucle, pero conviene que sea explícito por applet.

### C. Orden por relevancia (opcional)

Inyectar primero los que matchean la ruta actual de forma específica y dejar al final los
genéricos. Con (A) aplicado esto pierde casi toda su importancia.

## Impacto estimado

Con (A) en `/Purchasing/PurchaseOrders`: de 28 applets / 79 archivos a ~3-4 applets / ~10
archivos. Con (B) encima, esas pocas cargas dejan de ser secuenciales.

## Por qué NO se implementó en esta sesión

Toca `extension/background.js`, y los cambios de `extension/` **no se despliegan por el canal
normal**: la extensión se distribuye como `.zip` y hay que republicarla (ver
`CLAUDE.md` §Seguridad, nota 2026-07-15 sobre CWS). Es un cambio de una sola pieza, de bajo
riesgo y alto impacto, pero necesita su propio ciclo de release y validación.

**Lo que sí se puede hacer sin republicar:** nada equivalente. El gate vive necesariamente en
el loader, que es código de la extensión. Añadir `urlPatterns` al `config.json` desde ya es
inofensivo (el loader viejo lo ignora) y deja el terreno listo para cuando se republique.
