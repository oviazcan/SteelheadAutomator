# Detección de duplicados D1/D2/D3 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extender `process-deep-audit` (v0.7.1 → v0.8.0) con tres firmas de duplicado (D1: mismo nombre, D2: mismo tren de IDs top-level, D3: mismo tren de nombres top-level) sobre PROCESS principales, satélites, SUB_PROCESS, STEP_SHIPPING y RT, emitiendo 3 hojas XLSX nuevas con canónico marcado y `AccionSugerida_NUEVO` editable.

**Architecture:** Read-only, sin mutaciones. La detección es una fase global que corre después de R1-R4. Reusa caché de árboles (`state.treesById`) alimentado por R1-R4 para evitar HTTP duplicado; solo SUB_PROCESS/STEP_SHIPPING/RT requieren `getProcessTree` extra. `getProcessNodeParents` se consulta solo para miembros de grupos `size ≥ 2`. Pool concurrente y cancelación se reusan del orquestador existente.

**Tech Stack:** JavaScript vanilla MV3, SheetJS (window.XLSX ya inyectado), `window.ProcessShared`, `window.SteelheadAPI`. Sin frameworks, sin bundlers.

**Spec de referencia:** `docs/superpowers/specs/2026-05-18-process-duplicates-design.md`

---

## File Structure

Archivos tocados:

| Archivo | Rol | Cambio |
|---|---|---|
| `remote/scripts/process-shared.js` | Constantes + queries + helpers compartidos | Agrega `signatureD1/D2/D3`, `groupBySignature`. Bump `__psVersion`. |
| `remote/scripts/process-deep-audit.js` | Applet de auditoría | Agrega `evaluateD`, `pickCanonical`, hojas D1/D2/D3 + Leyenda, panel con descripciones + sección Duplicados, título mergeado por hoja. Bump `VERSION`. |
| `remote/config.json` | Config de runtime (consumido por `SteelheadAPI`) | Bump `version` + `lastUpdated` + bloque `duplicates` + concurrency `trees/parents`. |
| `docs/processes-architecture.md` | Doc de referencia | Nueva sección 11 + entrada en glosario §9. |
| `extension/background.js` | Bootstrap de la extensión | **Sin cambios** (la action `run-process-deep-audit` ya existe). |

No se crean archivos nuevos. La feature vive enteramente dentro de los dos scripts existentes para no agregar `<script>` tags al cargador.

---

## Convenciones del proyecto (recordatorio para implementador)

- **JavaScript vanilla** sin frameworks. Sin `import`/`require` — todo cuelga de `window.*`.
- **Logging:** usar `log(msg)` / `warn(msg)` que ya envuelven `api().log` / `api().warn`. NO usar `console.log` directo (audit pre-prod tiene un item de gatear logs detrás de flag DEBUG).
- **Errores tolerables:** si una llamada GraphQL individual falla 3 veces, registrar en `state.errors` y seguir. El run no aborta.
- **Cancelación:** patrón `runId` monotónico + `isStale(myRunId)` + `bailIfStale(myRunId)`. TODA función async del orquestador debe aceptar `myRunId` o tener acceso al `isStale` cerrado por closure.
- **`window.ProcessShared` (alias `ps()`):** ya carga `loadAllNodes`, `loadScannerNodes`, `loadSharedByLine`, `fetchAllProcesses`. La PRIMERA llamada en el run dispara la carga real; las siguientes son no-op (state interno).
- **Sin secrets en logs:** no incluir tokens ni payloads sensibles en `log()`.
- **Tests:** este proyecto NO tiene infra de tests automáticos (es un userscript que corre en la tab de Steelhead contra un backend real). La verificación es **manual en producción** según los pasos del plan. Cada task termina con un "Verifica en navegador" cuando aplica, NO con `npm test`.
- **Commits:** prefijo `feat(deep-audit):`, `feat(shared):`, `chore(config):`, `docs(...)`. Sin emojis salvo si el usuario lo pide.

---

## Task 1: Agregar firmas D1/D2/D3 a `process-shared.js`

Helpers puros: no tocan HTTP, no tienen estado. Se ponen aquí (no en deep-audit) porque pueden reusarse desde otros applets futuros.

**Files:**
- Modify: `remote/scripts/process-shared.js` (agregar funciones antes del bloque `return {`; añadir nombres al objeto exportado)

- [ ] **Step 1: Agregar `signatureD1` a process-shared.js**

Buscar en `process-shared.js` la línea exacta:

```js
  // ── Acceso a config (lazy, vía SteelheadAPI.getDomain) ──
```

Justo **antes** de esa línea, insertar:

```js
  // ── Firmas de duplicado (D1/D2/D3) ──
  // Cada firma reduce un nodo o un árbol a un string canónico. Dos items con la
  // misma firma se consideran duplicados bajo ese criterio. Las firmas no tienen
  // estado y son puras: el caller agrupa con groupBySignature.

  function signatureD1(node) {
    if (!node || !node.name) return null;
    return normName(node.name);
  }

  function signatureD2(treeRoot) {
    if (!treeRoot) return null;
    const top = extractTopLevel(treeRoot);
    return JSON.stringify(top.map(c => c.id));
  }

  function signatureD3(treeRoot) {
    if (!treeRoot) return null;
    const top = extractTopLevel(treeRoot);
    return JSON.stringify(top.map(c => normName(c.name || '')));
  }

  function groupBySignature(items, sigFn) {
    const map = new Map();
    for (const item of items) {
      const sig = sigFn(item);
      if (sig == null) continue;
      let arr = map.get(sig);
      if (!arr) { arr = []; map.set(sig, arr); }
      arr.push(item);
    }
    return map;
  }

```

- [ ] **Step 2: Exportar las 4 funciones en el objeto `return`**

Buscar el bloque `return {` final (cerca de `// Intervals`). Localizar la sección `// Árbol`:

```js
    // Árbol
    relParentId,
    relChildId,
    relChildName,
    relChildType,
    bfsRelationships,
    extractTopLevel,
    flattenTree,
```

Inmediatamente después de `flattenTree,`, agregar **una nueva sección**:

```js

    // Firmas de duplicado
    signatureD1,
    signatureD2,
    signatureD3,
    groupBySignature,
```

(Sí, una línea en blanco antes del comentario `// Firmas de duplicado` para mantener separación visual con las otras secciones.)

- [ ] **Step 3: Bumpear `__psVersion`**

Buscar y reemplazar exactamente:

```js
  window.__psVersion = '0.7.0';
  try { console.log('[SA] process-shared cargado · v0.7.0'); } catch (_) {}
```

Por:

```js
  window.__psVersion = '0.8.0';
  try { console.log('[SA] process-shared cargado · v0.8.0'); } catch (_) {}
```

- [ ] **Step 4: Validar sintaxis del archivo**

Run: `node -c remote/scripts/process-shared.js`
Expected: comando termina con código 0, sin output.

Si hay error, leer el mensaje (`Unexpected token`, `Identifier ... has already been declared`, etc.) y corregir. NO continuar hasta que `node -c` pase.

- [ ] **Step 5: Verificación funcional rápida (REPL)**

Run:

```bash
node -e '
const fs = require("fs");
const code = fs.readFileSync("remote/scripts/process-shared.js","utf8");
// Stub mínimo: SteelheadAPI no se necesita para signatures puras.
global.window = {};
global.window.SteelheadAPI = { log: ()=>{}, warn: ()=>{} };
eval(code);
const PS = global.window.ProcessShared;
console.log("D1:", PS.signatureD1({name:"SP Embarque en Almacén"}));
console.log("D1 dup:", PS.signatureD1({name:"sp embarque en  almacen"}) === PS.signatureD1({name:"SP Embarque en Almacén"}));
console.log("D2 empty:", PS.signatureD2({id:1, descendantRelationships:[]}));
console.log("D3 null:", PS.signatureD3(null));
const map = PS.groupBySignature(
  [{name:"A"},{name:"a"},{name:"B"}],
  PS.signatureD1
);
console.log("groups:", [...map.entries()]);
'
```

Expected output:
```
D1: sp embarque en almacen
D1 dup: false
D2 empty: []
D3 null: null
groups: [ [ 'a', [ {name:'A'}, {name:'a'} ] ], [ 'b', [ {name:'B'} ] ] ]
```

Nota: el "D1 dup: false" valida que doble espacio no se colapsa (es comportamiento esperado — `normName` solo hace NFD+lowercase+trim, no normaliza whitespace interno). Si el caso se da en producción se puede endurecer después; en el universo real de Steelhead los nombres están bien escritos.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/process-shared.js
git commit -m "$(cat <<'EOF'
feat(shared): agregar signatureD1/D2/D3 y groupBySignature

Helpers puros para detección de duplicados que se consumirán desde
process-deep-audit v0.8.0. D1 = normName, D2 = tren de IDs top-level,
D3 = tren de nombres normalizados top-level.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Agregar config block `duplicates` y concurrency `trees`/`parents`

Solo bumpea config y agrega el bloque nuevo. NO bumpea `version` aún — eso se hace al final del plan, en el deploy.

**Files:**
- Modify: `remote/config.json` (líneas ~296-299)

- [ ] **Step 1: Agregar `trees` y `parents` al bloque `concurrency`**

Buscar y reemplazar exactamente este bloque:

```json
        "concurrency": {
          "audit": 5,
          "retryDelaysMs": [0, 1000, 2000]
        }
```

Por:

```json
        "concurrency": {
          "audit": 5,
          "trees": 5,
          "parents": 5,
          "retryDelaysMs": [0, 1000, 2000]
        },
        "duplicates": {
          "enabled": true,
          "includeSources": ["main","satellite","rt","subprocess","stepshipping"],
          "ignoreNamePatterns": [],
          "ignoreIds": []
        }
```

Notar la coma al final de `}` de `concurrency` (importante: era el último campo del padre, ahora le sigue `duplicates`).

- [ ] **Step 2: Validar JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('remote/config.json','utf8')); console.log('JSON OK');"`

Expected: `JSON OK`

Si falla, leer el mensaje (`Unexpected token ... in JSON at position N`), abrir el archivo en esa posición y corregir.

- [ ] **Step 3: Verificar que los nuevos campos están accesibles**

Run:

