// tools/test/hash-scanner-persist.test.js
// Persistencia del scan a través de recargas (Fase B, fix del bug "recarga pierde el scan").
// Núcleos testeables: mergeResults debe fusionar screens; slimForBackup produce un
// backup pequeño con lo esencial (hash + screens) para localStorage.
const test = require('node:test');
const assert = require('node:assert/strict');
const HashScanner = require('../../remote/scripts/hash-scanner.js');
const { recordOperation, discovered, slimForBackup } = HashScanner._internal;

function reset(){ for (const k of Object.keys(discovered)) delete discovered[k]; }

test('mergeResults: fusiona screens de una op ya vista (no los pierde)', () => {
  reset();
  // op ya vista, con una pantalla
  discovered.AllCustomers = { hash:'h', count:1, variablesSamples:[], responseSamples:[], errorSamples:[],
    screens:[{ pathname:'/Customers', breadcrumb:null, count:1 }] };
  // llega backup con la MISMA op vista en OTRA pantalla
  HashScanner.mergeResults({ AllCustomers: { hash:'h', count:1, variablesSamples:[], responseSamples:[], errorSamples:[],
    screens:[{ pathname:'/Customers/9', breadcrumb:'a:abrir', count:1 }] } });
  const paths = discovered.AllCustomers.screens.map(s=>s.pathname).sort();
  assert.deepEqual(paths, ['/Customers','/Customers/9']); // ambas pantallas presentes
});

test('mergeResults: op nueva conserva sus screens', () => {
  reset();
  HashScanner.mergeResults({ GetPartNumber: { hash:'h', count:1, screens:[{pathname:'/PartNumbers/5',breadcrumb:null,count:2}] } });
  assert.equal(discovered.GetPartNumber.screens[0].pathname, '/PartNumbers/5');
});

test('slimForBackup: incluye hash+screens+status, excluye samples pesados', () => {
  reset();
  discovered.X = { hash:'abc', count:3, status:'known', configKey:'X',
    screens:[{pathname:'/x',breadcrumb:null,count:1}],
    responseSamples:[{huge:'x'.repeat(9999)}], variablesSamples:[{a:1}], responseSchema:{big:true} };
  const slim = slimForBackup();
  assert.equal(slim.X.hash, 'abc');
  assert.deepEqual(slim.X.screens, [{pathname:'/x',breadcrumb:null,count:1}]);
  assert.equal(slim.X.status, 'known');
  assert.equal(slim.X.responseSamples, undefined); // no arrastra lo pesado
  assert.equal(slim.X.responseSchema, undefined);
});
