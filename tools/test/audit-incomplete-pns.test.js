// tools/test/audit-incomplete-pns.test.js
// Carga tools/audit-incomplete-pns.js en un vm con stub window/document.
// Como el IIFE async no tiene awaits cuando REMOTE_CONFIG está provisto,
// corre sincrónicamente y deja __SAAuditIncompletePNs en sandbox.window.
//
// Tests:
//   - parseCSV maneja quoting, BOM, multilínea.
//   - parseRows extrae filas de datos saltando section headers.
//   - comparePartNumber detecta: sin labels, sin specs, sin spec params, sin racks,
//     sin predictivos, mismatch en customInputs, etc.
//
// Run: node --test tools/test/audit-incomplete-pns.test.js

const test = require('node:test');
// non-strict para tolerar cross-realm (arrays de vm sandbox tienen distinto Array.prototype)
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'audit-incomplete-pns.js');

const MOCK_CONFIG = {
  version: 'test',
  steelhead: {
    baseUrl: 'https://app.gosteelhead.com',
    graphqlEndpoint: '/graphql',
    apolloClientVersion: '4.0.8',
    hashes: {
      queries: {
        GetPartNumber: 'h_gpn',
        AllPartNumbers: 'h_apn',
        CustomerSearchByName: 'h_csbn',
        AllProcesses: 'h_proc',
        AllLabels: 'h_lab',
        AllRackTypes: 'h_rt',
      },
      mutations: {},
    },
    domain: {
      unitIds: { KGM: 'u_kgm', LBR: 'u_lbr', CMK: 'u_cmk', FTK: 'u_ftk', LM: 'u_lm', FOT: 'u_fot', LO: 'u_lo', MTR: 'u_mtr' },
    },
  },
};

function mkElementStub() {
  const el = {
    style: {}, classList: { add() {}, remove() {} },
    appendChild() { return el; }, removeChild() { return el; },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    cloneNode() { return mkElementStub(); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    parentNode: null,
    onclick: null, onchange: null, oninput: null,
    innerHTML: '', textContent: '', value: '', id: '', className: '',
    files: null, scrollTop: 0, scrollHeight: 0, href: '', download: '',
    click() {},
    remove() {},
  };
  return el;
}

function loadAuditScript() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const window = { REMOTE_CONFIG: MOCK_CONFIG };
  // getElementById devuelve un stub (no null) para que openModal() automático del IIFE
  // no truene en el test runner cuando setea .onclick = ...
  const document = {
    getElementById: () => mkElementStub(),
    createElement: () => mkElementStub(),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
  };
  const sandbox = {
    window, document,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('fetch should not be called in test'); },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    Blob: function () {},
    alert: () => {},
    Promise,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'audit-incomplete-pns.js' });
  if (!sandbox.window.__SAAuditIncompletePNs) {
    throw new Error('__SAAuditIncompletePNs no fue exportado. ¿El IIFE truena antes del export?');
  }
  return sandbox.window.__SAAuditIncompletePNs;
}

const A = loadAuditScript();

// ═══════════════════════════════════════════════════════════════════════
// parseCSV
// ═══════════════════════════════════════════════════════════════════════
test('parseCSV: simple', () => {
  const rows = A.parseCSV('a,b,c\r\n1,2,3\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCSV: comillas con comas embebidas', () => {
  const rows = A.parseCSV('a,"b,b",c\n');
  assert.deepEqual(rows[0], ['a', 'b,b', 'c']);
});

test('parseCSV: escape de comilla con ""', () => {
  const rows = A.parseCSV('"a""b",c\n');
  assert.deepEqual(rows[0], ['a"b', 'c']);
});

test('parseCSV: celdas multilínea entre comillas', () => {
  const rows = A.parseCSV('"line1\nline2",x\n');
  assert.deepEqual(rows[0], ['line1\nline2', 'x']);
});

test('parseCSV: BOM al inicio se ignora', () => {
  const rows = A.parseCSV('﻿a,b\n');
  assert.deepEqual(rows[0], ['a', 'b']);
});

// ═══════════════════════════════════════════════════════════════════════
// parseRows
// ═══════════════════════════════════════════════════════════════════════
function mkRow(overrides = {}) {
  const r = Array(69).fill('');
  for (const [k, v] of Object.entries(overrides)) r[Number(k)] = v;
  return r;
}

test('parseRows: salta filas de section header (col A = PARÁMETROS, Archivado, V/F)', () => {
  const rows = [
    mkRow({ 0: 'PARÁMETROS' }),
    mkRow({ 0: 'Archivado', 5: 'Número de\nparte' }),
    mkRow({ 0: 'V/F', 5: 'Texto' }),
    mkRow({ 5: 'PN-001', 4: 'ACME' }),
  ];
  const { parts } = A.parseRows(rows);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].pn, 'PN-001');
  assert.equal(parts[0].cliente, 'ACME');
});