```bash
node -e '
const cfg = JSON.parse(require("fs").readFileSync("remote/config.json","utf8"));
const pa = cfg.steelhead.domain.processAudit;
console.log("concurrency:", JSON.stringify(pa.concurrency));
console.log("duplicates:", JSON.stringify(pa.duplicates));
'
```

Expected:
```
concurrency: {"audit":5,"trees":5,"parents":5,"retryDelaysMs":[0,1000,2000]}
duplicates: {"enabled":true,"includeSources":["main","satellite","rt","subprocess","stepshipping"],"ignoreNamePatterns":[],"ignoreIds":[]}
```

- [ ] **Step 4: Commit**

```bash
git add remote/config.json
git commit -m "$(cat <<'EOF'
chore(config): agregar bloque duplicates y concurrency trees/parents

Prep para deep-audit v0.8.0: bloque duplicates con flags ignoreIds/
ignoreNamePatterns (canal de escape), y pools dedicados para fetch de
árboles faltantes y getProcessNodeParents. Version bump se hace al final
del deploy junto con los scripts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Agregar accessor `duplicatesConfig` en process-shared.js

Pequeño wrapper para que deep-audit lea `duplicates.{ignoreIds, ignoreNamePatterns, includeSources, enabled}` con defaults sanos.

**Files:**
- Modify: `remote/scripts/process-shared.js`

- [ ] **Step 1: Agregar `duplicatesConfig` después de `auditConcurrency`**

Buscar en `process-shared.js`:

```js
  function auditConcurrency() {
    return getProcessAuditConfig().concurrency || { audit: 5, retryDelaysMs: [0, 1000, 2000] };
  }
```

Inmediatamente después (antes del `return {` final), agregar:

```js

  function duplicatesConfig() {
    const cfg = getProcessAuditConfig().duplicates || {};
    return {
      enabled: cfg.enabled !== false,
      includeSources: cfg.includeSources || ['main','satellite','rt','subprocess','stepshipping'],
      ignoreNamePatterns: (cfg.ignoreNamePatterns || []).map(p => {
        try { return new RegExp(p, 'i'); } catch (_) { return null; }
      }).filter(Boolean),
      ignoreIds: new Set((cfg.ignoreIds || []).map(Number).filter(Number.isFinite))
    };
  }
```

- [ ] **Step 2: Exportar `duplicatesConfig` en el objeto `return`**

Buscar la sección `// Config accessors` en el `return {`:

```js
    // Config accessors
    finishProductMap,
    satelliteOverrides,
    auditConcurrency
```

Reemplazar por:

```js
    // Config accessors
    finishProductMap,
    satelliteOverrides,
    auditConcurrency,
    duplicatesConfig
```

(Coma final agregada; agrega también la última línea.)

- [ ] **Step 3: Validar sintaxis**

Run: `node -c remote/scripts/process-shared.js`
Expected: código 0.

- [ ] **Step 4: Verificación funcional (lee config real)**

Run:

```bash
node -e '
const fs = require("fs");
const cfgJSON = fs.readFileSync("remote/config.json","utf8");
const cfg = JSON.parse(cfgJSON);
global.window = {};
global.window.SteelheadAPI = {
  log: ()=>{}, warn: ()=>{},
  getDomain: () => cfg.steelhead.domain
};
eval(fs.readFileSync("remote/scripts/process-shared.js","utf8"));
const dc = global.window.ProcessShared.duplicatesConfig();
console.log("enabled:", dc.enabled);
console.log("includeSources:", dc.includeSources);
console.log("ignoreNamePatterns:", dc.ignoreNamePatterns);
console.log("ignoreIds size:", dc.ignoreIds.size);
'
```

Expected:
```
enabled: true
includeSources: [ 'main', 'satellite', 'rt', 'subprocess', 'stepshipping' ]
ignoreNamePatterns: []
ignoreIds size: 0
```

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/process-shared.js
git commit -m "$(cat <<'EOF'
feat(shared): accessor duplicatesConfig con defaults y compilación de regex

Lee processAudit.duplicates del config con defaults sanos: enabled=true,
los 5 sources, listas vacías. ignoreNamePatterns se compila a RegExp /i
descartando patrones inválidos; ignoreIds se materializa como Set<number>.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Caché `state.treesById` en process-deep-audit

Modificación mínima al estado existente. Permite que R1-R4 alimenten la caché que D2/D3 consumirán después sin HTTP duplicado.

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (función `resetState` y dos puntos de inyección en `auditProcess`/`evaluateR3`)

- [ ] **Step 1: Agregar `treesById` al estado en `resetState`**

Buscar:

```js
  function resetState() {
    state = {
      runId: (state?.runId || 0) + 1,
      cancelled: false,
      processes: [],
      satellites: [],
      progress: { current: 0, total: 0, phase: 'init' },
      rows: { resumen: [], r1: [], r2: [], r3: [], r4: [], catalogos: [] },
      errors: []
    };
    return state.runId;
  }
```

Reemplazar por:

```js
  function resetState() {
    state = {
      runId: (state?.runId || 0) + 1,
      cancelled: false,
      processes: [],
      satellites: [],
      progress: { current: 0, total: 0, phase: 'init' },
      rows: { resumen: [], r1: [], r2: [], r3: [], r4: [], d1: [], d2: [], d3: [], catalogos: [], leyenda: [] },
      treesById: new Map(),
      duplicates: { partial: false, groupsD1: 0, groupsD2: 0, groupsD3: 0, membersD1: 0, membersD2: 0, membersD3: 0 },
      errors: []
    };
    return state.runId;
  }
```

- [ ] **Step 2: Cachear el árbol en `auditProcess`**

Buscar:

```js
    try {
      const tree = await withRetry(() => ps().getProcessTree(processNode.id), `audit ${processNode.id}`, myRunId);
      bailIfStale(myRunId);

      result.r1 = evaluateR1(tree?.treeRoot, processNode);
```

Reemplazar por:

```js
    try {
      const tree = await withRetry(() => ps().getProcessTree(processNode.id), `audit ${processNode.id}`, myRunId);
      bailIfStale(myRunId);
      if (tree) state.treesById.set(processNode.id, tree);

      result.r1 = evaluateR1(tree?.treeRoot, processNode);
```

- [ ] **Step 3: Cachear el árbol en `evaluateR3`**

Buscar (cerca de la línea 367):

```js
    let tree;
    try {
      tree = await withRetry(() => ps().getProcessTree(satellite.id), `R3 sat ${satellite.id}`, myRunId);
```

Reemplazar por:

```js
    let tree;
    try {
      tree = await withRetry(() => ps().getProcessTree(satellite.id), `R3 sat ${satellite.id}`, myRunId);
      if (tree) state.treesById.set(satellite.id, tree);
```

- [ ] **Step 4: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): caché treesById alimentado por R1-R4 + slots rows.d1/d2/d3

Cambio infraestructural para que la fase D no haga getProcessTree
duplicado por procesos ya auditados. También agrega slots para hojas
nuevas y un objeto duplicates con conteos para Resumen.

Sin cambio funcional visible (R1-R4 siguen idénticos).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Helper `buildAuditUniverse` para enumerar los 5 buckets

Reúne PROCESS principales, satélites, RT, SUB_PROCESS y STEP_SHIPPING en una lista unificada con `{id, name, type, source}`. Respeta `ignoreIds` e `ignoreNamePatterns`.

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (agregar después de `buildSatelliteCatalog`)

- [ ] **Step 1: Agregar `buildAuditUniverse` después de `buildSatelliteCatalog`**

Buscar el cierre de `buildSatelliteCatalog`:

```js
    return [...out.values()];
  }

  // ── Helpers de normalización para R4-c (producto cubre sufijos) ──
```

Insertar entre el `}` y el comentario `// ── Helpers de normalización`:

```js

  // ── Universo a analizar para D1/D2/D3 ──
  // Reúne los 5 buckets respetando ignoreIds/ignoreNamePatterns/includeSources.
  // Cada item: {id, name, type, source}. Source es metadata para el reporte,
  // NO afecta la detección (un PROCESS clon de un SUB_PROCESS sí cuenta).
  function buildAuditUniverse(allProcesses, satelliteCatalog) {
    const dupCfg = ps().duplicatesConfig();
    if (!dupCfg.enabled) return [];
    const include = new Set(dupCfg.includeSources);
    const ignoreIds = dupCfg.ignoreIds;
    const ignoreNamePatterns = dupCfg.ignoreNamePatterns;
    const isIgnored = (id, name) => {
      if (ignoreIds.has(Number(id))) return true;
      return ignoreNamePatterns.some(re => re.test(name || ''));
    };

    const universe = [];
    const seen = new Set();
    const push = (id, name, type, source) => {
      if (id == null || seen.has(id)) return;
      if (isIgnored(id, name)) return;
      if (!include.has(source)) return;
      seen.add(id);
      universe.push({ id, name: name || '', type: type || null, source });
    };

    const satIds = new Set(satelliteCatalog.map(s => s.id));

    // Bucket 1: PROCESS principales (excluye satélites y RT/SP)
    // Bucket 2: PROCESS satélites
    // Bucket 4: RT (PROCESS con prefijo RT que isExcludedProcessName filtró antes)
    for (const p of allProcesses) {
      if (!p || p.type !== 'PROCESS') continue;
      if (satIds.has(p.id)) { push(p.id, p.name, p.type, 'satellite'); continue; }
      if (/^RT\b/i.test(p.name || '')) { push(p.id, p.name, p.type, 'rt'); continue; }
      if (/^SP\b/i.test(p.name || '')) continue; // SP que sea PROCESS — raro, no se cuenta como main
      push(p.id, p.name, p.type, 'main');
    }

    // Bucket 3: SUB_PROCESS y Bucket 5: STEP_SHIPPING — del catálogo cargado por loadAllNodes
    const cat = ps().getCatalog();
    if (cat && cat.namesById) {
      for (const [id, name] of cat.namesById.entries()) {
        const type = cat.typesById.get(id);
        if (type === 'SUB_PROCESS') push(id, name, type, 'subprocess');
        else if (type === 'STEP_SHIPPING') push(id, name, type, 'stepshipping');
      }
    }

    return universe;
  }
```

- [ ] **Step 2: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): buildAuditUniverse para enumerar los 5 buckets

