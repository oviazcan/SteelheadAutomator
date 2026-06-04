# Archiver — Filtro por Etiquetas + Archivar/Desarchivar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extender el applet `archiver` para archivar/desarchivar PNs filtrando por etiquetas (AND/OR), con fecha opcional y un conteo en vivo de cuántas partes se afectarán.

**Architecture:** El form de criterios se muda del `extension/background.js` al script remoto `remote/scripts/archiver.js` (nuevo entry point `openConfigAndRun()`), de modo que cambios futuros de filtros salgan solo por deploy a `gh-pages`. La lógica pura de filtrado (slim, descubrir etiquetas, match AND/OR, idempotencia) se extrae a funciones testeables vía `node --test` en sandbox `vm`. La UI corre en 3 pantallas: config → scan → filtros+conteo → preview/ejecutar.

**Tech Stack:** JavaScript vanilla (sin frameworks/bundlers), Chrome MV3 (`extension/`), GraphQL Apollo Persisted Queries vía `window.SteelheadAPI`, tests con `node:test` + `node:vm`.

---

## Contexto que el implementador DEBE leer antes de empezar

1. `docs/superpowers/specs/2026-06-03-archiver-label-filter-design.md` — el spec aprobado.
2. `remote/scripts/archiver.js` — applet actual (510 líneas). Funciones clave:
   - `fetchAllActivePNs(onProgress, pageSize)` (líneas ~81-95): pagina `AllPartNumbers`, hoy guarda el **nodo completo** y filtra `!n.archivedAt`.
   - `run(options)` (líneas ~101-256): orquesta scan → pre-filtro fecha → (utilizacion: cruce WO/REC) → `showArchiverPreview` → `executeArchive`.
   - `executeArchive(selectedPNs, opts, alreadyCompleted, results, DOMAIN)` (líneas ~264-328): `runPool` conc. 3, `UpdatePartNumber {id, archivedAt: now}`, resume en `localStorage` (`sa_archiver_resume_v1`).
   - `showArchiverPreview(...)` (líneas ~359-452): tabla con checkboxes, límite 500 filas DOM, devuelve Promise con seleccionados.
   - El IIFE es **síncrono** y solo DEFINE funciones (no toca DOM/localStorage al cargar) → se puede cargar en sandbox `vm`.
3. `extension/background.js` case `run-archiver` (líneas ~705-786): hoy arma el modal de config y llama `window.PNArchiver.run({cutoffDate, dateType, direction, enableValidation})`.
4. `tools/test/audit-incomplete-pns.test.js` — patrón de test (sandbox `vm` + stubs + lee `window.__SAAuditIncompletePNs`). **Copiar este patrón.**
5. `remote/scripts/steelhead-api.js` — `window.SteelheadAPI` expone `query(operationName, variables, hashKey)`, `getDomain()`, `log()`, `warn()`. `getDomain()` trae `validacionProcessNodeIds`.

### Estructura de un nodo de `AllPartNumbers` (verificada en `docs/api/Payload: AllPartNumbers.txt`)
```js
{
  id: 3633028,
  name: "CBLLEE9AXBABX01",
  createdAt: "2026-05-26T18:36:31.218339+00:00",
  archivedAt: null,                          // null = activo
  customerByCustomerId: { id, name },        // puede ser null
  partNumberLabelsByPartNumberId: {
    nodes: [
      { labelByLabelId: { id: 8474, name: "NP Desconocido", color: "#ffeb3b" } }
    ]
  }
  // partNumberGroupByPartNumberGroupId: null  ← vacío en estos datos (fase 2)
  // processNodeDescriptionsByPartNumberId.nodes: []  ← vacío (fase 2)
}
```

### Reglas del proyecto a respetar
- Slim responses: NO acumular nodos pesados (skill `memory-hardening-applets`).
- UI/strings en español, código/variables en inglés.
- Insertar texto de PNs con `textContent`, nunca `innerHTML` (XSS — el preview existente ya lo hace bien con DOM API).
- Match de etiquetas case-insensitive, comparar por `name` (lo que ve el usuario) pero conservar `id`.

### Checkpoints MANUALES (solo Omar — requieren sesión autenticada en app.gosteelhead.com)
Estos NO se pueden automatizar en tests; el implementador debe **pausar y pedirle a Omar** que los corra en la consola de DevTools:
- **M1:** ¿`AllPartNumbers` devuelve PNs archivados? (necesario para modo desarchivar.)
- **M2:** ¿`UpdatePartNumber {id, archivedAt:null}` desarchiva de verdad?
- **M3:** ¿La etiqueta se llama exactamente `SQ1`? (en la muestra solo aparece `SQ2`.)
Snippets exactos en Task 2 (M1) y Task 5 (M2).

---

## File Structure

- **Modify** `remote/scripts/archiver.js`:
  - Agregar bloque de **helpers puros** (`slimPN`, `discoverLabels`, `matchesLabels`, `applyFilters`, `isInTargetState`) y exponerlos en `_internals`.
  - Generalizar `fetchAllActivePNs` → `fetchPNsForMode(mode, onProgress, pageSize)` con slim + descubrimiento de etiquetas.
  - Insertar pantalla `showFilterScreen(...)` entre scan y preview.
  - Mudar el form de config: `showConfigForm()` + `openConfigAndRun()`.
  - Adaptar `executeArchive` para modo desarchivar + idempotencia + resume-by-mode.
- **Modify** `extension/background.js`: simplificar case `run-archiver` a inyectar + `openConfigAndRun()`.
- **Create** `tools/test/archiver.test.js`: tests de los helpers puros.
- **Create** `docs/applets/archiver.md`: bitácora nueva.
- **Modify** `CLAUDE.md`: alta de `archiver` en el índice de applets.
- **Modify** `remote/config.json`: bump `version` + `lastUpdated` (+ `extensionVersion`).

---

## Task 1: Helpers puros de filtrado (TDD)

**Files:**
- Modify: `remote/scripts/archiver.js` (agregar funciones dentro del IIFE + exponer `_internals`)
- Create: `tools/test/archiver.test.js`

- [ ] **Step 1: Agregar los helpers puros dentro del IIFE de `archiver.js`**

