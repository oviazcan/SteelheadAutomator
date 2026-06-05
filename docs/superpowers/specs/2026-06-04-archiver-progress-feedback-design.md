# Archiver — Feedback de progreso (carga + ejecución)

> Spec de diseño · 2026-06-04 · applet `archiver` (`remote/scripts/archiver.js`)

## Contexto y problema

El **Archivador Masivo de PNs** no da feedback visual de progreso confiable. Síntomas
reportados por el usuario:

1. **Al confirmar la ejecución no aparece ninguna barra ni indicador** — "no sabes si
   sí está trabajando o no".
2. **"Tarda mucho en cargar"** sin señal de actividad mientras escanea.

## Diagnóstico (root cause)

Tres fallas concretas en el código actual:

1. **El overlay de progreso desaparece justo al ejecutar (flujo normal).**
   `showFilterScreen` (`archiver.js:504`) y `showArchiverPreview` (`:569`) llaman
   `removeArchiverUI()` para mostrar su propia pantalla. En el path normal,
   `executeArchive` se invoca desde `run:299` y **nunca re-muestra el overlay**; sus
   llamadas a `updateArchiverUI(...)` (`:319`, `:357`) no encuentran `#sa-arch-text` y
   no pintan nada → la mutación real corre sin overlay visible. (El path de *resume*
   sí muestra overlay porque `run:250` llama `showArchiverUI` antes de `executeArchive`.)

2. **La barra es markup muerto.** `showArchiverUI:482` inserta
   `<div class="dl9-bar"><div class="dl9-bar-fill" id="sa-arch-bar">`, pero:
   - `.dl9-bar` / `.dl9-bar-fill` / `.dl9-progress` **no tienen CSS** en `ensureStyles`
     (`:387`) → la barra es invisible.
   - El `width` de `#sa-arch-bar` **nunca se actualiza** → estática. Solo el texto
     (`#sa-arch-text`) se mueve.

3. **La carga no tiene barra.** `fetchPNsForMode` (`:159`) pagina `AllPartNumbers`
   (`pagedData.nodes`, `offset`/`first=500`) emitiendo solo texto `"Cargando PNs... N"`.

## Decisiones (sesión de brainstorming)

- **Alcance:** carga + ejecución (las dos quejas).
- **Carga:** % real si `pagedData.totalCount` existe; si no → barra **animada
  indeterminada** (degrada en runtime, sin dependencia dura).
- **Ejecución:** barra con % real (`completados/total`).
- **Enfoque A:** overlay de progreso persistente + barra reutilizable. Cambios
  localizados; **no** se reescriben las pantallas de filtros/preview (ya funcionan).

## Diseño

### Componentes nuevos / modificados

| Componente | Tipo | Rol |
|---|---|---|
| `ensureProgressOverlay()` | reusar `showArchiverUI` (ya idempotente, `if (!ov)`) | Garantiza overlay antes de cada fase que carga/muta |
| `setProgress(fraction, text)` | nuevo | `fraction∈[0,1]` → barra al `%`; `fraction==null` → barra animada. `text` vía `textContent` (XSS-safe). Crea overlay si falta (defensivo) |
| CSS de barra | nuevo en `ensureStyles` | `.dl9-bar`, `.dl9-bar-fill`, `.dl9-bar-fill.indet`, `@keyframes dl9slide`, `.dl9-progress` |
| `computeLoadProgress({processed,total,kept})` | nuevo (puro) | → `{fraction, text}` para la carga; `total` falsy ⇒ `fraction=null` |
| `computeExecProgress({done,total,errors,gerundio})` | nuevo (puro) | → `{fraction, text}` para la ejecución |

### CSS (en `ensureStyles`, tema verde del archiver)

```css
.dl9-bar{height:10px;background:#0f291a;border-radius:6px;overflow:hidden;margin:14px 0 10px}
.dl9-bar-fill{height:100%;width:0;background:#4ade80;border-radius:6px;transition:width .2s ease}
.dl9-bar-fill.indet{width:40%;animation:dl9slide 1.1s infinite ease-in-out}
@keyframes dl9slide{0%{margin-left:-40%}100%{margin-left:100%}}
.dl9-progress{font-size:13px;color:#cbd5e1}
```

