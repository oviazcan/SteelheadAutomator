# Planos en Remisión (`packing-slip-drawings`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando el cliente de una remisión tiene `DatosLogisticos.IncluirPlanos`, adjuntar al correo del albarán los archivos de sus números de parte —con panel de revisión—, delatar en ámbar los NP que no tienen plano, e imprimir remisión + selección en un solo PDF.

**Architecture:** Molde de `cfdi-attacher.js`: interceptor de `fetch` sobre la mutation de envío que inyecta `variables.attachments`, más un panel inyectado en la fila `Attachments` del modal «Send Shipping Email». Toda la decisión vive en núcleos puros con golden tests; el applet solo hace DOM y red.

**Tech Stack:** JavaScript vanilla (sin frameworks ni bundlers) · `node:test` + `node:assert/strict` · `pdf-lib` para coser PDFs · `MuiIconAnchorCore` para anclaje por forma de icono.

**Spec:** [`docs/superpowers/specs/2026-08-04-packing-slip-drawings-design.md`](../specs/2026-08-04-packing-slip-drawings-design.md)

## Global Constraints

- **JavaScript vanilla.** Sin React, sin frameworks, sin bundlers, sin TypeScript.
- **Documentación y UI en español; código, variables y funciones en inglés.**
- **Dual export en todo núcleo puro:** `module.exports` (tests con node) + `root.<NombreCore>` (browser). Patrón exacto en `remote/scripts/file-uploader-core.js:246-249`.
- **UI propia en DARK MODE:** base `#1c2430`, texto `#e6e9ee`, inputs `#141a23`, acento verde `#13a36f`, ámbar de aviso `#d98e04`. **Excepción:** los nodos que heredan estilo de MUI para integrarse a la tabla del modal (ver Task 6).
- **Prohibido anclar a clases `css-<hash>`.** El paper del modal trae `css-1d28aor`; no se usa. Anclar por texto + estructura, heredando clases de presentación del vecino vivo.
- **Prohibido `data-testid` como única señal.** SH lo eliminó (verificado en vivo 2026-08-04: `null` en los 7 botones de la fila de acciones).
- **Todo nodo inyectado en una tabla de React lleva de quién es y se revalida cada pasada.** React recicla los `<tr>`.
- **El interceptor NO hace trabajo síncrono pesado sobre el body del envío.** El payload lleva el HTML completo del correo; `JSON.parse` una vez, tocar solo `variables.attachments`, re-serializar. **Sin regex globales sobre el body.** (Congeló la pestaña dos veces en el reconocimiento.)
- **Este applet nunca cancela un envío.** Una remisión sin plano sigue siendo válida.
- **Correr un test:** `node --test tools/test/<archivo>.test.js` · **Suite completa:** `tools/run-tests.sh`
- **Path del custom input, medido:** `customInputs.DatosLogisticos.IncluirPlanos`
- **Nombres de operación GraphQL:** usar SIEMPRE los hashes de `remote/config.json`, nunca hardcodeados.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `remote/scripts/packing-slip-drawings-core.js` | **Decisión pura**: leer el check del cliente, clasificar archivos, armar el plan de adjuntos, deduplicar. Sin DOM ni red. |
| `remote/scripts/packing-slip-modal-core.js` | **Reconocimiento puro del modal**: distinguir el de remisión del de factura, extraer los NP de su tabla. Recibe nodos, no los busca. |
| `remote/scripts/packing-slip-print.js` | Coser el PDF combinado con `pdf-lib` e imprimirlo por iframe. |
| `remote/scripts/packing-slip-drawings.js` | Glue: interceptor de `fetch`, observer del modal, panel UI. |
| `remote/scripts/lib/pdf-lib.min.js` | Librería (artefacto, no se edita). |
| `tools/test/packing-slip-drawings-core.test.js` | Golden test del núcleo de decisión. |
| `tools/test/packing-slip-modal-core.test.js` | Golden test del reconocimiento del modal. |
| `docs/applets/packing-slip-drawings.md` | Bitácora. |

**Por qué dos núcleos y no uno:** el de decisión no sabe qué es un `<tr>`; el de modal no sabe qué es un plano. Separarlos deja cada golden test enfocado y permite probar el reconocimiento del DOM con fixtures de HTML sin arrastrar la lógica de clasificación.

---

### Task 1: Núcleo de decisión — leer el check del cliente

**Files:**
- Create: `remote/scripts/packing-slip-drawings-core.js`
- Test: `tools/test/packing-slip-drawings-core.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `readIncluirPlanos(customInputs) → true | false | null`

**Contexto que el implementador necesita:** el ERP entrega `customInputs` en tres formas distintas según la query (objeto anidado, string JSON, o booleano serializado como string). `duplicate-tiers.js:51` ya lidia con esto. **`null` significa «no pude leerlo» y NO es lo mismo que `false`**: `false` apaga el applet en silencio, `null` muestra nota ámbar.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/packing-slip-drawings-core.test.js
// Golden tests del núcleo de decisión de "Planos en Remisión".
// Run: node --test tools/test/packing-slip-drawings-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../remote/scripts/packing-slip-drawings-core.js');

// ---------- readIncluirPlanos ----------
// Path medido contra la DuckDB (snapshot TLC 2026-08-04):
// customer.custom_input → $.DatosLogisticos.IncluirPlanos

test('readIncluirPlanos: objeto anidado con booleano real', () => {
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: true } }), true);
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: false } }), false);
});

test('readIncluirPlanos: string JSON (como lo devuelven algunas queries)', () => {
  assert.equal(Core.readIncluirPlanos('{"DatosLogisticos":{"IncluirPlanos":true}}'), true);
  assert.equal(Core.readIncluirPlanos('{"DatosLogisticos":{"IncluirPlanos":false}}'), false);
});

test('readIncluirPlanos: booleano serializado como string', () => {
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: 'true' } }), true);
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: { IncluirPlanos: 'false' } }), false);
});

test('readIncluirPlanos: AUSENTE devuelve null, que NO es false', () => {
  // 6 de los 81 clientes activos no tienen el campo. "No sé" ≠ "no quiere".
  assert.equal(Core.readIncluirPlanos({ DatosLogisticos: {} }), null);
  assert.equal(Core.readIncluirPlanos({}), null);
  assert.equal(Core.readIncluirPlanos(null), null);
  assert.equal(Core.readIncluirPlanos(undefined), null);
});

test('readIncluirPlanos: basura ilegible devuelve null, no revienta', () => {
  assert.equal(Core.readIncluirPlanos('no soy json {{{'), null);
  assert.equal(Core.readIncluirPlanos(42), null);
  assert.equal(Core.readIncluirPlanos([]), null);
});

test('readIncluirPlanos: otro grupo con el mismo nombre de campo NO cuenta', () => {
  // Solo DatosLogisticos.IncluirPlanos gobierna. Un homónimo en otro grupo se ignora.
  assert.equal(Core.readIncluirPlanos({ DatosFactura: { IncluirPlanos: true } }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/packing-slip-drawings-core.test.js`
Expected: FAIL — `Cannot find module '../../remote/scripts/packing-slip-drawings-core.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// remote/scripts/packing-slip-drawings-core.js
// Planos en Remisión — núcleo PURO de decisión (sin DOM ni red).
// Decide si el cliente pide planos, qué es plano y qué es foto, y qué se premarca.
// Dual export: module.exports (tests con node) + root.PackingSlipDrawingsCore (browser).
// Golden tests: tools/test/packing-slip-drawings-core.test.js
(function (root) {
  'use strict';

  // Normaliza las TRES formas en que el ERP entrega customInputs:
  // objeto anidado, string JSON, o nada. Devuelve objeto o null.
  function asObject(ci) {
    if (ci && typeof ci === 'object' && !Array.isArray(ci)) return ci;
    if (typeof ci === 'string') {
      try {
        const parsed = JSON.parse(ci);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) { return null; }
    }
    return null;
  }

  // ¿El cliente pide que le mandemos los planos?
  //   true  → sí
  //   false → no
  //   null  → NO PUDE LEERLO. Distinto de false: `false` apaga el applet en
  //           silencio, `null` obliga a la nota ámbar. Ausente ≠ vacío.
  function readIncluirPlanos(customInputs) {
    const obj = asObject(customInputs);
    if (!obj) return null;
    const grupo = asObject(obj.DatosLogisticos);
    if (!grupo) return null;
    const v = grupo.IncluirPlanos;
    if (v === true || v === false) return v;
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (t === 'true') return true;
      if (t === 'false') return false;
    }
    return null;
  }

  const api = { readIncluirPlanos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PackingSlipDrawingsCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/packing-slip-drawings-core.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/packing-slip-drawings-core.js tools/test/packing-slip-drawings-core.test.js
git commit -m "feat(packing-slip-drawings): núcleo lee IncluirPlanos — null no es false"
```