Insertar este bloque dentro del IIFE `PNArchiver`, justo después de los helpers de resume (después de `clearResume()`, ~línea 75):

```js
  // ═══════════════════════════════════════════
  // HELPERS PUROS DE FILTRADO (testeables)
  // ═══════════════════════════════════════════

  // Reduce un nodo pesado de AllPartNumbers a lo mínimo necesario (memoria).
  function slimPN(node) {
    const labels = (node.partNumberLabelsByPartNumberId?.nodes || [])
      .map(n => n.labelByLabelId)
      .filter(Boolean)
      .map(l => ({ id: l.id, name: l.name }));
    return {
      id: node.id,
      name: node.name,
      createdAt: node.createdAt || null,
      archivedAt: node.archivedAt || null,
      customer: node.customerByCustomerId?.name || '',
      labels,
    };
  }

  // Catálogo de etiquetas descubiertas con conteo, ordenado por nombre.
  // slimPNs: [{labels:[{id,name}]}] → [{name, count}]
  function discoverLabels(slimPNs) {
    const counts = new Map();
    for (const pn of slimPNs) {
      for (const l of pn.labels || []) {
        if (!l.name) continue;
        counts.set(l.name, (counts.get(l.name) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // ¿El PN cumple el filtro de etiquetas? mode: 'AND' | 'OR'.
  // selectedNames vacío => no filtra (true). Case-insensitive por name.
  function matchesLabels(pn, selectedNames, mode) {
    if (!selectedNames || selectedNames.length === 0) return true;
    const have = new Set((pn.labels || []).map(l => String(l.name || '').toUpperCase()));
    const want = selectedNames.map(s => String(s).toUpperCase());
    return mode === 'OR'
      ? want.some(w => have.has(w))
      : want.every(w => have.has(w));
  }

  // Aplica todos los filtros opcionales (intersección AND entre criterios).
  // filters: { selectedLabels:[name], labelMode:'AND'|'OR',
  //            dateFilter?: { cutoffISO, direction:'before'|'after' } }
  // Devuelve el subconjunto que pasa TODOS los filtros activos.
  function applyFilters(slimPNs, filters) {
    const { selectedLabels = [], labelMode = 'AND', dateFilter = null } = filters || {};
    return slimPNs.filter(pn => {
      if (!matchesLabels(pn, selectedLabels, labelMode)) return false;
      if (dateFilter && dateFilter.cutoffISO) {
        if (!pn.createdAt) return false;
        const d = new Date(pn.createdAt);
        const cut = new Date(dateFilter.cutoffISO);
        if (dateFilter.direction === 'after' ? !(d > cut) : !(d < cut)) return false;
      }
      return true;
    });
  }

  // Idempotencia: ¿el PN ya está en el estado destino para el modo dado?
  // mode 'archive': ya archivado. mode 'unarchive': ya activo.
  function isInTargetState(pn, mode) {
    return mode === 'unarchive' ? pn.archivedAt == null : pn.archivedAt != null;
  }
```

- [ ] **Step 2: Exponer `_internals` para tests**

Al final del archivo, reemplazar la línea de export. Buscar:

```js
if (typeof window !== 'undefined') window.PNArchiver = PNArchiver;
```

y reemplazarla por:

```js
if (typeof window !== 'undefined') {
  window.PNArchiver = PNArchiver;
  window.__SAArchiver = PNArchiver._internals;
}
```

Y en el `return` del IIFE (hoy `return { run, stop };`, ~línea 507) agregar `_internals`:

```js
  return {
    run, stop,
    _internals: { slimPN, discoverLabels, matchesLabels, applyFilters, isInTargetState },
  };
```

- [ ] **Step 3: Escribir el test que falla**

Crear `tools/test/archiver.test.js`:

```js
// tools/test/archiver.test.js
// Carga remote/scripts/archiver.js en un vm con stub window/document.
// El IIFE es síncrono y solo define funciones, así que expone window.__SAArchiver.
// Run: node --test tools/test/archiver.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'archiver.js');

function loadArchiver() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const window = {};
  const sandbox = {
    window,
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }),
                head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, Promise,
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'archiver.js' });
  if (!sandbox.window.__SAArchiver) throw new Error('__SAArchiver no exportado');
  return sandbox.window.__SAArchiver;
}

const A = loadArchiver();

const node = (over = {}) => ({
  id: 1, name: 'PN1', createdAt: '2026-01-01T00:00:00Z', archivedAt: null,
  customerByCustomerId: { id: 9, name: 'ACME' },
  partNumberLabelsByPartNumberId: { nodes: [
    { labelByLabelId: { id: 10, name: 'SQ1', color: '#fff' } },
    { labelByLabelId: { id: 11, name: 'Antitarnish', color: '#000' } },
  ] },
  ...over,
});

test('slimPN reduce el nodo a campos slim + labels', () => {
  const s = A.slimPN(node());
  assert.equal(s.id, 1);
  assert.equal(s.customer, 'ACME');
  assert.deepEqual(s.labels.map(l => l.name), ['SQ1', 'Antitarnish']);
});

test('slimPN tolera customer y labels ausentes', () => {
  const s = A.slimPN({ id: 2, name: 'X', customerByCustomerId: null, partNumberLabelsByPartNumberId: null });
  assert.equal(s.customer, '');
  assert.deepEqual(s.labels, []);
});

test('discoverLabels cuenta y ordena alfabéticamente', () => {
  const pns = [A.slimPN(node()), A.slimPN(node({ partNumberLabelsByPartNumberId: { nodes: [
    { labelByLabelId: { id: 10, name: 'SQ1' } } ] } }))];
  const cat = A.discoverLabels(pns);
  assert.deepEqual(cat, [{ name: 'Antitarnish', count: 1 }, { name: 'SQ1', count: 2 }]);
});

test('matchesLabels AND exige todas (case-insensitive)', () => {
  const pn = A.slimPN(node());
  assert.equal(A.matchesLabels(pn, ['sq1', 'antitarnish'], 'AND'), true);
  assert.equal(A.matchesLabels(pn, ['SQ1', 'SQ2'], 'AND'), false);
});

test('matchesLabels OR exige cualquiera', () => {
  const pn = A.slimPN(node());
  assert.equal(A.matchesLabels(pn, ['SQ2', 'Antitarnish'], 'OR'), true);
  assert.equal(A.matchesLabels(pn, ['SQ2', 'SQ3'], 'OR'), false);
});

test('matchesLabels sin selección no filtra', () => {
  assert.equal(A.matchesLabels(A.slimPN(node()), [], 'AND'), true);
});

test('applyFilters intersecta etiquetas + fecha', () => {
  const a = A.slimPN(node({ id: 1, createdAt: '2025-01-01T00:00:00Z' }));
  const b = A.slimPN(node({ id: 2, createdAt: '2026-06-01T00:00:00Z' }));
  const out = A.applyFilters([a, b], {
    selectedLabels: ['SQ1', 'Antitarnish'], labelMode: 'AND',
    dateFilter: { cutoffISO: '2026-01-01T00:00:00Z', direction: 'before' },
  });
  assert.deepEqual(out.map(p => p.id), [1]);
});

test('isInTargetState idempotencia por modo', () => {
  const active = A.slimPN(node({ archivedAt: null }));
  const arch = A.slimPN(node({ archivedAt: '2026-01-01T00:00:00Z' }));
  assert.equal(A.isInTargetState(active, 'archive'), false);
  assert.equal(A.isInTargetState(arch, 'archive'), true);
  assert.equal(A.isInTargetState(active, 'unarchive'), true);
  assert.equal(A.isInTargetState(arch, 'unarchive'), false);
});
```

