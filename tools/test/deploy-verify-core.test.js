// tools/test/deploy-verify-core.test.js
// TRINQUETE del incidente 2026-08-05: tres deploys del autopilot quedaron atorados sin
// llegar a producción (sitio en 1.11.77, main en 1.11.80) y el motor cerró en SILENCIO.
// Estas pruebas fijan que el camino "el push no llegó al sitio EN VIVO" NO pueda volver
// a terminar en éxito silencioso.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyPushError,
  verifyLiveDeploy,
  detectLiveDrift,
  formatDeployNotLiveAlert,
} = require('../hash-autopilot/deploy-verify-core.mjs');

const cfg = (queries = {}, mutations = {}, version = '1.0.0') => ({
  version,
  steelhead: { hashes: { queries, mutations } },
});

// ── classifyPushError ───────────────────────────────────────────────────────
test('classifyPushError: reconoce el rechazo real de git (el del incidente)', () => {
  const real = `To https://github.com/oviazcan/SteelheadAutomator.git
 ! [rejected]        gh-pages -> gh-pages (non-fast-forward)
error: failed to push some refs to 'https://github.com/oviazcan/SteelheadAutomator.git'
hint: Updates were rejected because the tip of your current branch is behind`;
  assert.equal(classifyPushError(real), 'non-fast-forward');
  assert.equal(classifyPushError('hint: Updates were rejected because ...'), 'non-fast-forward');
  assert.equal(classifyPushError(' ! [rejected] (fetch first)'), 'non-fast-forward');
});

test('classifyPushError: fail-closed — lo que no sabemos resolver NO se rebasea', () => {
  // Un rechazo por permisos o por el pre-push NO debe disparar un rebase automático:
  // reescribir historia sobre una causa que no leímos es peor que fallar.
  assert.equal(classifyPushError('remote: Permission denied'), 'other');
  assert.equal(classifyPushError('pre-push: gh-pages NO espeja main:remote/'), 'other');
  assert.equal(classifyPushError(''), 'other');
  assert.equal(classifyPushError(null), 'other');
  assert.equal(classifyPushError(undefined), 'other');
});

// ── verifyLiveDeploy — el corazón del trinquete ─────────────────────────────
test('verifyLiveDeploy: EL CASO DEL INCIDENTE — repo corregido, sitio con el viejo ⇒ NO ok', () => {
  // Reproduce InvoiceByIdInDomain: el repo (y el commit, y el tag) ya traen 6535d82a,
  // pero gh-pages sigue publicando el hash muerto 06a51d03.
  const live = cfg({ InvoiceByIdInDomain: '06a51d03' }, {}, '1.11.77');
  const r = verifyLiveDeploy(live, [{ op: 'InvoiceByIdInDomain', liveHash: '6535d82a' }]);
  assert.equal(r.ok, false, 'un deploy que no llegó al sitio JAMÁS puede reportarse ok');
  assert.deepEqual(r.missing, [{ op: 'InvoiceByIdInDomain', expected: '6535d82a', live: '06a51d03' }]);
});

