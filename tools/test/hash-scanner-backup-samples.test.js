// tools/test/hash-scanner-backup-samples.test.js
// El backup slim conserva las MUESTRAS de las ops NUEVAS/CAMBIADAS.
//
// Causa raíz (scan 2026-07-27): el flujo de "Agrupar/Serializar Piezas" disparó 8 ops
// nuevas (CreateManyPartGroups, GroupPartsDialogQuery, …). La página recargó al Guardar,
// slimForBackup() guardó SOLO hash+count+screens con las muestras VACÍAS, y al reiniciar
// mergeResults restauró esas entradas huecas. Resultado: los hashes sobrevivieron pero los
// payloads —lo único que permite escribir el applet— se perdieron para siempre.
//
// Las ops 'known' siguen SIN muestras: ya están documentadas y son la mayoría del volumen,
// así que gastar cuota de localStorage en ellas no compra nada.
const test = require('node:test');
const assert = require('node:assert/strict');
const HashScanner = require('../../remote/scripts/hash-scanner.js');
const { discovered, slimForBackup, truncateForBackup, persistBackup } = HashScanner._internal;

function reset() { for (const k of Object.keys(discovered)) delete discovered[k]; }

function opEntry(over = {}) {
  return {
    hash: 'h', count: 1, status: 'new', configKey: null, screens: [],
    variablesSamples: [], responseSamples: [], errorSamples: [], errorCount: 0,
    ...over,
  };
}

test('op NUEVA conserva sus variablesSamples en el backup', () => {
  reset();
  discovered.CreateManyPartGroups = opEntry({
    variablesSamples: [{ input: { partGroups: [{ name: '100' }] } }],
  });
  const slim = slimForBackup();
  assert.deepEqual(slim.CreateManyPartGroups.variablesSamples,
    [{ input: { partGroups: [{ name: '100' }] } }]);
});

test('op NUEVA conserva una responseSample en el backup', () => {
  reset();
  discovered.GroupPartsDialogQuery = opEntry({
    responseSamples: [{ allPartGroups: { nodes: [{ id: 948191, name: '100' }] } }],
  });
  const slim = slimForBackup();
  assert.equal(slim.GroupPartsDialogQuery.responseSamples.length, 1);
  assert.equal(slim.GroupPartsDialogQuery.responseSamples[0].allPartGroups.nodes[0].id, 948191);
});

test('op CHANGED también conserva muestras (hash rotado = payload que documentar)', () => {
  reset();
  discovered.GetPartNumber = opEntry({ status: 'changed', variablesSamples: [{ partNumberId: 7 }] });
  assert.equal(slimForBackup().GetPartNumber.variablesSamples.length, 1);
});

test('op KNOWN sigue SIN muestras (no gasta cuota en lo ya documentado)', () => {
  reset();
  discovered.CurrentUser = opEntry({
    status: 'known',
    variablesSamples: [{ a: 1 }],
    responseSamples: [{ big: 'x'.repeat(9999) }],
  });
  const slim = slimForBackup();
  assert.deepEqual(slim.CurrentUser.variablesSamples, []);
  assert.deepEqual(slim.CurrentUser.responseSamples, []);
});

test('truncateForBackup recorta arrays largos y marca el recorte', () => {
  const big = { nodes: Array.from({ length: 500 }, (_, i) => ({ id: i })) };
  const cut = truncateForBackup(big, 3);
  assert.equal(cut.nodes.length, 4);              // 3 elementos + el marcador
  assert.equal(cut.nodes[3].__saTruncated, 497);  // cuántos se tiraron
  assert.equal(cut.nodes[0].id, 0);               // preserva la FORMA (que es lo que sirve)
});

test('truncateForBackup no altera un objeto que ya cabe', () => {
  const small = { nodes: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(truncateForBackup(small, 3), small);
});

test('una response gigante NO se come el presupuesto: se trunca', () => {
  reset();
  discovered.Pesada = opEntry({
    responseSamples: [{ nodes: Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `n${i}` })) }],
  });
  const bytes = JSON.stringify(slimForBackup()).length;
  assert.ok(bytes < 200000, `el backup pesó ${bytes} bytes — debía truncarse`);
});

test('presupuesto global: las VARIABLES se priorizan sobre las respuestas', () => {
  reset();
  // 60 ops nuevas, cada una con una respuesta pesada y variables chiquitas.
  for (let i = 0; i < 60; i++) {
    discovered[`Op${i}`] = opEntry({
      variablesSamples: [{ id: i }],
      responseSamples: [{ nodes: Array.from({ length: 4000 }, (_, j) => ({ id: j, blob: 'y'.repeat(40) })) }],
    });
  }
  const slim = slimForBackup();
  const conVars = Object.values(slim).filter((o) => o.variablesSamples.length > 0).length;
  assert.equal(conVars, 60, 'todas las ops deben conservar sus variables');
  const bytes = JSON.stringify(slim).length;
  assert.ok(bytes < 2_000_000, `el backup pesó ${bytes} bytes — excede el presupuesto`);
});

test('round-trip: mergeResults recupera las muestras del backup serializado', () => {
  reset();
  discovered.CreateNewPartGroup = opEntry({
    variablesSamples: [{ input: { name: '200' } }],
    responseSamples: [{ createNewPartGroup: { partGroup: { id: 948192 } } }],
  });
  const wire = JSON.parse(JSON.stringify(slimForBackup()));
  reset();                       // simula la recarga: el estado en memoria se pierde
  HashScanner.mergeResults(wire);
  assert.deepEqual(discovered.CreateNewPartGroup.variablesSamples[0], { input: { name: '200' } });
  assert.equal(discovered.CreateNewPartGroup.responseSamples[0].createNewPartGroup.partGroup.id, 948192);
});

test('persistBackup cae al mínimo si la cuota revienta — nunca pierde los hashes', () => {
  reset();
  discovered.Op = opEntry({ variablesSamples: [{ a: 1 }], responseSamples: [{ b: 2 }] });
  const store = {};
  let intentos = 0;
  const ls = {
    setItem(k, v) {
      intentos++;
      if (intentos === 1) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      store[k] = v;
    },
  };
  assert.equal(persistBackup(ls), true);
  assert.equal(intentos, 2, 'debe reintentar con el backup mínimo');
  const guardado = JSON.parse(store.__sa_scan_backup);
  assert.equal(guardado.Op.hash, 'h');                  // el hash sobrevive
  assert.deepEqual(guardado.Op.variablesSamples, []);   // las muestras se sacrifican, no el hash
});

test('persistBackup devuelve false si ni el mínimo cabe (no lanza)', () => {
  reset();
  discovered.Op = opEntry();
  const ls = { setItem() { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } };
  assert.equal(persistBackup(ls), false);
});