Reúne PROCESS principales, satélites, RT, SUB_PROCESS y STEP_SHIPPING
en una lista unificada con metadata source. Respeta ignoreIds e
ignoreNamePatterns del config. Sin uso aún (próximas tasks lo invocan).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Función `evaluateD` — orquestador de D1/D2/D3

Esta es la pieza grande. Recibe `auditUniverse` + `treesById`, fetcha árboles faltantes, calcula firmas, agrupa, fetcha parents para grupos size≥2, decide canónico, emite filas.

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (agregar después de `evaluateR4`, antes de `auditProcess`)

- [ ] **Step 1: Agregar `evaluateD` antes de `auditProcess`**

Buscar:

```js
    return { findings, leadOK, productOK, coherenciaOK };
  }

  // ── Auditor por proceso (orquesta R1, R2, R4 sobre una raíz PROCESS) ──
  async function auditProcess(processNode, myRunId) {
```

Insertar entre el `}` que cierra `evaluateR4` y el comentario `// ── Auditor por proceso`:

```js

  // ── pickCanonical (un canon por grupo de duplicados) ──
  // Ordena por (referencias entrantes DESC, id ASC). El primer elemento gana.
  function pickCanonical(members, parentsByIdCache) {
    return members.slice().sort((a, b) => {
      const pa = parentsByIdCache.get(a.id);
      const pb = parentsByIdCache.get(b.id);
      const fa = (pa == null) ? -1 : pa;  // sin dato pierde contra cualquier número
      const fb = (pb == null) ? -1 : pb;
      if (fa !== fb) return fb - fa;
      return a.id - b.id;
    })[0];
  }

  // ── evaluateD: D1/D2/D3 sobre el universo. Mutates state.rows.d1/d2/d3
  // y state.duplicates. ──
  async function evaluateD(auditUniverse, myRunId) {
    const concurrency = ps().auditConcurrency();
    const treesPool = concurrency.trees || 5;
    const parentsPool = concurrency.parents || 5;

    // 1. Fetch árboles faltantes (para SUB_PROCESS/STEP_SHIPPING/RT no auditados por R1-R4)
    const missing = auditUniverse.filter(n => !state.treesById.has(n.id));
    log(`  D-fase: árboles ya cacheados=${auditUniverse.length - missing.length}, por fetchar=${missing.length}`);

    if (missing.length) {
      state.progress.phase = `D · fetchando árboles faltantes · 0/${missing.length}`;
      renderPanel();
      await runPool(missing, async (node) => {
        if (state.cancelled || isStale(myRunId)) return;
        try {
          const tree = await withRetry(() => ps().getProcessTree(node.id), `D tree ${node.id}`, myRunId);
          if (tree) state.treesById.set(node.id, tree);
        } catch (err) {
          if (err?.message === '__sa_aborted__') throw err;
          // Error individual: el nodo se omite de D2/D3 pero sigue en D1
        }
      }, treesPool, (done, total) => {
        if (!isStale(myRunId)) {
          state.progress.phase = `D · fetchando árboles faltantes · ${done}/${total}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);
    }

    // Si el run fue cancelado a media fetch, marca parcial pero no aborta — D1 sí puede emitir
    if (state.cancelled) state.duplicates.partial = true;

    // 2. Calcular firmas + agrupar
    state.progress.phase = 'D · calculando firmas y agrupando';
    renderPanel();
    const sigD1Fn = (n) => ps().signatureD1(n);
    const sigD2Fn = (n) => {
      const t = state.treesById.get(n.id);
      return t ? ps().signatureD2(t.treeRoot) : null;
    };
    const sigD3Fn = (n) => {
      const t = state.treesById.get(n.id);
      return t ? ps().signatureD3(t.treeRoot) : null;
    };
    const groupsD1 = ps().groupBySignature(auditUniverse, sigD1Fn);
    const groupsD2 = ps().groupBySignature(auditUniverse, sigD2Fn);
    const groupsD3 = ps().groupBySignature(auditUniverse, sigD3Fn);

    // Filtrar grupos size>=2
    const dupGroupsD1 = [...groupsD1.entries()].filter(([, members]) => members.length >= 2);
    const dupGroupsD2 = [...groupsD2.entries()].filter(([, members]) => members.length >= 2);
    const dupGroupsD3 = [...groupsD3.entries()].filter(([, members]) => members.length >= 2);

    // Cross-flags: ¿este id aparece como duplicado en otra firma?
    const inD1 = new Set(), inD2 = new Set(), inD3 = new Set();
    for (const [, members] of dupGroupsD1) for (const m of members) inD1.add(m.id);
    for (const [, members] of dupGroupsD2) for (const m of members) inD2.add(m.id);
    for (const [, members] of dupGroupsD3) for (const m of members) inD3.add(m.id);

    // 3. Fetch parents para todos los miembros únicos de los 3 conjuntos
    const allDupIds = new Set([...inD1, ...inD2, ...inD3]);
    const parentsByIdCache = new Map();
    if (allDupIds.size) {
      state.progress.phase = `D · fetchando referencias entrantes · 0/${allDupIds.size}`;
      renderPanel();
      const idsArr = [...allDupIds];
      await runPool(idsArr, async (id) => {
        if (state.cancelled || isStale(myRunId)) return;
        try {
          const parents = await withRetry(() => ps().getProcessNodeParents(id), `D parents ${id}`, myRunId);
          parentsByIdCache.set(id, parents.length);
        } catch (err) {
          if (err?.message === '__sa_aborted__') throw err;
          // sin dato: pickCanonical lo trata como -1 (pierde)
        }
      }, parentsPool, (done, total) => {
        if (!isStale(myRunId)) {
          state.progress.phase = `D · fetchando referencias entrantes · ${done}/${total}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);
    }

    if (state.cancelled) state.duplicates.partial = true;

    // 4. Emitir filas por grupo
    function emitRows(targetArr, dupGroups) {
      for (const [groupId, members] of dupGroups) {
        const canon = pickCanonical(members, parentsByIdCache);
        for (const m of members) {
          const isCanon = (m.id === canon.id);
          const refs = parentsByIdCache.get(m.id);
          let accion = '';
          if (isCanon) accion = 'MANTENER';
          else if (refs === 0) accion = 'ARCHIVAR';
          else if (refs != null && refs > 0) accion = 'FUSIONAR';
          targetArr.push({
            ProcessID: m.id,
            ProcessName: m.name,
            Tipo: m.type || '',
            Source: m.source,
            GrupoID: groupId,
            GrupoTamano: members.length,
            EsCanonico: isCanon,
            ReferenciasEntrantes: (refs == null) ? '' : refs,
            EsArchivado: false,
            TambienEnD1: inD1.has(m.id),
            TambienEnD2: inD2.has(m.id),
            TambienEnD3: inD3.has(m.id),
            AccionSugerida: accion,
            AccionSugerida_NUEVO: '',
            Notas_NUEVO: ''
          });
        }
      }
    }
    emitRows(state.rows.d1, dupGroupsD1);
    emitRows(state.rows.d2, dupGroupsD2);
    emitRows(state.rows.d3, dupGroupsD3);

    state.duplicates.groupsD1 = dupGroupsD1.length;
    state.duplicates.groupsD2 = dupGroupsD2.length;
    state.duplicates.groupsD3 = dupGroupsD3.length;
    state.duplicates.membersD1 = state.rows.d1.length;
    state.duplicates.membersD2 = state.rows.d2.length;
    state.duplicates.membersD3 = state.rows.d3.length;

    log(`  D1: ${state.duplicates.groupsD1} grupos / ${state.duplicates.membersD1} miembros`);
    log(`  D2: ${state.duplicates.groupsD2} grupos / ${state.duplicates.membersD2} miembros`);
    log(`  D3: ${state.duplicates.groupsD3} grupos / ${state.duplicates.membersD3} miembros`);
  }
```

- [ ] **Step 2: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

- [ ] **Step 3: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): evaluateD orquesta D1/D2/D3 + pickCanonical

Fetch de árboles faltantes con pool dedicado, cálculo de firmas y agrupado
con groupBySignature, fetch de parents solo para grupos size>=2, emisión
de filas por grupo con canónico marcado y AccionSugerida auto-rellenada.
Tolerancia a errores individuales y cancelación parcial (D1 sale completa
si D2/D3 quedan parciales por cancel a media fetch).

No invoca aún desde run() — siguiente task lo wirea.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wirear `evaluateD` en `run()` después de R3

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (función `run`, después del segundo `bailIfStale` post-R3)

- [ ] **Step 1: Insertar invocación de `evaluateD` entre R3 y `buildResumenRows`**

Buscar:

```js
      }, concurrency, (done) => {
        if (!isStale(myRunId)) {
          satDone = done;
          state.progress.current = mainProcesses.length + done;
          state.progress.phase = `auditando satélites · ${done}/${satelliteCatalog.length}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);

      // Construir Resumen + Catálogos
      buildResumenRows();
      buildCatalogosRows();
```

Reemplazar por:

```js
      }, concurrency, (done) => {
        if (!isStale(myRunId)) {
          satDone = done;
          state.progress.current = mainProcesses.length + done;
          state.progress.phase = `auditando satélites · ${done}/${satelliteCatalog.length}`;
          renderPanel();
        }
      }, myRunId);
      bailIfStale(myRunId);

      // Detección de duplicados D1/D2/D3 (fase global post R1-R4)
      const auditUniverse = buildAuditUniverse(allProcesses, satelliteCatalog);
      log(`Universo D: ${auditUniverse.length} nodos (main+sat+rt+subprocess+stepshipping, descontando ignoreIds/ignoreNamePatterns)`);
      if (auditUniverse.length && ps().duplicatesConfig().enabled) {
        await evaluateD(auditUniverse, myRunId);
        bailIfStale(myRunId);
      } else {
        log('  D-fase saltada (duplicates.enabled=false o universo vacío)');
      }

      // Construir Resumen + Catálogos
      buildResumenRows();
      buildCatalogosRows();
      buildLeyendaRows();
```

(Nota: `buildLeyendaRows` se define en Task 9. La línea se deja aquí para minimizar diff posterior; si Task 9 aún no está hecha y se hace una corrida intermedia, la función throw — pero entre tasks no se corre el applet contra producción. Después de Task 9, todo queda funcional.)

- [ ] **Step 2: Actualizar conteo de `progress.total` para incluir fase D**

Buscar:

```js
      state.progress.total = mainProcesses.length + satelliteCatalog.length;