test('verifyLiveDeploy: sólo dice ok cuando el sitio sirve EXACTAMENTE lo deployado', () => {
  const live = cfg({ GetStation: '17b32d82', WorkboardById: '646200a9' });
  const r = verifyLiveDeploy(live, [
    { op: 'GetStation', liveHash: '17b32d82' },
    { op: 'WorkboardById', liveHash: '646200a9' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});

test('verifyLiveDeploy: detecta el deploy PARCIAL (uno llegó, otro no)', () => {
  const live = cfg({ GetStation: '17b32d82', WorkboardById: '68b7ca4c' });
  const r = verifyLiveDeploy(live, [
    { op: 'GetStation', liveHash: '17b32d82' },
    { op: 'WorkboardById', liveHash: '646200a9' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].op, 'WorkboardById');
});

test('verifyLiveDeploy: FAIL-CLOSED — sitio ilegible NO es éxito', () => {
  // "No pude verificar" nunca puede colapsar a "verifiqué que está bien": esa confusión
  // es la que dejó tres hashes rotos en producción.
  for (const nada of [null, undefined, 'no soy json', 42]) {
    const r = verifyLiveDeploy(nada, [{ op: 'GetSpec', liveHash: 'ce4337c3' }]);
    assert.equal(r.ok, false, `liveConfig=${String(nada)} debe fallar cerrado`);
    assert.match(r.reason, /no se pudo leer/i);
  }
});

test('verifyLiveDeploy: una op AUSENTE en el sitio cuenta como no llegada', () => {
  const r = verifyLiveDeploy(cfg({}), [{ op: 'GetSpec', liveHash: 'ce4337c3' }]);
  assert.equal(r.ok, false);
  assert.equal(r.missing[0].live, null);
});

test('verifyLiveDeploy: encuentra el hash aunque sea MUTATION, no query', () => {
  const live = cfg({}, { SaveManyPartNumberPrices: 'c7bc19da' });
  const r = verifyLiveDeploy(live, [{ op: 'SaveManyPartNumberPrices', liveHash: 'c7bc19da' }]);
  assert.equal(r.ok, true);
});

test('verifyLiveDeploy: sin pares esperados no inventa un fallo', () => {
  assert.equal(verifyLiveDeploy(cfg({}), []).ok, true);
});

// ── detectLiveDrift — cierra el agujero "el sistema se auto-convence" ───────
test('detectLiveDrift: caza el drift heredado de una corrida ANTERIOR', () => {
  // Sin esto, a la corrida siguiente cfgHash==liveHash ⇒ "vigente" ⇒ la op sale del
  // radar aunque el sitio siga sirviendo el viejo.
  const local = cfg({ GetStation: '17b32d82', GetSpec: 'ce4337c3' }, {}, '1.11.80');
  const live = cfg({ GetStation: 'a41cfd01', GetSpec: 'ce4337c3' }, {}, '1.11.77');
  const d = detectLiveDrift(local, live);
  assert.equal(d.drift, true);
  assert.equal(d.ops.length, 1);
  assert.equal(d.ops[0].op, 'GetStation');
  assert.equal(d.version, '1.11.80');
  assert.equal(d.liveVersion, '1.11.77');
});

test('detectLiveDrift: una op NUEVA que aún no propaga es lag, no drift', () => {
  const local = cfg({ GetStation: '17b32d82', OpNueva: 'aaaa1111' });
  const live = cfg({ GetStation: '17b32d82' });
  assert.equal(detectLiveDrift(local, live).drift, false);
});

test('detectLiveDrift: todo igual ⇒ sin drift', () => {
  const c = cfg({ A: '1', B: '2' }, { M: '3' });
  assert.equal(detectLiveDrift(c, c).drift, false);
});

// ── formatDeployNotLiveAlert — que GRITE, y que se entienda ────────────────
test('formatDeployNotLiveAlert: nombra el estado real, no un genérico', () => {
  const txt = formatDeployNotLiveAlert(
    [{ op: 'InvoiceByIdInDomain', expected: '6535d82a3b32', live: '06a51d0363', applets: ['cfdi-attacher'] }],
    { version: '1.11.80', liveVersion: '1.11.77', pushError: ' ! [rejected] gh-pages (non-fast-forward)' },
  );
  // Debe decir que sigue ROTO en vivo — no basta con "el deploy falló".
  assert.match(txt, /NO LLEGÓ A PRODUCCIÓN/);
  assert.match(txt, /SIGUEN ROTOS/);
  assert.match(txt, /InvoiceByIdInDomain/);
  assert.match(txt, /cfdi-attacher/);
  assert.match(txt, /1\.11\.80/);
  assert.match(txt, /1\.11\.77/);
  assert.match(txt, /non-fast-forward/);
});

test('formatDeployNotLiveAlert: sin faltantes no fabrica alarma', () => {
  assert.equal(formatDeployNotLiveAlert([]), '');
  assert.equal(formatDeployNotLiveAlert(null), '');
});
