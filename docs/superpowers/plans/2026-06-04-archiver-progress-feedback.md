# Archiver Progress Feedback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar feedback de progreso visible y confiable en el applet `archiver` durante la carga (scan) y la ejecución (archivar/desarchivar), arreglando el overlay que hoy desaparece al ejecutar y la barra que es markup muerto.

**Architecture:** Enfoque A (overlay persistente + barra reusable). Se agregan dos funciones puras de cálculo (`computeLoadProgress`, `computeExecProgress`) testeables en el sandbox `vm`, un helper de UI `setProgress(fraction, text)` que reusa el overlay idempotente existente, el CSS que hoy falta para la barra, y se reconecta cada fase (scan, cruce de utilización, ejecución) para pintar progreso. El fix clave: `executeArchive` re-asegura el overlay al inicio.

**Tech Stack:** JavaScript vanilla (sin frameworks/bundlers), `node --test` + `node:vm` para tests puros, deploy por `gh-pages` (GitHub Pages).

---

## File Structure

- **Modify `remote/scripts/archiver.js`** (única fuente del applet):
  - Helpers puros nuevos: `fmt`, `computeLoadProgress`, `computeExecProgress` (tras `isInTargetState`, ~línea 153). Exponer las dos `compute*` en `_internals` (~línea 700).
  - CSS de barra en `ensureStyles` (~línea 390).
  - Helper UI `setProgress(fraction, text)` (junto a `showArchiverUI`/`updateArchiverUI`, ~línea 487).
  - `fetchPNsForMode` (~159): capturar `pagedData.totalCount` y emitir `{processed,total,kept}`.
  - `run` (~257, ~260): callback de scan vía `setProgress(computeLoadProgress(...))`.
  - `filterByUnused` (~181,196,203,216): `setProgress(null, …)` (animada).
  - `executeArchive` (~308): `setProgress` al inicio (re-asegura overlay) + en cada PN; `saveResume` cada 5.
- **Modify `tools/test/archiver.test.js`**: tests de `computeLoadProgress` y `computeExecProgress`.
- **Modify `remote/config.json`**: bump `version` (cache-bust) en el deploy.
- **Deploy**: sync byte-exact a `gh-pages`.

---

## Task 1: Funciones puras de progreso (`computeLoadProgress`, `computeExecProgress`)

**Files:**
- Modify: `remote/scripts/archiver.js` (agregar helpers tras `isInTargetState` ~línea 153; exponer en `_internals` ~línea 700)
- Test: `tools/test/archiver.test.js`

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tools/test/archiver.test.js` (antes de EOF):

```javascript
test('computeLoadProgress con total → fracción y texto procesados/total', () => {
  const r = A.computeLoadProgress({ processed: 1800, total: 3750, kept: 320 });
  assert.equal(r.fraction, 1800 / 3750);
  assert.equal(r.text, 'Cargando PNs... 1,800/3,750 (320 del modo)');
});

test('computeLoadProgress sin total → fracción null y conteo de encontrados', () => {
  const r = A.computeLoadProgress({ processed: 500, total: null, kept: 320 });
  assert.equal(r.fraction, null);
  assert.equal(r.text, 'Cargando PNs... 320');
});

test('computeLoadProgress clamp processed>total a 1', () => {
  const r = A.computeLoadProgress({ processed: 4000, total: 3750, kept: 100 });
  assert.equal(r.fraction, 1);
});

test('computeExecProgress fracción done/total + errores plural', () => {
  const r = A.computeExecProgress({ done: 140, total: 512, errors: 2, gerundio: 'Archivando' });
  assert.equal(r.fraction, 140 / 512);
  assert.equal(r.text, 'Archivando 140/512 — 2 errores');
});

test('computeExecProgress sin errores omite sufijo; singular y mode-aware', () => {
  assert.equal(
    A.computeExecProgress({ done: 1, total: 10, errors: 0, gerundio: 'Desarchivando' }).text,
    'Desarchivando 1/10');
  assert.equal(
    A.computeExecProgress({ done: 5, total: 10, errors: 1, gerundio: 'Archivando' }).text,
    'Archivando 5/10 — 1 error');
});

test('computeExecProgress total=0 → fracción 0 (no NaN)', () => {
  assert.equal(A.computeExecProgress({ done: 0, total: 0, errors: 0, gerundio: 'Archivando' }).fraction, 0);
});
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `node --test tools/test/archiver.test.js`
Expected: FAIL — `A.computeLoadProgress is not a function` (las funciones aún no existen).

- [ ] **Step 3: Implementar las funciones puras**

