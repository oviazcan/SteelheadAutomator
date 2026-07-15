// tools/test/bulk-upload-batch.test.js
// Golden test de la planeación de lotes (troceo SOLO_PN) — bulk-upload-batch.js.
//
// Foco crítico: el INVARIANTE DE NO-REGRESIÓN. Cuando no aplica troceo, la función
// DEBE devolver exactamente UN rango [[0, total]] para que el caller corra el bloque
// de ejecución en una sola iteración byte-idéntica al comportamiento actual.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { planBatchRanges, batchLabel, describeBatchPlan, isValidSize } =
  require(path.join(__dirname, '..', '..', 'remote', 'scripts', 'bulk-upload-batch.js'));

// --- Helper: verifica el invariante de cobertura de un conjunto de rangos ---
function assertCovers(ranges, total, msg) {
  // contiguos desde 0, cubren hasta total, sin huecos ni traslapes
  let cursor = 0;
  for (const [s, e] of ranges) {
    assert.equal(s, cursor, `${msg}: rango arranca en ${s}, esperaba ${cursor}`);
    assert.ok(e >= s, `${msg}: rango [${s},${e}] invertido`);
    cursor = e;
  }
  assert.equal(cursor, total, `${msg}: cobertura termina en ${cursor}, esperaba ${total}`);
}

test('no-regresión: size falsy → un solo rango completo', () => {
  assert.deepEqual(planBatchRanges(8862, 0), [[0, 8862]]);
  assert.deepEqual(planBatchRanges(8862, null), [[0, 8862]]);
  assert.deepEqual(planBatchRanges(500, undefined), [[0, 500]]);
});

test('no-regresión: total <= size → un solo rango completo', () => {
  assert.deepEqual(planBatchRanges(1000, 1000), [[0, 1000]]);
  assert.deepEqual(planBatchRanges(500, 1000), [[0, 500]]);
  assert.deepEqual(planBatchRanges(1, 1000), [[0, 1]]);
});

test('no-regresión: size inválido (negativo/NaN/fraccional) → un solo rango', () => {
  assert.deepEqual(planBatchRanges(500, -5), [[0, 500]]);
  assert.deepEqual(planBatchRanges(500, NaN), [[0, 500]]);
  assert.deepEqual(planBatchRanges(500, 3.5), [[0, 500]]);
  assert.deepEqual(planBatchRanges(500, Infinity), [[0, 500]]);
  assert.deepEqual(planBatchRanges(500, '1000'), [[0, 500]]); // string no es size válido
});

test('troceo real: 8862 filas / 1000 → 9 lotes, último parcial (862)', () => {
  const r = planBatchRanges(8862, 1000);
  assert.deepEqual(r, [
    [0, 1000], [1000, 2000], [2000, 3000], [3000, 4000], [4000, 5000],
    [5000, 6000], [6000, 7000], [7000, 8000], [8000, 8862],
  ]);
  assert.equal(r.length, 9);
  assertCovers(r, 8862, '8862/1000');
});

test('troceo exacto: 3000 / 1000 → 3 lotes, sin rango vacío al final', () => {
  const r = planBatchRanges(3000, 1000);
  assert.deepEqual(r, [[0, 1000], [1000, 2000], [2000, 3000]]);
  assert.equal(r.length, 3);
  assertCovers(r, 3000, '3000/1000');
});

test('size 1: 3 / 1 → 3 lotes unitarios', () => {
  assert.deepEqual(planBatchRanges(3, 1), [[0, 1], [1, 2], [2, 3]]);
});

test('total 0 → una iteración no-op [[0,0]]', () => {
  assert.deepEqual(planBatchRanges(0, 1000), [[0, 0]]);
  assert.deepEqual(planBatchRanges(0, 0), [[0, 0]]);
});

test('total inválido → [[0,0]]', () => {
  assert.deepEqual(planBatchRanges(-3, 1000), [[0, 0]]);
  assert.deepEqual(planBatchRanges(NaN, 1000), [[0, 0]]);
  assert.deepEqual(planBatchRanges(undefined, 1000), [[0, 0]]);
});

test('total fraccional se pisa a entero', () => {
  assert.deepEqual(planBatchRanges(2500.9, 1000), [[0, 1000], [1000, 2000], [2000, 2500]]);
});

test('cobertura para varios tamaños (property-style)', () => {
  for (const total of [0, 1, 999, 1000, 1001, 2000, 8862, 20000]) {
    for (const size of [0, 1, 100, 1000, 5000]) {
      const r = planBatchRanges(total, size);
      const norm = Math.max(0, Math.floor(total));
      assertCovers(r, norm, `total=${total} size=${size}`);
      // no-regresión: si no trocea, exactamente 1 rango
      if (!isValidSize(size) || norm <= size) {
        assert.equal(r.length, 1, `total=${total} size=${size}: debía ser 1 rango`);
      }
      // ningún rango vacío salvo el caso total=0
      if (norm > 0) {
        for (const [s, e] of r) assert.ok(e > s, `total=${total} size=${size}: rango vacío [${s},${e}]`);
      }
    }
  }
});

test('batchLabel es 1-based', () => {
  assert.equal(batchLabel(0, 9), 'Lote 1/9');
  assert.equal(batchLabel(8, 9), 'Lote 9/9');
  assert.equal(batchLabel(0, 1), 'Lote 1/1');
});

test('describeBatchPlan: resumen para el preview', () => {
  const d = describeBatchPlan(8862, 1000);
  assert.equal(d.total, 8862);
  assert.equal(d.size, 1000);
  assert.equal(d.batches, 9);
  assert.equal(d.willBatch, true);
  assert.deepEqual(d.sizes, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 862]);
  assert.equal(d.sizes.reduce((a, b) => a + b, 0), 8862);
});

test('describeBatchPlan: sin troceo → willBatch=false, un lote', () => {
  const d = describeBatchPlan(500, 1000);
  assert.equal(d.batches, 1);
  assert.equal(d.willBatch, false);
  assert.equal(d.size, 1000);      // size válido pero no se trocea (total<=size)
  assert.deepEqual(d.sizes, [500]);

  const d2 = describeBatchPlan(500, 0);
  assert.equal(d2.willBatch, false);
  assert.equal(d2.size, null);     // size inválido
});

test('isValidSize', () => {
  assert.equal(isValidSize(1000), true);
  assert.equal(isValidSize(1), true);
  assert.equal(isValidSize(0), false);
  assert.equal(isValidSize(-1), false);
  assert.equal(isValidSize(3.5), false);
  assert.equal(isValidSize(NaN), false);
  assert.equal(isValidSize(Infinity), false);
  assert.equal(isValidSize('1000'), false);
  assert.equal(isValidSize(null), false);
});
