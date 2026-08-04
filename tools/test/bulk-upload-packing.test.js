// tools/test/bulk-upload-packing.test.js
// Golden test del núcleo de "Instrucciones de Empaque" (plantilla v13).
//
// Se ejerce contra el árbol de proceso REAL de un PN de producción (63 relaciones, 60 nodos
// únicos) guardado en fixtures/. Ese árbol es el que hace peligroso el problema: contiene
// SIETE nodos cuyo nombre incluye "Embarque". Anclar por subcadena elegiría uno cualquiera y
// las instrucciones terminarían en un paso que el operador de piso no mira — sin ningún error
// visible, porque la escritura sí tendría éxito.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const P = require('../../remote/scripts/bulk-upload-packing.js');
const TREE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bulk-upload-packing-tree.json'), 'utf8'));

const NODO_EMPAQUE = 'Preparando Embarque en Almacén';
const NODO_EMPAQUE_ID = 154303;

// ── Decisión por celda: los 3 estados del contrato ───────────────────────────
test('planPackingInstruction: vacío no toca, "-" borra, dato sustituye', () => {
  assert.deepEqual(P.planPackingInstruction(''), { action: 'skip', markdown: null });
  assert.deepEqual(P.planPackingInstruction('   '), { action: 'skip', markdown: null });
  assert.deepEqual(P.planPackingInstruction(null), { action: 'skip', markdown: null });
  assert.deepEqual(P.planPackingInstruction(undefined), { action: 'skip', markdown: null });
  // El borrado NO tiene mutation propia: se escribe cadena vacía.
  assert.deepEqual(P.planPackingInstruction('-'), { action: 'clear', markdown: '' });
  assert.deepEqual(P.planPackingInstruction('  -  '), { action: 'clear', markdown: '' });
  assert.deepEqual(P.planPackingInstruction('Empacar en tarima'), { action: 'set', markdown: 'Empacar en tarima' });
});

test('planPackingInstruction: "skip" y "clear" NO son lo mismo', () => {
  // Este es EL par que no se puede confundir: ambos terminan pareciéndose a "vacío", pero
  // uno deja las instrucciones intactas y el otro las borra. Si `skip` produjera markdown
  // '' en vez de null, cada carga con la columna en blanco BORRARÍA las instrucciones de
  // todos los PNs de la corrida, en silencio.
  const skip = P.planPackingInstruction('');
  const clear = P.planPackingInstruction('-');
  assert.equal(skip.action, 'skip');
  assert.equal(skip.markdown, null, 'no tocar debe ser null, nunca cadena vacía');
  assert.equal(clear.action, 'clear');
  assert.equal(clear.markdown, '');
  assert.notEqual(skip.action, clear.action);
});

test('planPackingInstruction: el texto va CRUDO (el campo es markdown)', () => {
  const md = 'Empacar con **esquineros**\n- 2 por caja\n<span style="color: red;">Frágil</span>';
  const r = P.planPackingInstruction(md);
  assert.equal(r.action, 'set');
  assert.equal(r.markdown, md, 'no se escapa ni se transforma: el ERP guarda markdown/HTML');
});

test('planPackingInstruction: un guión LARGO o doble no es el sentinel', () => {
  // El sentinel es exactamente "-". Un "--" o un guión largo son texto que el usuario
  // escribió, y tratarlos como borrado destruiría datos que quiso poner.
  assert.equal(P.planPackingInstruction('--').action, 'set');
  assert.equal(P.planPackingInstruction('—').action, 'set');
  assert.equal(P.planPackingInstruction('- ver anexo').action, 'set');
});

// ── Resolución del nodo destino ──────────────────────────────────────────────
test('resolvePackingNode: encuentra el nodo de empaque en el árbol REAL', () => {
  const nodes = P.flattenProcessNodes(TREE);
  const r = P.resolvePackingNode(nodes, NODO_EMPAQUE);
  assert.equal(r.ok, true);
  assert.equal(r.nodeId, NODO_EMPAQUE_ID);
});

test('resolvePackingNode: el árbol real tiene 7 nodos con "Embarque" — por eso match EXACTO', () => {
  const nodes = P.flattenProcessNodes(TREE);
  const conEmbarque = nodes.filter(n => /mbarque/.test(n.name || ''));
  assert.ok(conEmbarque.length >= 7, `el fixture debe conservar la ambigüedad real (hay ${conEmbarque.length})`);
  // Un match por subcadena tendría de dónde escoger; el exacto deja exactamente uno.
  const exactos = nodes.filter(n => P.normNodeName(n.name) === P.normNodeName(NODO_EMPAQUE));
  assert.equal(exactos.length, 1);
  assert.equal(exactos[0].id, NODO_EMPAQUE_ID);
});

