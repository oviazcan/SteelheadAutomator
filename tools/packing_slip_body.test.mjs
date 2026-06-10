import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  escapeHtml, mdToHtml, isPendingName, pluralContenedor,
} from './packing_slip_body.mjs'

// ── Task 1: helpers de string ────────────────────────────────────────────────

test('escapeHtml: < > & se escapan', () => {
  assert.equal(escapeHtml('Acero <1040> & Co'), 'Acero &lt;1040&gt; &amp; Co')
})

test('escapeHtml: null/undefined → ""', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

test('mdToHtml: **negrita** y _cursiva_ y \\n', () => {
  assert.equal(mdToHtml('**Hola** _mundo_\nfin'), '<b>Hola</b> <i>mundo</i><br>fin')
})

test('mdToHtml: NO crea cursiva en part_number_id (underscore intra-palabra)', () => {
  assert.equal(mdToHtml('part_number_id'), 'part_number_id')
})

test('mdToHtml: escapa HTML antes de formatear', () => {
  assert.equal(mdToHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;')
})

test('mdToHtml: null → ""', () => {
  assert.equal(mdToHtml(null), '')
})

test('isPendingName: "Pending"/"PEN"/"." → true; trim; null/normal → false', () => {
  assert.equal(isPendingName('Pending'), true)
  assert.equal(isPendingName('PEN'), true)
  assert.equal(isPendingName('  .  '), true)
  assert.equal(isPendingName('4507421079'), false)
  assert.equal(isPendingName(null), false)
  assert.equal(isPendingName(''), false)
})

test('pluralContenedor: 1 → contenedor; 2 → contenedores', () => {
  assert.equal(pluralContenedor(1), 'contenedor')
  assert.equal(pluralContenedor(2), 'contenedores')
})
