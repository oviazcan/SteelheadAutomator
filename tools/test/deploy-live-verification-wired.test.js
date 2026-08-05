// tools/test/deploy-live-verification-wired.test.js
// TRINQUETE DE CABLEADO (incidente 2026-08-05).
//
// El núcleo puro puede estar perfecto y aun así el motor cerrar en silencio: eso es
// exactamente lo que pasó — `deploy.sh` fallaba, el motor lo sabía, y el fallo moría en
// un `console.log`. Estas pruebas leen el FUENTE de hash-autopilot.mjs y fijan que los
// eslabones sigan conectados. Es el mismo patrón que popup-actions-wired.test.js: un
// contrato que ningún archivo falla solo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../hash-autopilot/hash-autopilot.mjs'), 'utf8');
const DEPLOY_SH = fs.readFileSync(path.join(__dirname, '../deploy.sh'), 'utf8');

test('el motor VERIFICA contra el sitio EN VIVO tras deployar', () => {
  assert.match(SRC, /verifyLiveDeploy\s*\(/, 'debe llamar a verifyLiveDeploy');
  assert.match(SRC, /fetchLiveConfig\s*\(/, 'debe leer el config EN VIVO');
  assert.match(SRC, /oviazcan\.github\.io\/SteelheadAutomator\/config\.json/, 'debe apuntar al sitio publicado');
});

test('la verificación en vivo corre AUNQUE el script de deploy haya salido 0', () => {
  // El bug: `main` se pushea ANTES que `gh-pages`, así que exit 0 del script NO prueba
  // publicación. La verificación debe estar FUERA del try/catch del execFileSync.
  const bloque = SRC.slice(SRC.indexOf('→ Auto-deploy:'), SRC.indexOf('Sincroniza los rotados EXTERNOS'));
  assert.ok(bloque.length > 0, 'no encontré el bloque de auto-deploy');
  const posCatch = bloque.indexOf('} catch (e) {');
  const posVerify = bloque.indexOf('verifyLiveDeploy');
  assert.ok(posVerify > posCatch, 'verifyLiveDeploy debe correr DESPUÉS del try/catch, no dentro del try');
});

test('un deploy que no llegó al sitio GRITA en el correo', () => {
  assert.match(SRC, /formatDeployNotLiveAlert\s*\(/, 'debe empujar la alerta al cuerpo del correo');
  assert.match(SRC, /liveOk === false/, 'debe distinguir "no llegó" de "no aplica"');
});

test('el deploy roto CUENTA como urgente ⇒ el correo se manda aunque no haya nada más', () => {
  // Antes: `if (sec.length)` con sec vacío ⇒ CERO correo. Ese era el silencio.
  assert.match(SRC, /nDeployRoto/, 'debe existir el contador de deploy roto');
  const m = SRC.match(/const nUrgentes = [^;]+;/);
  assert.ok(m, 'no encontré el cálculo de nUrgentes');
  assert.match(m[0], /nDeployRoto/, 'nUrgentes DEBE sumar nDeployRoto o el correo no se manda');
});

test('un deploy roto NUNCA se reporta con tono de éxito', () => {
  const m = SRC.match(/const tipo = [\s\S]{0,400}?;/);
  assert.ok(m, 'no encontré el cálculo de tipo');
  assert.match(m[0], /nDeployRoto > 0 \? 'fallo'/, "tipo debe ser 'fallo' cuando el deploy no llegó, antes que cualquier otra rama");
});

test('no se afirma "CORREGIDAS Y DEPLOYADAS" si el sitio no lo sirve', () => {
  assert.match(SRC, /deployed && !deployNotLive && plan\.toDeploy\.length/, 'la sección de corregidas debe exigir que el sitio lo confirme');
  assert.match(SRC, /deployed && liveOk !== false \?/, 'el pie del correo no puede afirmar publicación sin confirmar');
});

test('el drift heredado se mide contra origin/gh-pages (no contra el CDN)', () => {
  // Si se midiera contra el sitio, un lag normal del CDN daría falso positivo y
  // volveríamos al cry-wolf que este repo ya pagó caro.
  assert.match(SRC, /readOriginGhPagesConfig\s*\(/);
  assert.match(SRC, /origin\/gh-pages:config\.json/);
  assert.match(SRC, /detectLiveDrift\s*\(/);
});

test('deploy.sh reintenta con rebase SOLO ante non-fast-forward', () => {
  assert.match(DEPLOY_SH, /push_con_rebase/, 'debe existir el helper de reintento');
  assert.match(DEPLOY_SH, /non-fast-forward\|fetch first\|Updates were rejected/, 'debe filtrar la causa');
  assert.match(DEPLOY_SH, /rebase --abort/, 'un conflicto debe abortar, no publicar a ciegas');
});

test('deploy.sh restaura la rama tras rebasear gh-pages', () => {
  // gh-pages se maneja con checkout ida y vuelta en el worktree de main: un rebase que
  // no restaure dejaría el worktree en la rama equivocada.
  const f = DEPLOY_SH.slice(DEPLOY_SH.indexOf('push_con_rebase() {'), DEPLOY_SH.indexOf('echo "→ push origin main gh-pages"'));
  assert.match(f, /previa/, 'debe recordar la rama previa');
  assert.match(f, /checkout "\$previa"/, 'debe volver a la rama previa');
});