test('resolvePackingNode: nombre inexistente NO adivina', () => {
  const nodes = P.flattenProcessNodes(TREE);
  const r = P.resolvePackingNode(nodes, 'Nodo Que No Existe');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-encontrado');
  assert.equal(r.nodeId, null);
});

test('resolvePackingNode: ante DOS nodos con el mismo nombre no elige ninguno', () => {
  const nodes = [
    { id: 1, name: 'Preparando Embarque en Almacén' },
    { id: 2, name: 'Preparando Embarque en Almacén' },
  ];
  const r = P.resolvePackingNode(nodes, NODO_EMPAQUE);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguo');
  assert.equal(r.nodeId, null);
  assert.equal(r.candidates.length, 2, 'debe reportar los candidatos para que un humano decida');
});

test('resolvePackingNode: el MISMO nodo repetido en el árbol no es ambigüedad', () => {
  // El árbol real repite nodos que aparecen varias veces en la receta (hay 63 relaciones
  // para 60 nodos únicos). Repetición del mismo id ≠ dos nodos distintos.
  const nodes = [
    { id: 154303, name: NODO_EMPAQUE },
    { id: 154303, name: NODO_EMPAQUE },
  ];
  const r = P.resolvePackingNode(nodes, NODO_EMPAQUE);
  assert.equal(r.ok, true);
  assert.equal(r.nodeId, 154303);
});

test('resolvePackingNode: tolera acentos, mayúsculas y espacios dobles', () => {
  // El catálogo real trae "Inspeccionando y  Empacando" con doble espacio: los nombres los
  // teclean humanos, así que el match no puede ser byte a byte.
  const nodes = P.flattenProcessNodes(TREE);
  for (const variante of ['PREPARANDO EMBARQUE EN ALMACEN', 'preparando  embarque  en  almacén', '  Preparando Embarque en Almacén  ']) {
    const r = P.resolvePackingNode(nodes, variante);
    assert.equal(r.ok, true, `debió resolver: ${variante}`);
    assert.equal(r.nodeId, NODO_EMPAQUE_ID);
  }
});

test('resolvePackingNode: sin nombre configurado NO escribe en ningún lado', () => {
  const nodes = P.flattenProcessNodes(TREE);
  for (const vacio of ['', '   ', null, undefined]) {
    const r = P.resolvePackingNode(nodes, vacio);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'sin-nombre-configurado');
    assert.equal(r.nodeId, null);
  }
});

test('flattenProcessNodes: aplana el árbol real e incluye la raíz', () => {
  const nodes = P.flattenProcessNodes(TREE);
  assert.equal(nodes.length, 64, '63 relaciones + la raíz');
  assert.equal(nodes[0].id, TREE.id, 'la raíz va primero');
  // Tolerante con entradas rotas: no debe tronar ni inventar nodos.
  assert.deepEqual(P.flattenProcessNodes(null), []);
  assert.deepEqual(P.flattenProcessNodes({}), []);
  assert.deepEqual(P.flattenProcessNodes({ descendantRelationships: [{}, { processNodeByFromId: null }] }), []);
});

// ── Payload ──────────────────────────────────────────────────────────────────
test('buildPackingPayload: reproduce el payload capturado del ERP', () => {
  // Capturado en vivo: PN 3887933, nodo 154303 (hash-scanner 2026-08-03).
  const got = P.buildPackingPayload(3887933, 154303, 'Instrucciones de **Embarque** en Almacén');
  assert.deepEqual(got, {
    input: {
      partNumberId: 3887933,
      processNodeDescriptions: [{
        processNodeId: 154303,
        processNodeOccurrence: 1,
        otherOccurrences: [],
        descriptionMarkdown: 'Instrucciones de **Embarque** en Almacén',
        cascadeToOccurrences: false,
        cascadeToRecipeNodes: false,
      }],
    },
  });
});

test('buildPackingPayload: el borrado manda cadena vacía, no null', () => {
  // No hay mutation de borrado: borrar ES escribir "". Un null podría dejar el campo
  // intacto o tronar la validación del servidor, y en ambos casos el operador creería
  // que borró algo que sigue ahí.
  const plan = P.planPackingInstruction('-');
  const got = P.buildPackingPayload(1, 2, plan.markdown);
  assert.equal(got.input.processNodeDescriptions[0].descriptionMarkdown, '');
});

test('buildPackingPayload: NUNCA propaga a otras ocurrencias ni recetas', () => {
  const got = P.buildPackingPayload(1, 2, 'x');
  const d = got.input.processNodeDescriptions[0];
  assert.equal(d.cascadeToOccurrences, false);
  assert.equal(d.cascadeToRecipeNodes, false);
  assert.deepEqual(d.otherOccurrences, []);
});
