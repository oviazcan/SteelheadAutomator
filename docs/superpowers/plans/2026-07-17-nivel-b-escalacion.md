# Nivel B — Escalación autónoma de recetas rotas · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando una receta del hash-autopilot se rompe (`needs-attention.json`), un cron local intenta re-descubrirla sola y, falle o no, manda un correo con el TRACE detallado de cada acción intentada.

**Architecture:** launchd local a :53 → `run-escalation.sh` (gate por `needs-attention.json` + refresh ROCP) → `claude -p` headless con el prompt de re-descubrimiento. El re-descubrimiento usa Playwright headless (infra del motor). Un módulo puro (`escalation-trace.mjs`) da forma al trace y su resumen para el correo. Guardrails: solo toca recetas, tests antes de deployar, idempotente.

**Tech Stack:** Node ESM (`node:test`), bash, launchd (plist), Playwright (ya presente), `claude -p` (Claude Code headless).

## Global Constraints

- JavaScript vanilla / Node ESM; núcleos puros testeables con `node:test` (sin red/DOM).
- Rutas absolutas del proyecto: `/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator`.
- El re-descubrimiento es **read-only** sobre datos de Steelhead (solo navega + captura; nunca confirma escrituras).
- El deploy de hashes lo hace SOLO `hash-autopilot.mjs` (con sus candados: firma KMS, freno de masa). El agente de escalación **nunca** edita `remote/config.json`.
- Correo a los 3 destinatarios vía `tools/hash-autopilot/autopilot-notify.sh`.
- Suite verde (`tools/run-tests.sh`) antes de cualquier deploy.
- Commits en `main`; el tooling NO va a `gh-pages`.

---

### Task 1: Módulo puro del trace (`escalation-trace.mjs`)

**Files:**
- Create: `tools/hash-autopilot/escalation-trace.mjs`
- Test: `tools/test/escalation-trace.test.js`

**Interfaces:**
- Produces: `newTrace(date) → Trace`; `addAction(trace, action) → Trace`; `outcomeByOp(trace) → {op: 'reparada'|'escalada'}`; `summarizeForEmail(trace, maxPerOp=8) → string`.
- `action` = `{ op, step, action, target, selectorTried, observed, opFired, screenshot }`.

- [ ] **Step 1: Write the failing test**

```js
// tools/test/escalation-trace.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { newTrace, addAction, outcomeByOp, summarizeForEmail } = require('../hash-autopilot/escalation-trace.mjs');

const A = (op, opFired, observed) => ({ op, step: 1, action: 'clickButton', target: 'add invoice', selectorTried: "span[aria-label='Add Invoice']", observed, opFired, screenshot: null });

test('newTrace: estructura base', () => {
  const t = newTrace('2026-07-17');
  assert.equal(t.date, '2026-07-17');
  assert.deepEqual(t.actions, []);
});
test('addAction: agrega inmutable', () => {
  const t0 = newTrace('2026-07-17');
  const t1 = addAction(t0, A('X', false, 'no encontrado'));
  assert.equal(t0.actions.length, 0);
  assert.equal(t1.actions.length, 1);
  assert.equal(t1.actions[0].op, 'X');
});
test('outcomeByOp: reparada si alguna acción disparó la op', () => {
  let t = newTrace('d');
  t = addAction(t, A('X', false, 'falló'));
  t = addAction(t, A('X', true, 'op disparada'));
  t = addAction(t, A('Y', false, 'falló'));
  assert.deepEqual(outcomeByOp(t), { X: 'reparada', Y: 'escalada' });
});
test('summarizeForEmail: incluye op, observación y marca de resultado', () => {
  let t = newTrace('d');
  t = addAction(t, A('X', false, 'la UI cambió el aria-label'));
  t = addAction(t, A('X', true, 'op disparada con el nuevo selector'));
  const s = summarizeForEmail(t);
  assert.match(s, /X/);
  assert.match(s, /la UI cambió el aria-label/);
  assert.match(s, /✓|reparada/i);
});
test('summarizeForEmail: recorta a maxPerOp por op', () => {
  let t = newTrace('d');
  for (let i = 0; i < 12; i++) t = addAction(t, A('X', false, 'intento ' + i));
  const s = summarizeForEmail(t, 3);
  assert.match(s, /\+ 9 más|9 acciones más/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/escalation-trace.test.js`
