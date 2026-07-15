// tools/test/bulk-upload-pnlookup-tdz.test.js
// Regresión del bug 1.5.39: "Cannot access 'pnLookup' before initialization".
//
// El troceo SOLO_PN (#4, v1.5.37) envolvió el bloque de ejecución en un `for` sobre
// lotes y, para resetear estado entre lotes, agregó `pnLookup.clear()` al inicio del
// cuerpo del for. Pero `pnLookup` se declara con `const` MÁS ABAJO, dentro del mismo
// cuerpo del for → temporal dead zone: acceder a él antes de su declaración lanza
// FATAL. Solo se disparaba con troceo activo (>1000 filas SOLO_PN), por eso los
// archivos chicos (monolíticos, doBatch=false) no lo pescaban.
//
// A diferencia de `parts`/`pnStatus` (scope superior → hay que rellenarlos por lote),
// `pnLookup` es LOCAL al cuerpo del for: cada iteración ya crea un `new Map()` fresco.
// El invariante: ninguna referencia de CÓDIGO a `pnLookup` debe preceder a su `const`
// dentro del bloque del for de troceo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload.js'), 'utf8');
const LINES = SRC.split('\n');

test('TDZ: no se referencia pnLookup antes de su const dentro del for de troceo', () => {
  const forIdx = LINES.findIndex(l => l.includes('for (let __soloBatchIdx'));
  assert.ok(forIdx >= 0, 'no se encontró el for de troceo (for (let __soloBatchIdx ...)');

  const declIdx = LINES.findIndex((l, i) => i > forIdx && /const\s+pnLookup\s*=/.test(l));
  assert.ok(declIdx > forIdx, 'no se encontró la declaración `const pnLookup =` después del for');

  // Líneas entre el for (inclusive) y la declaración (exclusive), sin comentarios de línea.
  const offenders = LINES
    .slice(forIdx, declIdx)
    .map((l, i) => ({ n: forIdx + i + 1, code: l.replace(/\/\/.*$/, '') }))
    .filter(x => /\bpnLookup\b/.test(x.code));

  assert.deepEqual(
    offenders.map(o => o.n), [],
    `uso de pnLookup ANTES de su declaración const (TDZ) en línea(s): ${offenders.map(o => o.n).join(', ')}`);
});