- [ ] **Step 4: Correr el test y verificar que falla (antes del Step 1/2 aplicados) o pasa (si ya aplicaste)**

Run: `node --test tools/test/archiver.test.js`
Expected: si aplicaste Steps 1-2, **PASS** (8 tests). Si querés ver el rojo primero, comenta el bloque `_internals` y corre: FAIL con `__SAArchiver no exportado`.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/archiver.js tools/test/archiver.test.js
git commit -m "feat(archiver): helpers puros de filtrado por etiquetas + tests"
```

---

## Task 2: Scan slim + mode-aware fetch + descubrimiento de etiquetas

**Files:**
- Modify: `remote/scripts/archiver.js` (`fetchAllActivePNs` → `fetchPNsForMode`)

- [ ] **Step 1: CHECKPOINT MANUAL M1 — pedir a Omar que verifique archivados**

Pausar y pedirle a Omar que corra esto en la consola de DevTools de app.gosteelhead.com (logueado) y reporte el resultado:

```js
(async () => {
  const r = await window.SteelheadAPI.query('AllPartNumbers',
    { orderBy: ['ID_DESC'], offset: 0, first: 500, searchQuery: '' }, 'AllPartNumbers');
  const nodes = r?.pagedData?.nodes || [];
  const archived = nodes.filter(n => n.archivedAt);
  console.log(`total ${nodes.length}, archivados en la página: ${archived.length}`);
})();
```

- Si `archivados > 0` → `AllPartNumbers` SÍ devuelve archivados; el modo desarchivar funciona con la misma query (filtrando `n.archivedAt != null`). Continuar.
- Si `archivados == 0` → es probable que la query solo regrese activos. **Detenerse y replanear** el modo desarchivar (investigar variable `includeArchived` o query alterna). Para no bloquear el resto, se puede implementar fase 1 **solo modo archivar** y dejar desarchivar pendiente. Documentarlo.

- [ ] **Step 2: Reemplazar `fetchAllActivePNs` por `fetchPNsForMode`**

Buscar la función `fetchAllActivePNs` (líneas ~81-95) y reemplazarla completa por:

```js
  // Pagina AllPartNumbers en SLIM. mode 'archive' → conserva activos;
  // 'unarchive' → conserva archivados. Acumula catálogo de etiquetas (Map).
  async function fetchPNsForMode(mode, onProgress, pageSize = 500) {
    const slimPNs = [];
    let offset = 0;
    while (!stopped) {
      const data = await api().query('AllPartNumbers', {
        orderBy: ['ID_ASC'], offset, first: pageSize, searchQuery: ''
      }, 'AllPartNumbers');
      const nodes = data?.pagedData?.nodes || [];
      for (const n of nodes) {
        const isArchived = !!n.archivedAt;
        const keep = mode === 'unarchive' ? isArchived : !isArchived;
        if (keep) slimPNs.push(slimPN(n));   // SLIM: no guardar nodo pesado
      }
      if (onProgress) onProgress(`Cargando PNs... ${slimPNs.length}`);
      if (nodes.length < pageSize) break;
      offset += pageSize;
    }
    return slimPNs;
  }
```

- [ ] **Step 3: Verificar que el resto del archivo no rompe por el rename**

Run: `grep -n "fetchAllActivePNs" remote/scripts/archiver.js`
Expected: 0 resultados (ya no se referencia; `run()` se reescribe en Task 3).

- [ ] **Step 4: Re-correr tests (no deben romperse)**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS (8 tests) — los helpers no cambiaron.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): scan slim + fetch por modo (archive/unarchive)"
```

---

## Task 3: Pantalla de filtros con conteo en vivo + reescribir `run()`

**Files:**
- Modify: `remote/scripts/archiver.js` (`run()` y nueva `showFilterScreen()`)

- [ ] **Step 1: Agregar `showFilterScreen()` dentro del IIFE (antes de `showArchiverPreview`)**