`setProgress` agrega/quita la clase `indet` en `#sa-arch-bar` y setea `style.width`
(ignorado mientras esté `indet` porque la animación controla `margin-left`).

### Comportamiento por fase

| Fase | Función | Barra | Texto (ejemplo) |
|---|---|---|---|
| **Scan** | `fetchPNsForMode` | % real si `totalCount`; si no, animada | `Cargando PNs… 1,800/3,750 (320 del modo)` · `Cargando PNs… 320` |
| **Cruce utilización** | `filterByUnused` | animada | `Cargando OTs… página 2, 140 con OT` · `Cargando recibos…` |
| **Ejecución** | `executeArchive` | % real (`done/total`) | `Archivando 140/512 — 2 errores` (mode-aware: "Desarchivando") |

### El fix central (overlay ausente)

`executeArchive` llama **`ensureProgressOverlay()` al inicio**, en ambos paths (normal
y resume). Así, al confirmar en el preview, el overlay reaparece con la barra activa.
Las pantallas de filtros/preview **no se modifican** (siguen removiendo el overlay al
abrir; nosotros lo recreamos antes de ejecutar).

### Detalle del % de carga

- `pagedData.totalCount` cuenta **todos** los PNs (activos + archivados). El avance
  honesto del scan es `processed/total` donde `processed = offset + nodes.length`, no
  `kept/total` (por eso el texto muestra ambos: procesados/total y "del modo").
- `fetchPNsForMode` lee `totalCount` de la **primera página**; lo guarda y pasa
  `{processed, total, kept}` al callback en cada página.
- `total` ausente (`undefined`) ⇒ `computeLoadProgress` devuelve `fraction=null` ⇒
  barra animada + conteo de encontrados.
- `filterByUnused` usa siempre animada (no se invierte en leer su `totalCount`; es fase
  secundaria y solo corre en modo archive + `dateType=utilizacion`).

### Granularidad de actualización

- **UI:** `setProgress` en **cada** PN completado en `executeArchive` (barato: width +
  text). Reemplaza el throttle actual de "cada 5".
- **`saveResume`:** se mantiene **cada 5** (es escritura a `localStorage`, más cara).
- Carga: `setProgress` una vez por página (como hoy el texto).

### No romper / edge cases

- **Detener:** el botón `#sa-arch-stop` vive en el overlay; funciona en toda fase con
  overlay visible (carga y ejecución). Sin cambios de lógica (`stopped=true`).
- **Resume:** `run:250` pasa a usar `ensureProgressOverlay()` + `setProgress`. Lógica
  intacta.
- **Idempotencia:** un PN saltado por `isInTargetState` cuenta como avance
  (`completed.add`), así la barra sube igual. Sin cambios.
- **Seguridad:** `setProgress` usa `textContent` (no `innerHTML`); CSS estático.

### Testing

- **Puro/unit** (`tools/test/archiver.test.js`, patrón `node --test` + sandbox vm,
  expuesto vía `window.__SAArchiver`):
  - `computeLoadProgress`: con `total` → `fraction=processed/total` y texto con ambos;
    sin `total` → `fraction=null` y texto de conteo.
  - `computeExecProgress`: `fraction=done/total`, texto mode-aware y conteo de errores;
    bordes `total=0` y `done=total`.
- **DOM:** se valida en el piloto del usuario (sesión autenticada) — ver barra en carga
  (% vs animada) y en ejecución, y el botón Detener.

### Deploy

Cambia `remote/scripts/archiver.js` ⇒ bump `remote/config.json` `version` + sync
byte-exact a `gh-pages` (hot file: una sola sesión deploya a la vez). Sin cambios en
`extension/` ⇒ no toca `manifest.json` ni el `.zip`.

## Criterios de éxito

1. Al confirmar la ejecución, aparece de inmediato el overlay con barra que avanza
   `done/total` y el botón Detener — en el flujo normal (no solo en resume).
2. Durante el scan, la barra muestra % real si Steelhead da el total, o animada si no,
   con el conteo creciendo en vivo.
3. La barra es visible (CSS presente) y su relleno se mueve.
4. Detener, resume e idempotencia siguen funcionando.
5. `node --test tools/test/archiver.test.js` en verde, incluyendo los casos nuevos.
