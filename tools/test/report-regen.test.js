// tools/test/report-regen.test.js
// Carga remote/scripts/report-regen.js en un vm con stub window/document.
// El IIFE arranca ensureBooted() (async, espera deps que nunca llegan en el sandbox),
// pero las funciones puras quedan expuestas en window.__SAReportRegen sin pegar a red.
// Run: node --test tools/test/report-regen.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'remote', 'scripts', 'report-regen.js');

function loadInternals() {
  const code = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const window = {};
  const noopEl = { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {},
                   addEventListener() {}, querySelector: () => null, insertBefore() {} };
  const sandbox = {
    window,
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => Object.assign({}, noopEl),
      head: { appendChild() {} },
      body: { appendChild() {} },
      documentElement: { appendChild() {} }
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Number, String, Math,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; }
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'report-regen.js' });
  if (!sandbox.window.__SAReportRegen) throw new Error('__SAReportRegen no exportado');
  // El IIFE arranca ensureBooted()→waitForDeps (20s de polling en el sandbox).
  // destroy() corta el loop al próximo tick para que el test no cuelgue 20s.
  if (sandbox.window.ReportRegen && sandbox.window.ReportRegen.destroy) {
    sandbox.window.ReportRegen.destroy();
  }
  return sandbox.window.__SAReportRegen;
}

const RR = loadInternals();

// ── computeState ──────────────────────────────────────────────────────────
test('available cuando no hay cooldown ni job', () => {
  const serverNow = Date.parse('2026-06-15T12:00:00Z');
  const past = '2026-06-15T11:55:00Z'; // recomputableAt ya pasó
  const s = RR.computeState({ recomputableAt: past, activeJob: null }, serverNow);
  assert.strictEqual(s.status, 'available');
  assert.strictEqual(s.remainingMs, 0);
});

test('available cuando recomputableAt es null', () => {
  const s = RR.computeState({ recomputableAt: null, activeJob: null }, Date.now());
  assert.strictEqual(s.status, 'available');
});

test('cooldown cuando recomputableAt está en el futuro', () => {
  const serverNow = Date.parse('2026-06-15T12:00:00Z');
  const future = '2026-06-15T12:10:00Z'; // +10 min
  const s = RR.computeState({ recomputableAt: future, activeJob: null }, serverNow);
  assert.strictEqual(s.status, 'cooldown');
  assert.strictEqual(s.remainingMs, 10 * 60 * 1000);
});

test('regenerating cuando hay job propio activo (gana sobre cooldown)', () => {
  const serverNow = Date.parse('2026-06-15T12:00:00Z');
  const future = '2026-06-15T12:10:00Z';
  const s = RR.computeState({ recomputableAt: future, activeJob: { isDone: false, errorMessage: null } }, serverNow);
  assert.strictEqual(s.status, 'regenerating');
  assert.strictEqual(s.remainingMs, 10 * 60 * 1000);
});

test('job terminado (isDone) ya no es regenerating → cae a cooldown', () => {
  const serverNow = Date.parse('2026-06-15T12:00:00Z');
  const future = '2026-06-15T12:05:00Z';
  const s = RR.computeState({ recomputableAt: future, activeJob: { isDone: true, errorMessage: null } }, serverNow);
  assert.strictEqual(s.status, 'cooldown');
});

test('job con error no cuenta como regenerating', () => {
  const serverNow = Date.parse('2026-06-15T12:00:00Z');
  const past = '2026-06-15T11:00:00Z';
  const s = RR.computeState({ recomputableAt: past, activeJob: { isDone: false, errorMessage: 'boom' } }, serverNow);
  assert.strictEqual(s.status, 'available');
});

test('recomputableAt inválido se trata como sin cooldown', () => {
  const s = RR.computeState({ recomputableAt: 'no-es-fecha', activeJob: null }, Date.now());
  assert.strictEqual(s.status, 'available');
  assert.strictEqual(s.remainingMs, 0);
});

// ── computeSkewMs ───────────────────────────────────────────────────────────
test('skew positivo: reloj del servidor adelantado', () => {
  const clientNow = Date.parse('2026-06-15T12:00:00Z');
  const serverTxn = '2026-06-15T12:00:05Z'; // +5s
  assert.strictEqual(RR.computeSkewMs(serverTxn, clientNow), 5000);
});

test('skew negativo: reloj del cliente adelantado', () => {
  const clientNow = Date.parse('2026-06-15T12:00:10Z');
  const serverTxn = '2026-06-15T12:00:00Z';
  assert.strictEqual(RR.computeSkewMs(serverTxn, clientNow), -10000);
});

test('skew 0 cuando transactionTime falta o es inválido', () => {
  assert.strictEqual(RR.computeSkewMs(null, Date.now()), 0);
  assert.strictEqual(RR.computeSkewMs('xxx', Date.now()), 0);
});

test('skew aplicado: countdown corrige reloj desfasado', () => {
  // Cliente atrasado 30s respecto al servidor.
  const clientNow = Date.parse('2026-06-15T12:00:00Z');
  const serverTxn = '2026-06-15T12:00:30Z';
  const skew = RR.computeSkewMs(serverTxn, clientNow); // +30000
  const serverNow = clientNow + skew;
  const recomputableAt = '2026-06-15T12:05:30Z'; // 5 min después del server now
  const s = RR.computeState({ recomputableAt, activeJob: null }, serverNow);
  assert.strictEqual(s.status, 'cooldown');
  assert.strictEqual(s.remainingMs, 5 * 60 * 1000);
});

// ── formatCountdown ─────────────────────────────────────────────────────────
test('formatCountdown mm:ss', () => {
  assert.strictEqual(RR.formatCountdown(0), '00:00');
  assert.strictEqual(RR.formatCountdown(9 * 1000), '00:09');
  assert.strictEqual(RR.formatCountdown(75 * 1000), '01:15');
  assert.strictEqual(RR.formatCountdown(14 * 60 * 1000 + 59 * 1000), '14:59');
});

test('formatCountdown h:mm:ss cuando supera 1h', () => {
  assert.strictEqual(RR.formatCountdown(3661 * 1000), '1:01:01');
});

test('formatCountdown redondea hacia arriba (ceil) y nunca negativo', () => {
  assert.strictEqual(RR.formatCountdown(500), '00:01');
  assert.strictEqual(RR.formatCountdown(-5000), '00:00');
});

// ── pickPollIntervalMs ──────────────────────────────────────────────────────
test('intervalos de polling por estado', () => {
  assert.strictEqual(RR.pickPollIntervalMs('regenerating'), 10000);
  assert.strictEqual(RR.pickPollIntervalMs('cooldown'), 30000);
  assert.strictEqual(RR.pickPollIntervalMs('available'), 60000);
  assert.strictEqual(RR.pickPollIntervalMs('loading'), 15000);
});