En `remote/scripts/archiver.js`, justo después de la función `isInTargetState` (cierre `}` ~línea 153) y antes del comentario de banda `// ═══` que precede a `fetchPNsForMode`, insertar:

```javascript
  // Formatea enteros con separador de miles (determinista, sin depender de ICU).
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // Progreso de la fase de carga (scan). total falsy ⇒ indeterminado (fraction null).
  function computeLoadProgress({ processed, total, kept }) {
    if (total && total > 0) {
      const fraction = Math.min(processed / total, 1);
      return { fraction, text: `Cargando PNs... ${fmt(processed)}/${fmt(total)} (${fmt(kept)} del modo)` };
    }
    return { fraction: null, text: `Cargando PNs... ${fmt(kept)}` };
  }

  // Progreso de la fase de ejecución. gerundio = 'Archivando' | 'Desarchivando'.
  function computeExecProgress({ done, total, errors, gerundio }) {
    const fraction = total > 0 ? Math.min(done / total, 1) : 0;
    const errPart = errors > 0 ? ` — ${errors} ${errors === 1 ? 'error' : 'errores'}` : '';
    return { fraction, text: `${gerundio} ${fmt(done)}/${fmt(total)}${errPart}` };
  }
```

Luego, en el `return { ... _internals: {...} }` del IIFE (~línea 700), agregar las dos funciones al objeto `_internals`:

```javascript
    _internals: { slimPN, discoverLabels, matchesLabels, applyFilters, isInTargetState, computeLoadProgress, computeExecProgress },
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS — los 10 tests previos + los 6 nuevos en verde.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/archiver.js tools/test/archiver.test.js
git commit -m "feat(archiver): funciones puras de progreso (carga + ejecución) + tests"
```

---

## Task 2: CSS de la barra de progreso

**Files:**
- Modify: `remote/scripts/archiver.js` — `ensureStyles` (~línea 390)

> No es unit-testeable (es CSS/DOM). La verificación es: el suite sigue verde (no rompí el parse) + inspección visual en el piloto.

- [ ] **Step 1: Agregar las reglas CSS faltantes**

En `ensureStyles`, dentro del template string asignado a `s.textContent` (~línea 390), **antes** del backtick de cierre, anexar estas reglas (la barra es `dl9-bar` / `dl9-bar-fill`, hoy sin estilo):

```css
.dl9-bar{height:10px;background:#0f291a;border-radius:6px;overflow:hidden;margin:14px 0 10px}.dl9-bar-fill{height:100%;width:0;background:#4ade80;border-radius:6px;transition:width .2s ease}.dl9-bar-fill.indet{width:40%;animation:dl9slide 1.1s infinite ease-in-out}@keyframes dl9slide{0%{margin-left:-40%}100%{margin-left:100%}}.dl9-progress{font-size:13px;color:#cbd5e1}
```

(Pegar como continuación del string CSS existente, sin romper las comillas invertidas.)

- [ ] **Step 2: Verificar que no rompí el script**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS — el `vm` carga `archiver.js` sin SyntaxError y los 16 tests siguen verdes.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): CSS de la barra de progreso (dl9-bar/.indet/keyframes)"
```

---

## Task 3: Helper de UI `setProgress(fraction, text)`

**Files:**
- Modify: `remote/scripts/archiver.js` — junto a `updateArchiverUI` (~línea 492)

> DOM helper, no unit-testeable. Verificación: suite verde (no rompe parse) + piloto.

- [ ] **Step 1: Agregar `setProgress`**

Justo después de la función `updateArchiverUI` (cierre `}` ~línea 492), insertar:

```javascript
  // Pinta progreso reusando el overlay idempotente (showArchiverUI). fraction en
  // [0,1] → barra determinada; fraction null → barra animada (clase 'indet').
  function setProgress(fraction, text) {
    showArchiverUI(text);                 // asegura overlay + setea #sa-arch-text
    const bar = document.getElementById('sa-arch-bar');
    if (!bar) return;
    if (fraction == null) {
      bar.classList.add('indet');
      bar.style.width = '';               // deja que la clase 'indet' controle el ancho
    } else {
      bar.classList.remove('indet');
      const pct = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
      bar.style.width = `${pct}%`;
    }
  }
```

- [ ] **Step 2: Verificar parse + sin regresión**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS — 16 tests verdes.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): helper setProgress (barra determinada/animada sobre overlay)"
```

---

## Task 4: Progreso en la fase de carga (`fetchPNsForMode` + `run`)

**Files:**
- Modify: `remote/scripts/archiver.js` — `fetchPNsForMode` (~159), `run` (~257 y ~260)

