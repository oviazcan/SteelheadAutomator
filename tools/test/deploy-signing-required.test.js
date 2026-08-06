// tools/test/deploy-signing-required.test.js
// Trinquete: NINGUNA vía de deploy puede publicar sin firmar mientras la extensión verifique.
// Run: node --test tools/test/deploy-signing-required.test.js
//
// ── Por qué existe (INCIDENTE 2026-08-05) ──────────────────────────────────
// El deploy de 1.11.90 corrió sin `SA_KMS_KEY` en el entorno. `deploy.sh` tenía un `else` que
// SOLO IMPRIMÍA un aviso, así que publicó el config nuevo conservando el `config.sig` y los
// `scriptIntegrity` de 1.11.89. La verificación de firma es FAIL-CLOSED: `fetchConfigFresh`
// descartó el config entero y el popup mostró «Sin conexión» a TODOS los usuarios — la
// extensión completa, no sólo el applet que se estaba deployando.
//
// Había DOS candados y ninguno actuó, cada uno por su propia razón:
//
//   1. `deploy.sh` degradaba a aviso. Un `⚠️` en medio de 30 líneas de salida no frena a nadie,
//      y menos a una sesión que no conoce el repo.
//   2. `.githooks/pre-push` SÍ valida la firma… pero se instala COPIÁNDOSE a `.git/hooks`. El
//      hook activo era del 23 de julio, anterior a que se le agregara esa validación. Mejorar
//      el hook versionado NO protege a nadie hasta que cada clon reinstale, y nada avisaba del
//      desfase. El candado existía en el repo y no existía en la máquina.
//
// De ahí las tres aserciones: el guard en las DOS vías de deploy, ANTES de tocar nada, y la
// validación de firma viva en el hook versionado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// El guard: "si hay pública embebida Y no hay SA_KMS_KEY → ABORTA". Se busca por sus dos
// ingredientes en la misma condición, no por el texto del mensaje (que se puede reescribir).
const GUARD = /\[\s*-n\s*"\$PUB_[A-Z]+"\s*\][\s\S]{0,40}\[\s*-z\s*"\$\{SA_KMS_KEY:-\}"\s*\]/;

// La condición sola NO es el candado: la primera versión de este test la daba por buena y
// SEGUÍA EN VERDE al degradar el `exit 1` a un `echo` (verificado inyectando esa regresión).
// Lo que hay que exigir es la CONSECUENCIA, así que se lee el cuerpo del `if` y se comprueba
// que termine el proceso. Un guard que detecta y deja pasar es el incidente otra vez.
function cuerpoDelGuard(sh) {
  const i = sh.search(GUARD);
  assert.ok(i !== -1, 'no encuentro el guard de firma');
  const fin = sh.indexOf('\nfi', i);
  assert.ok(fin !== -1, 'el guard no cierra con fi');
  return sh.slice(i, fin);
}
const ABORTA = /\bexit\s+1\b|\bdie\b/;

test('deploy.sh aborta si falta SA_KMS_KEY y la extensión verifica firma', () => {
  const sh = read('tools/deploy.sh');
  assert.match(sh, GUARD,
    'falta el guard que aborta el deploy sin firma (incidente 1.11.90)');
  assert.match(cuerpoDelGuard(sh), ABORTA,
    'el guard DETECTA pero no aborta: sin exit 1 el deploy continúa y publica sin firma');
  assert.match(sh, /PUB_PREFLIGHT=.*SA_INTEGRITY_PUBKEY/,
    'el guard debe leer la pública REAL embebida, no asumir la fase');
});

test('deploy.sh corre ese guard ANTES de bumpear la versión', () => {
  const sh = read('tools/deploy.sh');
  const guard = sh.search(GUARD);
  const bump = sh.indexOf('bump config version');
  assert.ok(guard !== -1 && bump !== -1, 'no encuentro guard o bump');
  // Si el guard corriera después del bump, el config quedaría modificado en el worktree y
  // el operador tendría que limpiar a mano tras un aborto. Fallar temprano no deja rastro.
  assert.ok(guard < bump,
    'el guard debe abortar ANTES de modificar remote/config.json');
});

test('wb-deploy.sh tiene el mismo guard, y también aborta', () => {
  const sh = read('tools/wb-deploy.sh');
  assert.match(sh, GUARD,
    'wb-deploy.sh publica sin pasar por deploy.sh: necesita su propio guard');
  assert.match(cuerpoDelGuard(sh), ABORTA,
    'el guard de wb-deploy.sh detecta pero no aborta');
});

test('ninguna vía degrada la falta de firma a simple aviso', () => {
  // La rama permisiva sólo es legítima con la pública VACÍA (pre-Fase-0), y entonces debe
  // decirlo. Un «deploy SIN firmar» a secas es exactamente el mensaje que no frenó el incidente.
  for (const f of ['tools/deploy.sh', 'tools/wb-deploy.sh']) {
    const sh = read(f);
    for (const line of sh.split('\n')) {
      if (!/SIN firmar/.test(line) || /^\s*#/.test(line)) continue;
      assert.match(line, /pública vacía|pre-Fase-0/,
        `${f}: el aviso de "SIN firmar" debe acotarse al caso de pública vacía — ${line.trim()}`);
    }
  }
});

test('el pre-push versionado valida la firma del config', () => {
  const hook = read('.githooks/pre-push');
  assert.match(hook, /verify-config-sig\.mjs/,
    'el pre-push debe verificar config.sig — es el backstop de TODAS las vías, incluida la manual');
  assert.match(hook, /SA_INTEGRITY_PUBKEY/,
    'el pre-push debe leer la pública embebida para decidir si exige firma');
});

test('deploy.sh reinstala el hook si el activo quedó desfasado', () => {
  // El hook se COPIA a .git/hooks. Sin esta reinstalación, una mejora al candado versionado
  // no llega a las máquinas y protege sólo en el repo — que es como pasó el incidente.
  const sh = read('tools/deploy.sh');
  assert.match(sh, /\.githooks/, 'deploy.sh debe comparar contra .githooks/');
  assert.match(sh, /install-hooks\.sh/, 'deploy.sh debe reinstalar los hooks al detectar desfase');
});