---

### Task 2: Núcleo de decisión — clasificar archivos

**Files:**
- Modify: `remote/scripts/packing-slip-drawings-core.js`
- Test: `tools/test/packing-slip-drawings-core.test.js` (append)

**Interfaces:**
- Consumes: nada de Task 1.
- Produces: `classifyFile(originalName) → 'plano' | 'foto' | 'otro'`

**Contexto:** medido contra la DuckDB, los 30,547 archivos vinculados a NP se reparten en `jpg` 25,905 · `pdf` 3,936 · `png` 627 · `jpeg` 55 · `bmp/gif/tif/step` 13. **PDF ⇒ plano; imagen ⇒ foto.** `step` es CAD, cuenta como plano. La clasificación solo elige el **default** del panel; el operador ve todo y puede marcar lo que quiera.

- [ ] **Step 1: Write the failing test**

```javascript
// ---------- classifyFile ----------
// Distribución real medida en TLC: jpg 25905 · pdf 3936 · png 627 · jpeg 55 · bmp/gif/tif/step 13

test('classifyFile: PDF y CAD son plano', () => {
  assert.equal(Core.classifyFile('4521-A__plano_rev3.pdf'), 'plano');
  assert.equal(Core.classifyFile('dibujo.dwg'), 'plano');
  assert.equal(Core.classifyFile('modelo.dxf'), 'plano');
  assert.equal(Core.classifyFile('pieza.step'), 'plano');
});

test('classifyFile: imágenes son foto', () => {
  assert.equal(Core.classifyFile('NAT1219802_ISO_02.jpg'), 'foto');
  assert.equal(Core.classifyFile('x.jpeg'), 'foto');
  assert.equal(Core.classifyFile('x.png'), 'foto');
  assert.equal(Core.classifyFile('x.bmp'), 'foto');
  assert.equal(Core.classifyFile('x.gif'), 'foto');
  assert.equal(Core.classifyFile('x.tif'), 'foto');
});

test('classifyFile: la extensión es case-insensitive', () => {
  assert.equal(Core.classifyFile('PLANO.PDF'), 'plano');
  assert.equal(Core.classifyFile('FOTO.JPG'), 'foto');
});

test('classifyFile: nombre con puntos internos usa la ÚLTIMA extensión', () => {
  assert.equal(Core.classifyFile('4521.rev.2.pdf'), 'plano');
  assert.equal(Core.classifyFile('pieza.v1.jpg'), 'foto');
});

test('classifyFile: desconocido o sin extensión es "otro"', () => {
  assert.equal(Core.classifyFile('archivo.xlsx'), 'otro');
  assert.equal(Core.classifyFile('sinextension'), 'otro');
  assert.equal(Core.classifyFile(''), 'otro');
  assert.equal(Core.classifyFile(null), 'otro');
  assert.equal(Core.classifyFile(undefined), 'otro');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/packing-slip-drawings-core.test.js`
Expected: FAIL — `Core.classifyFile is not a function`

- [ ] **Step 3: Write minimal implementation**

Añadir dentro del IIFE de `packing-slip-drawings-core.js`, antes del `const api`:

```javascript
  // Extensiones que cuentan como PLANO. `step` es CAD; entra porque el criterio
  // es "documento técnico que el cliente quiere ver", no "es un PDF".
  const PLANO_EXT = new Set(['pdf', 'dwg', 'dxf', 'step', 'stp', 'iges', 'igs']);
  // Extensiones de imagen. La convención de fotografía del repo es
  // <PN>_<VISTA>_<num> / <PN>__<descriptor>, siempre sobre estas extensiones.
  const FOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'heic']);

  // Última extensión de un nombre, en minúsculas. '' si no tiene.
  function extOf(filename) {
    const s = String(filename == null ? '' : filename);
    const m = s.match(/\.([^.\/\\]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  // 'plano' | 'foto' | 'otro'. SOLO decide el DEFAULT del panel: el operador ve
  // todo y marca lo que quiera. Un plano escaneado en JPG cae en 'foto' y queda
  // desmarcado, pero VISIBLE y a un clic — nunca se oculta.
  function classifyFile(originalName) {
    const e = extOf(originalName);
    if (!e) return 'otro';
    if (PLANO_EXT.has(e)) return 'plano';
    if (FOTO_EXT.has(e)) return 'foto';
    return 'otro';
  }
```

Y ampliar el export: `const api = { readIncluirPlanos, classifyFile };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/packing-slip-drawings-core.test.js`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/packing-slip-drawings-core.js tools/test/packing-slip-drawings-core.test.js
git commit -m "feat(packing-slip-drawings): clasificación plano/foto por extensión medida"
```

---

### Task 3: Núcleo de decisión — armar el plan de adjuntos

**Files:**
- Modify: `remote/scripts/packing-slip-drawings-core.js`
- Test: `tools/test/packing-slip-drawings-core.test.js` (append)

**Interfaces:**
- Consumes: `classifyFile` (Task 2).
- Produces:
  ```
  buildAttachmentPlan({ pns, filesByPn }) → {
    groups:      [{ pnId, pnName, files: [{ filename, displayName, kind, preselected }] }],
    pnsSinPlano: [{ pnId, pnName }],
    totals:      { archivos, preseleccionados, pnsSinArchivo }
  }
  toAttachments(files) → [{ filename, displayName }]
  ```
  Donde `filename` es `userFile.name` (el nombre generado del servidor) y `displayName` es `userFile.originalName` (lo que el cliente ve en el correo).

**Contexto crítico:** `pnsSinPlano` es la mitad del valor del applet. Medido: de 1,726 NP activos de FISHER (único cliente con el check), **1,329 (77%) no tienen ningún archivo** y solo 125 tienen PDF. El caso normal es que no haya nada que adjuntar; si el applet se calla, el operador cree que el cliente recibió sus planos.

**Regla de `pnsSinPlano`:** entra el NP **sin ningún archivo de tipo `plano`** — incluye tanto al que no tiene nada como al que solo tiene fotos. Ambos casos dejan al cliente sin el plano que pidió.

- [ ] **Step 1: Write the failing test**

```javascript
// ---------- buildAttachmentPlan ----------
// Forma de entrada: pns = [{id, name}], filesByPn = { [pnId]: [{name, originalName}] }
// `name` = userFile.name (generado por el servidor, es lo que se adjunta)
// `originalName` = lo que el cliente ve

const PNS = [
  { id: 101, name: '4521-A' },
  { id: 102, name: '4522-B' },
  { id: 103, name: '4523-C' },
];
const FILES = {
  101: [
    { name: 'gen-aaa.pdf', originalName: '4521-A__plano_rev3.pdf' },
    { name: 'gen-bbb.jpg', originalName: '4521-A_ISO_01.jpg' },
  ],
  102: [{ name: 'gen-ccc.pdf', originalName: '4522-B__dwg.pdf' }],
  103: [], // sin ningún archivo — el caso mayoritario (77% en Fisher)
};

test('buildAttachmentPlan: agrupa por NP conservando el orden recibido', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  assert.deepEqual(p.groups.map(g => g.pnName), ['4521-A', '4522-B', '4523-C']);
  assert.equal(p.groups[0].files.length, 2);
  assert.equal(p.groups[2].files.length, 0);
});

test('buildAttachmentPlan: premarca SOLO los planos, las fotos van visibles y desmarcadas', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  const g0 = p.groups[0].files;
  const pdf = g0.find(f => f.displayName.endsWith('.pdf'));
  const jpg = g0.find(f => f.displayName.endsWith('.jpg'));
  assert.equal(pdf.preselected, true);
  assert.equal(pdf.kind, 'plano');
  assert.equal(jpg.preselected, false, 'la foto NO viene marcada');
  assert.ok(jpg, 'pero SÍ está presente — nada se oculta');
});

test('buildAttachmentPlan: adjunta userFile.name y muestra originalName', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  const f = p.groups[0].files[0];
  assert.equal(f.filename, 'gen-aaa.pdf');
  assert.equal(f.displayName, '4521-A__plano_rev3.pdf');
});

