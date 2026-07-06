// tools/test/hash-autopilot-date.test.js
// dateStrLocal: fecha YYYY-MM-DD en hora LOCAL, para que RUN_DATE coincida con
// el archivo que escribe validate-hashes.py (datetime.now(), también local).
// Sin esto, en UTC-6 de tarde/noche el motor buscaba el archivo de MAÑANA.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dateStrLocal } = require('../hash-autopilot/hash-autopilot.mjs');
// new Date(y, monthIndex, day, ...) interpreta en hora LOCAL, así que los getters
// locales devuelven exactamente esos componentes en cualquier TZ → test determinista.
test('dateStrLocal: usa componentes LOCALES, formato YYYY-MM-DD con padding', () => {
  assert.equal(dateStrLocal(new Date(2026, 6, 6, 23, 30)), '2026-07-06');   // 6 jul 23:30 local
  assert.equal(dateStrLocal(new Date(2026, 0, 5, 0, 1)), '2026-01-05');     // padding mes y día
});
