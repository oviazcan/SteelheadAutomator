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

// Carga el archiver con un window.SteelheadAPI inyectado, para tests de
// fetchPNsForMode (que sí pega a la API). Sandbox fresco por test → `stopped`
// arranca en false sin contaminar otros tests.
function loadArchiverWithApi(mockApi) {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const window = { SteelheadAPI: mockApi };
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
  const internals = sandbox.window.__SAArchiver;
  internals._win = sandbox.window;  // acceso a PNArchiver.stop() para el guard de `stopped`
  return internals;
}

// Mock fiel al server real de AllPartNumbers:
//  - includeArchived:'YES' → activos + archivados
//  - includeArchived:'NO' (o ausente) → SOLO activos
//  - NINGÚN nodo trae `archivedAt` en el selection set (confirmado contra el
//    payload real: el campo no existe a nivel de nodo PN).
// `calls` registra cada query para aseverar que se hacen ambas pasadas.
function makeAllPNsApi(active, archived) {
  const calls = [];
  const api = {
    query(op, vars) {
      if (op !== 'AllPartNumbers') return Promise.resolve({});
      calls.push({ includeArchived: vars.includeArchived, offset: vars.offset || 0 });
      const pool = vars.includeArchived === 'YES' ? active.concat(archived) : active;
      const first = vars.first, offset = vars.offset || 0;
      const nodes = pool.slice(offset, offset + first);
      return Promise.resolve({ pagedData: { nodes, totalCount: pool.length } });
    },
    log() {}, warn() {},
  };
  return { api, calls };
}

// Nodo PN tal cual lo entrega el server: SIN `archivedAt` (no está en el
// selection set). Solo los campos que el slim consume.
const rawNode = (id, name, labels = []) => ({
  id, name, createdAt: '2026-01-01T00:00:00Z',
  customerByCustomerId: { id: 9, name: 'ACME' },
  partNumberLabelsByPartNumberId: { nodes: labels.map((n, i) => ({ labelByLabelId: { id: 100 + i, name: n } })) },
});

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

test('applyFilters excluye PNs sin createdAt cuando dateFilter está activo', () => {
  const a = A.slimPN(node({ id: 1, createdAt: null }));
  const out = A.applyFilters([a], {
    selectedLabels: [], labelMode: 'AND',
    dateFilter: { cutoffISO: '2026-01-01T00:00:00Z', direction: 'before' },
  });
  assert.deepEqual(out, []);
});

test('applyFilters: fecha exactamente en el corte se excluye (límite estricto)', () => {
  const onCutoff = A.slimPN(node({ id: 3, createdAt: '2026-01-01T00:00:00Z' }));
  const before = A.applyFilters([onCutoff], { dateFilter: { cutoffISO: '2026-01-01T00:00:00Z', direction: 'before' } });
  const after = A.applyFilters([onCutoff], { dateFilter: { cutoffISO: '2026-01-01T00:00:00Z', direction: 'after' } });
  assert.equal(before.length, 0);
  assert.equal(after.length, 0);
});

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

// ── Progreso de 2 pasos (desarchivar): no "engañar" con el conteo de activos ──

test('computeLoadProgress paso 1/2 (escaneo de catálogo) no muestra conteo del modo y ocupa [0,0.5]', () => {
  const r = A.computeLoadProgress({ processed: 1000, total: 4000, kept: 1000, step: 1, steps: 2 });
  assert.equal(r.text, 'Paso 1/2: escaneando catálogo... 1,000/4,000'); // sin "(N del modo)"
  assert.equal(r.fraction, (1000 / 4000) / 2); // mitad inferior de la barra
});

test('computeLoadProgress paso 2/2 muestra archivados y ocupa [0.5,1]', () => {
  const r = A.computeLoadProgress({ processed: 2000, total: 4000, kept: 37, step: 2, steps: 2 });
  assert.equal(r.text, 'Paso 2/2: identificando archivados... 2,000/4,000 (37 archivados)');
  assert.equal(r.fraction, 0.5 + (2000 / 4000) / 2);
});