Expected: FAIL ("Cannot find module '../hash-autopilot/escalation-trace.mjs'").

- [ ] **Step 3: Write minimal implementation**

```js
// tools/hash-autopilot/escalation-trace.mjs
// Núcleo PURO del trace de re-descubrimiento (Nivel B). Registra cada acción
// intentada para que el operador mejore las heurísticas. Sin red/DOM.

export function newTrace(date) {
  return { date, actions: [] };
}

// addAction(trace, action) → NUEVO trace con la acción añadida (inmutable).
export function addAction(trace, action) {
  return { ...trace, actions: [...trace.actions, action] };
}

// outcomeByOp(trace) → { op: 'reparada' | 'escalada' }. 'reparada' si ALGUNA
// acción de esa op disparó la op objetivo (opFired true).
export function outcomeByOp(trace) {
  const out = {};
  for (const a of trace.actions || []) {
    if (out[a.op] === 'reparada') continue;
    out[a.op] = a.opFired ? 'reparada' : 'escalada';
  }
  return out;
}

// summarizeForEmail(trace, maxPerOp) → texto legible para el correo. Agrupa por
// op, lista hasta maxPerOp acciones con su resultado y observación, y anota el
// desenlace (reparada/escalada).
export function summarizeForEmail(trace, maxPerOp = 8) {
  const byOp = {};
  for (const a of trace.actions || []) (byOp[a.op] || (byOp[a.op] = [])).push(a);
  const outcome = outcomeByOp(trace);
  const blocks = [];
  for (const [op, acts] of Object.entries(byOp)) {
    const mark = outcome[op] === 'reparada' ? '✓ reparada' : '✗ escalada';
    const shown = acts.slice(0, maxPerOp).map((a, i) =>
      `   ${i + 1}. [${a.action}] ${a.target || a.selectorTried || ''} → ${a.opFired ? 'OP DISPARADA' : 'no'} · ${a.observed || ''}`);
    const extra = acts.length > maxPerOp ? `\n   … + ${acts.length - maxPerOp} acciones más` : '';
    blocks.push(`• ${op} (${mark}):\n${shown.join('\n')}${extra}`);
  }
  return blocks.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/escalation-trace.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/hash-autopilot/escalation-trace.mjs tools/test/escalation-trace.test.js
git commit -m "feat(escalation): módulo puro del trace de re-descubrimiento (Nivel B)"
```

---

### Task 2: Enriquecer `needs-attention.json` con la receta vieja completa

**Files:**
- Modify: `tools/hash-autopilot/hash-autopilot.mjs` (función `writeNeedsAttention`, ~línea 395)
- Test: `tools/test/needs-attention-shape.test.js` (extraer la construcción a una función pura)

**Interfaces:**
- Produces: `buildNeedsAttention(notCaptured, recipes, date) → { date, ops:[{op, recipeTried, module, steps, captures, observed}] }` — función pura exportada de `hash-autopilot-core.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// tools/test/needs-attention-shape.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNeedsAttention } = require('../hash-autopilot/hash-autopilot-core.mjs');

test('buildNeedsAttention: incluye module + captures + steps de la receta vieja', () => {
  const recipes = { 'invoices-x': { module: 'Invoices', steps: [{ goto: '/x' }], captures: ['GetReceivedOrdersWithReceivedOrderLineItems'] } };
  const na = buildNeedsAttention([{ op: 'GetReceivedOrdersWithReceivedOrderLineItems' }], recipes, '2026-07-17');
  assert.equal(na.date, '2026-07-17');
  assert.equal(na.ops[0].op, 'GetReceivedOrdersWithReceivedOrderLineItems');
  assert.equal(na.ops[0].recipeTried, 'invoices-x');
  assert.equal(na.ops[0].module, 'Invoices');
  assert.deepEqual(na.ops[0].steps, [{ goto: '/x' }]);
  assert.deepEqual(na.ops[0].captures, ['GetReceivedOrdersWithReceivedOrderLineItems']);
});
test('buildNeedsAttention: op sin receta → recipeTried null, steps null', () => {
  const na = buildNeedsAttention([{ op: 'Nueva' }], {}, 'd');
  assert.equal(na.ops[0].recipeTried, null);
  assert.equal(na.ops[0].steps, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/needs-attention-shape.test.js`