test('buildAttachmentPlan: pnsSinPlano incluye al que NO TIENE NADA', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  assert.deepEqual(p.pnsSinPlano.map(x => x.pnName), ['4523-C']);
});

test('buildAttachmentPlan: pnsSinPlano incluye también al que SOLO tiene fotos', () => {
  // Un NP con 3 fotos y ningún plano deja al cliente sin lo que pidió.
  const p = Core.buildAttachmentPlan({
    pns: [{ id: 1, name: 'SOLO-FOTOS' }],
    filesByPn: { 1: [{ name: 'g1.jpg', originalName: 'a_ISO_01.jpg' }] },
  });
  assert.deepEqual(p.pnsSinPlano.map(x => x.pnName), ['SOLO-FOTOS']);
  assert.equal(p.groups[0].files.length, 1, 'la foto sigue visible y marcable');
});

test('buildAttachmentPlan: totals cuenta archivos, premarcados y NP sin archivo', () => {
  const p = Core.buildAttachmentPlan({ pns: PNS, filesByPn: FILES });
  assert.equal(p.totals.archivos, 3);
  assert.equal(p.totals.preseleccionados, 2);
  assert.equal(p.totals.pnsSinArchivo, 1);
});

test('buildAttachmentPlan: entrada vacía no revienta y da un plan vacío', () => {
  const p = Core.buildAttachmentPlan({ pns: [], filesByPn: {} });
  assert.deepEqual(p.groups, []);
  assert.deepEqual(p.pnsSinPlano, []);
  assert.equal(p.totals.archivos, 0);
});

test('buildAttachmentPlan: tolera pns/filesByPn ausentes', () => {
  const p = Core.buildAttachmentPlan({});
  assert.deepEqual(p.groups, []);
  assert.equal(p.totals.archivos, 0);
});

// ---------- toAttachments ----------

test('toAttachments: proyecta al shape que espera la mutation', () => {
  const out = Core.toAttachments([
    { filename: 'gen-aaa.pdf', displayName: 'plano.pdf', kind: 'plano' },
  ]);
  assert.deepEqual(out, [{ filename: 'gen-aaa.pdf', displayName: 'plano.pdf' }]);
});