test('computeLoadProgress paso 1/2 sin total → procesados, indeterminado', () => {
  const r = A.computeLoadProgress({ processed: 500, total: null, kept: 500, step: 1, steps: 2 });
  assert.equal(r.fraction, null);
  assert.equal(r.text, 'Paso 1/2: escaneando catálogo... 500');
});

test('computeLoadProgress paso 2/2 sin total → archivados hallados', () => {
  const r = A.computeLoadProgress({ processed: 800, total: null, kept: 12, step: 2, steps: 2 });
  assert.equal(r.fraction, null);
  assert.equal(r.text, 'Paso 2/2: identificando archivados... 12 archivados');
});

test('fetchPNsForMode unarchive emite progreso con step 1 y luego step 2', async () => {
  const { api } = makeAllPNsApi([rawNode(1, 'A1')], [rawNode(3, 'X3')]);
  const Ai = loadArchiverWithApi(api);
  const steps = [];
  await Ai.fetchPNsForMode('unarchive', (p) => { if (p.step) steps.push(p.step); }, 500);
  assert.ok(steps.includes(1) && steps.includes(2), `esperaba pasos 1 y 2, vi ${steps}`);
});

test('fetchPNsForMode archive emite progreso sin step (pasada única, legacy)', async () => {
  const { api } = makeAllPNsApi([rawNode(1, 'A1')], []);
  const Ai = loadArchiverWithApi(api);
  let sawStep = false;
  await Ai.fetchPNsForMode('archive', (p) => { if (p.step) sawStep = true; }, 500);
  assert.equal(sawStep, false);
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

// ── fetchPNsForMode: el bug del desarchivado (0 resultados) ──

test('fetchPNsForMode unarchive devuelve los ARCHIVADOS (diff dos pasadas)', async () => {
  const active = [rawNode(1, 'A1'), rawNode(2, 'A2')];
  const archived = [rawNode(3, 'X3'), rawNode(4, 'X4')];
  const { api, calls } = makeAllPNsApi(active, archived);
  const Ai = loadArchiverWithApi(api);

  const got = await Ai.fetchPNsForMode('unarchive', null, 500);

  // Solo los archivados, nunca los activos.
  assert.deepEqual(got.map(p => p.id).sort(), [3, 4]);
  // Marcados como archivados (archivedAt no-null) para que isInTargetState
  // los reconozca y executeArchive los mute en vez de saltarlos.
  for (const p of got) assert.notEqual(p.archivedAt, null);
  for (const p of got) assert.equal(A.isInTargetState(p, 'unarchive'), false);
  // Requiere la pasada includeArchived:'YES' (sin ella el server no da archivados).
  assert.ok(calls.some(c => c.includeArchived === 'YES'), 'debe pedir includeArchived:YES');
});

test('fetchPNsForMode archive devuelve los ACTIVOS con archivedAt null', async () => {
  const active = [rawNode(1, 'A1'), rawNode(2, 'A2')];
  const archived = [rawNode(3, 'X3')];
  const { api } = makeAllPNsApi(active, archived);
  const Ai = loadArchiverWithApi(api);

  const got = await Ai.fetchPNsForMode('archive', null, 500);

  assert.deepEqual(got.map(p => p.id).sort(), [1, 2]);
  for (const p of got) assert.equal(p.archivedAt, null);
  for (const p of got) assert.equal(A.isInTargetState(p, 'archive'), false);
});

test('fetchPNsForMode unarchive pagina ambas pasadas (pageSize chico)', async () => {
  const active = [rawNode(1, 'A1'), rawNode(2, 'A2'), rawNode(5, 'A5')];
  const archived = [rawNode(3, 'X3'), rawNode(4, 'X4')];
  const { api } = makeAllPNsApi(active, archived);
  const Ai = loadArchiverWithApi(api);

  const got = await Ai.fetchPNsForMode('unarchive', null, 2); // fuerza varias páginas

  assert.deepEqual(got.map(p => p.id).sort(), [3, 4]);
  for (const p of got) assert.notEqual(p.archivedAt, null); // sentinel también en páginas >1
});

test('fetchPNsForMode unarchive con CERO archivados devuelve []', async () => {
  const { api } = makeAllPNsApi([rawNode(1, 'A1'), rawNode(2, 'A2')], []);
  const Ai = loadArchiverWithApi(api);
  const got = await Ai.fetchPNsForMode('unarchive', null, 500);
  assert.deepEqual(got, []); // todos activos → el diff no debe colar activos
});

test('fetchPNsForMode unarchive sin ningún activo (activeIds vacío) devuelve todos los archivados', async () => {
  const { api } = makeAllPNsApi([], [rawNode(3, 'X3'), rawNode(4, 'X4')]);
  const Ai = loadArchiverWithApi(api);
  const got = await Ai.fetchPNsForMode('unarchive', null, 500);
  assert.deepEqual(got.map(p => p.id).sort(), [3, 4]);
  for (const p of got) assert.notEqual(p.archivedAt, null);
});

test('fetchPNsForMode deduplica un PN repetido entre páginas (offset drift)', async () => {
  // archive single-pass: el mismo PN aparece dos veces en el pool → una sola fila.
  const dup = rawNode(7, 'A7');
  const { api } = makeAllPNsApi([rawNode(1, 'A1'), dup, dup], []);
  const Ai = loadArchiverWithApi(api);
  const got = await Ai.fetchPNsForMode('archive', null, 500);
  assert.deepEqual(got.map(p => p.id).sort(), [1, 7]); // 7 no se duplica
});

test('fetchPNsForMode unarchive con stop() en la pasada 1 corta y devuelve []', async () => {
  const { api } = makeAllPNsApi([rawNode(1, 'A1')], [rawNode(3, 'X3')]);
  const Ai = loadArchiverWithApi(api);
  const orig = api.query.bind(api);
  let n = 0;
  api.query = (op, vars) => { if (++n === 1) Ai._win.PNArchiver.stop(); return orig(op, vars); };
  const got = await Ai.fetchPNsForMode('unarchive', null, 500);
  assert.deepEqual(got, []); // el guard `if (stopped) return []` corta antes de la pasada 2
});

test('fetchPNsForMode drena Apollo entre páginas cuando el módulo host-cleanup está cargado', async () => {
  const { api } = makeAllPNsApi([rawNode(1, 'A1'), rawNode(2, 'A2'), rawNode(5, 'A5')], []);
  const Ai = loadArchiverWithApi(api);
  let drains = 0;
  Ai._win.SteelheadHostCleanup = { apolloCacheDrain: () => { drains++; } }; // hc() lo lee lazy
  await Ai.fetchPNsForMode('archive', null, 1); // pageSize 1 → varias páginas → varios drains
  assert.ok(drains > 0, 'drainHostCache debe invocar apolloCacheDrain del módulo');
});

test('fetchPNsForMode unarchive conserva labels para el filtro posterior', async () => {
  const active = [rawNode(1, 'A1', ['SQ1'])];
  const archived = [rawNode(3, 'X3', ['SQ1', 'Antitarnish'])];
  const { api } = makeAllPNsApi(active, archived);
  const Ai = loadArchiverWithApi(api);

  const got = await Ai.fetchPNsForMode('unarchive', null, 500);
  assert.deepEqual(got.map(p => p.id), [3]);
  assert.deepEqual(got[0].labels.map(l => l.name).sort(), ['Antitarnish', 'SQ1']);
});

test('slimPN respeta archivedAtOverride (selection set no trae archivedAt)', () => {
  // El nodo viene SIN archivedAt; el override lo marca como archivado.
  const s = A.slimPN(rawNode(3, 'X3'), '__archived__');
  assert.equal(s.archivedAt, '__archived__');
  // Con el sentinel, idempotencia: en unarchive NO está en estado destino (hay
  // que mutarlo), en archive SÍ está en estado destino (ya archivado).
  assert.equal(A.isInTargetState(s, 'unarchive'), false);
  assert.equal(A.isInTargetState(s, 'archive'), true);
});
