const test = require('node:test');
const assert = require('node:assert/strict');
const { entityFor, resolveUrl } = require('../hash-autopilot/mutation-deps.mjs');

test('entityFor: mapea id → {type, ent}', () => {
  const cfg = { entities: { partNumber: { id: 3770957 }, quote: { id: 288 } } };
  assert.equal(entityFor(cfg, 3770957).type, 'partNumber');
  assert.equal(entityFor(cfg, 288).type, 'quote');
  assert.equal(entityFor(cfg, 999), null);
});
test('resolveUrl: sustituye {id} (PN vive en /PartNumbers/{id})', () => {
  assert.equal(resolveUrl({ screenPath: '/PartNumbers/{id}' }, 3770957, 344),
    'https://app.gosteelhead.com/PartNumbers/3770957');
});