Expected: FAIL ("buildNeedsAttention is not a function").

- [ ] **Step 3: Add the pure function to `hash-autopilot-core.mjs`**

```js
// Construye el payload de needs-attention.json (Nivel B). Enriquece cada op con
// la receta vieja COMPLETA (module + steps + captures) para dar al re-descubridor
// un punto de partida. op sin receta → recipeTried/steps null (crear desde cero).
export function buildNeedsAttention(notCaptured, recipes, date) {
  const find = (op) => Object.entries(recipes || {}).find(([, r]) => (r.captures || []).includes(op));
  const ops = (notCaptured || []).map((r) => {
    const rec = find(r.op);
    return {
      op: r.op,
      recipeTried: rec ? rec[0] : null,
      module: rec ? (rec[1].module || null) : null,
      steps: rec ? (rec[1].steps || null) : null,
      captures: rec ? (rec[1].captures || null) : null,
      observed: 'la receta no disparó la op (0 capturas)',
    };
  });
  return { date, ops };
}
```

- [ ] **Step 4: Wire it into `writeNeedsAttention` in `hash-autopilot.mjs`**

Replace the body of `writeNeedsAttention` so it uses the pure builder (import `buildNeedsAttention` from `./hash-autopilot-core.mjs` at the top with the other core imports):

```js
function writeNeedsAttention(notCaptured, recipes, date) {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = buildNeedsAttention(notCaptured, recipes, date);
    writeFileSync(join(RESULTS_DIR, 'needs-attention.json'), JSON.stringify(payload, null, 2));
    console.log(`  señal de escalamiento escrita (${payload.ops.length} op).`);
  } catch (e) { console.log(`(no se pudo escribir needs-attention: ${String(e).slice(0, 80)})`); }
}
```

- [ ] **Step 5: Run tests**

Run: `node --test tools/test/needs-attention-shape.test.js && node --check tools/hash-autopilot/hash-autopilot.mjs`
Expected: PASS + "OK".

- [ ] **Step 6: Commit**

```bash
git add tools/hash-autopilot/hash-autopilot-core.mjs tools/hash-autopilot/hash-autopilot.mjs tools/test/needs-attention-shape.test.js
git commit -m "feat(escalation): enriquecer needs-attention.json con module+steps+captures de la receta vieja"
```

---

### Task 3: El prompt de re-descubrimiento (`escalation-prompt.md`)

**Files:**
- Create: `tools/hash-autopilot/escalation-prompt.md`

**Interfaces:** artefacto de texto que `run-escalation.sh` pasa a `claude -p`. No testeable con node; su corrección se valida en la prueba supervisada (Task 6).

- [ ] **Step 1: Write the prompt file**