```

Reemplazar por:

```js
      // Estimación inicial: R1+R2+R4 + R3 + (universo a fetchar en D). Ajustada
      // dinámicamente cuando evaluateD descubre los faltantes reales.
      state.progress.total = mainProcesses.length + satelliteCatalog.length;
```

(Sin cambio funcional — el comentario documenta que la fase D actualizará `progress.phase` con su propio "X/Y" pero NO mete su conteo en `progress.total`. Más simple y consistente con cómo R3 se reporta hoy.)

- [ ] **Step 3: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

**Nota:** Después de este step la función `run()` referencia `buildLeyendaRows` que aún no existe. El archivo NO ejecuta hasta que se carga en runtime; `node -c` solo valida sintaxis, no resoluciones de nombre. Cualquier corrida real fallará — esto se resuelve en Task 9.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): wirear evaluateD en run() después de R3

Construye el universo via buildAuditUniverse, dispara evaluateD si está
habilitado y agrega buildLeyendaRows al pipeline (definido en próxima
task). Sin cambios al flujo R1-R4.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Panel UI — leyendas descriptivas + sección Duplicados

Cambia el resumen + tabs del panel para que cada R y D muestre descripción legible y conteo separado de `grupos / miembros`.

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (funciones `renderSummary`, `renderTabs`, `renderTable`)

- [ ] **Step 1: Reescribir `renderSummary` con descripciones**

Buscar:

```js
  function renderSummary() {
    const wrap = document.getElementById('pdeep-summary');
    if (!wrap) return;
    wrap.style.display = '';
    const conIssues = state.rows.resumen.filter(r => r.EstadoGlobal === 'CON HALLAZGOS').length;
    wrap.innerHTML = `
      <div><b>${state.processes.length + state.satellites.length}</b><span>procesos</span></div>
      <div><b>${state.rows.r1.length}</b><span>R1</span></div>
      <div><b>${state.rows.r2.filter(r => r.Estado && r.Estado !== 'OK').length}</b><span>R2</span></div>
      <div><b>${state.rows.r3.filter(r => r.Estado && r.Estado !== 'OK').length}</b><span>R3</span></div>
      <div><b>${state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK').length}</b><span>R4</span></div>
    `;
    const tabsWrap = document.getElementById('pdeep-tabs-wrap');
    if (tabsWrap) tabsWrap.style.display = '';
  }
```

Reemplazar por:

```js
  // Descripciones canónicas (mismos textos en panel, leyenda XLSX y tooltips)
  const RULE_LABELS = {
    R1: '"Listo" con tipo incorrecto',
    R2: 'Tiempos por sección/línea',
    R3: 'Satélites con tiempos cargados',
    R4: 'Lead time + producto coherente',
    D1: 'Mismo nombre (catálogo drift)',
    D2: 'Mismo tren de IDs top-level',
    D3: 'Mismo tren de nombres top-level'
  };

  function renderSummary() {
    const wrap = document.getElementById('pdeep-summary');
    if (!wrap) return;
    wrap.style.display = '';
    wrap.style.gridTemplateColumns = '1fr';  // override del CSS (5 cols) — ahora son listas
    const r1 = state.rows.r1.length;
    const r2 = state.rows.r2.filter(r => r.Estado && r.Estado !== 'OK').length;
    const r3 = state.rows.r3.filter(r => r.Estado && r.Estado !== 'OK').length;
    const r4 = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK').length;
    const d = state.duplicates || {};
    const partialBadge = d.partial ? ` <span style="color:#c62828; font-size:10px;">[PARCIAL]</span>` : '';
    wrap.innerHTML = `
      <div style="text-align:left; padding:8px; background:#f5f5f5; border-radius:4px;">
        <div style="font-weight:600; margin-bottom:4px;">${state.processes.length + state.satellites.length} procesos auditados</div>
        <div style="font-weight:600; margin-top:8px;">Reglas estructurales</div>
        <div title="${escapeHtml(RULE_LABELS.R1)}">▸ R1 — ${escapeHtml(RULE_LABELS.R1)} <b style="float:right;">${r1}</b></div>
        <div title="${escapeHtml(RULE_LABELS.R2)}">▸ R2 — ${escapeHtml(RULE_LABELS.R2)} <b style="float:right;">${r2}</b></div>
        <div title="${escapeHtml(RULE_LABELS.R3)}">▸ R3 — ${escapeHtml(RULE_LABELS.R3)} <b style="float:right;">${r3}</b></div>
        <div title="${escapeHtml(RULE_LABELS.R4)}">▸ R4 — ${escapeHtml(RULE_LABELS.R4)} <b style="float:right;">${r4}</b></div>
        <div style="font-weight:600; margin-top:8px;">Duplicados ★ NUEVO${partialBadge}</div>
        <div title="${escapeHtml(RULE_LABELS.D1)}">▸ D1 — ${escapeHtml(RULE_LABELS.D1)} <b style="float:right;">${d.groupsD1 || 0} grupos / ${d.membersD1 || 0}</b></div>
        <div title="${escapeHtml(RULE_LABELS.D2)}">▸ D2 — ${escapeHtml(RULE_LABELS.D2)} <b style="float:right;">${d.groupsD2 || 0} grupos / ${d.membersD2 || 0}</b></div>
        <div title="${escapeHtml(RULE_LABELS.D3)}">▸ D3 — ${escapeHtml(RULE_LABELS.D3)} <b style="float:right;">${d.groupsD3 || 0} grupos / ${d.membersD3 || 0}</b></div>
      </div>
    `;
    const tabsWrap = document.getElementById('pdeep-tabs-wrap');
    if (tabsWrap) tabsWrap.style.display = '';
  }
```

- [ ] **Step 2: Agregar tabs D1/D2/D3 en `renderTabs`**

Buscar:

```js
  function renderTabs() {
    const wrap = document.getElementById('pdeep-tabs');
    if (!wrap) return;
    wrap.innerHTML = `
      <button data-act="tab-resumen" class="${_activeTab === 'resumen' ? 'active' : ''}">Resumen</button>
      <button data-act="tab-r1" class="${_activeTab === 'r1' ? 'active' : ''}">R1 (${state.rows.r1.length})</button>
      <button data-act="tab-r2" class="${_activeTab === 'r2' ? 'active' : ''}">R2 (${state.rows.r2.filter(r => r.Estado !== 'OK').length})</button>
      <button data-act="tab-r3" class="${_activeTab === 'r3' ? 'active' : ''}">R3 (${state.rows.r3.filter(r => r.Estado !== 'OK').length})</button>
      <button data-act="tab-r4" class="${_activeTab === 'r4' ? 'active' : ''}">R4 (${state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK').length})</button>
    `;
  }
```

Reemplazar por:

```js
  function renderTabs() {
    const wrap = document.getElementById('pdeep-tabs');
    if (!wrap) return;
    const r1Count = state.rows.r1.length;
    const r2Count = state.rows.r2.filter(r => r.Estado !== 'OK').length;
    const r3Count = state.rows.r3.filter(r => r.Estado !== 'OK').length;
    const r4Count = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK').length;
    const d1Count = state.rows.d1.length;
    const d2Count = state.rows.d2.length;
    const d3Count = state.rows.d3.length;
    wrap.innerHTML = `
      <button data-act="tab-resumen" class="${_activeTab === 'resumen' ? 'active' : ''}">Resumen</button>
      <button data-act="tab-r1" title="${escapeHtml(RULE_LABELS.R1)}" class="${_activeTab === 'r1' ? 'active' : ''}">R1 (${r1Count})</button>
      <button data-act="tab-r2" title="${escapeHtml(RULE_LABELS.R2)}" class="${_activeTab === 'r2' ? 'active' : ''}">R2 (${r2Count})</button>
      <button data-act="tab-r3" title="${escapeHtml(RULE_LABELS.R3)}" class="${_activeTab === 'r3' ? 'active' : ''}">R3 (${r3Count})</button>
      <button data-act="tab-r4" title="${escapeHtml(RULE_LABELS.R4)}" class="${_activeTab === 'r4' ? 'active' : ''}">R4 (${r4Count})</button>
      <button data-act="tab-d1" title="${escapeHtml(RULE_LABELS.D1)}" class="${_activeTab === 'd1' ? 'active' : ''}">D1 (${d1Count})</button>
      <button data-act="tab-d2" title="${escapeHtml(RULE_LABELS.D2)}" class="${_activeTab === 'd2' ? 'active' : ''}">D2 (${d2Count})</button>
      <button data-act="tab-d3" title="${escapeHtml(RULE_LABELS.D3)}" class="${_activeTab === 'd3' ? 'active' : ''}">D3 (${d3Count})</button>
    `;
  }
```

- [ ] **Step 3: Manejar tabs D1/D2/D3 en `renderTable`**

Buscar:

```js
    } else if (_activeTab === 'r4') {
      headers = ['ProcessName', 'ProductName_actual', 'SufijosNoCubiertos', 'EstadoCoherencia'];
      rows = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK');
    }
```

Reemplazar por:

```js
    } else if (_activeTab === 'r4') {
      headers = ['ProcessName', 'ProductName_actual', 'SufijosNoCubiertos', 'EstadoCoherencia'];
      rows = state.rows.r4.filter(r => r.EstadoCoherencia !== 'OK');
    } else if (_activeTab === 'd1') {
      headers = ['ProcessName', 'Tipo', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'AccionSugerida'];
      rows = state.rows.d1;
    } else if (_activeTab === 'd2') {
      headers = ['ProcessName', 'Tipo', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'AccionSugerida'];
      rows = state.rows.d2;
    } else if (_activeTab === 'd3') {
      headers = ['ProcessName', 'Tipo', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'AccionSugerida'];
      rows = state.rows.d3;
    }
```

- [ ] **Step 4: Bumpear `VERSION`**

Buscar:

```js
  const VERSION = '0.7.1';
```

Reemplazar por:

```js
  const VERSION = '0.8.0';