test('toAttachments: DEDUPLICA por filename — un archivo en dos NP se adjunta una vez', () => {
  // Caso real: dos NP de la misma remisión comparten el mismo plano.
  const out = Core.toAttachments([
    { filename: 'gen-aaa.pdf', displayName: 'compartido.pdf' },
    { filename: 'gen-aaa.pdf', displayName: 'compartido.pdf' },
    { filename: 'gen-bbb.pdf', displayName: 'otro.pdf' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.filename), ['gen-aaa.pdf', 'gen-bbb.pdf']);
});

test('toAttachments: lista vacía da array vacío (el payload no se debe tocar)', () => {
  assert.deepEqual(Core.toAttachments([]), []);
  assert.deepEqual(Core.toAttachments(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/packing-slip-drawings-core.test.js`
Expected: FAIL — `Core.buildAttachmentPlan is not a function`

- [ ] **Step 3: Write minimal implementation**

Añadir dentro del IIFE, antes del `const api`:

```javascript
  // Arma el plan que pinta el panel. Determinista: conserva el orden de `pns`
  // y, dentro de cada NP, el orden en que llegaron los archivos.
  //
  // `pnsSinPlano` es la mitad del valor de este applet: medido, el 77% de los NP
  // de FISHER no tiene NINGÚN archivo, así que "no hay nada que adjuntar" es el
  // caso NORMAL. Si no se delata, el operador cree que el cliente recibió sus planos.
  // Entra al hueco tanto el NP sin nada como el que solo tiene fotos: ambos dejan
  // al cliente sin el plano que pidió.
  function buildAttachmentPlan(input) {
    const pns = (input && input.pns) || [];
    const filesByPn = (input && input.filesByPn) || {};
    const groups = [];
    const pnsSinPlano = [];
    let archivos = 0, preseleccionados = 0, pnsSinArchivo = 0;

    for (const pn of pns) {
      if (!pn || pn.id == null) continue;
      const raw = filesByPn[pn.id] || [];
      const files = raw.map((f) => {
        const displayName = (f && f.originalName) || (f && f.name) || '';
        const kind = classifyFile(displayName);
        const preselected = kind === 'plano';
        archivos++;
        if (preselected) preseleccionados++;
        return { filename: (f && f.name) || '', displayName, kind, preselected };
      });
      groups.push({ pnId: pn.id, pnName: pn.name || '', files });
      if (!files.length) pnsSinArchivo++;
      if (!files.some((f) => f.kind === 'plano')) {
        pnsSinPlano.push({ pnId: pn.id, pnName: pn.name || '' });
      }
    }

    return { groups, pnsSinPlano, totals: { archivos, preseleccionados, pnsSinArchivo } };
  }

  // Proyecta la selección al shape que espera la mutation, deduplicando por
  // `filename`: un mismo archivo puede colgar de dos NP de la misma remisión y
  // el cliente no debe recibirlo dos veces.
  function toAttachments(files) {
    const seen = new Set();
    const out = [];
    for (const f of files || []) {
      if (!f || !f.filename || seen.has(f.filename)) continue;
      seen.add(f.filename);
      out.push({ filename: f.filename, displayName: f.displayName || f.filename });
    }
    return out;
  }
```

Y ampliar el export: `const api = { readIncluirPlanos, classifyFile, buildAttachmentPlan, toAttachments };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/packing-slip-drawings-core.test.js`
Expected: PASS — 22 tests

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/packing-slip-drawings-core.js tools/test/packing-slip-drawings-core.test.js
git commit -m "feat(packing-slip-drawings): plan de adjuntos + el hueco de NP sin plano"
```

---

### Task 4: Núcleo de modal — distinguir el de remisión del de factura

**Files:**
- Create: `remote/scripts/packing-slip-modal-core.js`
- Test: `tools/test/packing-slip-modal-core.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `isShippingEmailModal({ heading, switchCount, hasEmailIcon }) → boolean`

**Contexto crítico (riesgo R3 del spec):** `cfdi-attacher.js:141-146` reconoce el modal de factura por «≥2 MuiSwitch + icono Send/Email». El modal de la remisión tiene **5 MuiSwitch y un icono de correo** ⇒ **también matchearía**. Si los dos applets se activan en el mismo modal, ambos inyectan panel y ambos tocan `attachments`. La señal que los separa es el **heading**: `Send Shipping Email` vs `Send Invoice Email`.

El núcleo recibe datos ya extraídos (heading como string, conteos como números) para poder testearlo sin DOM.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/test/packing-slip-modal-core.test.js
// Golden tests del reconocimiento del modal "Send Shipping Email".
// Estructura capturada EN VIVO el 2026-08-04 (Ecoplating TLC, dominio 344).
// Run: node --test tools/test/packing-slip-modal-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Modal = require('../../remote/scripts/packing-slip-modal-core.js');

// ---------- isShippingEmailModal ----------

test('isShippingEmailModal: reconoce el modal REAL de la remisión', () => {
  // Medido en vivo: heading "Send Shipping Email", 5 MuiSwitch
  // (Logo, Parts List, Visible to Others, Enlace de Albarán de Entrega, +1), icono de correo.
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Shipping Email', switchCount: 5, hasEmailIcon: true,
  }), true);
});

test('isShippingEmailModal: RECHAZA el modal de factura (riesgo R3)', () => {
  // Este es el de cfdi-attacher. Su structMatch (>=2 switches + icono) también
  // matchearía el de remisión, así que la separación la hace el HEADING.
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Invoice Email', switchCount: 3, hasEmailIcon: true,
  }), false);
});

test('isShippingEmailModal: acepta el heading en español', () => {
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Enviar Correo de Albarán', switchCount: 5, hasEmailIcon: true,
  }), true);
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Enviar Remisión', switchCount: 5, hasEmailIcon: true,
  }), true);
});

test('isShippingEmailModal: el heading es case/espacio-insensible', () => {
  assert.equal(Modal.isShippingEmailModal({
    heading: '  SEND   SHIPPING   EMAIL  ', switchCount: 5, hasEmailIcon: true,
  }), true);
});

test('isShippingEmailModal: sin heading cae a la estructura (>=4 switches + icono)', () => {
  // Red de seguridad si SH traduce el título a algo no previsto: el modal de
  // factura tiene 3 switches, el de remisión 5. El umbral de 4 los separa.
  assert.equal(Modal.isShippingEmailModal({
    heading: '', switchCount: 5, hasEmailIcon: true,
  }), true);
  assert.equal(Modal.isShippingEmailModal({
    heading: '', switchCount: 3, hasEmailIcon: true,
  }), false);
});

test('isShippingEmailModal: sin icono de correo NO es el modal', () => {
  assert.equal(Modal.isShippingEmailModal({
    heading: '', switchCount: 5, hasEmailIcon: false,
  }), false);
});

test('isShippingEmailModal: un heading AJENO gana sobre la estructura', () => {
  // Si el título dice claramente "factura", no lo tocamos aunque tenga 5 switches.
  assert.equal(Modal.isShippingEmailModal({
    heading: 'Send Invoice Email', switchCount: 5, hasEmailIcon: true,
  }), false);
});

test('isShippingEmailModal: entrada vacía o basura devuelve false', () => {
  assert.equal(Modal.isShippingEmailModal({}), false);
  assert.equal(Modal.isShippingEmailModal(null), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/packing-slip-modal-core.test.js`
Expected: FAIL — `Cannot find module '../../remote/scripts/packing-slip-modal-core.js'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// remote/scripts/packing-slip-modal-core.js
// Reconocimiento PURO del modal "Send Shipping Email" y extracción de sus NP.
// Recibe datos ya leídos del DOM (strings y números) para poder testearse sin navegador.
// Dual export: module.exports (tests con node) + root.PackingSlipModalCore (browser).
// Golden tests: tools/test/packing-slip-modal-core.test.js
//
// ── POR QUÉ EXISTE LA DISTINCIÓN (riesgo R3) ───────────────────────────────────
// `cfdi-attacher` reconoce el modal de FACTURA por «>=2 MuiSwitch + icono de
// correo». El modal de REMISIÓN, medido en vivo el 2026-08-04, tiene 5 MuiSwitch
// y un icono de correo — o sea que también pasaría ese filtro. Si ambos applets
// se activan en el mismo modal, los dos inyectan panel y los dos tocan
// `attachments`. Lo que los separa es el HEADING.
(function (root) {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // Headings del modal de REMISIÓN. EN medido en vivo; ES pendiente de confirmar
  // (el modal salió en inglés con la app en español). Se anclan los dos que
  // conocemos y se DECLARA la deuda — no se adivina la traducción.
  const HEADING_PROPIO = [/send\s+shipping\s+email/, /enviar\s+correo\s+de\s+albar/, /enviar\s+(la\s+)?remisi/];
  // Headings AJENOS: si el título dice esto, el modal NO es nuestro pase lo que pase.
  const HEADING_AJENO = [/invoice/, /factura/];

  // El modal de factura tiene 3 switches (Logo / Attach PDF / Visible to Others);
  // el de remisión tiene 5. El umbral de 4 los separa cuando no hay heading legible.
  const MIN_SWITCHES = 4;

  function isShippingEmailModal(info) {
    if (!info) return false;
    if (!info.hasEmailIcon) return false;
    const h = norm(info.heading);
    if (h && HEADING_AJENO.some((re) => re.test(h))) return false;
    if (h && HEADING_PROPIO.some((re) => re.test(h))) return true;
    // Sin heading reconocible: red de seguridad estructural.
    return Number(info.switchCount) >= MIN_SWITCHES;
  }

  const api = { isShippingEmailModal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PackingSlipModalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/packing-slip-modal-core.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/packing-slip-modal-core.js tools/test/packing-slip-modal-core.test.js
git commit -m "feat(packing-slip-drawings): distinguir el modal de remisión del de factura (R3)"
```

---

### Task 5: Núcleo de modal — extraer los NP de la tabla del correo

**Files:**
- Modify: `remote/scripts/packing-slip-modal-core.js`
- Test: `tools/test/packing-slip-modal-core.test.js` (append)

**Interfaces:**
- Consumes: nada de Task 4.
- Produces: `extractPartNumbers(rowTexts) → [{ pnName, soNumber, woNumber, qty }]`

**Contexto:** el reconocimiento en vivo mostró que el modal **ya trae la tabla de partes** con encabezado `SO # | WO # | Part # | QTY` y filas como `#1770 - 4300016123 | #13667 | 10-4307003-001 | 2567`. Esto cierra el riesgo R2: no hace falta descubrir una query nueva. El núcleo recibe **el texto de cada fila ya extraído** (array de strings), no nodos.

**Regla de robustez:** el nombre del NP es lo único que importa; SO/WO/QTY son contexto para el panel. Una fila que no calce el patrón se **descarta con `warn`**, nunca se inventa.

- [ ] **Step 1: Write the failing test**

```javascript
// ---------- extractPartNumbers ----------
// Filas capturadas EN VIVO del preview del correo (remisión #1746, 2026-08-04).
// El separador real entre celdas es tabulador (innerText de un <tr>).

test('extractPartNumbers: lee la fila REAL capturada en vivo', () => {
  const out = Modal.extractPartNumbers(['#1770 - 4300016123\t#13667\t10-4307003-001\t2567']);
  assert.equal(out.length, 1);
  assert.equal(out[0].pnName, '10-4307003-001');
  assert.equal(out[0].soNumber, '#1770 - 4300016123');
  assert.equal(out[0].woNumber, '#13667');
  assert.equal(out[0].qty, '2567');
});

test('extractPartNumbers: descarta la fila de ENCABEZADO', () => {
  const out = Modal.extractPartNumbers([
    'SO #\tWO #\tPart #\tQTY',
    '#1770 - 4300016123\t#13667\t10-4307003-001\t2567',
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pnName, '10-4307003-001');
});

test('extractPartNumbers: varias partes conservan su orden', () => {
  const out = Modal.extractPartNumbers([
    'SO #\tWO #\tPart #\tQTY',
    '#1\t#10\tPN-AAA\t5',
    '#2\t#20\tPN-BBB\t7',
    '#3\t#30\tPN-CCC\t9',
  ]);
  assert.deepEqual(out.map(x => x.pnName), ['PN-AAA', 'PN-BBB', 'PN-CCC']);
});

test('extractPartNumbers: DEDUPLICA el mismo PN repetido en varias líneas', () => {
  // El preview del modal repite bloques "Parts List"; el mismo PN puede salir 4 veces.
  const out = Modal.extractPartNumbers([
    '#1\t#10\tPN-AAA\t5',
    '#1\t#10\tPN-AAA\t5',
    '#2\t#20\tPN-BBB\t7',
  ]);
  assert.deepEqual(out.map(x => x.pnName), ['PN-AAA', 'PN-BBB']);
});

test('extractPartNumbers: descarta filas que no calzan, sin inventar', () => {
  const out = Modal.extractPartNumbers([
    'Respond to this email with any questions.',
    'Copyright © 2026 - Steelhead Technologies',
    'Click to View Packing Slip #1746',
    '',
    '#1\t#10\tPN-AAA\t5',
  ]);
  assert.deepEqual(out.map(x => x.pnName), ['PN-AAA']);
});

test('extractPartNumbers: entrada vacía da lista vacía — y eso NO es conocimiento', () => {
  // Una lista vacía puede significar "no hay partes" o "no supe leerlas".
  // Quien consume debe tratarla como hueco, no como certeza. Ver glue (Task 7).
  assert.deepEqual(Modal.extractPartNumbers([]), []);
  assert.deepEqual(Modal.extractPartNumbers(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/packing-slip-modal-core.test.js`
Expected: FAIL — `Modal.extractPartNumbers is not a function`

- [ ] **Step 3: Write minimal implementation**

Añadir dentro del IIFE de `packing-slip-modal-core.js`, antes del `const api`:

```javascript
  // Encabezados de la tabla de partes, en los dos idiomas conocidos.
  const HEADER_RE = /^(so\s*#|wo\s*#|part\s*#|qty|ov\s*#|ot\s*#|parte\s*#|cant)/;

  // Extrae los NP de la tabla del preview del correo.
  // Entrada: el innerText de cada <tr> (celdas separadas por tabulador).
  // Formato REAL medido: "#1770 - 4300016123\t#13667\t10-4307003-001\t2567"
  //                       SO #                WO #    Part #          QTY
  //
  // Descarta lo que no calce en vez de adivinar: escribir el PN equivocado es
  // peor que no escribir ninguno. El preview repite bloques "Parts List", así
  // que se deduplica por nombre de PN.
  function extractPartNumbers(rowTexts) {
    const out = [];
    const seen = new Set();
    for (const raw of rowTexts || []) {
      const line = String(raw == null ? '' : raw).trim();
      if (!line) continue;
      if (HEADER_RE.test(line.toLowerCase())) continue;
      const cells = line.split('\t').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length < 4) continue;
      const pnName = cells[2];
      if (!pnName || seen.has(pnName)) continue;
      seen.add(pnName);
      out.push({ pnName, soNumber: cells[0], woNumber: cells[1], qty: cells[3] });
    }
    return out;
  }
```

Y ampliar el export: `const api = { isShippingEmailModal, extractPartNumbers };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/packing-slip-modal-core.test.js`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/packing-slip-modal-core.js tools/test/packing-slip-modal-core.test.js
git commit -m "feat(packing-slip-drawings): leer los NP del DOM del modal (cierra R2)"
```

---

### Task 6: El panel — UI dark mode inyectada bajo «Attachments»

**Files:**
- Create: `remote/scripts/packing-slip-drawings.js`
- Test: manual en vivo (la UI no se testea con node; la decisión ya está cubierta por Tasks 1-5)

**Interfaces:**
- Consumes: `PackingSlipDrawingsCore.buildAttachmentPlan`, `PackingSlipModalCore.isShippingEmailModal`, `PackingSlipModalCore.extractPartNumbers`, `MuiIconAnchorCore.hasAnyIcon`, `SteelheadAPI.query`.
- Produces: `window.PackingSlipDrawings = { init, getSelectedFiles, getPlan }`
  - `getSelectedFiles() → [{ filename, displayName, kind, url }]` — lo marcado. Consumen Task 7 (correo, usa `filename`/`displayName`) y Task 8 (impresión, usa `url`/`displayName`).
  - `getPlan() → { groups, pnsSinPlano, noResueltos, totals }`

**Estructura medida del punto de inyección (2026-08-04):**

```html
<tr class="MuiTableRow-root">
  <td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium">
    <p class="MuiTypography-root MuiTypography-body1">Attachments</p>
  </td>
  <td class="MuiTableCell-root MuiTableCell-body MuiTableCell-sizeMedium">
    <div><button class="MuiButtonBase-root MuiButton-root MuiButton-contained …">ADD</button></div>
  </td>
</tr>
```

- [ ] **Step 1: Escribir el esqueleto del applet con el observer y el gate**

```javascript
// remote/scripts/packing-slip-drawings.js
// Planos en Remisión — adjunta los archivos del NP al correo del albarán.
// Depende de: SteelheadAPI, MuiIconAnchorCore, PackingSlipDrawingsCore, PackingSlipModalCore
const PackingSlipDrawings = (() => {
  'use strict';

  const LOG = '[SA][planos-remision]';
  const Core = () => window.PackingSlipDrawingsCore;
  const Modal = () => window.PackingSlipModalCore;
  const api = () => window.SteelheadAPI;

  let enabled = true;
  let currentPlan = null;      // plan del modal abierto
  let selected = new Map();    // filename → {filename, displayName, kind}
  let observerActive = false;

  // ── Reconocimiento del modal ───────────────────────────────────────────────

  function readModalInfo(dlg) {
    const Icons = window.MuiIconAnchorCore;
    const heading = (dlg.querySelector('h1,h2,h3,h4,h5,h6') || {}).textContent || '';
    const switchCount = dlg.querySelectorAll('.MuiSwitch-root, [class*="Switch-root"]').length;
    // El path del sobre YA está catalogado como EmailOutlinedIcon (coincide byte
    // a byte con el medido en vivo). En ESTA pantalla no hay aria de respaldo:
    // la forma no es la segunda opción, es la única.
    const hasEmailIcon = Icons
      ? Icons.hasAnyIcon(dlg, ['EmailOutlinedIcon', 'SendIcon'])
      : !!dlg.querySelector('svg');
    return { heading, switchCount, hasEmailIcon };
  }

  // Localiza la fila "Attachments" por TEXTO de su primera celda (ES+EN),
  // nunca por clase css-<hash>.
  function findAttachmentsRow(dlg) {
    const rows = dlg.querySelectorAll('tr');
    for (const tr of rows) {
      const first = tr.querySelector('td, th');
      if (!first) continue;
      const t = (first.textContent || '').trim().toLowerCase();
      if (/^(attachments?|adjuntos?|archivos adjuntos)$/.test(t)) return tr;
    }
    return null;
  }

  function init() {
    enabled = document.documentElement.dataset.saPsDrawingsEnabled !== 'false';
    setupObserver();  // el observer se monta SIEMPRE, aunque el applet esté apagado
    console.log(LOG, 'inicializado', enabled ? '(activo)' : '(apagado)');
  }

  return { init };
})();

if (typeof window !== 'undefined') {
  window.PackingSlipDrawings = PackingSlipDrawings;
  PackingSlipDrawings.init();
}
```

- [ ] **Step 2: Añadir el observer con latch de ÉXITO (no de intento)**

Insertar antes de `function init()`:

```javascript
  // El latch marca el ÉXITO, no el INTENTO: si `mountPanel` falla por un render
  // a medias y marcáramos antes, el panel se congelaría "desaparecido" para
  // siempre. Devuelve si logró montar; solo entonces se marca.
  function setupObserver() {
    if (observerActive) return;
    observerActive = true;
    const obs = new MutationObserver(() => {
      const dlg = document.querySelector('.MuiDialog-paper, [role="dialog"]');
      if (!dlg) { currentPlan = null; selected.clear(); return; }
      if (dlg.dataset.saPsDrawingsMounted === '1') return;
      if (!Modal().isShippingEmailModal(readModalInfo(dlg))) return;
      if (mountPanel(dlg)) dlg.dataset.saPsDrawingsMounted = '1';
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
```

- [ ] **Step 3: Añadir la resolución NP → archivos**

El modal da el **nombre** del PN, no su id. Hay que resolver `nombre → id → archivos`, con las dos
queries que el repo ya usa (`file-uploader.js:88-108`). La URL de descarga se arma con el
**`userFile.name`** (el nombre generado del servidor).

Insertar antes de `function setupObserver()`:

```javascript
  // El endpoint desde el que se sirve un userFile ya subido. R4/R7: hay que
  // CONFIRMARLO en vivo con un archivo real antes de confiar en la impresión
  // (Task 7 Step 2). Si cambia, es lo único que hay que tocar.
  const FILE_URL = (generatedName) => `/api/files/${encodeURIComponent(generatedName)}`;

  // nombre de PN → {id, name} exacto. SearchPartNumbers NO devuelve archivados,
  // que es justo lo que queremos: un NP archivado no debería ir en una remisión.
  async function resolvePnId(pnName) {
    const data = await api().query('SearchPartNumbers', {
      searchQuery: pnName, first: 20, offset: 0, orderBy: ['ID_DESC'],
    });
    const nodes = (data && data.searchPartNumbers && data.searchPartNumbers.nodes) || [];
    const exact = nodes.find((n) => n && String(n.name).trim() === String(pnName).trim());
    return exact ? { id: exact.id, name: exact.name } : null;
  }

  // id de PN → archivos vinculados. Misma query que usa file-uploader.
  async function fetchPnFiles(pnId) {
    const data = await api().query('GetPartNumber', {
      partNumberId: pnId, usagesLimit: 10, usagesOffset: 0,
    });
    const pn = (data && data.partNumberById) || {};
    const nodes = (pn.partNumberUserFilesByPartNumberId
      && pn.partNumberUserFilesByPartNumberId.nodes) || [];
    return nodes
      .map((n) => n && n.userFileByUserFileName)
      .filter(Boolean)
      .map((uf) => ({ name: uf.name, originalName: uf.originalName }));
  }

  // Resuelve todo el plan. SERIAL a propósito: el /graphql de SH se cuelga bajo
  // ráfaga (~40 requests) y el límite es POR SESIÓN — tumbaría también la
  // pantalla nativa. Una remisión puede traer 88 NP; no se paraleliza.
  async function loadFilesFor(parts, container) {
    const pns = [];
    const filesByPn = {};
    const noResueltos = [];
    for (const p of parts) {
      try {
        const pn = await resolvePnId(p.pnName);
        if (!pn) { noResueltos.push(p.pnName); continue; }
        pns.push(pn);
        filesByPn[pn.id] = await fetchPnFiles(pn.id);
      } catch (e) {
        noResueltos.push(p.pnName);
        console.warn(LOG, 'no pude resolver', p.pnName, e && e.message);
      }
    }
    currentPlan = Core().buildAttachmentPlan({ pns, filesByPn });
    currentPlan.noResueltos = noResueltos;   // hueco DISTINTO al de "sin plano"
    selected.clear();
    for (const g of currentPlan.groups) {
      for (const f of g.files) {
        if (f.preselected) selected.set(f.filename, { ...f, url: FILE_URL(f.filename) });
      }
    }
    renderPanel(container);
  }
```

- [ ] **Step 4: Añadir el montaje y el render del panel (dark mode + ámbar del hueco)**

Insertar antes de `function setupObserver()`:

```javascript
  const PALETTE = {
    bg: '#1c2430', fg: '#e6e9ee', input: '#141a23',
    accent: '#13a36f', amber: '#d98e04', dim: '#8b95a5',
  };

  // Los nombres de PN y de archivo vienen de GraphQL ⇒ vector cross-user.
  // Se escapan SIEMPRE antes de entrar a innerHTML.
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Devuelve true SOLO si logró montar. El gate de estado va aquí dentro, no
  // antes del observer: la UI de entrada se monta siempre que la ruta aplique.
  function mountPanel(dlg) {
    if (!enabled) return false;
    const row = findAttachmentsRow(dlg);
    if (!row) { console.warn(LOG, 'no encontré la fila de adjuntos'); return false; }

    const parts = Modal().extractPartNumbers(
      [...dlg.querySelectorAll('tr')].map((tr) => tr.innerText || '')
    );

    const tr = document.createElement('tr');
    tr.className = row.className;                 // hereda del vecino VIVO
    tr.dataset.saPsDrawings = '1';
    const tdLabel = document.createElement('td');
    const tdBody = document.createElement('td');
    const cells = row.querySelectorAll('td, th');
    if (cells[0]) tdLabel.className = cells[0].className;
    if (cells[1]) tdBody.className = cells[1].className;
    tdLabel.textContent = 'Planos';
    tdBody.style.cssText = `background:${PALETTE.bg};color:${PALETTE.fg};border-radius:6px;padding:8px;`;
    tdBody.textContent = 'Buscando planos…';
    tr.appendChild(tdLabel);
    tr.appendChild(tdBody);
    row.parentElement.insertBefore(tr, row.nextSibling);

    loadFilesFor(parts, tdBody);   // async: pinta cuando llega
    return true;
  }

  // Pinta el plan. TRES estados distintos, y ninguno se confunde con otro:
  //   · archivos listados (con su checkbox)
  //   · ÁMBAR "sin plano": el cliente los pide y el NP no los tiene — es el caso
  //     MAYORITARIO medido (77% de los NP de Fisher), y callarlo haría creer al
  //     operador que el cliente los recibió
  //   · ÁMBAR "no pude verificar": no se resolvió el NP. Distinto de "no tiene".
  function renderPanel(container) {
    const plan = currentPlan;
    if (!plan) { container.textContent = 'No pude leer los números de parte.'; return; }
    const parts = [];

    for (const g of plan.groups) {
      parts.push(`<div style="margin:6px 0;font-weight:600">${escHtml(g.pnName)}</div>`);
      if (!g.files.length) {
        parts.push(`<div style="color:${PALETTE.amber};margin-left:12px">⚠ sin archivos cargados</div>`);
        continue;
      }
      for (const f of g.files) {
        const chk = f.preselected ? 'checked' : '';
        parts.push(
          `<label style="display:block;margin-left:12px;color:${PALETTE.fg}">` +
          `<input type="checkbox" data-sa-file="${escHtml(f.filename)}" ${chk}> ` +
          `${escHtml(f.displayName)} <span style="color:${PALETTE.dim}">(${escHtml(f.kind)})</span>` +
          `</label>`
        );
      }
    }

    if (plan.pnsSinPlano.length) {
      parts.push(
        `<div style="margin-top:10px;padding:8px;border-left:3px solid ${PALETTE.amber};color:${PALETTE.amber}">` +
        `Este cliente pide planos. <b>${plan.pnsSinPlano.length}</b> de <b>${plan.groups.length}</b> ` +
        `número(s) de parte no tienen ninguno: ${escHtml(plan.pnsSinPlano.map(p => p.pnName).join(', '))}` +
        `</div>`
      );
    }
    if (plan.noResueltos && plan.noResueltos.length) {
      parts.push(
        `<div style="margin-top:8px;padding:8px;border-left:3px solid ${PALETTE.amber};color:${PALETTE.amber}">` +
        `No pude verificar ${plan.noResueltos.length} número(s) de parte: ` +
        `${escHtml(plan.noResueltos.join(', '))}. El correo sale igual.</div>`
      );
    }

    parts.push(
      `<div style="margin-top:10px">` +
      `<button data-sa-print="1" style="background:${PALETTE.accent};color:#fff;border:0;` +
      `border-radius:4px;padding:6px 12px;cursor:pointer">🖨️ Imprimir remisión + selección</button>` +
      `<span data-sa-count style="margin-left:10px;color:${PALETTE.dim}"></span></div>`
    );

    container.innerHTML = parts.join('');
    container.querySelectorAll('input[data-sa-file]').forEach((cb) => {
      cb.addEventListener('change', () => onToggleFile(cb.dataset.saFile, cb.checked));
    });
    const printBtn = container.querySelector('button[data-sa-print]');
    if (printBtn) printBtn.addEventListener('click', () => onPrint(container));
    updateCount(container);
  }

  function findFileInPlan(filename) {
    for (const g of (currentPlan ? currentPlan.groups : [])) {
      const f = g.files.find((x) => x.filename === filename);
      if (f) return f;
    }
    return null;
  }

  function onToggleFile(filename, checked) {
    const f = findFileInPlan(filename);
    if (!f) return;
    if (checked) selected.set(filename, { ...f, url: FILE_URL(filename) });
    else selected.delete(filename);
    const c = document.querySelector('tr[data-sa-ps-drawings] [data-sa-count]');
    if (c) c.textContent = `${selected.size} seleccionado(s)`;
  }

  function updateCount(container) {
    const c = container.querySelector('[data-sa-count]');
    if (c) c.textContent = `${selected.size} seleccionado(s)`;
  }

  // Lo que consumen el interceptor (Task 7) y la impresión (Task 8).
  // Shape: [{filename, displayName, kind, url}]
  function getSelectedFiles() { return [...selected.values()]; }
  function getPlan() { return currentPlan; }
```

- [ ] **Step 5: Exportar la API pública**

Cambiar el `return` del IIFE a:

```javascript
  return { init, getSelectedFiles, getPlan };
```

- [ ] **Step 6: Probar en vivo con el operador**

Abrir `/Domains/344/Shipping/PackingSlips`, dar clic en el sobre de una remisión y verificar:
- el panel aparece **bajo** la fila Attachments, en dark mode
- el panel **NO** aparece en el modal de factura (`/Domains/344/Invoices`) — riesgo R3
- los NP listados coinciden con los del preview del correo
- en una remisión de **FISHER** sin archivos, sale el bloque ámbar

- [ ] **Step 7: Commit**

```bash
git add remote/scripts/packing-slip-drawings.js
git commit -m "feat(packing-slip-drawings): panel dark mode con el hueco en ámbar"
```

---

### Task 7: El interceptor — inyectar los adjuntos sin congelar la pestaña

**Files:**
- Modify: `remote/scripts/packing-slip-drawings.js`

**Interfaces:**
- Consumes: `getSelectedFiles()` (Task 6), `Core().toAttachments`.
- Produces: efecto sobre `variables.attachments` de la mutation de envío.

**Contexto crítico (R8, medido):** el payload del envío lleva el **HTML completo del correo**. En el reconocimiento, un interceptor que hacía `JSON.parse` + regex global sobre ese body **congeló la pestaña dos veces, >25 s cada una**. Este interceptor hace lo mínimo: un `JSON.parse`, tocar `attachments`, re-serializar.

**Contexto (R1, abierto):** el nombre exacto de la operación no está confirmado. Se implementa con una **lista** de nombres aceptados que incluye `SendEmailChecked` (la que ya intercepta `cfdi-attacher`), y se registra en consola el `operationName` real la primera vez que pase una mutation de envío, para cerrarlo en la primera corrida real.

- [ ] **Step 1: Añadir el interceptor**

```javascript
  // Operaciones que mandan el correo. R1 ABIERTO: `SendEmailChecked` es la que
  // usa el modal de factura (cfdi-attacher) y es la candidata más probable, pero
  // NO está confirmada para el de remisión — el clic en SEND congelaba la
  // pestaña durante el reconocimiento. Se aceptan varias y se LOGUEA la real.
  const SEND_OPS = ['SendEmailChecked', 'SendShippingEmail', 'SendPackingSlipEmail'];

  let origFetch = null;

  function patchFetch() {
    if (window.__saPsDrawingsFetchPatched) return;
    window.__saPsDrawingsFetchPatched = true;
    origFetch = window.fetch;

    window.fetch = function (...args) {
      const [url, opts] = args;
      // Guardas BARATAS primero: nada de trabajo sobre el body si no aplica.
      if (!selected.size) return origFetch.apply(this, args);
      if (typeof url !== 'string' || url.indexOf('/graphql') < 0) return origFetch.apply(this, args);
      if (!opts || typeof opts.body !== 'string') return origFetch.apply(this, args);

      // ⚠️ R8: el body lleva el HTML COMPLETO del correo. UN parse, tocar solo
      // `attachments`, re-serializar. NADA de regex globales sobre el body —
      // eso congeló la pestaña dos veces en el reconocimiento del 2026-08-04.
      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch (_) { return origFetch.apply(this, args); }
      const opName = bodyObj && bodyObj.operationName;
      if (!opName || SEND_OPS.indexOf(opName) < 0) return origFetch.apply(this, args);

      console.log(LOG, 'operación de envío detectada:', opName);  // cierra R1 en vivo

      try {
        const extra = Core().toAttachments([...selected.values()]);
        if (extra.length) {
          bodyObj.variables = bodyObj.variables || {};
          bodyObj.variables.attachments = [
            ...(bodyObj.variables.attachments || []),
            ...extra,
          ];
          args[1] = Object.assign({}, opts, { body: JSON.stringify(bodyObj) });
          console.log(LOG, `${extra.length} plano(s) adjuntado(s)`);
        }
      } catch (e) {
        // A DIFERENCIA de cfdi-attacher, aquí NO se cancela el envío: una
        // factura sin CFDI es inválida, una remisión sin plano sigue siendo
        // una remisión. Se avisa y el correo sale.
        console.warn(LOG, 'no pude adjuntar los planos, el correo sale sin ellos:', e && e.message);
      }
      return origFetch.apply(this, args);
    };
  }
```

Y llamar `patchFetch()` dentro de `init()`, antes de `setupObserver()`.

- [ ] **Step 2: Verificar que no cancela el envío ante error**

Forzar `Core().toAttachments` a lanzar (temporalmente, en consola:
`window.PackingSlipDrawingsCore.toAttachments = () => { throw new Error('boom'); }`),
mandar un correo de prueba **al correo del consultor** y confirmar que **sí sale**, con el `warn` en consola.

- [ ] **Step 3: Confirmar R1 con el operador**

En el primer envío real, leer el `console.log` `operación de envío detectada: <nombre>`. Si el nombre **no** está en `SEND_OPS`, añadirlo y **documentarlo en la bitácora**; si es `SendEmailChecked`, marcar R1 como cerrado en el spec.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/packing-slip-drawings.js
git commit -m "feat(packing-slip-drawings): interceptor que adjunta sin congelar (R8)"
```

---

### Task 8: Impresión — PDF combinado con `pdf-lib`

**Files:**
- Create: `remote/scripts/packing-slip-print.js`
- Create: `remote/scripts/lib/pdf-lib.min.js` (descargar el artefacto)

**Interfaces:**
- Consumes: `PackingSlipDrawings.getSelectedFiles()`.
- Produces: `window.PackingSlipPrint = { printCombined({ packingSlipPdfUrl, files }) → Promise<{ok, missing}> }`

**Contexto:** `remote/scripts/lib/` ya sirve `pdf.min.js` (377 KB) y `xlsx.full.min.js` (881 KB), cada uno declarado en el array `scripts` del applet que lo usa — meter `pdf-lib` sigue el precedente. `pdf.js` **lee**, `pdf-lib` **escribe**: son complementarias.

- [ ] **Step 1: Descargar la librería**

```bash
curl -L -o remote/scripts/lib/pdf-lib.min.js https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js
node --check remote/scripts/lib/pdf-lib.min.js && ls -la remote/scripts/lib/pdf-lib.min.js
```

- [ ] **Step 2: Escribir el módulo de impresión**

```javascript
// remote/scripts/packing-slip-print.js
// Cose la remisión + los archivos seleccionados en UN PDF y lo manda a imprimir.
// Depende de: pdf-lib (window.PDFLib)
//
// Por qué coser y no imprimir uno por uno: con 88 NP en una remisión real de
// Fisher serían decenas de diálogos. Y por qué pdf-lib y no rasterizar con el
// pdf.js que ya está: rasterizar degrada justo las cotas finas de los planos,
// que es lo que el cliente exige impreso.
const PackingSlipPrint = (() => {
  'use strict';
  const LOG = '[SA][planos-remision][print]';

  async function fetchBytes(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status} al bajar ${url}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // Devuelve {ok, missing[]}. `missing` son los archivos que no se pudieron
  // incorporar: se REPORTAN, nunca se omiten en silencio.
  async function printCombined({ packingSlipPdfUrl, files }) {
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    const missing = [];

    // 1) La remisión va PRIMERO. Si falla, se sigue con los archivos y se avisa.
    if (packingSlipPdfUrl) {
      try {
        const src = await PDFDocument.load(await fetchBytes(packingSlipPdfUrl));
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } catch (e) {
        missing.push({ name: 'la remisión', reason: e.message });
        console.warn(LOG, 'no pude incorporar la remisión:', e.message);
      }
    }

    // 2) Los archivos, en el orden del panel (agrupados por NP).
    for (const f of files || []) {
      try {
        const bytes = await fetchBytes(f.url);
        if (/\.pdf$/i.test(f.displayName)) {
          const src = await PDFDocument.load(bytes);
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        } else if (/\.(jpe?g)$/i.test(f.displayName)) {
          addImagePage(out, await out.embedJpg(bytes));
        } else if (/\.png$/i.test(f.displayName)) {
          addImagePage(out, await out.embedPng(bytes));
        } else {
          missing.push({ name: f.displayName, reason: 'formato no imprimible' });
        }
      } catch (e) {
        missing.push({ name: f.displayName, reason: e.message });
        console.warn(LOG, 'no pude incorporar', f.displayName, e.message);
      }
    }

    if (!out.getPageCount()) return { ok: false, missing };
    await sendToPrinter(await out.save());
    return { ok: true, missing };
  }

  // Una imagen por página, escalada a CARTA (612×792 pt) respetando la
  // relación de aspecto y centrada.
  function addImagePage(doc, img) {
    const PW = 612, PH = 792, M = 18;
    const page = doc.addPage([PW, PH]);
    const scale = Math.min((PW - M * 2) / img.width, (PH - M * 2) / img.height);
    const w = img.width * scale, h = img.height * scale;
    page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
  }

  // Iframe oculto + print(). Mismo patrón ya probado en wo-listing-columns
  // para las etiquetas de OT, con su fallback a pestaña.
  function sendToPrinter(bytes) {
    return new Promise((resolve) => {
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0;opacity:0;';
      iframe.src = url;
      iframe.onload = () => {
        try { iframe.contentWindow.print(); }
        catch (e) { console.warn(LOG, 'iframe bloqueado, abro pestaña:', e.message); window.open(url, '_blank'); }
        setTimeout(() => { try { iframe.remove(); URL.revokeObjectURL(url); } catch (_) {} }, 60000);
        resolve();
      };
      document.body.appendChild(iframe);
    });
  }

  return { printCombined };
})();

if (typeof window !== 'undefined') window.PackingSlipPrint = PackingSlipPrint;
```

- [ ] **Step 3: Definir `onPrint` en `packing-slip-drawings.js`**

El botón 🖨️ ya lo pinta `renderPanel` (Task 6) con `data-sa-print` y su listener llama a `onPrint`.
Falta definir esa función. Insertar junto a `getSelectedFiles`:

```javascript
  // El link al albarán ya vive en el modal ("Click to View Packing Slip #1746"),
  // así que se toma de ahí en vez de adivinar una ruta. R7: si no aparece, se
  // imprime SOLO la selección y se dice — nunca se imprime en silencio algo
  // distinto de lo que el operador marcó.
  function findPackingSlipPdfUrl(dlg) {
    const a = dlg && dlg.querySelector(
      'a[href*="/api/pdf/share/"], object[data*="/api/pdf/share/"], iframe[src*="/api/pdf/share/"]'
    );
    if (!a) return null;
    return a.getAttribute('href') || a.getAttribute('data') || a.getAttribute('src');
  }

  async function onPrint(container) {
    const btn = container.querySelector('button[data-sa-print]');
    if (btn) { btn.disabled = true; btn.textContent = '🖨️ Preparando…'; }
    const dlg = container.closest('.MuiDialog-paper, [role="dialog"]');
    const psUrl = findPackingSlipPdfUrl(dlg);
    try {
      const res = await window.PackingSlipPrint.printCombined({
        packingSlipPdfUrl: psUrl,
        files: getSelectedFiles(),
      });
      if (!res.ok) {
        alert('No se pudo armar nada para imprimir (ni la remisión ni los archivos).');
      } else if (res.missing.length) {
        // Se REPORTA lo que no entró. Imprimir de menos en silencio es
        // exactamente el modo de falla que este applet existe para evitar.
        alert('Se mandó a imprimir, pero esto NO entró:\n' +
          res.missing.map((m) => `• ${m.name} (${m.reason})`).join('\n'));
      }
    } catch (e) {
      alert('Error al imprimir: ' + (e && e.message));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🖨️ Imprimir remisión + selección'; }
    }
  }
```

- [ ] **Step 4: Probar en vivo**

Imprimir una remisión con 1 PDF + 1 JPG marcados y verificar: **un solo diálogo**, la remisión
primero, el plano legible (no rasterizado), la foto en su propia página. Probar también **sin** que
el modal tenga link de albarán, y confirmar que imprime solo la selección **y lo dice**.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/packing-slip-print.js remote/scripts/lib/pdf-lib.min.js
git commit -m "feat(packing-slip-drawings): imprimir remisión + selección en un PDF"
```

---

### Task 9: Registro, cableado y ruta de regeneración de hash

**Files:**
- Modify: `remote/config.json`
- Modify: `extension/background.js` (case del toggle)
- Modify: `tools/hash-autopilot/route-catalog.json`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: el applet cargado y encendible desde el popup.

**Contexto:** un botón del popup es un contrato entre TRES archivos —`popup.js` lo pinta, `config.json` lo declara, el script remoto lo implementa— y **ninguno falla solo**. Los trinquetes `popup-actions-wired.test.js` y `mui-icon-core-wiring.test.js` existen justo por eso.

- [ ] **Step 1: Añadir la app a `config.json`**

```jsonc
{
  "id": "packing-slip-drawings",
  "name": "Planos en Remisión",
  "subtitle": "Adjunta los planos del NP al correo del albarán",
  "icon": "📐",
  "category": "Herramientas",
  "autoInject": true,
  "urlPatterns": ["^/Domains/\\d+/Shipping(?:/|$)"],
  "scripts": [
    "scripts/steelhead-api.js",
    "scripts/mui-icon-anchor-core.js",
    "scripts/lib/pdf-lib.min.js",
    "scripts/packing-slip-drawings-core.js",
    "scripts/packing-slip-modal-core.js",
    "scripts/packing-slip-print.js",
    "scripts/packing-slip-drawings.js"
  ],
  "requiredPermissions": [],
  "actions": [{
    "id": "toggle-packing-slip-drawings",
    "label": "Planos en Remisión",
    "sublabel": "Adjunta los planos del NP al enviar el albarán",
    "icon": "📐",
    "type": "toggle",
    "handler": "message",
    "message": "toggle-packing-slip-drawings"
  }]
}
```

**El `urlPatterns` cubre las DOS superficies** que pidió el operador: `/Shipping` (módulo donde se
crean) y `/Shipping/PackingSlips` (lista de albaranes). Es deliberadamente **más ancho** que el de
`batch-name-filter`, que excluye sub-rutas a propósito.

- [ ] **Step 2: Correr los trinquetes de cableado**

Run: `node --test tools/test/popup-actions-wired.test.js tools/test/mui-icon-core-wiring.test.js`
Expected: PASS. Si falla, añadir el `case 'toggle-packing-slip-drawings'` en `extension/background.js`.

- [ ] **Step 3: Registrar la ruta de regeneración de hash**

Si Task 7 descubrió una operación **nueva** (no `SendEmailChecked`), añadirla a
`tools/hash-autopilot/route-catalog.json` con la ruta:
`goto /Domains/{domain}/Shipping/PackingSlips` → clic en el icono `EmailOutlinedIcon` de la fila →
captura. **Un hash sin ruta de regeneración es deuda** y el trinquete lo verifica.

Run: `node --test tools/test/hash-regen-coverage.test.js`
Expected: PASS — el número de huérfanas **no sube** de la línea base (59 al 2026-08-04).

- [ ] **Step 4: Correr la suite completa**

Run: `tools/run-tests.sh`
Expected: PASS en todos los archivos.

- [ ] **Step 5: Commit**

```bash
git add remote/config.json extension/background.js tools/hash-autopilot/route-catalog.json
git commit -m "feat(packing-slip-drawings): registro en config + cableado del toggle"
```

---

### Task 10: Bitácora e índice

**Files:**
- Create: `docs/applets/packing-slip-drawings.md`
- Modify: `CLAUDE.md` (tabla de applets)
- Modify: `docs/applets/README.md`

- [ ] **Step 1: Escribir la bitácora**

Debe contener, además del qué-hace: la **evidencia medida** (77% de NP de Fisher sin archivo — el
hueco es el caso normal), el **anclaje** (forma `EmailOutlinedIcon`, sin aria en esta pantalla), la
**regla R8** (nada síncrono sobre el body), la **deuda bilingüe** declarada (heading ES pendiente,
tooltip EN pendiente) y el estado de **R1**.

- [ ] **Step 2: Añadir el renglón al índice de `CLAUDE.md`**

```markdown
| `packing-slip-drawings` | 0.1.0 | Adjunta los planos del NP al correo de la remisión + imprime remisión y selección en un PDF | [`packing-slip-drawings.md`](docs/applets/packing-slip-drawings.md) |
```

- [ ] **Step 3: Commit**

```bash
git add docs/applets/packing-slip-drawings.md CLAUDE.md docs/applets/README.md
git commit -m "docs(packing-slip-drawings): bitácora e índice"
```

---

### Task 11: Deploy

- [ ] **Step 1: Verificar el estado antes de razonar sobre él**

Run: `tools/deploy-status.sh`
Expected: la rama de trabajo, `main`, `gh-pages` y el sitio en vivo, con el invariante byte-a-byte OK.

- [ ] **Step 2: Deployar**

```bash
tools/deploy.sh "feat(packing-slip-drawings): planos en el correo de la remisión" --check packing-slip-drawings
```

**Si la sesión vive en el worktree `workbench`**, NO usar `deploy.sh` (arrastraría la WIP ajena de
`main`); usar `SH_ALLOW_DEPLOY=1 tools/wb-deploy.sh packing-slip-drawings "<mensaje>"` y **comparar
antes `config.version` contra `main`**.

- [ ] **Step 3: Verificar en vivo**

Run: `tools/deploy-status.sh`
Expected: la versión del sitio en vivo coincide con la de `main`.

- [ ] **Step 4: Canario en producción**

Con el operador: llegar a `/Domains/344/Shipping/PackingSlips` **navegando** (no recargando — el gate
por URL depende del sondeo de `location.pathname`), abrir el correo de una remisión de **FISHER
CONTROLES DE MEXICO** y verificar el panel, el ámbar del hueco, el adjunto y la impresión.

---

## Notas de riesgo vivas

| # | Riesgo | Dónde se cierra |
|---|---|---|
| **R1** | Nombre real de la operación de envío | Task 7 Step 3 — el `console.log` lo delata en el primer envío |
| **R3** | `cfdi-attacher` y este applet en el mismo modal | Task 4 (heading) + Task 11 Step 4 con ambos activos |
| **R4** | ¿`userFile.name` es citable como adjunto sin re-subir? | Task 7 Step 2 con **un** archivo real |
| **R7** | Ruta del PDF de la remisión para imprimir | Task 8 — degrada a «solo archivos» + ámbar si falla |
| **R8** | Payload enorme congela la pestaña | Task 7 — guardas baratas antes del `JSON.parse` |
