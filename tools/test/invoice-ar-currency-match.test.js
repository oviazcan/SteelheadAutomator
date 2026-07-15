// tools/test/invoice-ar-currency-match.test.js
// Contrato del matcher de divisa por NOMBRE de cuenta AR (invoice-autofill.js).
// Bug 2026-07-15: el catálogo no es uniforme — muchas cuentas AR traen el código ISO
// ("... 1140 USD"), pero otras usan nomenclatura contable mexicana "M.N." (Moneda
// Nacional = pesos), p.ej. "Hubbell Products Mexico S. de R.L. 1177 M.N.". El filtro
// duro anterior (/\bMXN\b/) las descartaba y AR no resolvía. Este test extrae las
// funciones REALES del applet (no una copia) y las ejerce para evitar regresiones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extrae `function <name>(...) { ... }` del fuente por conteo de llaves balanceado.
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start !== -1, `no se encontró ${name} en invoice-autofill.js`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`llaves desbalanceadas extrayendo ${name}`);
}

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'remote', 'scripts', 'invoice-autofill.js'), 'utf8');
// nameMatchesCurrency depende de normalizeForMatch: inyectamos ambas y exportamos la 1ra.
const factory = new Function(
  `${extractFn(SRC, 'normalizeForMatch')}\n${extractFn(SRC, 'nameMatchesCurrency')}\nreturn nameMatchesCurrency;`);
const nameMatchesCurrency = factory();

test('MXN: reconoce "M.N." (Moneda Nacional) — bug Hubbell', () => {
  const n = 'Hubbell Products Mexico S. de R.L. 1177 M.N.';
  assert.equal(nameMatchesCurrency(n, 'MXN'), true);
  assert.equal(nameMatchesCurrency(n, 'USD'), false);
});

test('MXN: variantes en español y código ISO', () => {
  assert.equal(nameMatchesCurrency('Cliente General 1200 MXN', 'MXN'), true);
  assert.equal(nameMatchesCurrency('Cliente Pesos S.A. Pesos', 'MXN'), true);
  assert.equal(nameMatchesCurrency('Cliente ABC Moneda Nacional', 'MXN'), true);
  assert.equal(nameMatchesCurrency('Cliente XYZ MXP', 'MXN'), true); // ISO viejo
});

test('USD: código ISO (al final o mezclado) y español', () => {
  assert.equal(nameMatchesCurrency('Federal Mogul de Mexico ... 1140 USD', 'USD'), true);
  assert.equal(nameMatchesCurrency('Schneider Electric ... USD 1128', 'USD'), true);
  assert.equal(nameMatchesCurrency('Cliente Dolares Dólares', 'USD'), true);
});

test('sin divisa en el name → no matchea ninguna', () => {
  assert.equal(nameMatchesCurrency('Cliente Sin Divisa 1000', 'MXN'), false);
  assert.equal(nameMatchesCurrency('Cliente Sin Divisa 1000', 'USD'), false);
});

test('guard: iniciales "M N" sueltas (espacios, sin puntos) NO se leen como MXN', () => {
  // Una razón social "Grupo M N Industrial" no debe disparar MXN por accidente.
  assert.equal(nameMatchesCurrency('Grupo M N Industrial 1300 USD', 'MXN'), false);
  assert.equal(nameMatchesCurrency('Grupo M N Industrial 1300 USD', 'USD'), true);
});

test('no cruza divisas: cuenta USD no cuenta como MXN y viceversa', () => {
  assert.equal(nameMatchesCurrency('Federal Mogul ... 1140 USD', 'MXN'), false);
  assert.equal(nameMatchesCurrency('Cliente General 1200 MXN', 'USD'), false);
});

test('divisa vacía → false (fail-safe)', () => {
  assert.equal(nameMatchesCurrency('Cliente 1200 MXN', ''), false);
  assert.equal(nameMatchesCurrency('Cliente 1200 MXN', null), false);
});