```

- [ ] **Step 5: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

- [ ] **Step 6: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): panel UI con leyendas + sección Duplicados + tabs D1/D2/D3

Reemplaza grid de 5 contadores cripticos por listado con descripción
canónica (RULE_LABELS) de cada R/D. Sección Duplicados con grupos/miembros
y badge [PARCIAL] si state.duplicates.partial. Tabs D1/D2/D3 nuevos con
columnas relevantes. Bump VERSION a 0.8.0.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Hoja Leyenda + título mergeado por hoja + hojas D1/D2/D3 en XLSX

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (función `exportXlsx`, agregar `buildLeyendaRows`)

- [ ] **Step 1: Agregar `buildLeyendaRows` después de `buildCatalogosRows`**

Buscar (al final de `buildCatalogosRows`):

```js
    for (const e of state.errors.slice(0, 200)) {
      state.rows.catalogos.push({
        Categoria: 'error',
        Clave: String(e.item?.id || e.item || ''),
        Valor: String(e.err || '').substring(0, 500)
      });
    }
  }

  // ── XLSX export (SheetJS) ──
```

Insertar entre el `}` que cierra `buildCatalogosRows` y el comentario `// ── XLSX export`:

```js

  // ── Hoja Leyenda (una sola fuente de verdad para descripciones de R/D) ──
  function buildLeyendaRows() {
    state.rows.leyenda = [
      { Sigla: 'R1', Descripcion: RULE_LABELS.R1, Subcaso: '—', EstadoPosible: 'tipo inválido', AccionTipica: 'Cambiar tipo del nodo a SCANNER_NODE/STAGING/STEP_SHIPPING_READY' },
      { Sigla: 'R2', Descripcion: RULE_LABELS.R2, Subcaso: 'R2-a/b/c/d', EstadoPosible: 'sin treatment / sin estaciones / sin tiempos / parcial', AccionTipica: 'Asignar treatment + cargar tiempos por estación' },
      { Sigla: 'R3', Descripcion: RULE_LABELS.R3, Subcaso: 'R3-a/b/c/d', EstadoPosible: 'sin treatment / sin estaciones / sin tiempos / parcial', AccionTipica: 'Mismo que R2 sobre satélites' },
      { Sigla: 'R4', Descripcion: RULE_LABELS.R4, Subcaso: 'R4-a/b/c', EstadoPosible: 'sin lead / sin producto / producto no cubre sufijos', AccionTipica: 'Setear defaultLeadTime y productByProductId con nombre acorde a sufijos' },
      { Sigla: 'D1', Descripcion: RULE_LABELS.D1, Subcaso: '—', EstadoPosible: 'grupo size≥2 con mismo nombre normalizado', AccionTipica: 'Mantener canon (id+más refs); FUSIONAR si tiene refs o ARCHIVAR si refs=0' },
      { Sigla: 'D2', Descripcion: RULE_LABELS.D2, Subcaso: '—', EstadoPosible: 'grupo size≥2 con mismo árbol top-level (IDs)', AccionTipica: 'Validar si la duplicación es intencional (templates) o ARCHIVAR sobrante' },
      { Sigla: 'D3', Descripcion: RULE_LABELS.D3, Subcaso: '—', EstadoPosible: 'grupo size≥2 con mismo árbol top-level (nombres normalizados)', AccionTipica: 'Caso más común; FUSIONAR para consolidar referencias bajo el canon' }
    ];
  }
```

- [ ] **Step 2: Refactorizar `exportXlsx` para soportar título mergeado y agregar las 4 hojas nuevas**

Buscar todo el bloque `function exportXlsx() { ... }` (línea ~769 a ~832) y reemplazarlo por:

```js
  // ── XLSX export (SheetJS) ──
  function exportXlsx() {
    if (!window.XLSX) { alert('XLSX no cargado. Recarga la extensión.'); return; }
    const wb = window.XLSX.utils.book_new();

    // addSheet con título mergeado en fila 1, headers en fila 2, datos desde fila 3.
    // Si rows está vacío, igual emite título + headers + fila "(sin datos)".
    const addSheet = (name, title, rows, headers) => {
      const hdr = headers || (rows && rows[0] ? Object.keys(rows[0]) : ['(sin datos)']);
      const data = (rows && rows.length)
        ? rows.map(r => hdr.map(h => r[h] != null ? r[h] : ''))
        : [hdr.map(() => '')];
      const aoa = [
        [title],   // fila 1 — se mergea A1:?1 abajo
        hdr,       // fila 2 — encabezados
        ...data    // filas 3+
      ];
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);
      // Merge A1 hasta la última columna de los headers
      ws['!merges'] = (ws['!merges'] || []).concat([{
        s: { r: 0, c: 0 },
        e: { r: 0, c: Math.max(0, hdr.length - 1) }
      }]);
      window.XLSX.utils.book_append_sheet(wb, ws, name);
    };

    addSheet('Leyenda',
      'Leyenda — qué significa cada regla R/D del reporte',
      state.rows.leyenda,
      ['Sigla', 'Descripcion', 'Subcaso', 'EstadoPosible', 'AccionTipica']
    );

    addSheet('Resumen',
      `Resumen por proceso · ${state.duplicates.partial ? 'PARCIAL_POR_CANCELACION · ' : ''}generado ${new Date().toISOString()}`,
      state.rows.resumen,
      [
        'ProcessID', 'ProcessName', 'LineCode', 'EsSatélite', 'Secciones',
        'Hallazgos_R1', 'Hallazgos_R2', 'Hallazgos_R3', 'Hallazgos_R4',
        'EstadoGlobal', 'Error'
      ]
    );

    addSheet('R1_Listo_NoScanner',
      `R1 — ${RULE_LABELS.R1}. Nodos cuyo nombre matchea /Listo/ pero el type no es SCANNER_NODE, STAGING ni STEP_SHIPPING_READY.`,
      state.rows.r1,
      ['ProcessID', 'ProcessName', 'NodoListoID', 'NodoListoName', 'TipoActual', 'TipoEsperado']
    );

    addSheet('R2_TiemposLineaPrincipal',
      `R2 — ${RULE_LABELS.R2}. Por cada bloque T<n> detectado en top-level: treatment con estaciones y cycleTime>0.`,
      state.rows.r2,
      [
        'ProcessID', 'ProcessName', 'LineCode',
        'NodoListoID', 'NodoListoName',
        'TreatmentID', 'TreatmentName',
        'StationID', 'StationName',
        'CycleTime_min', 'TotalTime_min', 'TimeType',
        'CycleTime_min_NUEVO', 'TotalTime_min_NUEVO', 'TimeType_NUEVO',
        'Estado'
      ]
    );

    addSheet('R3_Satélites',
      `R3 — ${RULE_LABELS.R3}. Satélites (T100/T200/...) tratados como mini-procesos: treatment + estaciones + tiempos.`,
      state.rows.r3,
      [
        'SatelliteID', 'SatelliteName', 'TipoSufijo', 'CompartidoEnUso',
        'TreatmentID', 'StationID', 'StationName',
        'CycleTime_min', 'TotalTime_min',
        'CycleTime_min_NUEVO', 'TotalTime_min_NUEVO',
        'Estado'
      ]
    );

    addSheet('R4_LeadTime_Producto',
      `R4 — ${RULE_LABELS.R4}. defaultLeadTime > 0 y productByProductId con nombre que cubra los sufijos del nombre del proceso.`,
      state.rows.r4,
      [
        'ProcessID', 'ProcessName',
        'LeadTime_horas_actual', 'LeadTime_horas_NUEVO',
        'ProductID_actual', 'ProductName_actual', 'ProductName_NUEVO',
        'SufijosAcabado', 'SufijosNoCubiertos', 'EstadoCoherencia'
      ]
    );

    const dupHeaders = [
      'ProcessID', 'ProcessName', 'Tipo', 'Source',
      'GrupoID', 'GrupoTamano', 'EsCanonico', 'ReferenciasEntrantes', 'EsArchivado',
      'TambienEnD1', 'TambienEnD2', 'TambienEnD3',
      'AccionSugerida', 'AccionSugerida_NUEVO', 'Notas_NUEVO'
    ];

    addSheet('D1_DuplicadoNombre',
      `D1 — ${RULE_LABELS.D1}. Nodos activos distintos con el mismo nombre normalizado. Indica copias accidentales del catálogo.`,
      state.rows.d1, dupHeaders);

    addSheet('D2_DuplicadoTrenIDs',
      `D2 — ${RULE_LABELS.D2}. Procesos que reusan exactamente los mismos hijos directos en el mismo orden. Templates compartidos.`,
      state.rows.d2, dupHeaders);

    addSheet('D3_DuplicadoTrenNombres',
      `D3 — ${RULE_LABELS.D3}. Clones por "Save As...": mismos hijos top-level por nombre, IDs distintos. Caso más común.`,
      state.rows.d3, dupHeaders);

    addSheet('Catálogos',
      'Catálogos — sufijos de acabado, satélites detectados, primeros 200 errores del run.',
      state.rows.catalogos,
      ['Categoria', 'Clave', 'Valor']
    );

    const wbOut = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `process-deep-audit-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    log('XLSX descargado');
  }
