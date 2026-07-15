// tools/test/bulk-upload-history-idb.test.js
// Regresión del bug "Historial de Cargas: Sin cargas registradas" (2026-07).
//
// Causa raíz: sa_load_history se migró de localStorage (JSON.stringify, tolerante)
// a IndexedDB (structured clone, ESTRICTO). El guardado hacía `saIdbSet('sa_load_history',
// history)` con el objeto rico crudo. loadLog arrastra valores NO clonables del pipeline
// (p.ej. p.products con nodos del árbol de procesos) → store.put lanza DataCloneError
// SÍNCRONO → el catch lo traga → el historial NUNCA se guarda.
//
// structuredClone() de Node es el MISMO algoritmo que IndexedDB.put usa internamente,
// así que sirve como oráculo: si structuredClone(x) no truena, IDB.put(x) tampoco.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload.js');

function loadHelpers() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const sandbox = {
    window: {},
    document: { getElementById: () => null, head: { appendChild: () => {} }, body: { appendChild: () => {} }, createElement: () => ({ appendChild: () => {}, classList: { add: () => {} } }) },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async () => { throw new Error('fetch stub in test'); },
    chrome: { runtime: { sendMessage: () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    Blob: function() {},
    TextEncoder, TextDecoder,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bulk-upload.js' });
  return sandbox.window.BulkUploadHelpers;
}

// Reproduce la forma de loadLog con un valor no clonable arrastrado por el pipeline.
function loadLogConValorNoClonable() {
  return {
    id: 123,
    timestamp: '2026-07-02T00:00:00.000Z',
    mode: 'SOLO_PN',
    quoteName: 'COTIZACIÓN X',
    stats: { pnsCreated: 3, pnsExisting: 1 },
    errors: [],
    parts: [
      { pn: 'ABC-123', qty: 5, precio: 10.5, labels: ['ZINC'],
        // p.products del pipeline puede arrastrar referencias no clonables (función/DOM/etc.)
        products: [{ name: 'PROC-1', apply: function () { return 1; } }] },
    ],
  };
}

test('el bug se reproduce: structuredClone del loadLog crudo truena (== IDB.put falla)', () => {
  const loadLog = loadLogConValorNoClonable();
  assert.throws(() => structuredClone(loadLog), /could not be cloned|DataClone/i,
    'un loadLog con valor no clonable debe reventar structuredClone, igual que IDB.put');
});

test('makeIdbSafe deja el loadLog structured-clone-safe (IDB.put ya no trueca)', () => {
  const H = loadHelpers();
  assert.equal(typeof H.makeIdbSafe, 'function', 'makeIdbSafe debe estar exportado en __helpers');
  const safe = H.makeIdbSafe(loadLogConValorNoClonable());
  assert.doesNotThrow(() => structuredClone(safe),
    'tras makeIdbSafe, structuredClone (y por tanto IDB.put) no debe reventar');
});

test('makeIdbSafe preserva los datos JSON-serializables (los que usa Descargar CSV)', () => {
  const H = loadHelpers();
  const safe = H.makeIdbSafe(loadLogConValorNoClonable());
  assert.equal(safe.id, 123);
  assert.equal(safe.mode, 'SOLO_PN');
  assert.equal(safe.quoteName, 'COTIZACIÓN X');
  assert.equal(safe.stats.pnsCreated, 3);
  assert.equal(safe.parts[0].pn, 'ABC-123');
  assert.equal(safe.parts[0].qty, 5);
  assert.equal(safe.parts[0].precio, 10.5);
  assert.equal(JSON.stringify(safe.parts[0].labels), JSON.stringify(['ZINC']));
  assert.equal(safe.parts[0].products[0].name, 'PROC-1',
    'el nombre del producto (dato útil) se conserva; solo se descarta el valor no clonable');
});

test('makeIdbSafe es no-op para un objeto ya limpio (array de historial)', () => {
  const H = loadHelpers();
  const history = [{ id: 1, parts: [{ pn: 'A' }] }, { id: 2, parts: [] }];
  const safe = H.makeIdbSafe(history);
  // Comparación por estructura (JSON): el objeto sale del vm con prototipos de otro
  // realm, así que deepStrictEqual fallaría por identidad de prototipo, no por contenido.
  assert.equal(JSON.stringify(safe), JSON.stringify(history));
  assert.doesNotThrow(() => structuredClone(safe));
});
