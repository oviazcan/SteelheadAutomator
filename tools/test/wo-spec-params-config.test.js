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

test('el barrido no adivina el contenedor de la respuesta de clientes', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'remote', 'scripts', 'spec-migrator.js'), 'utf8');
  assert.match(src, /function firstNodes\(/,
    'debe existir un extractor genérico de nodes');
  const i = src.indexOf("api().query('AllCustomers'");
  assert.ok(i > 0);
  const bloque = src.slice(i, i + 900);
  assert.ok(bloque.includes('firstNodes('),
    'AllCustomers debe usar firstNodes, no un contenedor fijo');
});

test('ninguna fase larga se queda sin pintar progreso', () => {
  // El fallo de GRUPO COLLADO pasó desapercibido porque el panel no decía NADA mientras
  // trabajaba: 52 errores se acumularon y el operador vio una pantalla en blanco. Toda fase
  // que escriba en lote debe tener barra, contador y bitácora en vivo.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'remote', 'scripts', 'spec-migrator.js'), 'utf8');
  for (const marca of ['prog-msg', 'prog-bar', 'prog-log', 'sw-msg', 'sw-log']) {
    assert.ok(src.includes(marca), 'falta el indicador ' + marca);
  }
  assert.match(src, /const verbose = /, 'debe existir una bitácora en vivo');
});

test('AllCustomers se llama con las variables obligatorias', () => {
  // HTTP 400 en la primera corrida del barrido: includeArchived e includeAccountingFields son
  // required. catalog-fetcher.js ya tenía la llamada buena; había que copiarla, no inventarla.
  const fs2 = require('node:fs'), path2 = require('node:path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', '..', 'remote', 'scripts', 'spec-migrator.js'), 'utf8');
  const i = src.indexOf("api().query('AllCustomers'");
  assert.ok(i > 0, 'no encontré la llamada a AllCustomers');
  const bloque = src.slice(i, i + 400);
  for (const v of ['includeArchived', 'includeAccountingFields', 'orderBy', 'first', 'offset']) {
    assert.ok(bloque.includes(v), 'AllCustomers debe mandar ' + v);
  }
});

test('config: el reparador está cableado con fn', () => {
  const app = cfg.apps.find(a => a.id === 'spec-migrator');
  const act = app.actions.find(a => a.id === 'repair-archived');
  assert.ok(act, 'falta la acción repair-archived');
  assert.equal(act.fn, 'SpecMigrator.repairArchivedWithoutRestore');
});

test('los textos visibles del applet están en español, sin caracteres de otro alfabeto', () => {
  // Se coló una palabra en cirílico al escribir un prompt. El texto que ve el operador es
  // parte del producto: una errata así distrae y no debe llegar a producción.
  const fs3 = require('node:fs'), path3 = require('node:path');
  for (const f of ['spec-migrator.js', 'spec-migrator-normalize.js',
                   'wo-spec-params.js', 'wo-spec-params-core.js']) {
    const src = fs3.readFileSync(path3.join(__dirname, '..', '..', 'remote', 'scripts', f), 'utf8');
    const raro = src.match(/[Ѐ-ӿ一-鿿؀-ۿ]/g);
    assert.equal(raro, null, f + ' tiene caracteres de otro alfabeto: ' + (raro || []).slice(0,5).join(''));
  }
});

test('el checkpoint se lee ANTES de listar clientes, en barrido y reparador', () => {
  // "Pasó varios clientes, pero aún así me bota el error de nuevo": el listado iba primero,
  // así que un fallo del ERP mataba la corrida y dejaba el avance guardado pero inalcanzable.
  const fs4 = require('node:fs'), path4 = require('node:path');
  const src = fs4.readFileSync(
    path4.join(__dirname, '..', '..', 'remote', 'scripts', 'spec-migrator.js'), 'utf8');

  for (const fn of ['sweepAllCustomers', 'repairArchivedWithoutRestore']) {
    const i = src.indexOf('async function ' + fn);
    assert.ok(i > 0, 'falta ' + fn);
    const cuerpo = src.slice(i, i + 4000);
    const iCk = cuerpo.search(/sweepLoad\(\)|getItem\(DUP_REPAIR_KEY/);
    const iLista = cuerpo.indexOf('fetchCustomersTolerante');
    assert.ok(iCk > 0, fn + ' debe leer el checkpoint');
    assert.ok(iLista > 0, fn + ' debe usar el listado tolerante');
    assert.ok(iCk < iLista, fn + ': el checkpoint se lee ANTES de pedir la lista');
    assert.ok(cuerpo.includes('resolveCustomerList'),
      fn + ' debe poder seguir con la lista guardada si el ERP falla');
  }
});

test('la lista de clientes se guarda EN el checkpoint', () => {
  const fs5 = require('node:fs'), path5 = require('node:path');
  const src = fs5.readFileSync(
    path5.join(__dirname, '..', '..', 'remote', 'scripts', 'spec-migrator.js'), 'utf8');
  assert.match(src, /sweepSave\(\{ done: \[\.\.\.hechos\], totales, clientes,/,
    'el barrido debe persistir la lista');
  assert.match(src, /done: \[\.\.\.hechos\], totales, clientes, ts/,
    'el reparador debe persistir la lista');
});