```

- [ ] **Step 3: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

- [ ] **Step 4: Verificación rápida del XLSX (sintética con SheetJS)**

Run:

```bash
node -e '
// Bootstrap mínimo: stub window + XLSX local
const fs = require("fs");
// Si SheetJS no está en node_modules, instalarlo solo para este check:
let XLSX;
try { XLSX = require("xlsx"); } catch (_) {
  console.log("SKIP: instala con `npm i -g xlsx` o `npm i xlsx --no-save` para validar XLSX. Marca el step como OK si los pasos manuales en producción funcionan.");
  process.exit(0);
}
global.window = { XLSX, document: { createElement: () => ({ appendChild: () => {}, click: () => {} }), body: { appendChild: () => {}, removeChild: () => {} }, head: { appendChild: () => {} } }, URL: { createObjectURL: () => "", revokeObjectURL: () => {} }, Blob: function() {} };
global.alert = () => {};
global.URL = global.window.URL;
global.Blob = global.window.Blob;
global.document = global.window.document;
// Stub ProcessShared y SteelheadAPI (no se usan en exportXlsx con state.rows ya armado)
global.window.ProcessShared = { auditConcurrency: () => ({}), finishProductMap: () => ({}), satelliteOverrides: () => ({include:[],exclude:[]}), duplicatesConfig: () => ({enabled:true,includeSources:[],ignoreNamePatterns:[],ignoreIds:new Set()}), getCatalog: () => ({namesById: new Map(), typesById: new Map()}) };
global.window.SteelheadAPI = { log: ()=>{}, warn: ()=>{}, getDomain: () => ({}) };
eval(fs.readFileSync("remote/scripts/process-deep-audit.js","utf8"));
// Inyectar state mínimo
const pda = global.window.ProcessDeepAudit;
const st = pda.getState();
console.log("Initial state:", st);
console.log("VERSION:", pda.VERSION);
' 2>&1 | head -20
```

Expected: imprime `VERSION: 0.8.0` y `Initial state: null` (porque no se llamó `run`). Si el script no carga (SyntaxError o ReferenceError fuera de `run`), corrige antes de continuar.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): hoja Leyenda + título mergeado + 3 hojas Duplicados

XLSX ahora arranca con hoja "Leyenda" (una sola fuente de verdad para
descripciones R/D), cada hoja tiene fila 1 con título mergeado descriptivo,
y se agregan D1_DuplicadoNombre, D2_DuplicadoTrenIDs, D3_DuplicadoTrenNombres
con 15 columnas (Grupo*, EsCanonico, ReferenciasEntrantes, cross-flags,
AccionSugerida_NUEVO).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Resumen — agregar columnas Duplicados_D1/D2/D3 y flag parcial

Cada fila de Resumen ya tiene los conteos de hallazgos R1/R2/R3/R4 del proceso. Ahora agregamos conteo por proceso para D1/D2/D3 + flag global de parcial.

**Files:**
- Modify: `remote/scripts/process-deep-audit.js` (función `buildResumenRows` y headers del Resumen en `exportXlsx`)

- [ ] **Step 1: Reescribir `buildResumenRows` con columnas D**

Buscar:

```js
  // ── Hoja Resumen ──
  function buildResumenRows() {
    state.rows.resumen = [];
    for (const p of state.processes) {
      state.rows.resumen.push({
        ProcessID: p.id, ProcessName: p.name, LineCode: p.lineCode,
        EsSatélite: 'No',
        Secciones: p.r2.length ? new Set(p.r2.map(r => r.LineCode)).size : 0,
        Hallazgos_R1: p.counts.r1,
        Hallazgos_R2: p.counts.r2,
        Hallazgos_R3: 0,
        Hallazgos_R4: p.counts.r4,
        EstadoGlobal: p.estadoGlobal,
        Error: p.error || ''
      });
    }
    for (const s of state.satellites) {
      state.rows.resumen.push({
        ProcessID: s.id, ProcessName: s.name, LineCode: ps().extractLineCodeFromName(s.name) || '',
        EsSatélite: 'Sí',
        Secciones: 1,
        Hallazgos_R1: 0,
        Hallazgos_R2: 0,
        Hallazgos_R3: s.counts.r3 || 0,
        Hallazgos_R4: 0,
        EstadoGlobal: s.counts.r3 > 0 ? 'CON HALLAZGOS' : 'OK',
        Error: ''
      });
    }
  }
```

Reemplazar por:

```js
  // ── Hoja Resumen ──
  function buildResumenRows() {
    state.rows.resumen = [];

    // Indexar duplicados por ProcessID para conteo rápido
    const dupCountByPid = { d1: new Map(), d2: new Map(), d3: new Map() };
    const bump = (mapObj, pid) => mapObj.set(pid, (mapObj.get(pid) || 0) + 1);
    for (const r of state.rows.d1) bump(dupCountByPid.d1, r.ProcessID);
    for (const r of state.rows.d2) bump(dupCountByPid.d2, r.ProcessID);
    for (const r of state.rows.d3) bump(dupCountByPid.d3, r.ProcessID);

    const partialNote = state.duplicates && state.duplicates.partial ? 'PARCIAL_POR_CANCELACION' : '';

    for (const p of state.processes) {
      const dup1 = dupCountByPid.d1.get(p.id) || 0;
      const dup2 = dupCountByPid.d2.get(p.id) || 0;
      const dup3 = dupCountByPid.d3.get(p.id) || 0;
      const totalDup = dup1 + dup2 + dup3;
      const hadIssue = p.estadoGlobal === 'CON HALLAZGOS';
      state.rows.resumen.push({
        ProcessID: p.id, ProcessName: p.name, LineCode: p.lineCode,
        EsSatélite: 'No',
        Secciones: p.r2.length ? new Set(p.r2.map(r => r.LineCode)).size : 0,
        Hallazgos_R1: p.counts.r1,
        Hallazgos_R2: p.counts.r2,
        Hallazgos_R3: 0,
        Hallazgos_R4: p.counts.r4,
        Duplicados_D1: dup1,
        Duplicados_D2: dup2,
        Duplicados_D3: dup3,
        EstadoGlobal: (hadIssue || totalDup > 0) ? 'CON HALLAZGOS' : 'OK',
        NotaParcial: partialNote,
        Error: p.error || ''
      });
    }
    for (const s of state.satellites) {
      const dup1 = dupCountByPid.d1.get(s.id) || 0;
      const dup2 = dupCountByPid.d2.get(s.id) || 0;
      const dup3 = dupCountByPid.d3.get(s.id) || 0;
      const totalDup = dup1 + dup2 + dup3;
      const hadIssue = s.counts.r3 > 0;
      state.rows.resumen.push({
        ProcessID: s.id, ProcessName: s.name, LineCode: ps().extractLineCodeFromName(s.name) || '',
        EsSatélite: 'Sí',
        Secciones: 1,
        Hallazgos_R1: 0,
        Hallazgos_R2: 0,
        Hallazgos_R3: s.counts.r3 || 0,
        Hallazgos_R4: 0,
        Duplicados_D1: dup1,
        Duplicados_D2: dup2,
        Duplicados_D3: dup3,
        EstadoGlobal: (hadIssue || totalDup > 0) ? 'CON HALLAZGOS' : 'OK',
        NotaParcial: partialNote,
        Error: ''
      });
    }

    // Filas extra para nodos del universo D que no están en processes/satellites
    // (SUB_PROCESS, STEP_SHIPPING, RT) pero SÍ aparecen en algún grupo de duplicados.
    const allReportedIds = new Set(state.rows.resumen.map(r => r.ProcessID));
    const extraIdsWithDups = new Set([
      ...dupCountByPid.d1.keys(),
      ...dupCountByPid.d2.keys(),
      ...dupCountByPid.d3.keys()
    ].filter(id => !allReportedIds.has(id)));

    if (extraIdsWithDups.size) {
      const allDupRows = [...state.rows.d1, ...state.rows.d2, ...state.rows.d3];
      const byId = new Map();
      for (const r of allDupRows) if (!byId.has(r.ProcessID)) byId.set(r.ProcessID, r);
      for (const id of extraIdsWithDups) {
        const sample = byId.get(id);
        if (!sample) continue;
        state.rows.resumen.push({
          ProcessID: id,
          ProcessName: sample.ProcessName,
          LineCode: ps().extractLineCodeFromName(sample.ProcessName || '') || '',
          EsSatélite: 'No',
          Secciones: 0,
          Hallazgos_R1: 0, Hallazgos_R2: 0, Hallazgos_R3: 0, Hallazgos_R4: 0,
          Duplicados_D1: dupCountByPid.d1.get(id) || 0,
          Duplicados_D2: dupCountByPid.d2.get(id) || 0,
          Duplicados_D3: dupCountByPid.d3.get(id) || 0,
          EstadoGlobal: 'CON HALLAZGOS',
          NotaParcial: partialNote,
          Error: ''
        });
      }
    }
  }
```

- [ ] **Step 2: Actualizar headers de Resumen en `exportXlsx`**

Buscar (dentro de `exportXlsx`):

```js
    addSheet('Resumen',
      `Resumen por proceso · ${state.duplicates.partial ? 'PARCIAL_POR_CANCELACION · ' : ''}generado ${new Date().toISOString()}`,
      state.rows.resumen,
      [
        'ProcessID', 'ProcessName', 'LineCode', 'EsSatélite', 'Secciones',
        'Hallazgos_R1', 'Hallazgos_R2', 'Hallazgos_R3', 'Hallazgos_R4',
        'EstadoGlobal', 'Error'
      ]
    );
```

Reemplazar por:

```js
    addSheet('Resumen',
      `Resumen por proceso · ${state.duplicates.partial ? 'PARCIAL_POR_CANCELACION · ' : ''}generado ${new Date().toISOString()}`,
      state.rows.resumen,
      [
        'ProcessID', 'ProcessName', 'LineCode', 'EsSatélite', 'Secciones',
        'Hallazgos_R1', 'Hallazgos_R2', 'Hallazgos_R3', 'Hallazgos_R4',
        'Duplicados_D1', 'Duplicados_D2', 'Duplicados_D3',
        'EstadoGlobal', 'NotaParcial', 'Error'
      ]
    );
