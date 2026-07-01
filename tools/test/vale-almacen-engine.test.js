// tools/test/vale-almacen-engine.test.js
// Golden tests del motor puro del Vale de Almacén (comentarios estructurados).
// Run: node --test tools/test/vale-almacen-engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../remote/scripts/vale-almacen-engine.js');

// ── buildLineComment ──────────────────────────────────────────────────────
test('buildLineComment: caso completo con número de empleado', () => {
  const s = E.buildLineComment({
    articleName: 'T205-MP00 Req. de Estannato de Potasio',
    quantity: 3,
    unidad: 'KGM',
    assigneeName: 'Juan Pérez García',
    employeeNumber: 'ABC1234',
    equipmentName: 'T205 Linea de Zinc',
  });
  assert.equal(
    s,
    '[VALE] art:"T205-MP00 Req. de Estannato de Potasio" cant:3 unidad:"KGM" user:"Juan Pérez García" emp:ABC1234 linea:"T205 Linea de Zinc" [/VALE]'
  );
});

test('buildLineComment: sin número de empleado → emp:?', () => {
  const s = E.buildLineComment({
    articleName: 'Guante Nitrilo', quantity: 2, unidad: 'PZA',
    assigneeName: 'Ana López', employeeNumber: null, equipmentName: 'T310',
  });
  assert.match(s, /emp:\?/);
  assert.match(s, /cant:2/);
});

test('buildLineComment: sin unidad omite el par', () => {
  const s = E.buildLineComment({
    articleName: 'Tornillo', quantity: 5, assigneeName: 'Beto', employeeNumber: 'XYZ9999', equipmentName: 'T100',
  });
  assert.doesNotMatch(s, /unidad:/);
});

test('buildLineComment: cantidad decimal se preserva', () => {
  const s = E.buildLineComment({
    articleName: 'Ácido', quantity: 3.5, unidad: 'LTS', assigneeName: 'Cira', employeeNumber: 'DEF0001', equipmentName: 'T205',
  });
  assert.match(s, /cant:3\.5/);
});

