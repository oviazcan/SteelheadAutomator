// tools/test/hash-autopilot-core.test.js
// Núcleo PURO de hash-autopilot: clasificación de veredictos, shape check,
// decisión de deploy con freno de masa, y cobertura de recetas. Sin Playwright,
// sin red — todo testeable con node:test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOp, hasShape, planDeploy, missingCoverage, isValidatedCapture, pruneNeedsAttention, resolvedForPrune, escalableNotCaptured, newlyEscalated } = require('../hash-autopilot/hash-autopilot-core.mjs');

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

// ── poda por RETIRO del hash (incidente 2026-08-06) ───────────────────────────
// Una op cuyo hash se RETIRA del config (muerta, sin consumidor) desaparece de
// `results` para siempre → jamás entra a resolvedOps → el needs-attention quedaba
// armado indefinidamente y el cron del Nivel B gastaba un `claude -p` DIARIO sobre
// una op que ya no existe. Pasó con TempSpecFieldsAndOptions: retirada en v1.11.87
// (commit f56c10e) 50 min después de escalar; el motor ya no la nombra desde
// entonces y el archivo seguía apuntándola.
test('pruneNeedsAttention: quita las ops cuyo hash ya no está en el config (retiradas)', () => {
  const payload = { date: 'd', ops: [{ op: 'TempSpecFieldsAndOptions' }, { op: 'GetStation' }] };
  const pruned = pruneNeedsAttention(payload, [], ['GetStation', 'AllCustomers']);
  assert.deepEqual(pruned.ops.map((o) => o.op), ['GetStation'],
    'la retirada se va aunque nadie la haya "resuelto"');
});

test('pruneNeedsAttention: knownOps ausente → NO poda por retiro (fail-safe)', () => {
  const payload = { date: 'd', ops: [{ op: 'A' }] };
  assert.deepEqual(pruneNeedsAttention(payload, []).ops.map((o) => o.op), ['A']);
  assert.deepEqual(pruneNeedsAttention(payload, [], null).ops.map((o) => o.op), ['A']);
});

// AUSENTE ≠ VACÍO: si el config no cargó, knownOps llega [] y eso NO significa
// "ninguna op existe" — significa "no sé". Borrar todo ahí sería perder la señal.
test('pruneNeedsAttention: knownOps vacío → NO poda por retiro (AUSENTE ≠ VACÍO)', () => {
  const payload = { date: 'd', ops: [{ op: 'A' }, { op: 'B' }] };
  assert.deepEqual(pruneNeedsAttention(payload, [], []).ops.map((o) => o.op), ['A', 'B']);
});

test('pruneNeedsAttention: retiradas + resueltas hasta vaciar → null', () => {
  const payload = { date: 'd', ops: [{ op: 'Retirada' }, { op: 'Resuelta' }] };
  assert.equal(pruneNeedsAttention(payload, ['Resuelta'], ['Resuelta', 'Otra']), null);
});

// ── resolvedForPrune: TERCERA y CUARTA puerta del mismo cry-wolf (2026-08-08) ──
// El needs-attention del 2026-08-06 quedó armado DOS DÍAS con dos ops ya resueltas,
// y el cron del Nivel B gastó un `claude -p` diario sobre ellas. Cada una entró por
// una puerta distinta que `resolvedOps` (verdict 'vigente') no cubría:
//
//  • CreateManySensorMeasurements — su receta se REPARÓ y el hash se deployó 1 h
//    después de escalar (8e049f5). Al dejar de estar stale, el motor ya no la mete
//    en `results`: nunca vuelve a tener verdict, así que nunca se poda.
//  • SaveManyPartNumberPrices — la receta SÍ dispara (captura en cada corrida), pero
//    lo que captura es OTRA variante viva del mismo operationName, así que el verdict
//    es 'sospechoso' (fail-safe correcto: no se deploya). Con captura, la premisa de
//    la escalación —"la receta no disparó la op (0 capturas)"— ya es falsa.
//
// El criterio no es nuevo: es el MISMO gate por probe que ya suprime las falsas
// alarmas NUEVAS (gate.falseAlarms). Lo que faltaba era aplicárselo a las VIEJAS.
test('resolvedForPrune: verdict vigente y ops deployadas cuentan como resueltas', () => {
  const r = resolvedForPrune({
    results: [{ op: 'A', verdict: 'vigente' }, { op: 'B', verdict: 'rotadoValidado', liveHash: 'x' }],
    deployedOps: ['B'],
  });
  assert.deepEqual(r.map((x) => x.op).sort(), ['A', 'B']);
  assert.equal(r.find((x) => x.op === 'A').motivo, 'vigente');
});