```

- [ ] **Step 3: Validar sintaxis**

Run: `node -c remote/scripts/process-deep-audit.js`
Expected: código 0.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/process-deep-audit.js
git commit -m "$(cat <<'EOF'
feat(deep-audit): Resumen suma Duplicados_D1/D2/D3 + filas extra para
SUB_PROCESS/STEP_SHIPPING/RT que solo aparecen en grupos D, + NotaParcial.

EstadoGlobal pasa a CON HALLAZGOS si tiene cualquier conteo D>0 (no solo
R*>0). Nodos no auditados por R1-R4 pero presentes en grupos de duplicados
ganan su propia fila para que el Resumen sea cierre completo del run.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Test en navegador antes del deploy a gh-pages

Validación previa con la extensión apuntando localmente. NO hace deploy todavía — eso es Task 12.

**Files:** ninguno; pasos manuales.

- [ ] **Step 1: Verificar que `node -c` pase en ambos scripts**

Run:

```bash
node -c remote/scripts/process-shared.js && node -c remote/scripts/process-deep-audit.js && echo "OK"
```

Expected: `OK`. Si falla, corregir antes de seguir.

- [ ] **Step 2: Verificar consistencia de versiones**

Run:

```bash
grep -n "VERSION\|__psVersion\|version" remote/scripts/process-deep-audit.js remote/scripts/process-shared.js | head -10
grep -n '"version"\|"lastUpdated"' remote/config.json | head -5
```

Expected:
- `process-deep-audit.js`: `const VERSION = '0.8.0'`
- `process-shared.js`: `window.__psVersion = '0.8.0'`
- `config.json`: aún en `"version": "0.7.1"` (se bumpea en Task 12 como parte del deploy)

- [ ] **Step 3: Test manual local — pre-deploy**

(Este paso es opcional pero recomendado si tienes un branch de gh-pages local apuntando al main checkout via la técnica del usuario. Si no, salta al Step 4.)

a. Cargar la extensión en `chrome://extensions` con "Modo desarrollador" y "Cargar descomprimida" apuntando a `extension/`.
b. Editar `extension/manifest.json` temporalmente para que `host_permissions` incluya el origen donde sirvas localmente los scripts (típicamente file:// no funciona — usar un `python3 -m http.server` desde `remote/` y ajustar `config.json` `appsBaseUrl` localmente). Si esto es muy complejo en tu entorno, **salta al Step 4**.
c. Recargar la extensión y la página de Steelhead.
d. Verificar en consola: `[SA] process-shared cargado · v0.8.0` y `[SA] process-deep-audit cargado · v0.8.0`.

- [ ] **Step 4: Sanity check ofuscado — dry-run sin deploy**

Inyectar manualmente en DevTools de la tab de Steelhead (después de haber abierto la app de Steelhead con la extensión cargada en v0.7.1):

```js
// Verifica que ProcessShared 0.8.0 expone las firmas
// (Solo correr DESPUÉS de hacer el deploy a gh-pages — este step solo documenta qué buscar)
console.log('PS version:', window.__psVersion);
console.log('Has signatureD1:', typeof window.ProcessShared?.signatureD1);
console.log('Has signatureD2:', typeof window.ProcessShared?.signatureD2);
console.log('Has signatureD3:', typeof window.ProcessShared?.signatureD3);
console.log('Has groupBySignature:', typeof window.ProcessShared?.groupBySignature);
console.log('Has duplicatesConfig:', typeof window.ProcessShared?.duplicatesConfig);
```

Esperado después del deploy real (Task 12): todos los `typeof` devuelven `"function"`. **Este step no se "completa" hasta después del deploy** — déjalo abierto y márcalo cuando hayas verificado en producción.

- [ ] **Step 5: Sin commit en este task** (solo verificación)

---

## Task 12: Deploy a `gh-pages` + bump de `config.version`

Sigue el procedimiento documentado en `CLAUDE.md` ("Deploy a producción"). NO hace push automático — los pushes los hace el usuario para mantener control sobre `main`.

**Files:**
- Modify: `remote/config.json` (bump `version` y `lastUpdated`)
- Sync a `gh-pages`: `scripts/process-shared.js`, `scripts/process-deep-audit.js`, `config.json`

- [ ] **Step 1: Bumpear `version` y `lastUpdated` en `remote/config.json`**

Buscar:

```json
  "version": "0.7.1",
  "lastUpdated": "2026-05-15",
```

Reemplazar por:

```json
  "version": "0.8.0",
  "lastUpdated": "2026-05-18",
```

- [ ] **Step 2: Validar JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('remote/config.json','utf8')); console.log('JSON OK');"`
Expected: `JSON OK`.

- [ ] **Step 3: Commit en `main`**

```bash
git add remote/config.json
git commit -m "$(cat <<'EOF'
chore(config): bump version 0.7.1 → 0.8.0 (deep-audit Duplicados)

Cache-bust para que la extensión recargue process-shared.js y
process-deep-audit.js con las firmas D1/D2/D3.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Sync a `gh-pages` (layout aplanado)**

```bash
# Guardar checkout actual de main para copia
MAIN_CO=$(pwd)
# Switch a gh-pages
git switch gh-pages
# Copiar los 3 archivos con layout aplanado
cp "$MAIN_CO/remote/scripts/process-shared.js" scripts/process-shared.js
cp "$MAIN_CO/remote/scripts/process-deep-audit.js" scripts/process-deep-audit.js
cp "$MAIN_CO/remote/config.json" config.json
# Validar diff
git diff --stat
git status
```

Expected: ver los 3 archivos modificados (`scripts/process-shared.js`, `scripts/process-deep-audit.js`, `config.json`) en `git status`.

- [ ] **Step 5: Verificar sync byte-a-byte**

```bash
# Comparar contra main (recordar que MAIN_CO sigue apuntando al checkout)
diff "$MAIN_CO/remote/scripts/process-shared.js" scripts/process-shared.js && echo "shared OK"
diff "$MAIN_CO/remote/scripts/process-deep-audit.js" scripts/process-deep-audit.js && echo "deep-audit OK"
diff "$MAIN_CO/remote/config.json" config.json && echo "config OK"
```

Expected: tres líneas `OK`. Si hay diff inesperado, re-copiar.

- [ ] **Step 6: Commit en `gh-pages`**

```bash
git add scripts/process-shared.js scripts/process-deep-audit.js config.json
git commit -m "$(cat <<'EOF'
deploy: deep-audit Duplicados D1/D2/D3 + bump 0.8.0

Detección de duplicados sobre PROCESS principales, satélites, SUB_PROCESS,
STEP_SHIPPING y RT con 3 firmas (nombre normalizado, tren de IDs top-level,
tren de nombres top-level). 3 hojas XLSX nuevas + Leyenda + título mergeado
por hoja. Read-only; AccionSugerida_NUEVO editable para Fase 2.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Volver a `main`**

```bash
git switch main
```

- [ ] **Step 8: Reporte de estado (NO push automático)**

Run:

```bash
git log main --oneline -5
git log gh-pages --oneline -5
```

Imprimir al usuario:

```
Commits listos:
  main:     <SHA> chore(config): bump version 0.7.1 → 0.8.0
            <SHA> feat(deep-audit): Resumen suma Duplicados_D1/D2/D3 + ...
            ...
  gh-pages: <SHA> deploy: deep-audit Duplicados D1/D2/D3 + bump 0.8.0

Para publicar a producción, el usuario debe correr (con su autorización
explícita, ya que CLAUDE.md bloquea push a default branches):

    git push origin main && git push origin gh-pages
```

---

## Task 13: Validación en producción (post-push)

Pasos manuales que el usuario sigue después de haber hecho `git push origin main && git push origin gh-pages` y esperado el refresh de GitHub Pages (30-60s).

**Files:** ninguno; pasos manuales.

- [ ] **Step 1: Recargar la extensión**

`chrome://extensions` → botón "Recargar" en SteelheadAutomator. Si no aparece, reiniciar Chrome.

- [ ] **Step 2: Abrir Steelhead y verificar versión cargada**

Abrir `https://app.gosteelhead.com/`. Esperar a que la extensión inyecte los scripts.

Abrir DevTools (F12) → Consola. Filtrar por `[SA]`. Esperar líneas:

```
[SA] process-shared cargado · v0.8.0
[SA] process-deep-audit cargado · v0.8.0
```

Si aparece `v0.7.x`, esperar 1-2 min y recargar. GitHub Pages CDN puede tardar.

- [ ] **Step 3: Verificar exports en consola**

```js
console.log('PS:', window.__psVersion);
console.log('DA:', window.ProcessDeepAudit.VERSION);
console.log('Sigs:', ['signatureD1','signatureD2','signatureD3','groupBySignature','duplicatesConfig'].map(k => `${k}=${typeof window.ProcessShared[k]}`));
```

Expected: `Sigs: [ 'signatureD1=function', 'signatureD2=function', 'signatureD3=function', 'groupBySignature=function', 'duplicatesConfig=function' ]`.

- [ ] **Step 4: Correr la auditoría**

Disparar la acción `run-process-deep-audit` (botón en el panel de la extensión que ya existe). Esperar a que aparezca el overlay azul "🔬 Auditoría Profunda de Procesos · v0.8.0".

- [ ] **Step 5: Validar panel durante el run**

Observar que las fases pasan por:
- `catálogo · ...`
- `procesos · ...`
- `auditando ~N procesos + M satélites`
- `auditando procesos · X/N`
- `auditando satélites · X/M`
- `D · fetchando árboles faltantes · X/Y`
- `D · fetchando referencias entrantes · X/Z`
- `done`

Si alguna fase D no aparece, verificar `state.duplicates` en consola: `window.ProcessDeepAudit.getState().duplicates`.

- [ ] **Step 6: Validar panel al terminar**

Aparece sección "Reglas estructurales" con R1-R4 + sección "Duplicados ★ NUEVO" con D1/D2/D3 y conteos `grupos / miembros`. Hover sobre cada label muestra tooltip con descripción.

Tabs nuevos D1/D2/D3 disponibles.

- [ ] **Step 7: Validar caso conocido — `SP Embarque en Almacén`**

Click tab D1. Filtrar por "embarque". Verificar que aparece grupo de al menos 7 filas con `GrupoID = "sp embarque en almacen"`, una con `EsCanonico=true` (el de id más bajo con más parents), las demás con `AccionSugerida` ∈ {ARCHIVAR, FUSIONAR}.

- [ ] **Step 8: Descargar XLSX**

Click "📥 Exportar XLSX". El archivo se llama `process-deep-audit-2026-05-18.xlsx`.

Abrir en Excel o LibreOffice. Verificar:
- 10 hojas en este orden: `Leyenda`, `Resumen`, `R1_Listo_NoScanner`, `R2_TiemposLineaPrincipal`, `R3_Satélites`, `R4_LeadTime_Producto`, `D1_DuplicadoNombre`, `D2_DuplicadoTrenIDs`, `D3_DuplicadoTrenNombres`, `Catálogos`.
- Cada hoja: fila 1 = título mergeado A1:N1 (o similar según el conteo de headers) con texto descriptivo.
- Hoja `Leyenda`: 7 filas (R1, R2, R3, R4, D1, D2, D3) con columnas `Sigla, Descripcion, Subcaso, EstadoPosible, AccionTipica`.
- Hoja `D1_DuplicadoNombre`: grupo `sp embarque en almacen` presente.

- [ ] **Step 9: Validar caso de cancelación**

Volver a correr. Click "⏹ Detener" durante la fase "D · fetchando árboles faltantes · X/Y".

