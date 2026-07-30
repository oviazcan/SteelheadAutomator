// Ata el applet a su declaración en config.json: si alguien renombra el fn, mueve un script o
// borra un hash, esto se pone rojo antes de que el operador lo descubra en producción.
// Run: node --test tools/test/wo-spec-params-config.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const cfg = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'remote', 'config.json'), 'utf8'));

const HASHES = {
  GetPartNumberWorkOrderSpecsInfo:
    '0d77c6496b506be62b92c1d821b2e0ec115838cb404ef3ab1cffe2270ddeb827',
  ArchivePartNumberRecipeNodeSpecFieldParams:
    '7d33b66bb244910a9065c631630bceb15f01ca282ac208b16fecf85df36937a4',
  AddParamsToPartNumberRecipeNodeSpecFieldParam:
    '8e8b0ab50c0404a01985ec894d0c91d3eab4159c6360f923b9920b8e344aaef0'
};

test('config: las 3 operaciones están documentadas en knownOperations', () => {
  for (const op of Object.keys(HASHES)) {
    assert.ok(cfg.knownOperations[op], 'falta knownOperations.' + op);
  }
});

test('config: la query va en hashes.queries y las 2 mutations en hashes.mutations', () => {
  const q = cfg.steelhead.hashes.queries;
  const m = cfg.steelhead.hashes.mutations;
  assert.equal(q.GetPartNumberWorkOrderSpecsInfo, HASHES.GetPartNumberWorkOrderSpecsInfo);
  assert.equal(m.ArchivePartNumberRecipeNodeSpecFieldParams,
               HASHES.ArchivePartNumberRecipeNodeSpecFieldParams);
  assert.equal(m.AddParamsToPartNumberRecipeNodeSpecFieldParam,
               HASHES.AddParamsToPartNumberRecipeNodeSpecFieldParam);
});

test('config: GetPartNumber está disponible — el applet lo necesita para leer el NP', () => {
  const q = cfg.steelhead.hashes.queries;
  assert.ok(q.GetPartNumber, 'falta el hash de GetPartNumber');
});

test('config: la app spec-migrator carga el core ANTES que el glue', () => {
  const app = cfg.apps.find(a => a.id === 'spec-migrator');
  assert.ok(app, 'no existe la app spec-migrator');
  assert.ok(app.scripts.includes('scripts/wo-spec-params-core.js'));
  assert.ok(app.scripts.includes('scripts/wo-spec-params.js'));
  assert.ok(app.scripts.indexOf('scripts/wo-spec-params-core.js')
          < app.scripts.indexOf('scripts/wo-spec-params.js'),
          'el core debe cargarse antes que el glue');
});

test('config: la acción del popup está cableada con fn (si no, nace inalcanzable)', () => {
  const app = cfg.apps.find(a => a.id === 'spec-migrator');
  const act = app.actions.find(a => a.id === 'reapply-wo-params');
  assert.ok(act, 'falta la acción reapply-wo-params');
  assert.equal(act.handler, 'message');
  assert.equal(act.fn, 'WoSpecParams.openFromPopup');
});

test('config: el barrido autónomo está cableado con fn', () => {
  const app = cfg.apps.find(a => a.id === 'spec-migrator');
  const act = app.actions.find(a => a.id === 'sweep-forced-node');
  assert.ok(act, 'falta la acción sweep-forced-node');
  assert.equal(act.fn, 'SpecMigrator.sweepAllCustomers');
});
