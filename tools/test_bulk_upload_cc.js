'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const CC = require('../remote/scripts/bulk-upload-cc.js');

// ── Task 1: pickMostRecent + decideBlankAcabados ──

test('pickMostRecent: array vacío o no-array → null', () => {
  assert.strictEqual(CC.pickMostRecent([]), null);
  assert.strictEqual(CC.pickMostRecent(null), null);
  assert.strictEqual(CC.pickMostRecent(undefined), null);
});

test('pickMostRecent: devuelve el de id más alto', () => {
  assert.deepStrictEqual(CC.pickMostRecent([{ id: 5 }]), { id: 5 });
  assert.deepStrictEqual(CC.pickMostRecent([{ id: 5 }, { id: 9 }, { id: 3 }]), { id: 9 });
});

test('decideBlankAcabados: sin candidatos → null', () => {
  assert.strictEqual(CC.decideBlankAcabados([]), null);
  assert.strictEqual(CC.decideBlankAcabados(null), null);
});

test('decideBlankAcabados: 1 candidato → auto', () => {
  assert.deepStrictEqual(CC.decideBlankAcabados([{ id: 5 }]), { targetPnId: 5, autoDecided: true });
});

test('decideBlankAcabados: 2+ candidatos → más reciente, requiere confirmar', () => {
  assert.deepStrictEqual(
    CC.decideBlankAcabados([{ id: 5 }, { id: 9 }, { id: 3 }]),
    { targetPnId: 9, autoDecided: false }
  );
});

// ── Task 2: computeAccion + buildDetalle ──

test('computeAccion: combina tokens en orden ALTA, PRECIO, ENRIQUECIMIENTO', () => {
  assert.strictEqual(CC.computeAccion({ isNew: true }), 'ALTA');
  assert.strictEqual(CC.computeAccion({ hasPrice: true }), 'PRECIO');
  assert.strictEqual(CC.computeAccion({ hasEnrich: true }), 'ENRIQUECIMIENTO');
  assert.strictEqual(CC.computeAccion({ isNew: true, hasPrice: true }), 'ALTA, PRECIO');
  assert.strictEqual(CC.computeAccion({ hasPrice: true, hasEnrich: true }), 'PRECIO, ENRIQUECIMIENTO');
  assert.strictEqual(CC.computeAccion({}), '');
});

test('buildDetalle: ALTA', () => {
  assert.strictEqual(CC.buildDetalle({ accion: 'ALTA' }), 'PN creado vía carga masiva');
});

test('buildDetalle: PRECIO sin anterior → solo el nuevo', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'PRECIO', precioNuevo: 13.8, divisa: 'USD', precioAnterior: null }),
    '13.8 USD'
  );
});

test('buildDetalle: PRECIO con anterior → ant → nvo', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'PRECIO', precioAnterior: 12.5, precioNuevo: 13.8, divisa: 'USD' }),
    '12.5 → 13.8 USD'
  );
});

test('buildDetalle: ENRIQUECIMIENTO lista campos', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'ENRIQUECIMIENTO', enrichFields: ['specs', 'proceso'] }),
    'Enriquecimiento: specs, proceso'
  );
});

test('buildDetalle: combinado une segmentos con " · "', () => {
  assert.strictEqual(
    CC.buildDetalle({ accion: 'PRECIO, ENRIQUECIMIENTO', precioNuevo: 13.8, divisa: 'USD', enrichFields: ['specs'] }),
    '13.8 USD · Enriquecimiento: specs'
  );
});

test('buildDetalle: accion vacía → string vacío', () => {
  assert.strictEqual(CC.buildDetalle({ accion: '' }), '');
});

// ── Task 3: buildControlCambiosEntry + appendControlCambios ──

test('buildControlCambiosEntry: nombres exactos del schema', () => {
  const e = CC.buildControlCambiosEntry({
    accion: 'PRECIO', detalle: '12.5 → 13.8 USD', usuario: 'OMAR FIDEL VIAZCAN GOMEZ',
    version: '1.6.37', nowIso: '2026-06-04T18:22:00.000Z',
  });
  assert.deepStrictEqual(e, {
    Fecha: '2026-06-04T18:22:00.000Z',
    Usuario: 'OMAR FIDEL VIAZCAN GOMEZ',
    Accion: 'PRECIO',
    Detalle: '12.5 → 13.8 USD',
    Version: '1.6.37',
  });
});

test('buildControlCambiosEntry: usuario faltante → (desconocido)', () => {
  const e = CC.buildControlCambiosEntry({ accion: 'ALTA', detalle: '', usuario: null, version: '1.6.37', nowIso: 'x' });
  assert.strictEqual(e.Usuario, '(desconocido)');
});

test('appendControlCambios: crea el array si no existe', () => {
  const ci = { NotasAdicionales: 'hola' };
  CC.appendControlCambios(ci, { Accion: 'ALTA' });
  assert.deepStrictEqual(ci.ControlCambios, [{ Accion: 'ALTA' }]);
  assert.strictEqual(ci.NotasAdicionales, 'hola');
});

test('appendControlCambios: preserva historial previo', () => {
  const ci = { ControlCambios: [{ Accion: 'prueba' }] };
  CC.appendControlCambios(ci, { Accion: 'PRECIO' });
  assert.deepStrictEqual(ci.ControlCambios, [{ Accion: 'prueba' }, { Accion: 'PRECIO' }]);
});

test('appendControlCambios: ci null no rompe', () => {
  assert.strictEqual(CC.appendControlCambios(null, { Accion: 'ALTA' }), null);
});