test('resolvedForPrune: probe vigente resuelve aunque la op ya no esté en results', () => {
  const r = resolvedForPrune({ results: [], probeVerdicts: { CreateManySensorMeasurements: 'vigente' } });
  assert.deepEqual(r, [{ op: 'CreateManySensorMeasurements', motivo: 'probe-vigente' }]);
});

test('resolvedForPrune: captura resuelve aunque el verdict sea sospechoso', () => {
  const r = resolvedForPrune({
    results: [{ op: 'SaveManyPartNumberPrices', verdict: 'sospechoso', liveHash: '3f757f31' }],
  });
  assert.deepEqual(r, [{ op: 'SaveManyPartNumberPrices', motivo: 'capturada' }]);
});

test('resolvedForPrune: sin captura y probe stale → NO resuelta', () => {
  const r = resolvedForPrune({
    results: [{ op: 'X', verdict: 'noCapturado', liveHash: null }],
    probeVerdicts: { X: 'stale' },
  });
  assert.deepEqual(r, []);
});

// Fail-safe: un probe que no concluye (auth/unknown) NO es evidencia de nada. Podar
// ahí sería perder la señal por una sesión degradada — el error que ya costó dos
// corridas completas del Nivel B (07-28 y 07-31).
test('resolvedForPrune: probe auth/unknown no resuelve', () => {
  assert.deepEqual(resolvedForPrune({ probeVerdicts: { X: 'auth', Y: 'unknown' } }), []);
});

test('resolvedForPrune: entradas vacías o ausentes → [] (no poda nada)', () => {
  assert.deepEqual(resolvedForPrune(), []);
  assert.deepEqual(resolvedForPrune({}), []);
  assert.deepEqual(resolvedForPrune({ results: [null], probeVerdicts: null, deployedOps: null }), []);
});

test('resolvedForPrune: una op resuelta por dos vías se reporta una sola vez', () => {
  const r = resolvedForPrune({
    results: [{ op: 'A', verdict: 'vigente', liveHash: 'h' }],
    probeVerdicts: { A: 'vigente' },
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].motivo, 'vigente', 'gana el motivo más fuerte');
});