```markdown
<!-- tools/hash-autopilot/escalation-prompt.md -->
Eres el agente de escalación Nivel B del hash-autopilot. Objetivo: re-descubrir
recetas de navegación rotas y dejar un TRACE detallado de lo que intentaste.

REGLAS DURAS:
- READ-ONLY sobre Steelhead: solo NAVEGA y captura ops (lecturas). NUNCA confirmes
  una escritura (Guardar/Save/Submit/Confirm). Para ops de modal, abre el modal y NO guardes.
- NUNCA edites remote/config.json. El deploy de hashes lo hace hash-autopilot.mjs.
- Presupuesto: máximo ~15 acciones de browser POR op. Si lo agotas, escala.
- Registra CADA acción intentada en el trace (ver formato abajo), éxito o fracaso.

PASOS:
1. Lee tools/.hash-autopilot/needs-attention.json. Si no existe → termina sin gastar.
2. Para cada op:
   a. Usa steps (la receta vieja) como punto de partida. Abre Chromium headless con
      el ROCP inyectado reusando la infra de tools/hash-autopilot/ (recipe-runner +
      installInterceptor) — mira cómo lo hace hash-autopilot.mjs (makeRocpInit, sink).
   b. Instala el interceptor de /graphql. Prueba una secuencia; observa si la op
      objetivo se disparó. Si no, varía UN paso (nuevo selector, texto de botón
      bilingüe ES+EN, un clic intermedio) y reintenta. Toma screenshot en cada paso.
   c. Registra cada intento en el trace: { op, step, action, target, selectorTried,
      observed, opFired, screenshot }.
3. Si HALLAS la secuencia que dispara la op:
   - Actualiza tools/hash-autopilot/route-catalog.json (o click-recipes.json) con los
     steps nuevos.
   - Corre tools/run-tests.sh. Si falla, revierte la receta y escala.
   - Corre `node tools/hash-autopilot/hash-autopilot.mjs --only=<op>` (SIN --dry-run)
     para que capture+deploye con SUS salvaguardas.
4. Escribe el trace a tools/.hash-autopilot/escalation-trace-<fecha>.json y un resumen.
5. Manda UN correo con tools/hash-autopilot/autopilot-notify.sh:
   - exito "Nivel B: <n> receta(s) reparada(s)" <resumen del trace + diff>
   - fallo "Nivel B: no pude reparar <ops>" <trace detallado + diagnóstico>
6. Borra needs-attention.json solo cuando toda op quedó reparada o escalada.

FORMATO DEL TRACE (usa escalation-trace.mjs: newTrace/addAction/summarizeForEmail):
cada acción = { op, step, action, target, selectorTried, observed, opFired, screenshot }.
El resumen del correo DEBE mostrar, por op, la lista de acciones que intentaste con su
resultado — es lo que el operador usa para mejorar el sistema.
```

- [ ] **Step 2: Commit**

```bash
git add tools/hash-autopilot/escalation-prompt.md
git commit -m "feat(escalation): prompt de re-descubrimiento Nivel B (read-only + trace obligatorio)"
```

---

### Task 4: Wrapper `run-escalation.sh` (gate + ROCP + claude -p)

**Files:**
- Create: `tools/run-escalation.sh`
- Test: `tools/test/escalation-gate.test.js` (la lógica de gate como función pura)

**Interfaces:**
- Produces: `shouldRunEscalation(needsAttentionExists, alreadyTriedToday) → boolean` en `escalation-trace.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// tools/test/escalation-gate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunEscalation } = require('../hash-autopilot/escalation-trace.mjs');

test('gate: sin needs-attention → NO corre', () => {
  assert.equal(shouldRunEscalation(false, false), false);
});
test('gate: con needs-attention y no intentado hoy → corre', () => {
  assert.equal(shouldRunEscalation(true, false), true);
});
test('gate: con needs-attention pero ya intentado hoy → NO corre (idempotente)', () => {
  assert.equal(shouldRunEscalation(true, true), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test/escalation-gate.test.js`
Expected: FAIL ("shouldRunEscalation is not a function").

- [ ] **Step 3: Add `shouldRunEscalation` to `escalation-trace.mjs`**