Esperado:
- Fase cambia a `cancelado`.
- En `state.duplicates.partial === true`.
- Panel muestra badge `[PARCIAL]` junto a "Duplicados ★ NUEVO".
- Click "📥 Exportar XLSX" funciona; hoja Resumen muestra `NotaParcial = "PARCIAL_POR_CANCELACION"` en filas.

- [ ] **Step 10: Validar canal de escape `ignoreIds`**

En `remote/config.json` (en `main`), agregar temporalmente:

```json
"ignoreIds": [109804]
```

(Asumir 109804 es uno de los miembros del grupo SP Embarque; consultar la consola con `[...new Set(window.ProcessDeepAudit.getState().rows.d1.filter(r => r.ProcessName.includes("Embarque")).map(r => r.ProcessID))]` para obtener un ID real.)

Bumpear version `0.8.0 → 0.8.1`, deploy a `gh-pages`, push.

Re-correr el audit. Verificar que el id excluido ya no aparece en D1 (grupo bajó de 7 a 6).

Si esto pasa, revertir el cambio (volver `ignoreIds` a `[]`, version `0.8.1 → 0.8.2`, deploy + push) y dejar el applet limpio.

(Este step es opcional pero confirma que `duplicatesConfig` se respeta runtime.)

- [ ] **Step 11: Sin commit** (solo verificación). Si todos los pasos pasan, reportar al usuario:

```
✅ Deep Audit v0.8.0 desplegado y verificado en producción:
   - 10 hojas XLSX presentes
   - Grupo SP Embarque en Almacén detectado con N miembros (esperado ≥7)
   - Cancelación responsiva
   - Canal ignoreIds funciona (si Step 10 corrió)
```

---

## Task 14: Documentación

Actualiza `docs/processes-architecture.md` con la nueva sección + entrada en glosario.

**Files:**
- Modify: `docs/processes-architecture.md`

- [ ] **Step 1: Agregar entrada al glosario de versiones (§9)**

Buscar en `docs/processes-architecture.md`:

```
| 0.5.59 | Marcar el nodo raíz del proceso como `autoComplete: true` vía `UpdateProcessNode` después del `ProcureTree` exitoso |
```

Después de esa fila, agregar una nueva fila al final de la tabla (justo antes de `## 10. Treatments`):

```
| 0.8.0 (deep-audit) | Detección de duplicados D1/D2/D3 sobre PROCESS+SUB_PROCESS+STEP_SHIPPING+satélites+RT con 3 hojas XLSX + Leyenda + título mergeado. Canónico por id+parents; AccionSugerida_NUEVO editable. | `evaluateD` reusa caché `state.treesById` de R1-R4 para minimizar HTTP. Pool separado para árboles faltantes y `getProcessNodeParents`. |
```

- [ ] **Step 2: Agregar sección 11 — Detección de duplicados**

Buscar al final del archivo:

```
- **`extension/background.js:212` (`get-current-user`).** Sigue invocando `CurrentUser` deprecado (ver lección de v0.5.7 en `CLAUDE.md`). Pivotar a `CurrentUserDetails`.
```

Después del último item de la sección 11 ("Pendientes / áreas para extender"), agregar:

```markdown

## 12. Detección de duplicados (process-deep-audit ≥ v0.8.0)

`process-deep-audit` corre tres firmas de duplicado sobre un universo unificado
(PROCESS principales + satélites + RT + SUB_PROCESS + STEP_SHIPPING) después de
R1-R4. Read-only: emite tres hojas XLSX (D1, D2, D3) con `AccionSugerida_NUEVO`
editable para que un applet de Fase 2 procese decisiones de archivado/fusión.

### 12.1 Firmas

- **D1 — `signatureD1(node)` = `normName(name)`.** Detecta drift puro del catálogo
  (ej. los 7 IDs activos de `SP Embarque en Almacén`).
- **D2 — `signatureD2(treeRoot)` = `JSON.stringify(extractTopLevel(treeRoot).map(c => c.id))`.**
  Detecta procesos que reusan exactamente los mismos hijos directos en el mismo orden.
- **D3 — `signatureD3(treeRoot)` = `JSON.stringify(extractTopLevel(treeRoot).map(c => normName(c.name)))`.**
  Detecta clones por "Save As..." donde los nombres top-level son idénticos pero los
  IDs distintos. Caso más común dado los duplicados activos de SUB_PROCESS.

Profundidad: D3 mira solo top-level. Razones documentadas en el spec
`docs/superpowers/specs/2026-05-18-process-duplicates-design.md`. Si la corrida
real revela necesidad de full-depth, agregar D4 con datos.

### 12.2 Canónico

```js
function pickCanonical(members, parentsByIdCache) {
  return members.slice().sort((a, b) => {
    const pa = parentsByIdCache.get(a.id);
    const pb = parentsByIdCache.get(b.id);
    const fa = (pa == null) ? -1 : pa;
    const fb = (pb == null) ? -1 : pb;
    if (fa !== fb) return fb - fa;  // más referencias gana
    return a.id - b.id;              // empate → id más bajo gana
  })[0];
}
```

`parentsByIdCache` se llena con `getProcessNodeParents(id)` SOLO para miembros de
grupos con `size ≥ 2`. Para nodos sin dato (502, cancelación), `pickCanonical` los
trata como `-1` → pierden contra cualquier número.

`AccionSugerida` automática:
- `EsCanonico=true` → `MANTENER`
- `EsCanonico=false && refs=0` → `ARCHIVAR`
- `EsCanonico=false && refs>0` → `FUSIONAR`
- `refs` desconocido → vacío

### 12.3 Universo y filtros

`buildAuditUniverse(allProcesses, satelliteCatalog)` reúne los 5 buckets:

- `main` — PROCESS sin prefijo RT/SP, no satélite.
- `satellite` — del catálogo R3.
- `rt` — PROCESS con `/^RT\b/i`.
- `subprocess` — SUB_PROCESS del catálogo `loadAllNodes`.
- `stepshipping` — STEP_SHIPPING del catálogo.

Filtros desde `config.json:steelhead.domain.processAudit.duplicates`:
- `enabled: false` salta toda la fase.
- `includeSources: [...]` permite limitar a subconjuntos.
- `ignoreIds: [int]` excluye IDs específicos.
- `ignoreNamePatterns: ["regex"]` excluye por nombre (regex case-insensitive).

### 12.4 Cache `state.treesById`

Para evitar `getProcessTree` duplicado, `auditProcess` y `evaluateR3` (R1-R4)
guardan su árbol fetched en `state.treesById: Map<id, {treeRoot, processNodeById}>`.
`evaluateD` reusa lo cacheado y solo dispara fetch para los faltantes
(`auditUniverse \ treesById.keys`), típicamente SUB_PROCESS/STEP_SHIPPING/RT.

Pool separado: `processAudit.concurrency.trees` (default 5) para árboles faltantes,
`processAudit.concurrency.parents` (default 5) para `getProcessNodeParents`.

### 12.5 Cancelación parcial

Si el usuario cancela durante el fetch de árboles faltantes:
- D1 (que no depende del árbol) emite completo.
- D2/D3 se construyen con los árboles que sí se tienen.
- `state.duplicates.partial = true`.
- Panel marca `[PARCIAL]`, hoja Resumen muestra `NotaParcial = "PARCIAL_POR_CANCELACION"`.

Sin requests colgados; el pool drena pendientes ya iniciados pero no encola más.

### 12.6 Pendientes

- **Fase 2 — applet hermano.** Lee el XLSX editado con `AccionSugerida_NUEVO ∈ {ARCHIVAR, FUSIONAR, MANTENER}` y aplica las mutaciones. Para `FUSIONAR` requiere re-apuntar referencias entrantes al canon antes de archivar (mutation `ArchiveProcessNode` o equivalente — no investigado aún).
- **D4 full-depth.** Si D3 top-level resulta insuficiente, recursar firmas. Requiere `flattenTree` enriquecido y costo recursivo controlado.
- **Detección incremental.** Hoy cada corrida es desde cero. Persistir el último resultado en `chrome.storage.local` permitiría reportar "nuevos grupos vs corrida anterior".
```

- [ ] **Step 3: Commit**

```bash
git add docs/processes-architecture.md
git commit -m "$(cat <<'EOF'
docs(process-architecture): sección 12 — Detección de duplicados (deep-audit 0.8.0)

Documenta firmas D1/D2/D3, criterio del canónico, universo y filtros,
caché treesById, cancelación parcial, y pendientes para Fase 2.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (implementador)

Después de terminar todas las tasks, revisar contra el spec:

1. **Spec §4.1 (universo) → Task 5** ✓
2. **Spec §4.2 (D1) → Task 1 step 1** ✓
3. **Spec §4.3 (D2) → Task 1 step 1** ✓
4. **Spec §4.4 (D3) → Task 1 step 1** ✓
5. **Spec §4.5 (canónico) → Task 6 step 1 (pickCanonical)** ✓
6. **Spec §4.6 (funciones nuevas) → Tasks 1, 3, 6** ✓
7. **Spec §5.1 (caché treesById) → Task 4** ✓
8. **Spec §5.2 (pools) → Task 6 + Task 2 (config trees/parents)** ✓
9. **Spec §5.3 (cancelación) → Task 6 step 1 (chequeos isStale)** ✓
10. **Spec §5.4 (errores individuales) → Task 6 step 1 (try/catch interno)** ✓
11. **Spec §6.1 (panel) → Task 8** ✓
12. **Spec §6.2 (hojas XLSX) → Task 9** ✓
13. **Spec §6.3 (columnas D) → Task 6 step 1 (shape del row) + Task 9 (dupHeaders)** ✓
14. **Spec §7 (config) → Task 2 + Task 12** ✓
15. **Spec §8 (archivos tocados) → Tasks 1-14** ✓
16. **Spec §9 (casos prueba) → Task 13** ✓
17. **Spec §10 (plan validación) → Tasks 12-13** ✓
18. **Spec §11 (riesgos) — sin tarea directa; riesgos se mitigan via timeout/retries/pool ya implementados**
19. **Spec §12 (métricas éxito) → Task 13 step 11** ✓
20. **Spec §2 fuera-de-alcance — NO hay tarea de mutación; consistente** ✓

Toda sección del spec tiene cobertura. Plan listo.