test('resolvedForPrune alimenta pruneNeedsAttention: el caso REAL del 2026-08-06', () => {
  const payload = {
    date: '2026-08-06',
    ops: [{ op: 'CreateManySensorMeasurements' }, { op: 'SaveManyPartNumberPrices' }],
  };
  const resolved = resolvedForPrune({
    results: [{ op: 'SaveManyPartNumberPrices', verdict: 'sospechoso', liveHash: '3f757f31' }],
    probeVerdicts: { CreateManySensorMeasurements: 'vigente' },
  });
  assert.equal(pruneNeedsAttention(payload, resolved.map((x) => x.op), ['CreateManySensorMeasurements', 'SaveManyPartNumberPrices']), null);
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

// ── newlyEscalated: el disparador de la notificación ─────────────────────────
// needs-attention.json se reescribe en CADA corrida con algo que escalar (el autopilot
// corre por hora). Avisar por su existencia mandaría 24 correos al día sobre lo mismo, y un
// aviso que llega siempre se deja de leer. Solo se avisa por lo que aparece por primera vez.
const NA = (...ops) => ({ date: '2026-08-06', ops: ops.map((op) => ({ op, observed: 'x' })) });

test('newlyEscalated: sin previo (primera escalada) → avisa de todas', () => {
  assert.deepEqual(newlyEscalated(null, NA('AllEquipments', 'WorkOrderSchedule')),
    ['AllEquipments', 'WorkOrderSchedule']);
});
test('newlyEscalated: las MISMAS ops de la corrida anterior → NO avisa (nada de spam horario)', () => {
  assert.deepEqual(newlyEscalated(NA('AllEquipments'), NA('AllEquipments')), []);
});
test('newlyEscalated: solo la op nueva, no la que ya venía escalada', () => {
  assert.deepEqual(newlyEscalated(NA('AllEquipments'), NA('AllEquipments', 'WorkOrderSchedule')),
    ['WorkOrderSchedule']);
});
test('newlyEscalated: una op que se resolvió y REGRESA vuelve a avisar (una regresión es noticia)', () => {
  // la poda la quitó del previo → reaparece como nueva
  assert.deepEqual(newlyEscalated(NA('OtraOp'), NA('AllEquipments')), ['AllEquipments']);
});
test('newlyEscalated: nada que escalar → no avisa', () => {
  assert.deepEqual(newlyEscalated(NA('AllEquipments'), { date: 'x', ops: [] }), []);
  assert.deepEqual(newlyEscalated(null, null), []);
});
test('newlyEscalated: previo CORRUPTO se trata como ausente y avisa (AUSENTE ≠ VACÍO)', () => {
  // Un previo ilegible es "no sé qué había", no "no había nada": perder la señal cuesta
  // más que un correo de más. Un {ops:[]} explícito SÍ es conocimiento y también avisa,
  // porque de verdad no había nada escalado antes.
  assert.deepEqual(newlyEscalated({ basura: true }, NA('AllEquipments')), ['AllEquipments']);
  assert.deepEqual(newlyEscalated({ date: 'x', ops: [] }, NA('AllEquipments')), ['AllEquipments']);
});
test('newlyEscalated: tolera entradas nulas dentro de ops sin reventar', () => {
  assert.deepEqual(newlyEscalated({ ops: [null] }, { ops: [null, { op: 'A' }] }), ['A']);
});

// ── Cableado: que la decisión pura llegue de verdad al correo ────────────────
// El aviso es un contrato entre TRES piezas —el core decide, writeNeedsAttention lo
// invoca, autopilot-notify.sh manda el correo— y ninguna falla sola: si el runner deja de
// llamar a notifyNewlyEscalated, los tests puros siguen verdes y el silencio vuelve sin que
// nada se ponga rojo. Es exactamente el modo de falla que este archivo existe para cerrar.
const { readFileSync: _rf } = require('fs');
const RUNNER = _rf(require('path').join(__dirname, '../hash-autopilot/hash-autopilot.mjs'), 'utf8');

test('cableado: el runner importa newlyEscalated del core', () => {
  assert.match(RUNNER, /import\s*\{[^}]*\bnewlyEscalated\b[^}]*\}\s*from\s*'\.\/hash-autopilot-core\.mjs'/);
});
test('cableado: writeNeedsAttention lee el previo ANTES de sobrescribirlo', () => {
  const fn = RUNNER.slice(RUNNER.indexOf('function writeNeedsAttention'));
  const cuerpo = fn.slice(0, fn.indexOf('\n}'));
  const leePrevio = cuerpo.indexOf('readFileSync');
  const escribe = cuerpo.indexOf('writeFileSync');
  assert.ok(leePrevio > -1, 'sin leer el previo no se puede distinguir op nueva de op repetida');
  assert.ok(leePrevio < escribe, 'leer DESPUÉS de escribir compararía el archivo contra sí mismo → nunca avisa');
});
test('cableado: writeNeedsAttention dispara la notificación', () => {
  const fn = RUNNER.slice(RUNNER.indexOf('function writeNeedsAttention'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /notifyNewlyEscalated\(/);
});
test('cableado: notifica como "revision" (el autopilot funcionó; pide una persona)', () => {
  const fn = RUNNER.slice(RUNNER.indexOf('function notifyNewlyEscalated'));
  assert.match(fn.slice(0, 2000), /notify\(\s*'revision'/);
});
test('cableado: un dry-run NUNCA manda correo', () => {
  const fn = RUNNER.slice(RUNNER.indexOf('function notifyNewlyEscalated'));
  const cuerpo = fn.slice(0, 2000);
  assert.ok(cuerpo.indexOf('if (DRY)') > -1 && cuerpo.indexOf('if (DRY)') < cuerpo.indexOf("notify('revision'"),
    'el guard de DRY debe estar ANTES del envío');
});
