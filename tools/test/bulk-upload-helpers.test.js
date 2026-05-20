// tools/test/bulk-upload-helpers.test.js
// Carga remote/scripts/bulk-upload.js en un vm con stub window y extrae
// window.BulkUploadHelpers para testear helpers puros sin tocar DOM/fetch.

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
  try {
    vm.runInContext(code, sandbox, { filename: 'bulk-upload.js' });
  } catch (e) {
    throw new Error(`Failed to load bulk-upload.js in vm: ${e.message}\n${e.stack}`);
  }
  if (!sandbox.window.BulkUploadHelpers) {
    throw new Error('window.BulkUploadHelpers no fue exportado. Agregar exports al final del IIFE en bulk-upload.js.');
  }
  return sandbox.window.BulkUploadHelpers;
}

test('harness boots and exports helpers object', () => {
  const H = loadHelpers();
  assert.equal(typeof H, 'object');
});
