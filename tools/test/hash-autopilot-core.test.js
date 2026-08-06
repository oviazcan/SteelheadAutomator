// tools/test/hash-autopilot-core.test.js
// Núcleo PURO de hash-autopilot: clasificación de veredictos, shape check,
// decisión de deploy con freno de masa, y cobertura de recetas. Sin Playwright,
// sin red — todo testeable con node:test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOp, hasShape, planDeploy, missingCoverage, isValidatedCapture, pruneNeedsAttention, escalableNotCaptured } = require('../hash-autopilot/hash-autopilot-core.mjs');

const R = (op, verdict) => ({ op, verdict, cfgHash: 'old', liveHash: verdict === 'vigente' ? 'old' : 'new' });

test('classifyOp: capturado igual al config → vigente', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'aaa', http: 200, shapeOk: true }), 'vigente');
});
test('classifyOp: distinto + 200 + shape ok → rotadoValidado', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 200, shapeOk: true }), 'rotadoValidado');
});
test('classifyOp: distinto pero http 400 → sospechoso (no se deploya)', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 400, shapeOk: false }), 'sospechoso');
});
test('classifyOp: distinto + 200 pero sin shape → sospechoso', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: 'bbb', http: 200, shapeOk: false }), 'sospechoso');
});
test('classifyOp: no capturado (liveHash null) → noCapturado', () => {
  assert.equal(classifyOp({ cfgHash: 'aaa', liveHash: null, http: null, shapeOk: false }), 'noCapturado');
});

test('isValidatedCapture: responseOk del frontend → true', () => {
  assert.equal(isValidatedCapture({ responseOk: true }), true);
});
test('isValidatedCapture: captura-y-aborta con probe liveHash vigente → true (auto-deployable)', () => {
  assert.equal(isValidatedCapture({ abortProbeVigente: true }), true);
});
test('isValidatedCapture: sin evidencia (abortado + probe no vigente) → false (sospechoso)', () => {
  assert.equal(isValidatedCapture({}), false);
  assert.equal(isValidatedCapture({ responseOk: false, abortProbeVigente: false }), false);
});
test('captura-y-aborta validada por probe: liveHash≠cfg → rotadoValidado (se auto-deploya)', () => {
  const ok = isValidatedCapture({ abortProbeVigente: true });
  assert.equal(classifyOp({ cfgHash: 'old', liveHash: 'new', http: ok ? 200 : null, shapeOk: ok }), 'rotadoValidado');
});
test('captura-y-aborta con probe NO vigente (stale/auth): liveHash≠cfg → sospechoso (no deploya)', () => {
  const ok = isValidatedCapture({ abortProbeVigente: false });
  assert.equal(classifyOp({ cfgHash: 'old', liveHash: 'new', http: ok ? 200 : null, shapeOk: ok }), 'sospechoso');
});

test('hasShape: todas las llaves presentes → true', () => {
  assert.equal(hasShape({ pagedData: { nodes: [], totalCount: 3 } }, ['pagedData.nodes', 'pagedData.totalCount']), true);
});
test('hasShape: llave ausente → false', () => {
  assert.equal(hasShape({ pagedData: {} }, ['pagedData.nodes']), false);
});
test('hasShape: paths vacío → true (op sin shape declarado)', () => {
  assert.equal(hasShape({ anything: 1 }, []), true);
});

