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

// ── Degradar antes que descartar (2026-07-28) ────────────────────────────────
// El fix de arriba no alcanzó para las ops PESADAS: `take()` hacía UN recorte (arrays a 8)
// y, si aun así no cabía en BACKUP_BYTES_PER_OP, tiraba la muestra ENTERA. Justo las más
// caras de recapturar. Caso real: `CreateManyScheduleTasks` (crear una tarea de
// programación) llevaba desde el 2026-07-23 con hash y count=1 pero SIN una sola variable
// en 9 scans seguidos, mientras su hermana `UpdateManyScheduleTasks` (245 B) sí sobrevivía.
// Sin variables no se puede escribir la llamada → "programar donde no hay tarea" quedó
// bloqueado semanas por una poda de backup, no por el ERP.

// Payload deliberadamente enorme: ni recortado a 8 elementos baja de 120 KB.
function payloadPesado(nNodos = 4000) {
  return {
    scheduledTasks: { mnScheduleTask: [{
      scheduleId: 454, treatmentId: 94832, stationId: 12101,
      scheduleTaskElementsByScheduleTaskId: {
        nodes: Array.from({ length: nNodos }, (_, i) => ({
          partSetUuid: 'uuid-' + i + '-'.repeat(20),
          recipeNodeId: 46711342 + i, partNumberId: 3028455,
          rackIdLineage: [1, 2, 3], rackTypeIdLineage: [4, 5, 6],
          partCount: 50, partsPerBatch: 4,
          relatedPartTransferAccounts: [{ id: 44956003 + i, partCount: 50 }],
        })),
      },
    }] },
  };
}

test('una muestra PESADA se guarda recortada en vez de perderse', () => {
  reset();
  discovered.CreateManyScheduleTasks = opEntry({ variablesSamples: [payloadPesado()] });
  const slim = slimForBackup();
  const vs = slim.CreateManyScheduleTasks.variablesSamples;
  assert.equal(vs.length, 1, 'la muestra pesada NO debe descartarse');
  assert.ok(JSON.stringify(vs[0]).length <= 120000, 'debe caber en el tope por op');
});

test('la muestra recortada conserva la FORMA — que es para lo que sirve', () => {
  reset();
  discovered.CreateManyScheduleTasks = opEntry({ variablesSamples: [payloadPesado()] });
  const v = slimForBackup().CreateManyScheduleTasks.variablesSamples[0];
  // los campos que hacen falta para escribir la llamada siguen ahí
  const tarea = v.scheduledTasks.mnScheduleTask[0];
  assert.equal(tarea.scheduleId, 454);
  assert.equal(tarea.treatmentId, 94832);
  const nodo = tarea.scheduleTaskElementsByScheduleTaskId.nodes[0];
  for (const k of ['partSetUuid', 'recipeNodeId', 'partNumberId', 'rackIdLineage',
                   'rackTypeIdLineage', 'partCount', 'partsPerBatch', 'relatedPartTransferAccounts']) {
    assert.ok(k in nodo, `se perdió el campo ${k}: la forma ya no documenta la llamada`);
  }
});

test('op chica no se degrada: sigue guardándose completa', () => {
  reset();
  // el payload REAL de UpdateManyScheduleTasks (245 B) — no debe tocarse
  const real = { scheduledTasks: [{ id: 86745, scheduleId: 454, stationId: 12101,
    expectedStartTime: '2026-07-22T22:00:00.000Z', totalTimeMinutes: 5,
    cycleTimeMinutes: 0.0009090909090909091, treatmentTimeMinutes: 0.0009090909090909705,
    isIntentional: true }] };
  discovered.UpdateManyScheduleTasks = opEntry({ variablesSamples: [real] });
  assert.deepEqual(slimForBackup().UpdateManyScheduleTasks.variablesSamples, [real]);
});

test('si de plano no cabe, la entrada queda MARCADA (no muda)', () => {
  reset();
  // arrays de 1 elemento no ayudan si el peso está en un solo string gigante
  discovered.OpImposible = opEntry({ variablesSamples: [{ blob: 'x'.repeat(200000) }] });
  const slim = slimForBackup();
  assert.equal(slim.OpImposible.variablesSamples.length, 0);
  assert.equal(slim.OpImposible.samplesLost, true,
    'una entrada con hash y sin muestras debe DECIR que perdió las muestras');
});

test('round-trip: la op pesada sobrevive a la recarga con payload utilizable', () => {
  reset();
  discovered.CreateManyScheduleTasks = opEntry({ variablesSamples: [payloadPesado()] });
  const store = { data: {}, setItem(k, v) { this.data[k] = v; }, getItem(k) { return this.data[k] ?? null; } };
  assert.equal(persistBackup(store), true);
  const restored = JSON.parse(store.data.__sa_scan_backup);
  const nodo = restored.CreateManyScheduleTasks.variablesSamples[0]
    .scheduledTasks.mnScheduleTask[0].scheduleTaskElementsByScheduleTaskId.nodes[0];
  assert.ok(nodo.partSetUuid, 'tras recargar sigue habiendo con qué escribir la llamada');
});