test('parseRows: extrae labels, specs, racks, predictivos', () => {
  const rows = [
    mkRow({
      5: 'PN-002', 4: 'CUST',
      14: 'Cobre',
      15: 'L1', 16: 'L2',
      33: 'Espesor | 10 µm', 35: 'OtraSpec',
      41: 'Rack-A', 42: '12',
      53: '0.001', 54: '-',
      62: 'IBMS-123',
    }),
  ];
  const { parts } = A.parseRows(rows);
  assert.equal(parts.length, 1);
  const p = parts[0];
  assert.deepEqual(p.labels, ['L1', 'L2']);
  assert.equal(p.metalBase, 'Cobre');
  assert.deepEqual(p.specs[0], { name: 'Espesor', param: '10 µm' });
  assert.deepEqual(p.specs[1], { name: 'OtraSpec', param: '' });
  assert.equal(p.racks[0].name, 'Rack-A');
  assert.equal(p.racks[0].ppr, 12);
  // Predictivos: Plata Fina con 0.001, Estaño Puro con "-"
  const plata = p.predictiveUsage.find(x => x.inventoryItemId === 364506);
  const estano = p.predictiveUsage.find(x => x.inventoryItemId === 397490);
  assert.equal(plata.usagePerPart, '0.001');
  assert.equal(estano.usagePerPart, '-');
  assert.equal(p.quoteIBMS, 'IBMS-123');
});

test('parseRows: divisa "-" cae a USD (1.2.6 fix)', () => {
  const rows = [mkRow({ 5: 'PN-003', 4: 'X', 12: '-' })];
  const { parts } = A.parseRows(rows);
  assert.equal(parts[0].divisa, 'USD');
});

test('parseRows: rawRow preserva la fila original para emit CSV', () => {
  const row = mkRow({ 5: 'PN-004', 4: 'X', 14: 'Cobre' });
  const { parts } = A.parseRows([row]);
  assert.equal(parts[0].rawRow[5], 'PN-004');
  assert.equal(parts[0].rawRow[14], 'Cobre');
});

// ═══════════════════════════════════════════════════════════════════════
// comparePartNumber
// ═══════════════════════════════════════════════════════════════════════
const catalogs = {
  labelByName: new Map([['L1', 'lbl1'], ['L2', 'lbl2']]),
  rackByName: new Map([['Rack-A', { id: 'ra' }]]),
  processByName: new Map([['NIQUELADO', { id: 'pNi', name: 'NIQUELADO' }]]),
};

function mkPart(over = {}) {
  return {
    rowIdx: 100, rawRow: [],
    pn: 'TEST', cliente: 'ACME', descripcion: '', pnAlterno: '', pnGroup: '',
    qty: null, precio: null, unidadPrecio: '', divisa: 'USD', precioDefault: false,
    metalBase: '', labels: [], procesoOverride: '',
    products: [], specs: [],
    unitConv: { kgm: null, cmk: null, lm: null, minPzasLote: null },
    racks: [],
    dims: { length: null, width: null, height: null, outerDiam: null, innerDiam: null },
    linea: '', departamento: '', codigoSAT: '',
    archivado: false, validacion1er: false, forzarDuplicado: false, archivarAnterior: false,
    predictiveUsage: [],
    quoteIBMS: '', estacionIBMS: '', plano: '', piezasCarga: null, cargasHora: '', tiempoEntrega: null, notasAdicionalesPN: '',
    ...over,
  };
}

function mkPn(over = {}) {
  return {
    id: 'pn_x', name: 'TEST', archivedAt: null,
    customInputs: {},
    descriptionMarkdown: '',
    partNumberLabelsByPartNumberId: { nodes: [] },
    partNumberSpecsByPartNumberId: { nodes: [] },
    partNumberSpecFieldParamsByPartNumberId: { nodes: [] },
    partNumberRackTypesByPartNumberId: { nodes: [] },
    predictedInventoryUsagesByPartNumberId: { nodes: [] },
    partNumberPricesByPartNumberId: { nodes: [] },
    partNumberDimensionsByPartNumberId: { nodes: [] },
    inventoryItemByInventoryItemId: null,
    processNodeByDefaultProcessNodeId: null, defaultProcessNodeId: null,
    ...over,
  };
}

test('comparePartNumber: PN completo → 0 issues', () => {
  const part = mkPart({ labels: ['L1'] });
  const pn = mkPn({
    partNumberLabelsByPartNumberId: { nodes: [{ labelByLabelId: { name: 'L1' } }] },
  });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: labels esperados pero server no tiene', () => {
  const part = mkPart({ labels: ['L1', 'L2'] });
  const pn = mkPn();
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'labels');
  assert.deepEqual(issues[0].missing, ['L1', 'L2']);
});

test('comparePartNumber: spec esperada pero no linkeada', () => {
  const part = mkPart({ specs: [{ name: 'Espesor', param: '10 µm' }] });
  const pn = mkPn();
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'spec');
  assert.equal(issues[0].spec, 'Espesor');
});