```js
  // Pantalla de filtros: multiselect de etiquetas descubiertas + AND/OR + conteo en vivo.
  // slimPNs: lista ya filtrada por fecha (si aplicaba). Devuelve Promise<{selected:[slimPN]} | null>.
  function showFilterScreen(slimPNs, mode, labelCatalog) {
    const verbo = mode === 'unarchive' ? 'desarchivarán' : 'archivarán';
    return new Promise(resolve => {
      removeArchiverUI();
      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';
      md.innerHTML = `
        <h2 style="color:#4ade80">📦 Filtrar por etiquetas</h2>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:8px">
          ${slimPNs.length} PNs en el conjunto base. Elegí etiquetas para acotar (opcional).
        </p>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
          <label style="font-size:12px;color:#e2e8f0">Modo:</label>
          <label style="font-size:12px;color:#e2e8f0"><input type="radio" name="sa-lblmode" value="AND" checked> Todas (AND)</label>
          <label style="font-size:12px;color:#e2e8f0"><input type="radio" name="sa-lblmode" value="OR"> Cualquiera (OR)</label>
        </div>
        <div id="sa-lbl-list" style="max-height:240px;overflow-y:auto;background:#0f172a;border-radius:6px;padding:8px;margin-bottom:12px"></div>
        <div style="font-size:15px;color:#4ade80;margin-bottom:12px">
          <b id="sa-lbl-count">${slimPNs.length}</b> partes se ${verbo}
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-lbl-cancel">CANCELAR</button>
          <button class="dl9-btn" id="sa-lbl-next" style="background:#4ade80;color:#0f172a">CONTINUAR</button>
        </div>`;
      ov.appendChild(md);
      document.body.appendChild(ov);

      // Lista de etiquetas con checkbox (textContent — XSS-safe)
      const listEl = md.querySelector('#sa-lbl-list');
      labelCatalog.forEach((l, i) => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;color:#e2e8f0;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.className = 'sa-lbl-cb'; cb.dataset.name = l.name;
        const txt = document.createElement('span');
        txt.textContent = `${l.name} (${l.count})`;
        row.append(cb, txt);
        listEl.appendChild(row);
      });

      const getSelected = () => [...md.querySelectorAll('.sa-lbl-cb:checked')].map(cb => cb.dataset.name);
      const getMode = () => md.querySelector('input[name="sa-lblmode"]:checked').value;
      const recount = () => {
        const filtered = applyFilters(slimPNs, { selectedLabels: getSelected(), labelMode: getMode() });
        md.querySelector('#sa-lbl-count').textContent = filtered.length;
        return filtered;
      };
      md.querySelectorAll('.sa-lbl-cb').forEach(cb => cb.onchange = recount);
      md.querySelectorAll('input[name="sa-lblmode"]').forEach(r => r.onchange = recount);

      md.querySelector('#sa-lbl-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      md.querySelector('#sa-lbl-next').onclick = () => {
        const filtered = recount();
        ov.parentNode.removeChild(ov);
        resolve({ selected: filtered });
      };
    });
  }
```

- [ ] **Step 2: Reescribir `run()` para el nuevo flujo (slim + filtros + modo)**

Reemplazar la función `run(options)` (líneas ~101-256) por esta versión. Mantiene el resume al inicio y el cruce de "utilizacion", pero opera sobre slimPNs e inserta `showFilterScreen`:

```js
  async function run(options) {
    stopped = false;
    const {
      mode = 'archive',
      useDate = false, cutoffDate = null, dateType = 'creacion', direction = 'before',
      enableValidation = false,
    } = options;
    const DOMAIN = api().getDomain();
    const results = { found: 0, archived: 0, validated: 0, errors: [] };

    // ── Resume previo (solo si coincide el modo) ──
    const prevResume = loadResume();
    if (prevResume?.selectedPNs?.length && prevResume.opts?.mode === mode) {
      const pending = prevResume.selectedPNs.filter(p => !prevResume.completed.includes(p.id));
      const resume = confirm(
        `Hay un ${mode === 'unarchive' ? 'desarchivado' : 'archivado'} previo pendiente:\n` +
        `  ${prevResume.completed.length} ya hechos\n  ${pending.length} pendientes\n\n` +
        `¿Reanudar? (Cancelar = empezar de cero)`
      );
      if (resume) {
        showArchiverUI(`Reanudando: ${pending.length} pendientes...`);
        return await executeArchive(prevResume.selectedPNs, prevResume.opts, prevResume.completed, results, DOMAIN);
      }
      clearResume();
    }

    const verbo = mode === 'unarchive' ? 'Desarchivando' : 'Archivando';
    log(`Archivador: modo=${mode}, useDate=${useDate}${useDate ? ` (${dateType} ${direction} ${cutoffDate})` : ''}, validación=${enableValidation}`);
    showArchiverUI(`Buscando números de parte (${mode === 'unarchive' ? 'archivados' : 'activos'})...`);

    // 1. Scan slim por modo
    let slimPNs = await fetchPNsForMode(mode, (msg) => updateArchiverUI(msg), 500);
    if (stopped) return { ...results, stopped: true };
    log(`  ${slimPNs.length} PNs ${mode === 'unarchive' ? 'archivados' : 'activos'}`);

    // 2. Pre-filtro por fecha (opcional)
    const dateFilter = useDate && cutoffDate
      ? { cutoffISO: new Date(cutoffDate).toISOString(), direction }
      : null;
    if (dateFilter) {
      slimPNs = applyFilters(slimPNs, { dateFilter });
      log(`  ${slimPNs.length} tras filtro de fecha`);
    }

    // 3. Cruce de utilización (solo modo archive + dateType utilizacion)
    if (mode === 'archive' && useDate && dateType === 'utilizacion') {
      slimPNs = await filterByUnused(slimPNs, DOMAIN);
      if (stopped) return { ...results, stopped: true };
    }

    if (!slimPNs.length) { showArchiverResult(results, 'No hay PNs que cumplan los criterios base.'); return results; }

    // 4. Pantalla de filtros por etiqueta + conteo en vivo
    const labelCatalog = discoverLabels(slimPNs);
    const picked = await showFilterScreen(slimPNs, mode, labelCatalog);
    if (!picked) { log('Cancelado.'); return { cancelled: true }; }

    // 5. Construir lista para preview (slimPN ya trae name/customer/createdAt)
    const reasonBase = mode === 'unarchive' ? 'Desarchivar' : 'Archivar';
    const toArchive = picked.selected.map(p => ({
      id: p.id, name: p.name, createdAt: p.createdAt, customer: p.customer,
      reason: reasonBase, selected: true,
    }));
    results.found = toArchive.length;
    if (!toArchive.length) { showArchiverResult(results, 'Ningún PN tras el filtro de etiquetas.'); return results; }

    const selectedPNs = await showArchiverPreview(toArchive, mode);
    if (!selectedPNs) { log('Cancelado.'); return { cancelled: true }; }

    const opts = { mode, useDate, cutoffDate, dateType, direction, enableValidation };
    return await executeArchive(selectedPNs, opts, [], results, DOMAIN);
  }
```