```js
// Gate del cron de escalación: corre solo si hay señal Y no se intentó hoy
// (idempotencia — el marcador de "intentado hoy" lo pone el wrapper tras correr).
export function shouldRunEscalation(needsAttentionExists, alreadyTriedToday) {
  return !!needsAttentionExists && !alreadyTriedToday;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test/escalation-gate.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the wrapper `run-escalation.sh`**

```bash
#!/usr/bin/env bash
# Wrapper del Nivel B (escalación de recetas rotas). Lo invoca el launchd a :53.
# Gate por needs-attention.json + marcador idempotente diario; refresca ROCP; corre
# claude -p con el prompt de re-descubrimiento. Cero costo en días limpios.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${REPO_ROOT:=$(cd "$SCRIPT_DIR/.." && pwd)}"
: "${PYTHON:=/usr/bin/python3}"
: "${REPORTES_SH:=/Users/oviazcan/Projects/Ecoplating/Reportes SH}"
STATE_DIR="$REPO_ROOT/tools/.hash-autopilot"
NEEDS="$STATE_DIR/needs-attention.json"
TODAY="$(date '+%F')"
TRIED_MARK="$STATE_DIR/escalation-tried-$TODAY"
PROMPT="$REPO_ROOT/tools/hash-autopilot/escalation-prompt.md"

# Gate: sin señal → salir en silencio. Ya intentado hoy → salir (idempotente).
[ -f "$NEEDS" ] || { echo "$(date '+%F %T') sin needs-attention → nada que hacer"; exit 0; }
[ -f "$TRIED_MARK" ] && { echo "$(date '+%F %T') ya intenté hoy → skip"; exit 0; }

# Refrescar ROCP (fail-ruidoso: sin auth, no abrir navegador).
if ! ( cd "$REPORTES_SH" && "$PYTHON" -c "import sys; sys.path.insert(0,'scripts'); from steelhead_auth import get_access_token; get_access_token(force_refresh=True)" >/dev/null 2>&1 ); then
  echo "$(date '+%F %T') FATAL: refresh ROCP falló — no corro escalación" >&2
  "$REPO_ROOT/tools/hash-autopilot/autopilot-notify.sh" fallo "Nivel B: auth caída" "El refresh ROCP falló; la escalación no corrió. Corre steelhead_auth.py." 2>/dev/null || true
  exit 2
fi

touch "$TRIED_MARK"   # marca idempotente ANTES de correr (evita loop si claude cuelga)
cd "$REPO_ROOT"
claude -p "$(cat "$PROMPT")" --dangerously-skip-permissions 2>&1 | tee "$STATE_DIR/escalation-last.log"
```

- [ ] **Step 6: Make executable + smoke-test the gate (no claude)**

```bash
chmod +x tools/run-escalation.sh
# sin needs-attention → debe salir 0 sin correr claude:
rm -f tools/.hash-autopilot/needs-attention.json tools/.hash-autopilot/escalation-tried-$(date +%F)
tools/run-escalation.sh; echo "exit=$?"
```
Expected: imprime "sin needs-attention → nada que hacer", `exit=0`, y NO invoca claude.

- [ ] **Step 7: Commit**

```bash
git add tools/run-escalation.sh tools/hash-autopilot/escalation-trace.mjs tools/test/escalation-gate.test.js
git commit -m "feat(escalation): wrapper run-escalation.sh (gate idempotente + ROCP + claude -p)"
```

---

### Task 5: launchd plist (`com.ecoplating.steelhead-escalation.plist`)

**Files:**
- Create: `tools/launchd/com.ecoplating.steelhead-escalation.plist`

**Interfaces:** config del sistema; se valida con `plutil -lint` y se carga con `launchctl`.

- [ ] **Step 1: Write the plist (a :53, no RunAtLoad, Background)**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ecoplating.steelhead-escalation</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/run-escalation.sh</string>
    </array>
    <!-- A :53, 30 min después del motor (:23), para que el needs-attention del ciclo
         ya esté escrito. Gate por needs-attention.json → casi siempre sale en <1s. -->
    <key>StartCalendarInterval</key>
    <dict><key>Minute</key><integer>53</integer></dict>
    <key>WorkingDirectory</key>
    <string>/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator</string>
    <key>StandardOutPath</key>
    <string>/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-autopilot/escalation.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/tools/.hash-autopilot/escalation.err.log</string>
    <key>RunAtLoad</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
```

