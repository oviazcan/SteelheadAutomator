// tools/test/bulk-upload-packing-wired.test.js
// La columna "Instrucciones de Empaque" es un contrato entre CUATRO archivos que fallan por
// separado y en silencio: el hash vive en config.json, el módulo puro en un script que hay que
// registrar para que se inyecte, el nombre del nodo destino en config, y el glue que los une.
// Si cualquiera falta, no truena nada al cargar: simplemente NO se escriben las instrucciones
// (o peor, se escriben en el nodo equivocado). Es el mismo hueco que dejó las tres acciones del
// popup del auto-router inalcanzables durante semanas — el código se veía correcto en los tres
// archivos y la única señal habría sido el clic en producción.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..', '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'remote/config.json'), 'utf8'));
const sen = JSON.parse(readFileSync(join(ROOT, 'tools/hash-autopilot/sentinels-config.json'), 'utf8'));
const glue = readFileSync(join(ROOT, 'remote/scripts/bulk-upload.js'), 'utf8');
const Packing = require('../../remote/scripts/bulk-upload-packing.js');

const OP = 'SaveManyPartNumberProcessNodeDescriptionsAndFiles';
const SCRIPT = 'scripts/bulk-upload-packing.js';

test('el hash de la mutation está en config', () => {
  const h = cfg.steelhead.hashes.mutations[OP];
  assert.ok(h, `${OP} no está en steelhead.hashes.mutations`);
  assert.match(h, /^[0-9a-f]{64}$/, 'debe ser un sha256 en hex');
});

test('el módulo puro está registrado para inyectarse, y ANTES del glue', () => {
  const app = cfg.apps.find(a => a.id === 'carga-masiva');
  assert.ok(app, 'no existe la app carga-masiva');
  assert.ok(app.scripts.includes(SCRIPT), `${SCRIPT} no está en apps[carga-masiva].scripts`);
  assert.ok(cfg.scripts.includes(SCRIPT), `${SCRIPT} no está en la lista global de scripts a publicar`);
  // El orden importa: bulk-upload.js lee window.SteelheadBulkPacking al evaluarse.
  assert.ok(
    app.scripts.indexOf(SCRIPT) < app.scripts.indexOf('scripts/bulk-upload.js'),
    'el módulo debe cargarse antes que bulk-upload.js',
  );
});

test('el nombre del nodo destino está configurado y NO hardcodeado en el glue', () => {
  const p = cfg.steelhead.domain.bulkUpload.packingInstructions;
  assert.ok(p, 'falta steelhead.domain.bulkUpload.packingInstructions');
  assert.ok(p.nodeName && p.nodeName.trim(), 'packingInstructions.nodeName vacío: el STEP no escribiría nada');
  // Los ids de nodo son POR DOMINIO (los centinelas viven en TLC/344; MTY es otro dominio),
  // así que un id fijo en el código escribiría en el nodo equivocado —o en ninguno— en MTY.
  assert.ok(!glue.includes('154303'), 'el id del nodo de empaque no debe estar hardcodeado en el glue');
  assert.ok(!glue.includes(`'${p.nodeName}'`) && !glue.includes(`"${p.nodeName}"`),
    'el nombre del nodo tampoco debe estar hardcodeado: se lee de config');
});

test('bulkCfg expone packingInstructions (un campo que config define y el shape no expone queda muerto)', () => {
  // El bug 1.4.6 de este mismo applet fue exactamente eso: nonFinishLabelNames y
  // metalEquivalents estaban en config pero no en el shape de bulkCfg, así que el filtro
  // quedó muerto durante 3 versiones sin que nada fallara.
  assert.match(glue, /packingInstructions:\s*\{/, 'bulkCfg debe construir packingInstructions');
  assert.match(glue, /nodeName:\s*d\.packingInstructions\?\.nodeName/, 'nodeName debe leerse del config crudo');
});

test('el glue llama la op por su nombre exacto y con el payload del módulo', () => {
  assert.ok(glue.includes(OP), 'el glue no llama la mutation');
  assert.ok(glue.includes('Packing.buildPackingPayload'), 'el payload debe salir del módulo puro, no armarse inline');
  assert.ok(glue.includes('Packing.planPackingInstruction'), 'la decisión por celda debe salir del módulo puro');
  assert.ok(glue.includes('Packing.resolvePackingNode'), 'la resolución del nodo debe salir del módulo puro');
  assert.match(glue, /const Packing = window\.SteelheadBulkPacking/, 'el glue debe tomar el módulo del global correcto');
});

test('el módulo expone exactamente lo que el glue usa', () => {
  for (const fn of ['planPackingInstruction', 'resolvePackingNode', 'flattenProcessNodes', 'buildPackingPayload']) {
    assert.equal(typeof Packing[fn], 'function', `falta ${fn}`);
  }
});

test('la lectura del árbol usa GetProcessNode, que ya tiene hash y ruta de regeneración', () => {
  // Se eligió GetProcessNode justamente para NO agregar un hash de lectura: ya está en
  // config y ya está cubierto por el autopilot.
  assert.ok(cfg.steelhead.hashes.queries.GetProcessNode, 'GetProcessNode debe seguir en config');
  assert.match(glue, /GetProcessNode'.*processNodeOccurrence.*rootId|id: processId, processNodeOccurrence: 1, rootId: processId/s,
    'GetProcessNode exige las TRES variables (id/processNodeOccurrence/rootId)');
});

test('la mutation tiene ruta de regeneración (si no, el trinquete de deuda sube)', () => {
  const cubiertas = new Set();
  for (const e of Object.values(sen.entities || {})) {
    for (const op of [...(e._para || []), ...(e.opsGroup || [])]) cubiertas.add(op);
  }
  assert.ok(cubiertas.has(OP), `${OP} necesita entidad centinela`);
  const ent = Object.values(sen.entities).find(e => (e._para || []).includes(OP));
  assert.equal(ent.marker, 'Centinela', 'debe exigir el marcador Centinela (fail-closed)');
  assert.equal(ent._estrategia, 'capture-abort', 'escribe: debe capturar y abortar, no persistir');
});

test('el STEP no puede escribir sin nodo resuelto', () => {
  // Guard de seguridad leído del propio glue: si resolvePackingNode no da ok, se reporta y
  // se sale ANTES de la mutation. Escribir en un nodo adivinado deja las instrucciones en un
  // paso que el operador no mira, y la escritura habría tenido "éxito".
  const step = glue.slice(glue.indexOf('STEP 7c'), glue.indexOf('STEP 7b: Delete prices'));
  assert.ok(step.length > 500, 'no encontré el bloque del STEP 7c');
  const iCheck = step.indexOf('if (!res.ok)');
  const iWrite = step.indexOf(OP);
  assert.ok(iCheck > 0 && iWrite > iCheck, 'el guard de nodo no resuelto debe ir ANTES de la escritura');
});