- [ ] **Step 3: Extraer el cruce de utilización a `filterByUnused()`**

El bloque de "utilizacion" (WO + REC) que estaba inline en el `run()` viejo (líneas ~147-233) se mueve a una función que recibe slimPNs y devuelve los sin uso. Agregar dentro del IIFE:

```js
  // Cruza candidatos vs PNs con OT/recibos; devuelve los SIN uso. mode archive only.
  async function filterByUnused(candidates, DOMAIN) {
    updateArchiverUI(`Cargando órdenes de trabajo...`);
    const usedPNIds = new Set();
    let woOffset = 0;
    while (!stopped) {
      try {
        const woData = await withRetry(() => api().query('AllWorkOrders', {
          status: null, includeArchived: 'YES', couponWorkOrders: null, computeMargins: false,
          orderBy: ['ID_DESC'], offset: woOffset, first: 500, searchQuery: ''
        }, 'AllWorkOrders'), `AllWorkOrders ${woOffset}`);
        const woNodes = woData?.pagedData?.nodes || [];
        if (!woNodes.length) break;
        for (const wo of woNodes) for (const pnWO of (wo.partNumberWorkOrdersByWorkOrderId?.nodes || [])) {
          const pnId = pnWO.partNumberId || pnWO.partNumberByPartNumberId?.id;
          if (pnId) usedPNIds.add(pnId);
        }
        updateArchiverUI(`OTs: página ${Math.floor(woOffset / 500) + 1}, ${usedPNIds.size} PNs con OT`);
        if (woNodes.length < 500) break;
        woOffset += 500;
      } catch (e) { warn(`AllWorkOrders ${woOffset}: ${String(e).substring(0, 60)}`); break; }
    }
    if (stopped) return candidates;

    updateArchiverUI(`Cargando recibos...`);
    let recOffset = 0;
    while (!stopped) {
      try {
        const recData = await withRetry(() => api().query('AllReceivers', {
          orderBy: ['CREATED_AT_DESC'], offset: recOffset, first: 500, searchQuery: ''
        }, 'AllReceivers'), `AllReceivers ${recOffset}`);
        const recNodes = recData?.pagedData?.nodes || [];
        if (!recNodes.length) break;
        for (const rec of recNodes) for (const item of (rec.receiverBomItemsByReceiverId?.nodes || [])) {
          const pnId = item.partNumberId || item.partNumberByPartNumberId?.id;
          if (pnId) usedPNIds.add(pnId);
        }
        updateArchiverUI(`Recibos: página ${Math.floor(recOffset / 500) + 1}, ${usedPNIds.size} PNs con actividad`);
        if (recNodes.length < 500) break;
        recOffset += 500;
      } catch (e) { warn(`AllReceivers ${recOffset}: ${String(e).substring(0, 60)}`); break; }
    }
    log(`  ${usedPNIds.size} PNs con OT/recibos`);
    return candidates.filter(pn => !usedPNIds.has(pn.id));
  }
```

- [ ] **Step 4: Actualizar la firma de `showArchiverPreview` para recibir `mode`**

Cambiar la firma `function showArchiverPreview(pns, cutoffDate, dateType, direction, enableValidation)` a `function showArchiverPreview(pns, mode)`. Dentro, reemplazar el `<h2>` y el `<p>` de contexto por algo simple basado en `mode`:

```js
      const accion = mode === 'unarchive' ? 'Desarchivar' : 'Archivar';
      md.innerHTML = `
        <h2 style="color:#4ade80">📦 ${accion} — Preview</h2>
        <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">${pns.length} PNs seleccionados.</p>
        ${trimmed ? `<p style="color:#fbbf24;font-size:12px;margin-bottom:8px">⚠ Mostrando primeros ${MAX_ROWS} de ${pns.length}. Todos se procesan al confirmar.</p>` : ''}
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <input type="checkbox" checked id="sa-arch-selectall">
          <label for="sa-arch-selectall" style="font-size:12px;color:#94a3b8">Seleccionar todos los visibles</label>
          <span style="font-size:12px;color:#4ade80;margin-left:auto" id="sa-arch-count">${pns.length} seleccionados</span>
        </div>
        <div style="max-height:300px;overflow-y:auto">
          <table id="sa-arch-tbl" style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="color:#94a3b8;border-bottom:1px solid #334155"><th style="text-align:left;padding:4px"><input type="checkbox" checked id="sa-arch-th-check"></th><th style="text-align:left;padding:4px">PN</th><th style="text-align:left;padding:4px">Cliente</th><th style="text-align:left;padding:4px">Creado</th><th style="text-align:left;padding:4px">Acción</th></tr></thead>
            <tbody id="sa-arch-tbody"></tbody>
          </table>
        </div>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-arch-cancel">CANCELAR</button>
          <button class="dl9-btn dl9-btn-exec" id="sa-arch-exec">${accion.toUpperCase()} (<span id="sa-arch-exec-count">${pns.length}</span>)</button>
        </div>`;
```

(El resto de `showArchiverPreview` — construcción de filas con DOM API, `updateCount`, handlers — queda igual.)

- [ ] **Step 5: Re-correr tests + lint visual del archivo**