test('buildLineComment: escapa comillas dobles en los valores', () => {
  const s = E.buildLineComment({
    articleName: 'Cable 3" rojo', quantity: 1, assigneeName: 'Dr. "Chendo"', employeeNumber: null, equipmentName: 'T1',
  });
  assert.match(s, /art:"Cable 3\\" rojo"/);
  assert.match(s, /user:"Dr\. \\"Chendo\\""/);
});

// ── parseLineComment ──────────────────────────────────────────────────────
test('parseLineComment: round-trip fiel', () => {
  const line = {
    articleName: 'T205-MP00 Req. de Estannato de Potasio',
    quantity: 3, unidad: 'KGM',
    assigneeName: 'Juan Pérez García', employeeNumber: 'ABC1234',
    equipmentName: 'T205 Linea de Zinc',
  };
  const parsed = E.parseLineComment(E.buildLineComment(line));
  assert.deepEqual(parsed, line);
});

test('parseLineComment: emp:? → employeeNumber null', () => {
  const parsed = E.parseLineComment('[VALE] art:"X" cant:1 user:"Y" emp:? linea:"T1" [/VALE]');
  assert.equal(parsed.employeeNumber, null);
  assert.equal(parsed.quantity, 1);
  assert.equal(parsed.unidad, '');
});

test('parseLineComment: comillas escapadas se restauran', () => {
  const parsed = E.parseLineComment('[VALE] art:"Cable 3\\" rojo" cant:1 user:"Dr. \\"Chendo\\"" emp:? linea:"T1" [/VALE]');
  assert.equal(parsed.articleName, 'Cable 3" rojo');
  assert.equal(parsed.assigneeName, 'Dr. "Chendo"');
});

test('parseLineComment: texto sin sentinel → null', () => {
  assert.equal(E.parseLineComment('comentario libre del operador'), null);
  assert.equal(E.parseLineComment(''), null);
  assert.equal(E.parseLineComment(null), null);
});

test('parseLineComment: bloque sin art → null', () => {
  assert.equal(E.parseLineComment('[VALE] cant:1 user:"Y" [/VALE]'), null);
});

test('parseLineComment: tolera texto envolvente y saltos de línea', () => {
  const parsed = E.parseLineComment('Surtido del turno:\n[VALE] art:"Casco" cant:1 user:"Z" emp:GHI0007 linea:"T9" [/VALE]\nfin');
  assert.equal(parsed.articleName, 'Casco');
  assert.equal(parsed.employeeNumber, 'GHI0007');
});

// ── parseAllLines ─────────────────────────────────────────────────────────
test('parseAllLines: extrae varios bloques de un texto concatenado', () => {
  const txt = [
    E.buildHeaderComment({ fecha: '2026-06-30T14:00:00Z', equipmentName: 'T205', nodeName: 'SMP Surtimiento', pickupName: 'María', items: 2 }),
    E.buildLineComment({ articleName: 'Guante', quantity: 2, unidad: 'PZA', assigneeName: 'Juan', employeeNumber: 'ABC1234', equipmentName: 'T205' }),
    'comentario libre',
    E.buildLineComment({ articleName: 'Lentes', quantity: 1, assigneeName: 'Ana', employeeNumber: null, equipmentName: 'T205' }),
    E.buildFooterComment({ items: 2, completedAt: '2026-06-30T14:05:00Z' }),
  ].join('\n');
  const lines = E.parseAllLines(txt);
  assert.equal(lines.length, 2); // solo los [VALE], no INI/FIN ni el libre
  assert.equal(lines[0].articleName, 'Guante');
  assert.equal(lines[1].articleName, 'Lentes');
  assert.equal(lines[1].employeeNumber, null);
});

// ── header / footer ───────────────────────────────────────────────────────
test('buildHeaderComment: estructura correcta', () => {
  const s = E.buildHeaderComment({
    fecha: '2026-06-30T14:00:00Z', equipmentName: 'T205 Linea de Zinc',
    nodeName: 'SMP T205-LI Surtimiento de Materia Prima', pickupName: 'María López', items: 3,
  });
  assert.equal(
    s,
    '[VALE-INI] fecha:2026-06-30T14:00:00Z equipo:"T205 Linea de Zinc" nodo:"SMP T205-LI Surtimiento de Materia Prima" recoge:"María López" items:3 [/VALE-INI]'
  );
});

test('buildFooterComment: estructura correcta', () => {
  const s = E.buildFooterComment({ items: 3, completedAt: '2026-06-30T14:05:00Z' });
  assert.equal(s, '[VALE-FIN] items:3 completedAt:2026-06-30T14:05:00Z [/VALE-FIN]');
});

// ── validateValeLine ──────────────────────────────────────────────────────
test('validateValeLine: línea válida', () => {
  const r = E.validateValeLine({
    articleSensorId: 8482, articleName: 'Estannato', quantity: 3,
    assigneeId: 16884, assigneeName: 'Juan', equipmentName: 'T205',
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validateValeLine: falta artículo (sensorId)', () => {
  const r = E.validateValeLine({
    articleSensorId: null, articleName: '', quantity: 3,
    assigneeId: 1, assigneeName: 'Juan', equipmentName: 'T205',
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /artículo/i.test(e)));
});

test('validateValeLine: cantidad cero o negativa', () => {
  const r0 = E.validateValeLine({ articleSensorId: 1, articleName: 'X', quantity: 0, assigneeId: 1, assigneeName: 'J', equipmentName: 'T1' });
  const rNeg = E.validateValeLine({ articleSensorId: 1, articleName: 'X', quantity: -2, assigneeId: 1, assigneeName: 'J', equipmentName: 'T1' });
  assert.equal(r0.valid, false);
  assert.equal(rNeg.valid, false);
  assert.ok(r0.errors.some(e => /cantidad/i.test(e)));
});

test('validateValeLine: falta usuario asignado', () => {
  const r = E.validateValeLine({ articleSensorId: 1, articleName: 'X', quantity: 1, assigneeId: null, assigneeName: '', equipmentName: 'T1' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /usuario/i.test(e)));
});

test('validateValeLine: falta línea/equipo', () => {
  const r = E.validateValeLine({ articleSensorId: 1, articleName: 'X', quantity: 1, assigneeId: 1, assigneeName: 'J', equipmentName: '  ' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => /línea|equipo/i.test(e)));
});