> Verificación: suite verde + piloto.

- [ ] **Step 1: Capturar `totalCount` y emitir objeto de progreso en `fetchPNsForMode`**

Reemplazar el cuerpo de `fetchPNsForMode` (~líneas 159-177) por:

```javascript
  async function fetchPNsForMode(mode, onProgress, pageSize = 500) {
    const slimPNs = [];
    let offset = 0;
    let total = null;
    while (!stopped) {
      const data = await api().query('AllPartNumbers', {
        orderBy: ['ID_ASC'], offset, first: pageSize, searchQuery: ''
      }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      if (total == null) {
        const tc = data?.pagedData?.totalCount;
        total = (typeof tc === 'number' && tc > 0) ? tc : null;
      }
      for (const n of nodes) {
        const isArchived = !!n.archivedAt;
        const keep = mode === 'unarchive' ? isArchived : !isArchived;
        if (keep) slimPNs.push(slimPN(n));   // SLIM: no guardar nodo pesado
      }
      const processed = offset + nodes.length;
      if (onProgress) onProgress({ processed, total, kept: slimPNs.length });
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return slimPNs;
  }
```

- [ ] **Step 2: Conectar el callback de scan a `setProgress` en `run`**

En `run`, cambiar el mensaje inicial (~línea 257) de:

```javascript
    showArchiverUI(`Buscando números de parte (${mode === 'unarchive' ? 'archivados' : 'activos'})...`);
```

a:

```javascript
    setProgress(null, `Buscando números de parte (${mode === 'unarchive' ? 'archivados' : 'activos'})...`);
```

Y cambiar la llamada al scan (~línea 260) de:

```javascript
    let slimPNs = await fetchPNsForMode(mode, (msg) => updateArchiverUI(msg), 500);
```

a:

```javascript
    let slimPNs = await fetchPNsForMode(mode, (p) => {
      const r = computeLoadProgress(p);
      setProgress(r.fraction, r.text);
    }, 500);
```

- [ ] **Step 3: Verificar parse + sin regresión**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS — 16 tests verdes (el cambio no toca helpers puros existentes).

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): barra de carga con % real (totalCount) o animada"
```

---

## Task 5: Progreso en el cruce de utilización (`filterByUnused`)

**Files:**
- Modify: `remote/scripts/archiver.js` — `filterByUnused` (~181, ~196, ~203, ~216)

> Solo corre en modo `archive` + `dateType=utilizacion`. Barra siempre animada. Verificación: suite verde + piloto.

- [ ] **Step 1: Reemplazar las 4 llamadas `updateArchiverUI` por `setProgress(null, …)`**

- Línea ~181: `updateArchiverUI(\`Cargando órdenes de trabajo...\`);` →
  ```javascript
      setProgress(null, `Cargando órdenes de trabajo...`);
  ```
- Línea ~196: `updateArchiverUI(\`OTs: página ${Math.floor(woOffset / 500) + 1}, ${usedPNIds.size} PNs con OT\`);` →
  ```javascript
        setProgress(null, `OTs: página ${Math.floor(woOffset / 500) + 1}, ${usedPNIds.size} PNs con OT`);
  ```
- Línea ~203: `updateArchiverUI(\`Cargando recibos...\`);` →
  ```javascript
      setProgress(null, `Cargando recibos...`);
  ```
- Línea ~216: `updateArchiverUI(\`Recibos: página ${Math.floor(recOffset / 500) + 1}, ${usedPNIds.size} PNs con actividad\`);` →
  ```javascript
        setProgress(null, `Recibos: página ${Math.floor(recOffset / 500) + 1}, ${usedPNIds.size} PNs con actividad`);
  ```

- [ ] **Step 2: Verificar parse + sin regresión**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS — 16 tests verdes.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): barra animada durante el cruce de utilización (OTs/recibos)"
```

---

## Task 6: Progreso en la ejecución (`executeArchive`) — el fix central

**Files:**
- Modify: `remote/scripts/archiver.js` — `executeArchive` (~319 y ~356-359)

> Aquí está el bug raíz: el overlay no existe durante la mutación en el flujo normal. `setProgress` lo re-asegura. Verificación: suite verde + piloto (debe verse la barra al confirmar).

- [ ] **Step 1: Re-asegurar overlay al inicio + barra inicial**

Reemplazar la línea ~319:

```javascript
    updateArchiverUI(`${gerundio} ${pendingCount} PNs (concurrencia 3, ${completed.size} ya OK)...`);