Run: `node --test tools/test/archiver.test.js`
Expected: PASS (8 tests).
Run: `node -e "require('fs').readFileSync('remote/scripts/archiver.js','utf8'); new Function(require('fs').readFileSync('remote/scripts/archiver.js','utf8')); console.log('sintaxis OK')"`
Expected: `sintaxis OK` (no SyntaxError).

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): pantalla de filtros con conteo en vivo + run() por modo"
```

---

## Task 4: Form de config en el remoto (`showConfigForm` + `openConfigAndRun`)

**Files:**
- Modify: `remote/scripts/archiver.js`

- [ ] **Step 1: Agregar `showConfigForm()` dentro del IIFE**

```js
  // Modal de configuración (mudado desde extension/background.js). Devuelve
  // Promise<options | null>. options: {mode, useDate, cutoffDate, dateType, direction, enableValidation}
  function showConfigForm() {
    return new Promise(resolve => {
      ensureStyles();
      const ov = document.createElement('div');
      ov.className = 'dl9-overlay';
      const md = document.createElement('div');
      md.className = 'dl9-modal';
      md.style.background = '#1a2e1a';
      md.innerHTML = `
        <h2 style="color:#4ade80">📦 Archivador Masivo de PNs</h2>
        <div style="margin-bottom:14px;display:flex;gap:8px">
          <label style="flex:1;font-size:13px;color:#e2e8f0"><input type="radio" name="sa-mode" value="archive" checked> Archivar</label>
          <label style="flex:1;font-size:13px;color:#e2e8f0"><input type="radio" name="sa-mode" value="unarchive"> Desarchivar</label>
        </div>
        <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="sa-arch-usedate">
          <label for="sa-arch-usedate" style="font-size:13px;color:#e2e8f0">Usar fecha de corte</label>
        </div>
        <div id="sa-arch-datebox" style="display:none">
          <div style="margin-bottom:12px">
            <input type="date" id="sa-arch-date" style="width:100%;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px" value="${new Date().toLocaleDateString('en-CA')}">
          </div>
          <div style="margin-bottom:12px;display:flex;gap:8px">
            <select id="sa-arch-direction" style="flex:1;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
              <option value="before" selected>Antes de la fecha</option>
              <option value="after">Después de la fecha</option>
            </select>
            <select id="sa-arch-type" style="flex:1;padding:8px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px">
              <option value="utilizacion" selected>Última utilización</option>
              <option value="creacion">Fecha de creación</option>
              <option value="modificacion">Fecha de modificación</option>
            </select>
          </div>
        </div>
        <div id="sa-arch-valbox" style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="sa-arch-validation">
          <label for="sa-arch-validation" style="font-size:13px;color:#e2e8f0">Activar validación de ingeniería (solo archivar)</label>
        </div>
        <p style="font-size:11px;color:#64748b;margin-bottom:8px">Tras buscar, podrás filtrar por etiquetas y ver el conteo antes de confirmar.</p>
        <div class="dl9-btnrow">
          <button class="dl9-btn dl9-btn-cancel" id="sa-arch-form-cancel">CANCELAR</button>
          <button class="dl9-btn" id="sa-arch-form-exec" style="background:#4ade80;color:#0f172a">BUSCAR PNs</button>
        </div>`;
      ov.appendChild(md);
      document.body.appendChild(ov);

      const useDateCb = md.querySelector('#sa-arch-usedate');
      const dateBox = md.querySelector('#sa-arch-datebox');
      useDateCb.onchange = () => { dateBox.style.display = useDateCb.checked ? 'block' : 'none'; };
      const valBox = md.querySelector('#sa-arch-valbox');
      md.querySelectorAll('input[name="sa-mode"]').forEach(r => r.onchange = () => {
        valBox.style.display = md.querySelector('input[name="sa-mode"]:checked').value === 'archive' ? 'flex' : 'none';
      });

      md.querySelector('#sa-arch-form-cancel').onclick = () => { ov.parentNode.removeChild(ov); resolve(null); };
      md.querySelector('#sa-arch-form-exec').onclick = () => {
        const opts = {
          mode: md.querySelector('input[name="sa-mode"]:checked').value,
          useDate: useDateCb.checked,
          cutoffDate: md.querySelector('#sa-arch-date').value,
          dateType: md.querySelector('#sa-arch-type').value,
          direction: md.querySelector('#sa-arch-direction').value,
          enableValidation: md.querySelector('#sa-arch-validation').checked,
        };
        ov.parentNode.removeChild(ov);
        resolve(opts);
      };
    });
  }

  // Entry point único llamado desde la extensión.
  async function openConfigAndRun() {
    const opts = await showConfigForm();
    if (!opts) return { cancelled: true };
    try { return await run(opts); }
    catch (e) { return { error: e.message }; }
  }
```

- [ ] **Step 2: Agregar `ensureStyles()` (helper para inyectar `dl9-styles` una vez)**

El CSS `dl9-styles` hoy se inyecta inline en varios lugares (background.js, showArchiverPreview, showArchiverResult). Centralizarlo dentro del IIFE:

```js
  function ensureStyles() {
    if (document.getElementById('dl9-styles')) return;
    const s = document.createElement('style'); s.id = 'dl9-styles';
    s.textContent = `.dl9-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl9-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl9-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl9-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl9-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.dl9-btn-cancel{background:#475569;color:#e2e8f0}.dl9-btn-exec{background:#ef4444;color:white}`;
    document.head.appendChild(s);
  }
```

Reemplazar los bloques `if (!document.getElementById('dl9-styles')) { ... }` existentes en `showArchiverPreview` y `showArchiverResult` por una sola llamada `ensureStyles();`. En `showFilterScreen` (Task 3) agregar también `ensureStyles();` al inicio (antes de crear el overlay).

- [ ] **Step 3: Exponer `openConfigAndRun` en el return del IIFE**

Actualizar el `return` (Task 1 Step 2) a:

```js
  return {
    run, stop, openConfigAndRun,
    _internals: { slimPN, discoverLabels, matchesLabels, applyFilters, isInTargetState },
  };