test('comparePartNumber: spec linkeada pero sin params', () => {
  const part = mkPart({ specs: [{ name: 'Espesor', param: '10 µm' }] });
  const pn = mkPn({
    partNumberSpecsByPartNumberId: { nodes: [{ specBySpecId: { id: 'sp1', name: 'Espesor' } }] },
    partNumberSpecFieldParamsByPartNumberId: { nodes: [] },
  });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'specParam');
});

test('comparePartNumber: spec linkeada con params OK', () => {
  const part = mkPart({ specs: [{ name: 'Espesor', param: '10 µm' }] });
  const pn = mkPn({
    partNumberSpecsByPartNumberId: { nodes: [{ specBySpecId: { id: 'sp1', name: 'Espesor' } }] },
    partNumberSpecFieldParamsByPartNumberId: {
      nodes: [{
        specFieldParamBySpecFieldParamId: {
          id: 'sfp1',
          specFieldBySpecFieldId: { specBySpecId: { id: 'sp1' } },
        },
      }],
    },
  });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: rack faltante', () => {
  const part = mkPart({ racks: [{ name: 'Rack-A', ppr: 12 }] });
  const pn = mkPn();
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.equal(issues[0].field, 'rack');
});

test('comparePartNumber: rack PPR con redondeo de decimales NO debe fallar', () => {
  // CSV trae 12.4, server (entero) tiene 12 → CSV redondeado = 12, match.
  const part = mkPart({ racks: [{ name: 'Rack-A', ppr: 12.4 }] });
  const pn = mkPn({
    partNumberRackTypesByPartNumberId: { nodes: [{ rackTypeByRackTypeId: { name: 'Rack-A' }, partsPerRack: 12 }] },
  });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: rack PPR realmente distinto sí falla', () => {
  const part = mkPart({ racks: [{ name: 'Rack-A', ppr: 25 }] });
  const pn = mkPn({
    partNumberRackTypesByPartNumberId: { nodes: [{ rackTypeByRackTypeId: { name: 'Rack-A' }, partsPerRack: 12 }] },
  });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.equal(issues[0].field, 'rackPpr');
});

test('comparePartNumber: predictivo faltante', () => {
  const part = mkPart({ predictiveUsage: [{ inventoryItemId: 364506, usagePerPart: '0.001', name: 'Plata Fina' }] });
  const pn = mkPn();
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.equal(issues[0].field, 'predictive');
  assert.equal(issues[0].material, 'Plata Fina');
});

test('comparePartNumber: predictivo con micro≈valor match', () => {
  const part = mkPart({ predictiveUsage: [{ inventoryItemId: 364506, usagePerPart: '0.001', name: 'Plata Fina' }] });
  const pn = mkPn({
    predictedInventoryUsagesByPartNumberId: {
      nodes: [{ inventoryItemByInventoryItemId: { id: 364506 }, microQuantityPerPart: 1000 }],
    },
  });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: metalBase mismatch', () => {
  const part = mkPart({ metalBase: 'Cobre' });
  const pn = mkPn({ customInputs: { DatosAdicionalesNP: { BaseMetal: 'Aluminio' } } });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.ok(issues.some(i => i.field === 'ci' && i.key === 'metalBase'));
});

test('comparePartNumber: quoteIBMS coincide → sin issue', () => {
  const part = mkPart({ quoteIBMS: 'IBMS-1' });
  const pn = mkPn({ customInputs: { DatosAdicionalesNP: { QuoteIBMS: 'IBMS-1' } } });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: customInputs como string JSON se parsea', () => {
  const part = mkPart({ metalBase: 'Cobre' });
  const pn = mkPn({ customInputs: JSON.stringify({ DatosAdicionalesNP: { BaseMetal: 'Cobre' } }) });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: dims esperados pero server vacío', () => {
  const part = mkPart({ dims: { length: 0.1, width: null, height: null, outerDiam: null, innerDiam: null } });
  const pn = mkPn();
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.ok(issues.some(i => i.field === 'dims'));
});

test('comparePartNumber: proceso match', () => {
  const part = mkPart({ procesoOverride: 'NIQUELADO' });
  const pn = mkPn({ processNodeByDefaultProcessNodeId: { id: 'pNi', name: 'NIQUELADO' } });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.deepEqual(issues, []);
});

test('comparePartNumber: proceso mismatch', () => {
  const part = mkPart({ procesoOverride: 'NIQUELADO' });
  const pn = mkPn({ processNodeByDefaultProcessNodeId: { id: 'pOtro', name: 'CROMADO' } });
  const issues = A.comparePartNumber(part, pn, catalogs);
  assert.ok(issues.some(i => i.field === 'process'));
});

test('PREDICTIVE_MATERIALS expone 9 entradas con inventoryItemId esperados', () => {
  assert.equal(A.PREDICTIVE_MATERIALS.length, 9);
  const ids = A.PREDICTIVE_MATERIALS.map(m => m.inventoryItemId).sort((a, b) => a - b);
  assert.deepEqual(ids, [364506, 397490, 412305, 412479, 412723, 412805, 702767, 702768, 702769]);
});
