// Regresión del escáner de integración del bundle Safari (tools/safari-bundle-scan.py).
// Verifica los invariantes de clasificación contra el estado real del repo, para que la skill
// `safari-bundle-sync` pueda confiar en la salida.
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const out = execSync('python3 tools/safari-bundle-scan.py --json', { cwd: ROOT, encoding: 'utf8' });
const scan = JSON.parse(out);
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'safari/bundle.json'), 'utf8'));

test('reporta exactamente los applets de bundle.json como in_bundle', () => {
  assert.deepStrictEqual(scan.in_bundle, bundle.applets);
});

test('ningún candidato ya está en el bundle', () => {
  const inb = new Set(scan.in_bundle);
  for (const c of scan.candidates) assert.ok(!inb.has(c.id), `${c.id} es candidato pero ya está en el bundle`);
});

test('NO-APLICA ⟺ hay bloqueador de descarga', () => {
  for (const c of scan.candidates) {
    if (c.suggest === 'NO-APLICA') assert.ok(c.blockers_hard.length > 0, `${c.id} NO-APLICA sin bloqueador duro`);
    else assert.strictEqual(c.blockers_hard.length, 0, `${c.id} ${c.suggest} pero tiene bloqueador duro`);
  }
});

test('INTEGRABLE ⟺ sin bloqueadores (ni duros, ni blandos, ni chrome inseguro)', () => {
  for (const c of scan.candidates) {
    if (c.suggest !== 'INTEGRABLE') continue;
    assert.strictEqual(c.blockers_soft.length, 0, `${c.id} INTEGRABLE con bloqueador blando`);
    assert.strictEqual(c.chrome_unsafe.length, 0, `${c.id} INTEGRABLE con chrome inseguro`);
  }
});

test('REVISAR tiene señales blandas y ningún bloqueador duro', () => {
  for (const c of scan.candidates) {
    if (c.suggest !== 'REVISAR') continue;
    assert.ok(c.blockers_soft.length > 0 || c.chrome_unsafe.length > 0, `${c.id} REVISAR sin señales blandas`);
    assert.strictEqual(c.blockers_hard.length, 0);
  }
});

test('las herramientas de descarga conocidas caen en NO-APLICA (si no están en el bundle)', () => {
  const byId = Object.fromEntries(scan.candidates.map((c) => [c.id, c]));
  for (const id of ['spec-migrator', 'carga-masiva', 'auditor', 'spec-params-bulk']) {
    if (byId[id]) assert.strictEqual(byId[id].suggest, 'NO-APLICA', `${id} debería ser NO-APLICA`);
  }
});

test('cada lanzador extraído trae el shape esperado (message/fn/icon/label/sublabel)', () => {
  // Estructural, no dependiente del set actual de candidatos (que cambia al integrar): valida que
  // el escáner extrae los campos que la skill necesita para cablear el lanzador. `fn` puede ser null
  // (la skill lo resuelve), pero la clave debe existir; `message` siempre presente.
  for (const c of scan.candidates) {
    for (const l of c.launchers) {
      for (const k of ['message', 'fn', 'icon', 'label', 'sublabel']) {
        assert.ok(k in l, `${c.id}: launcher sin la clave '${k}'`);
      }
      assert.ok(l.message, `${c.id}: launcher sin message`);
    }
  }
});