```

- [ ] **Step 4: Verificar sintaxis + tests**

Run: `node -e "new Function(require('fs').readFileSync('remote/scripts/archiver.js','utf8')); console.log('OK')"`
Expected: `OK`.
Run: `node --test tools/test/archiver.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): form de config en remoto + openConfigAndRun (mode + fecha opcional)"
```

---

## Task 5: `executeArchive` con modo desarchivar + idempotencia + resume-by-mode

**Files:**
- Modify: `remote/scripts/archiver.js` (`executeArchive`)

- [ ] **Step 1: CHECKPOINT MANUAL M2 — pedir a Omar que verifique unarchive (solo si M1 confirmó archivados)**

Pedirle a Omar que tome un PN archivado de prueba y corra:

```js
(async () => {
  const id = /* pega aquí el id de un PN archivado de prueba */ 0;
  await window.SteelheadAPI.query('UpdatePartNumber', { id, archivedAt: null });
  const r = await window.SteelheadAPI.query('GetPartNumber', { partNumberId: id });
  console.log('archivedAt tras unarchive:', r?.partNumberById?.archivedAt);  // esperado: null
})();
```

- Si `archivedAt: null` → unarchive funciona vía `UpdatePartNumber`. Continuar.
- Si no → investigar mutación de unarchive correcta antes de exponer el modo desarchivar.

- [ ] **Step 2: Reescribir el cuerpo de `executeArchive` para soportar `mode`**

En `executeArchive`, el `opts` ahora trae `mode`. Cambiar: (a) la llave de resume para incluir el modo, (b) skip idempotente según `isInTargetState`, (c) el `archivedAt` destino. Reemplazar el worker dentro de `runPool`:

```js
    const targetArchivedAt = opts.mode === 'unarchive' ? null : null; // se setea por item abajo
    await runPool(selectedPNs, async (pn) => {
      if (stopped) return;
      if (completed.has(pn.id)) return;

      const newArchivedAt = opts.mode === 'unarchive' ? null : new Date().toISOString();
      try {
        await withRetry(() => api().query('UpdatePartNumber', { id: pn.id, archivedAt: newArchivedAt }),
          `${opts.mode === 'unarchive' ? 'Unarchive' : 'Archive'} ${pn.name}`);
        results.archived++;
      } catch (e) {
        results.errors.push(`${opts.mode === 'unarchive' ? 'Desarchivar' : 'Archivar'} "${pn.name}": ${String(e?.message || e).substring(0, 80)}`);
        return;
      }

      // Validación de ingeniería: solo en modo archivar
      if (opts.enableValidation && opts.mode === 'archive') {
        try {
          const nodeIds = DOMAIN.validacionProcessNodeIds || [];
          const optInOuts = nodeIds.map(id => ({ processNodeId: id, processNodeOccurrence: 1, cancelOthers: false }));
          await withRetry(() => api().query('SavePartNumber', { input: [{
            id: pn.id, name: pn.name, optInOuts,
            specsToApply: [], paramsToApply: [], partNumberDimensions: [], partNumberLocations: [],
            dimensionCustomValueIds: [], partNumberSpecsToArchive: [], partNumberSpecsToUnarchive: [],
            partNumberSpecFieldParamsToArchive: [], partNumberSpecFieldParamsToUnarchive: [],
            partNumberSpecClassificationsToUpdate: [], partNumberSpecFieldParamUpdates: [],
            specFieldParamUpdates: [], labelIds: [], ownerIds: [], defaults: [],
            inventoryPredictedUsages: []
          }] }), `Validation ${pn.name}`);
          results.validated++;
        } catch (e) { warn(`Validación "${pn.name}": ${String(e).substring(0, 80)}`); }
      }

      completed.add(pn.id);
      if (completed.size % 5 === 0 || completed.size === totalCount) {
        updateArchiverUI(`${opts.mode === 'unarchive' ? 'Desarchivando' : 'Archivando'} ${completed.size}/${totalCount} — ${results.errors.length} errores`);
        saveResume({ selectedPNs, opts, completed: [...completed] });
      }
    }, 3);
```

(El bloque `targetArchivedAt` de la primera línea es redundante — eliminarlo; `newArchivedAt` se calcula por item.)

- [ ] **Step 3: Verificar sintaxis + tests**

Run: `node -e "new Function(require('fs').readFileSync('remote/scripts/archiver.js','utf8')); console.log('OK')"`
Expected: `OK`.
Run: `node --test tools/test/archiver.test.js`
Expected: PASS (8 tests).

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/archiver.js
git commit -m "feat(archiver): executeArchive con modo desarchivar + resume-by-mode"
```

---

## Task 6: Simplificar el trigger en `extension/background.js`

**Files:**
- Modify: `extension/background.js` (case `run-archiver`, líneas ~705-786)

- [ ] **Step 1: Reemplazar el case `run-archiver` completo**

Reemplazar todo el bloque `case 'run-archiver': { ... }` por:

```js
    // ── Archiver ──
    case 'run-archiver': {
      const tab = await getSteelheadTab();
      await injectAppScripts(tab.id, 'archiver');

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: async () => {
          if (!window.PNArchiver?.openConfigAndRun) return { error: 'PNArchiver no disponible' };
          try { return await window.PNArchiver.openConfigAndRun(); }
          catch (e) { return { error: e.message }; }
        }
      });

      return results?.[0]?.result || { error: 'Sin resultado' };
    }
```

- [ ] **Step 2: Verificar que `injectAppScripts(..., 'archiver')` y el array `scripts` de config siguen correctos**

Run: `grep -n '"id": "archiver"' -A 8 remote/config.json`
Expected: ver `"scripts": ["scripts/steelhead-api.js", "scripts/archiver.js"]` — confirma que se inyecta `steelhead-api.js` antes (necesario para `window.SteelheadAPI`).

- [ ] **Step 3: Verificar sintaxis de background.js**

Run: `node --check extension/background.js`
Expected: sin salida (sintaxis OK).

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "refactor(extension): run-archiver delega el form a PNArchiver.openConfigAndRun"
```

---

## Task 7: Bitácora + índice en CLAUDE.md

**Files:**
- Create: `docs/applets/archiver.md`
- Modify: `CLAUDE.md` (tabla de índice de applets)

- [ ] **Step 1: Crear `docs/applets/archiver.md`**

```markdown
# Applet: `archiver` (Archivador Masivo de PNs)

## Qué hace
Archiva/desarchiva números de parte en bloque por criterios combinables (intersección AND):
- **Fecha** (opcional): creación / modificación / última utilización, antes/después de un corte.
- **Etiquetas** (fase 1): multi-selección con modo AND (todas) / OR (cualquiera).
- **Modo**: archivar (`archivedAt=now`) o desarchivar (`archivedAt=null`).