test('planDeploy: solo rotadoValidado va a toDeploy', () => {
  const res = [R('A', 'rotadoValidado'), R('B', 'vigente'), R('C', 'sospechoso'), R('D', 'noCapturado')];
  const p = planDeploy(res, {});
  assert.deepEqual(p.toDeploy.map((x) => x.op), ['A']);
  assert.deepEqual(p.suspicious.map((x) => x.op), ['C']);
  assert.deepEqual(p.notCaptured.map((x) => x.op), ['D']);
  assert.equal(p.massBrake, false);
});
test('planDeploy: >6 rotados dispara freno de masa (no deploya nada)', () => {
  const res = Array.from({ length: 7 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, true);
  assert.deepEqual(p.toDeploy, []);
  assert.match(p.reason, />6|freno|masa/i);
});
test('planDeploy: exactamente 6 rotados NO dispara freno', () => {
  const res = Array.from({ length: 6 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, false);
  assert.equal(p.toDeploy.length, 6);
});

// ── Freno de masa condicionado al PROBE (2026-08-05) ───────────────────────
// El freno medía "cuántos rotaron" y nunca "qué cuesta NO actuar". El 2026-08-05 bloqueó
// ~5 h el deploy de 14 hashes MUERTOS con los applets rotos en producción. Ahora la
// pregunta es: ¿el hash del config sigue vivo?
//   - cfgHash MUERTO  ⇒ el applet YA está roto. Corregir SIEMPRE, sin importar cuántos.
//   - cfgHash VIVO    ⇒ rotación "de futuro". Ahí sí frenar: no urge y protege del rollback.
const P = (ops, verdict) => Object.fromEntries(ops.map((o) => [o, verdict]));

test('planDeploy: 14 rotados con el hash viejo MUERTO se deployan TODOS (el caso 2026-08-05)', () => {
  const ops = Array.from({ length: 14 }, (_, i) => 'OP' + i);
  const res = ops.map((o) => R(o, 'rotadoValidado'));
  const p = planDeploy(res, { probeVerdicts: P(ops, 'stale') });
  assert.equal(p.massBrake, false, 'con el config muerto, frenar GARANTIZA el daño');
  assert.equal(p.toDeploy.length, 14);
});

test('planDeploy: muchos rotados con el hash viejo VIVO SÍ frenan (rotación de futuro)', () => {
  const ops = Array.from({ length: 7 }, (_, i) => 'OP' + i);
  const res = ops.map((o) => R(o, 'rotadoValidado'));
  const p = planDeploy(res, { probeVerdicts: P(ops, 'vigente') });
  assert.equal(p.massBrake, true);
  assert.deepEqual(p.toDeploy, [], 'nada urgente que salvar: los viejos siguen sirviendo');
  assert.equal(p.heldBack.length, 7);
});

test('planDeploy: freno MIXTO — retiene las de futuro pero deploya las MUERTAS', () => {
  // Lo que el freno viejo no podía hacer: era todo o nada, y elegía "nada".
  const muertas = ['M1', 'M2'];
  const vivas = Array.from({ length: 7 }, (_, i) => 'V' + i);
  const res = [...muertas, ...vivas].map((o) => R(o, 'rotadoValidado'));
  const p = planDeploy(res, { probeVerdicts: { ...P(muertas, 'stale'), ...P(vivas, 'vigente') } });
  assert.equal(p.massBrake, true, 'las 7 de futuro siguen frenando');
  assert.deepEqual(p.toDeploy.map((x) => x.op).sort(), ['M1', 'M2'], 'las MUERTAS se salvan igual');
  assert.equal(p.heldBack.length, 7);
  assert.match(p.reason, /vivo/i, 'la razón debe decir que el viejo sigue vivo, no solo contar');
});

test('planDeploy: SIN probe se comporta como antes (fail-safe: "no sé" no habilita deploy masivo)', () => {
  const res = Array.from({ length: 7 }, (_, i) => R('OP' + i, 'rotadoValidado'));
  assert.equal(planDeploy(res, {}).massBrake, true);
  assert.equal(planDeploy(res, { probeVerdicts: {} }).massBrake, true);
});

test('planDeploy: probe auth/unknown NO cuenta como muerto (no se asume urgencia)', () => {
  const ops = Array.from({ length: 7 }, (_, i) => 'OP' + i);
  const res = ops.map((o) => R(o, 'rotadoValidado'));
  assert.equal(planDeploy(res, { probeVerdicts: P(ops, 'auth') }).massBrake, true);
  assert.equal(planDeploy(res, { probeVerdicts: P(ops, 'unknown') }).massBrake, true);
});

test('planDeploy: pocas rotadas de futuro NO frenan (el umbral sigue vivo)', () => {
  const ops = ['A', 'B'];
  const res = ops.map((o) => R(o, 'rotadoValidado'));
  const p = planDeploy(res, { probeVerdicts: P(ops, 'vigente') });
  assert.equal(p.massBrake, false);
  assert.equal(p.toDeploy.length, 2);
});

test('planDeploy: rotado SIN cfgHash (hash de otro repo) NO se deploya, va a external', () => {
  const res = [
    { op: 'GetInsightsReportDetails', verdict: 'rotadoValidado', cfgHash: null, liveHash: 'new' },
    R('A', 'rotadoValidado'),
  ];
  const p = planDeploy(res, {});
  assert.deepEqual(p.toDeploy.map((x) => x.op), ['A']);
  assert.deepEqual(p.external.map((x) => x.op), ['GetInsightsReportDetails']);
});
test('planDeploy: los externos NO cuentan para el freno de masa', () => {
  const res = Array.from({ length: 7 }, (_, i) => ({ op: 'EXT' + i, verdict: 'rotadoValidado', cfgHash: null, liveHash: 'new' }));
  const p = planDeploy(res, {});
  assert.equal(p.massBrake, false);
  assert.deepEqual(p.toDeploy, []);
  assert.equal(p.external.length, 7);
});

test('missingCoverage: detecta ops target sin receta', () => {
  const recipes = { r1: { captures: ['AllCustomers'] }, r2: { captures: ['Customer'] } };
  const target = ['AllCustomers', 'Customer', 'CurrentUser'];
  assert.deepEqual(missingCoverage(recipes, target), ['CurrentUser']);
});
test('missingCoverage: todo cubierto → []', () => {
  const recipes = { r1: { captures: ['A', 'B'] } };
  assert.deepEqual(missingCoverage(recipes, ['A', 'B']), []);
});

test('pruneNeedsAttention: quita las ops resueltas y deja las pendientes', () => {
  const payload = { date: 'd', ops: [{ op: 'A' }, { op: 'B' }, { op: 'C' }] };
  const pruned = pruneNeedsAttention(payload, ['A', 'C']);
  assert.deepEqual(pruned.ops.map((o) => o.op), ['B']);
  assert.equal(pruned.date, 'd', 'preserva el resto del payload');
});

test('pruneNeedsAttention: todas resueltas → null (el caller borra el archivo)', () => {
  const payload = { date: 'd', ops: [{ op: 'A' }, { op: 'B' }] };
  assert.equal(pruneNeedsAttention(payload, ['A', 'B']), null);
});

test('pruneNeedsAttention: resolvedOps vacío → payload intacto', () => {
  const payload = { date: 'd', ops: [{ op: 'A' }] };
  assert.deepEqual(pruneNeedsAttention(payload, []).ops.map((o) => o.op), ['A']);
});

test('pruneNeedsAttention: payload nulo / sin ops → null (fail-safe)', () => {
  assert.equal(pruneNeedsAttention(null, ['A']), null);
  assert.equal(pruneNeedsAttention({ date: 'd' }, ['A']), null);
});

// ── escalableNotCaptured: quién merece despertar al Nivel B ────────────────────
test('escalableNotCaptured: excluye las suppressPendingReport (bug 2026-07-25)', () => {
  const nc = [{ op: 'CreateInvoicePdf' }, { op: 'SearchUnits' }];
  const out = escalableNotCaptured(nc, { suppressPending: ['CreateInvoicePdf'] });
  assert.deepEqual(out.map((r) => r.op), ['SearchUnits'],
    'CreateInvoicePdf es VIGENTE con captura flaky ya investigada → no escala ni alerta');
});

test('escalableNotCaptured: excluye también los huecos conocidos sin ruta', () => {
  const nc = [{ op: 'A' }, { op: 'B' }, { op: 'C' }];
  const out = escalableNotCaptured(nc, { knownNoRoute: ['A'], suppressPending: ['C'] });
  assert.deepEqual(out.map((r) => r.op), ['B']);
});

test('escalableNotCaptured: sin exclusiones → pasa todo (fail-open)', () => {
  const nc = [{ op: 'A' }, { op: 'B' }];
  assert.deepEqual(escalableNotCaptured(nc).map((r) => r.op), ['A', 'B']);
  assert.deepEqual(escalableNotCaptured(nc, {}).map((r) => r.op), ['A', 'B']);
});

test('escalableNotCaptured: entrada nula/sucia no truena', () => {
  assert.deepEqual(escalableNotCaptured(null, { suppressPending: ['X'] }), []);
  assert.deepEqual(escalableNotCaptured([null, { op: 'A' }], {}).map((r) => r.op), ['A']);
});

test('escalableNotCaptured: una suppressPending que SÍ capturó no pasa por aquí', () => {
  // Invariante de no-pérdida-de-detección: si el intento best-effort captura un hash
  // rotado, la op cae en toDeploy (verdict rotadoValidado), no en notCaptured.
  const results = [{ op: 'CreateInvoicePdf', verdict: 'rotadoValidado', cfgHash: 'old', liveHash: 'new' }];
  const plan = planDeploy(results, {});
  assert.deepEqual(plan.toDeploy.map((r) => r.op), ['CreateInvoicePdf']);
  assert.deepEqual(escalableNotCaptured(plan.notCaptured, { suppressPending: ['CreateInvoicePdf'] }), []);
});