- [ ] **Step 2: Validate**

Run: `plutil -lint tools/launchd/com.ecoplating.steelhead-escalation.plist`
Expected: "OK".

- [ ] **Step 3: Commit (NO cargar aún — la carga es paso manual del operador tras la prueba supervisada)**

```bash
git add tools/launchd/com.ecoplating.steelhead-escalation.plist
git commit -m "feat(escalation): launchd plist del Nivel B (a :53, gate por needs-attention)"
```

---

### Task 6: Documentar + prueba supervisada

**Files:**
- Modify: `tools/hash-autopilot/ESCALATION.md`
- Modify: `tools/hash-autopilot/README.md` (sección Agendado: mencionar el 2º launchd)

- [ ] **Step 1: Actualizar ESCALATION.md** — reemplazar la sección "Crear el cron" para reflejar el mecanismo real (launchd + run-escalation.sh, NO CronCreate) y documentar el formato del trace y el flujo por capas. Referir al spec `docs/superpowers/specs/2026-07-17-nivel-b-escalacion-design.md`.

- [ ] **Step 2: Prueba supervisada (con un needs-attention de prueba)** — fabricar un `needs-attention.json` de prueba con una op cuya receta SIGA funcionando (p.ej. una query de lista simple) y correr `tools/run-escalation.sh` a mano en una sesión supervisada; verificar que: (a) el gate deja pasar, (b) claude re-descubre/confirma la receta, (c) el trace se escribe con las acciones, (d) el correo llega con el resumen del trace, (e) el marcador idempotente evita el segundo run. Borrar el needs-attention de prueba al terminar.

- [ ] **Step 3: Commit docs**

```bash
git add tools/hash-autopilot/ESCALATION.md tools/hash-autopilot/README.md
git commit -m "docs(escalation): Nivel B — mecanismo launchd real + formato del trace + flujo por capas"
```

- [ ] **Step 4: Cargar el launchd (paso MANUAL del operador, tras la prueba supervisada verde)**

```bash
cp tools/launchd/com.ecoplating.steelhead-escalation.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ecoplating.steelhead-escalation.plist
launchctl list | grep escalation
```

---

## Self-Review

**Spec coverage:**
- §3 mecanismo launchd local :53 → Task 5. ✓
- §4 flujo del agente → Task 3 (prompt) + Task 4 (wrapper gate/ROCP). ✓
- §5 re-descubrimiento Playwright → Task 3 (prompt referencia la infra del motor). ✓
- §6 TRACE detallado → Task 1 (módulo) + Task 3 (prompt lo exige). ✓
- §7 guardrails (solo recetas, tests, idempotente, read-only, auth) → Task 3 (reglas) + Task 4 (gate idempotente + ROCP). ✓
- §8 componentes → Tasks 1-6 cubren todos. ✓

**Placeholder scan:** sin TBD/TODO; todo el código y XML está completo. Task 6 Step 1/2 son acciones de edición/validación descritas con su objetivo concreto (docs + prueba supervisada), no código.

**Type consistency:** `action` shape idéntico en Task 1 (test + impl), Task 3 (prompt) y el uso de `newTrace/addAction/summarizeForEmail/shouldRunEscalation/outcomeByOp` coincide entre `escalation-trace.mjs` y sus tests.

## Notas de ejecución

- El re-descubrimiento real (Task 3, ejecutado por `claude -p`) es la parte frágil por diseño; la prueba supervisada (Task 6 Step 2) usa una op cuya receta funciona para validar el ARNÉS (gate → trace → correo → idempotencia) sin depender de que el re-descubrimiento acierte.
- Carga del launchd = paso manual del operador (Task 6 Step 4), nunca automático.