Flujo: config → scan slim → pantalla de filtros con **conteo en vivo** → preview/tabla → ejecutar.
`runPool` concurrencia 3, resume en `localStorage` (por modo), idempotente.

## Versión actual
1.0.0 (filtro por etiquetas + archivar/desarchivar + fecha opcional + form en remoto).

## Arquitectura
- Form + filtros + preview viven en `remote/scripts/archiver.js` (`openConfigAndRun`).
- `extension/background.js` case `run-archiver` solo inyecta y llama `openConfigAndRun()`.
- Helpers puros testeados en `tools/test/archiver.test.js`.

## Datos
- `AllPartNumbers` trae etiquetas en `partNumberLabelsByPartNumberId.nodes[].labelByLabelId.{id,name}`.
- Grupo (`partNumberGroupByPartNumberGroupId`) y proceso (`processNodeDescriptions`) vienen **vacíos** en el listado → fase 2.

## Plan de validación (pendiente en prod)
- [ ] M1: confirmar que `AllPartNumbers` devuelve archivados (modo desarchivar).
- [ ] M2: confirmar que `UpdatePartNumber {archivedAt:null}` desarchiva.
- [ ] M3: confirmar nombre exacto de la etiqueta `SQ1`.
- [ ] Piloto: archivar PNs con SQ1 + Antitarnish (AND) en un subconjunto chico.

## Fase 2 (pendiente)
- Filtro por grupo de partes, línea y departamento (dimensiones contables personalizables; cada PN tiene ambas), y proceso. Requieren investigar la fuente del dato (probablemente `GetPartNumber` por PN).

## Spec / plan
- Spec: `docs/superpowers/specs/2026-06-03-archiver-label-filter-design.md`
- Plan: `docs/superpowers/plans/2026-06-03-archiver-label-filter.md`
```

- [ ] **Step 2: Agregar la fila al índice de applets en `CLAUDE.md`**

En la tabla `## Índice de applets`, agregar (después de la fila `create-order-autofill`):

```markdown
| `archiver` (Archivador Masivo) | 1.0.0 (filtro por etiquetas AND/OR + archivar/desarchivar + fecha opcional + form en remoto; fase 2 pendiente: grupo/línea/departamento/proceso) | [`docs/applets/archiver.md`](docs/applets/archiver.md) |
```

- [ ] **Step 3: Commit**

```bash
git add docs/applets/archiver.md CLAUDE.md
git commit -m "docs(archiver): bitácora nueva + alta en índice de applets"
```

---

## Task 8: Deploy a gh-pages + bump config + republicar extensión

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Bump `version`, `lastUpdated` y `extensionVersion`**

En `remote/config.json`: `version` `1.6.29` → `1.6.30`, `lastUpdated` → `2026-06-03T...` (hora actual), `extensionVersion` `1.6.2` → `1.6.3` (cambió `extension/background.js`).

- [ ] **Step 2: Commit en main**

```bash
git add remote/config.json
git commit -m "chore(config): bump 1.6.30 — archiver filtro por etiquetas + archive/unarchive"
```

- [ ] **Step 3: Sync a gh-pages (byte-exact)**

```bash
git stash push -- '*.xlsm' 2>/dev/null; git checkout gh-pages
git show main:remote/scripts/archiver.js > scripts/archiver.js
git show main:remote/config.json > config.json
git add scripts/archiver.js config.json
git commit -m "deploy: archiver filtro por etiquetas + archive/unarchive + bump 1.6.30"
git checkout main; git stash pop 2>/dev/null || true
```

- [ ] **Step 4: Push ambas ramas**

```bash
git push origin main && git push origin gh-pages
```

- [ ] **Step 5: Verificar byte-exact**

Run: `tools/check-deploy.sh archiver`
Expected: OK / sin diff entre `main:remote/scripts/archiver.js` y `gh-pages:scripts/archiver.js`.

- [ ] **Step 6: Republicar la extensión (manual — Omar)**

Empaquetar `extension/` y subir el `.zip` (Chrome Web Store unlisted) o recargar la extensión local. Necesario por el cambio en `background.js`. Tras recargar: reload de la extensión en `chrome://extensions`.

- [ ] **Step 7: Piloto en prod (manual — Omar)**

Correr el applet, modo Archivar, sin fecha, elegir `SQ1` + `Antitarnish` en AND, verificar que el conteo en vivo coincide y archivar un subconjunto chico de prueba.

---

## Self-Review (hecho al escribir el plan)

**1. Spec coverage:**
- Filtro por etiquetas AND/OR → Task 1 (lógica) + Task 3 (UI). ✓
- Fecha opcional + intersección AND → Task 1 `applyFilters` + Task 3 `run()` + Task 4 form. ✓
- Modo archivar/desarchivar → Task 2 (scan), Task 5 (execute), Task 4 (form). ✓
- Conteo en vivo → Task 3 `showFilterScreen`. ✓
- Form en remoto (Opción A) → Task 4 + Task 6. ✓
- Slim/memoria → Task 2 `slimPN` + `fetchPNsForMode`. ✓
- Bitácora + índice → Task 7. ✓
- Deploy + republicar extensión → Task 8. ✓
- Fase 2 documentada (grupo/línea/departamento/proceso) → Task 7 bitácora. ✓

**2. Placeholder scan:** sin TBD/TODO en código. Los "pega aquí el id" de M2 son inputs manuales explícitos del checkpoint, no placeholders de código. ✓

**3. Type consistency:** `slimPN` produce `{id,name,createdAt,archivedAt,customer,labels:[{id,name}]}` usado consistentemente en `discoverLabels`, `matchesLabels`, `applyFilters`, `run()`, `showFilterScreen`. `opts.mode` ('archive'|'unarchive') consistente en `run`/`executeArchive`/`fetchPNsForMode`/`showArchiverPreview`. `openConfigAndRun` expuesto en return y llamado en background.js. ✓

**Riesgos abiertos (gating, no bloqueantes del plan):** M1 (archivados en AllPartNumbers) puede forzar a entregar fase 1 solo-archivar si falla; M2/M3 son confirmaciones de prod. Marcados como checkpoints manuales.
