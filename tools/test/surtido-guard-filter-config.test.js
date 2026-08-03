// Contrato config ↔ scripts del filtro por línea destino.
// El ORDEN importa: el core debe cargar antes del glue, o FilterCore() sale undefined y el
// filtro queda muerto en silencio (el glue tolera su ausencia por fail-safe, así que un
// orden mal puesto NO truena — solo deja de funcionar, que es peor de diagnosticar).
// Run: node --test tools/test/surtido-guard-filter-config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'remote', 'config.json'), 'utf8'));
const app = config.apps.find((a) => a.id === 'surtido-guard');

test('el app surtido-guard existe', () => {
  assert.ok(app, 'no se encontró el app surtido-guard en config.apps');
});

test('el core del filtro está declarado en scripts', () => {
  assert.ok(app.scripts.includes('scripts/surtido-guard-filter-core.js'));
});

test('el core del filtro carga ANTES del glue', () => {
  const iCore = app.scripts.indexOf('scripts/surtido-guard-filter-core.js');
  const iGlue = app.scripts.indexOf('scripts/surtido-guard.js');
  assert.ok(iCore >= 0 && iGlue >= 0);
  assert.ok(iCore < iGlue, 'surtido-guard-filter-core.js debe ir antes de surtido-guard.js');
});

test('todo script declarado existe en el repo', () => {
  app.scripts.forEach((rel) => {
    const p = path.join(ROOT, 'remote', rel);
    assert.ok(fs.existsSync(p), 'falta el archivo declarado en config: ' + rel);
  });
});

test('AllStations tiene hash en config (lo usa el catálogo de líneas del dropdown)', () => {
  assert.ok(config.steelhead.hashes.queries.AllStations, 'falta el hash de AllStations');
});
