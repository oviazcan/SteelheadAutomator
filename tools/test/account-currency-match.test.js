// tools/test/account-currency-match.test.js
// Contrato del matcher de divisa por NOMBRE de cuenta, GEMELO en dos applets:
//   - invoice-autofill.js (cuenta AR / CXC)
//   - bill-autofill.js    (cuenta AP / CXP)
// Bug 2026-07-15: el catálogo no es uniforme — muchas cuentas traen el código ISO
// ("... 1140 USD"), pero otras usan nomenclatura contable mexicana "M.N." (Moneda
// Nacional = pesos), p.ej. "Hubbell Products Mexico S. de R.L. 1177 M.N.". Este test
// extrae la función REAL de CADA applet (no una copia) y las ejerce con los MISMOS
// casos, así ambos gemelos quedan obligados a comportarse igual (si uno diverge, rojo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extrae `function <name>(...) { ... }` del fuente por conteo de llaves balanceado.
function extractFn(src, name, file) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start !== -1, `no se encontró ${name} en ${file}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`llaves desbalanceadas extrayendo ${name} en ${file}`);
}

// nameMatchesCurrency depende de normalizeForMatch: inyectamos ambas y exportamos la 1ra.
function loadMatcher(file) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'remote', 'scripts', file), 'utf8');
  const factory = new Function(
    `${extractFn(src, 'normalizeForMatch', file)}\n` +
    `${extractFn(src, 'nameMatchesCurrency', file)}\n` +
    `return nameMatchesCurrency;`);
  return factory();
}

const APPLETS = {
  'invoice-autofill.js (AR)': loadMatcher('invoice-autofill.js'),
  'bill-autofill.js (AP)': loadMatcher('bill-autofill.js'),
};

// [name, cur, expected]
const CASES = [
  ['Hubbell Products Mexico S. de R.L. 1177 M.N.', 'MXN', true],   // bug Hubbell
  ['Hubbell Products Mexico S. de R.L. 1177 M.N.', 'USD', false],
  ['Cliente General 1200 MXN', 'MXN', true],
  ['Cliente Pesos S.A. Pesos', 'MXN', true],
  ['Cliente ABC Moneda Nacional', 'MXN', true],
  ['Cliente XYZ MXP', 'MXN', true],                                 // ISO viejo
  ['Federal Mogul de Mexico ... 1140 USD', 'USD', true],
  ['Schneider Electric ... USD 1128', 'USD', true],
  ['Proveedor Dolares Dólares', 'USD', true],
  ['Cuenta Sin Divisa 1000', 'MXN', false],
  ['Cuenta Sin Divisa 1000', 'USD', false],
  // guard: "M N" suelto (espacios sin puntos) NO es MXN
  ['Grupo M N Industrial 1300 USD', 'MXN', false],
  ['Grupo M N Industrial 1300 USD', 'USD', true],
  // no cruza divisas
  ['Federal Mogul ... 1140 USD', 'MXN', false],
  ['Cliente General 1200 MXN', 'USD', false],
  // fail-safe divisa vacía
  ['Cuenta 1200 MXN', '', false],
  ['Cuenta 1200 MXN', null, false],
];

for (const [applet, matcher] of Object.entries(APPLETS)) {
  test(`${applet}: matcher de divisa por name`, () => {
    for (const [name, cur, exp] of CASES) {
      assert.equal(matcher(name, cur), exp,
        `[${applet}] "${name}" vs ${cur} → esperado ${exp}`);
    }
  });
}

test('los dos gemelos coinciden caso por caso', () => {
  const inv = APPLETS['invoice-autofill.js (AR)'];
  const bill = APPLETS['bill-autofill.js (AP)'];
  for (const [name, cur] of CASES) {
    assert.equal(inv(name, cur), bill(name, cur),
      `divergencia gemelos en "${name}" vs ${cur}`);
  }
});
