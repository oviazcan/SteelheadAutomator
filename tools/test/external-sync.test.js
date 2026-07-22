// tools/test/external-sync.test.js
// Golden del sincronizador de hashes EXTERNOS del hash-autopilot (Reportes SH /
// PowerTools). applyHashesToText es puro; syncExternalToSinks usa deps mock.
const test = require('node:test');
const assert = require('node:assert/strict');

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const NEW = 'c'.repeat(64);

// Muestra estilo steelhead_client.py (dict Python, mismo shape que config.json).
const PY = `PERSISTED_QUERIES = {
    "GetInsightsReportDetails":         "${H1}",
    "CreateReportVariable":             "${H2}",
}`;

test('applyHashesToText: reemplaza solo la op existente, respeta las demás', async () => {
  const { applyHashesToText } = await import('../hash-autopilot/external-sync.mjs');
  const r = applyHashesToText(PY, { GetInsightsReportDetails: NEW });
  assert.equal(r.changed, true);
  assert.deepEqual(r.applied, ['GetInsightsReportDetails']);
  assert.match(r.text, new RegExp(`"GetInsightsReportDetails":\\s*"${NEW}"`));
  assert.match(r.text, new RegExp(`"CreateReportVariable":\\s*"${H2}"`)); // intacta
});

test('applyHashesToText: op inexistente → no aplica, changed=false', async () => {
  const { applyHashesToText } = await import('../hash-autopilot/external-sync.mjs');
  const r = applyHashesToText(PY, { NoExiste: NEW });
  assert.equal(r.changed, false);
  assert.deepEqual(r.applied, []);
  assert.equal(r.text, PY);
});

test('applyHashesToText: idempotente — mismo hash no marca changed', async () => {
  const { applyHashesToText } = await import('../hash-autopilot/external-sync.mjs');
  const r = applyHashesToText(PY, { GetInsightsReportDetails: H1 });
  assert.equal(r.changed, false);           // texto idéntico
  assert.deepEqual(r.applied, ['GetInsightsReportDetails']); // hubo match…
});

test('applyHashesToText: guard — hash mal formado se ignora', async () => {
  const { applyHashesToText } = await import('../hash-autopilot/external-sync.mjs');
  const r = applyHashesToText(PY, { GetInsightsReportDetails: 'no-es-hash' });
  assert.equal(r.changed, false);
  assert.equal(r.text, PY);
});

test('syncExternalToSinks: escribe en el sink correcto + changedRepos dedupe', async () => {
  const { syncExternalToSinks } = await import('../hash-autopilot/external-sync.mjs');
  const files = {
    '/repoA/scripts/steelhead_client.py': PY,
    '/repoB/sync/lowcode_sync.py': `X = { "OtraOp": "${H1}" }`,
  };
  const writes = {};
  const deps = {
    exists: (p) => p in files,
    readFile: (p) => files[p],
    writeFile: (p, c) => { writes[p] = c; },
  };
  const sinks = [
    { name: 'reportes-sh', repo: '/repoA', file: 'scripts/steelhead_client.py' },
    { name: 'pt', repo: '/repoB', file: 'sync/lowcode_sync.py' },
  ];
  const res = syncExternalToSinks({ GetInsightsReportDetails: NEW }, sinks, deps);
  // se escribió solo repoA (repoB no tenía la op)
  assert.ok('/repoA/scripts/steelhead_client.py' in writes);
  assert.ok(!('/repoB/sync/lowcode_sync.py' in writes));
  assert.deepEqual(res.changedRepos, ['/repoA']);
  assert.deepEqual(res.notFound, []);
});

test('syncExternalToSinks: sink ausente se omite (fail-safe), op sin sink → notFound', async () => {
  const { syncExternalToSinks } = await import('../hash-autopilot/external-sync.mjs');
  const deps = {
    exists: (p) => p === '/live/f.py',
    readFile: () => `Y = { "Presente": "${H1}" }`,
    writeFile: () => {},
  };
  const sinks = [
    { name: 'vivo', repo: '/live', file: 'f.py' },
    { name: 'ausente', repo: '/nope', file: 'x.py' },
  ];
  const res = syncExternalToSinks({ Ausente: NEW }, sinks, deps);
  const missing = res.report.find((r) => r.name === 'ausente');
  assert.equal(missing.missing, true);
  assert.deepEqual(res.notFound, ['Ausente']); // ningún sink contenía "Ausente"
});

test('syncExternalToSinks: una op en dos archivos del MISMO repo → 1 repo en changedRepos', async () => {
  const { syncExternalToSinks } = await import('../hash-autopilot/external-sync.mjs');
  const files = {
    '/pt/sync/a.py': `{ "Shared": "${H1}" }`,
    '/pt/sync/b.py': `{ "Shared": "${H1}" }`,
  };
  const writes = {};
  const deps = { exists: (p) => p in files, readFile: (p) => files[p], writeFile: (p, c) => { writes[p] = c; } };
  const sinks = [
    { name: 'a', repo: '/pt', file: 'sync/a.py' },
    { name: 'b', repo: '/pt', file: 'sync/b.py' },
  ];
  const res = syncExternalToSinks({ Shared: NEW }, sinks, deps);
  assert.equal(Object.keys(writes).length, 2);        // ambos archivos escritos
  assert.deepEqual(res.changedRepos, ['/pt']);        // pero 1 solo repo
});