```

por (re-asegura el overlay vía `setProgress`, lo que arregla el flujo normal donde el overlay fue removido por las pantallas de filtros/preview):

```javascript
    {
      const p0 = computeExecProgress({ done: completed.size, total: totalCount, errors: 0, gerundio });
      setProgress(p0.fraction, p0.text);
    }
```

- [ ] **Step 2: Actualizar la barra en cada PN; `saveResume` cada 5**

Reemplazar el bloque ~líneas 355-359:

```javascript
      completed.add(pn.id);
      if (completed.size % 5 === 0 || completed.size === totalCount) {
        updateArchiverUI(`${gerundio} ${completed.size}/${totalCount} — ${results.errors.length} errores`);
        saveResume({ selectedPNs, opts, completed: [...completed] });
      }
```

por (UI en cada PN, persistencia cada 5):

```javascript
      completed.add(pn.id);
      const done = completed.size;
      const p = computeExecProgress({ done, total: totalCount, errors: results.errors.length, gerundio });
      setProgress(p.fraction, p.text);
      if (done % 5 === 0 || done === totalCount) {
        saveResume({ selectedPNs, opts, completed: [...completed] });
      }
```

- [ ] **Step 3: Verificar parse + sin regresión**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS — 16 tests verdes.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "fix(archiver): overlay visible y barra % durante la ejecución (flujo normal)"
```

---

## Task 7: Deploy a producción (`gh-pages`)

**Files:**
- Modify: `remote/config.json` (`version`, `lastUpdated`)
- Deploy: rama `gh-pages` (sync byte-exact de `remote/scripts/archiver.js` y `config.json`)

> Hot file: solo una sesión deploya a la vez. `extension/` no cambió ⇒ no se toca `manifest.json` ni el `.zip`.

- [ ] **Step 1: Determinar la próxima versión (evitar choque con otra sesión)**

Run: `git fetch origin gh-pages && git show origin/gh-pages:config.json | grep -m1 '"version"'`
Tomar la versión publicada (p. ej. `1.6.35`) y elegir la siguiente patch por encima de `main` **y** de `gh-pages` (p. ej. `1.6.36`).

- [ ] **Step 2: Bump `remote/config.json`**

Editar `remote/config.json`: subir `version` a la elegida y `lastUpdated` a `2026-06-04` (o la fecha del deploy).

- [ ] **Step 3: Commit en la rama de trabajo**

```bash
git add remote/config.json
git commit -m "chore(config): bump <version> — barra de progreso del archiver"
```

- [ ] **Step 4: Sync a gh-pages vía worktree temporal (no toca el worktree actual)**

```bash
git worktree add /tmp/ghp-arch gh-pages
git show HEAD:remote/scripts/archiver.js > /tmp/ghp-arch/scripts/archiver.js
git show HEAD:remote/config.json        > /tmp/ghp-arch/config.json
git -C /tmp/ghp-arch add scripts/archiver.js config.json
git -C /tmp/ghp-arch status --short      # esperar SOLO esos 2 archivos
git -C /tmp/ghp-arch commit -m "deploy: barra de progreso del archiver + bump <version>"
git -C /tmp/ghp-arch push origin gh-pages
git push origin <rama-de-trabajo>
git worktree remove /tmp/ghp-arch
```

- [ ] **Step 5: Verificar byte-exact**

Run: `tools/check-deploy.sh archiver`
Expected: el script reporta `archiver.js` y `config.json` byte-idénticos entre `main` y `gh-pages`.

- [ ] **Step 6: Piloto (validación DOM real, sesión autenticada de Omar)**

Recargar la extensión (`chrome://extensions` → reload) y correr el archiver:
- **Scan:** la barra muestra % real si SH da `totalCount`, o animada con conteo creciente.
- **Ejecución:** al confirmar en el preview, aparece de inmediato el overlay con barra que avanza `done/total` + botón Detener (antes no se veía nada).
- **Detener / resume / idempotencia:** siguen funcionando.

---

## Self-Review (hecho)

- **Cobertura del spec:** scan % real/animada (Task 4), cruce utilización animada (Task 5), ejecución % + fix overlay (Task 6), CSS barra (Task 2), `setProgress` (Task 3), funciones puras + tests (Task 1), deploy (Task 7). ✔
- **Sin placeholders:** todo paso con código/comando concreto. ✔
- **Consistencia de tipos:** `computeLoadProgress({processed,total,kept})→{fraction,text}`, `computeExecProgress({done,total,errors,gerundio})→{fraction,text}`, `setProgress(fraction,text)` — nombres y firmas coinciden entre Task 1, 3, 4, 6. Texto con `...` (tres puntos, consistente con el código existente) y `—` (em dash, ya usado en el archivo). ✔
