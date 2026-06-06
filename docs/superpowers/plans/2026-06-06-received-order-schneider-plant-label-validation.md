# Validación de etiqueta de planta Schneider vs ship-to — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el hook `getReceivedOrderCustomization` (Power Tool `received-order`) marque en rojo cuando un NP de una OV Schneider no trae la etiqueta de su planta (SXX) o la etiqueta no coincide con la planta de la dirección de entrega de la OV.

**Architecture:** La lógica pura (mapa planta→substrings, resolución desde el ship-to, veredicto de etiqueta) vive en un módulo node canónico **testeado con TDD** (`tools/lib/schneider-plants.js`). El hook `.ts` **transcribe** esa lógica inline (no puede importar) y la conecta a los chips `helpers.addErrorMessage`. La verificación end-to-end del `.ts` es manual en el Test panel de Steelhead (los Power Tools no son node-testables).

**Tech Stack:** JavaScript vanilla (CommonJS para el módulo/test), `node:test` + `node:assert/strict`, TypeScript low-code (target legacy ES2017 — sin `??=`, `?.`/`??` sí son válidos) para el hook.

**Spec:** `docs/superpowers/specs/2026-06-06-received-order-schneider-plant-label-validation-design.md`

---

## File Structure

- **Create** `tools/lib/schneider-plants.js` — módulo canónico (datos + `resolvePlant` + `plantLabelVerdict`). Fuente de verdad. Sin dependencias, sin DOM.
- **Create** `tools/test/received-order-plant.test.js` — tabla de verdad sobre el módulo (`node --test`).
- **Modify** `powertools/synced/received-order/received-order.ts` — transcribe constantes + lógica al hook y emite chips/suprime el verde.
- **Modify** `docs/applets/powertools-ordendeventa.md` — entrada de bitácora.

> Nota: cambiar el `.ts` NO toca `remote/config.json` ni `gh-pages`. El deploy del Power Tool = pegar el `.ts` en el editor low-code de Steelhead.

---

## Task 1: Módulo canónico de plantas (lógica pura, TDD)

**Files:**
- Test: `tools/test/received-order-plant.test.js`
- Create: `tools/lib/schneider-plants.js`

- [ ] **Step 1: Escribir el test que falla**

Crear `tools/test/received-order-plant.test.js`:

```js
// tools/test/received-order-plant.test.js
// Tabla de verdad de la resolución de planta Schneider desde shipToAddress y del
// veredicto de etiqueta de planta del NP. Fuente de verdad: tools/lib/schneider-plants.js
// (el hook powertools/synced/received-order/received-order.ts transcribe esta lógica).

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHNEIDER_PLANTS, resolvePlant, plantLabelVerdict } = require('../lib/schneider-plants');

// Direcciones reales de Steelhead (capturas 2026-06-06), tal cual el shipToAddress.address.
const REAL = {
  STX: 'Vía Corta Santa Ana Puebla Km 17.5, Acuamanala de Miguel Hidalgo, Tlaxcala,, Tlaxcala, 90860, México',
  SXC: 'FWPR+J7, Tercera Sección Ocotitla, José María Morelos y Pavón,, Tlaxcala, 90434, México',
  SMY: 'Blvd. Escobedo 317, Ciudad Apodaca,, Nuevo León, 66627, México',
  SQ1: 'Vesta Industrial Park Querétaro, Av. Vesta 23 y 25 Edificio VPQ07, Colón,, Querétaro, 76294, México',
  SQ2: 'Carretera Estatal 100 4200 Lote 56, Parque Industrial Aeropuerto, Querétaro,, Querétaro, 76295, México',
  SCM: 'Michoacán 20, Complejo Industrial Tecnológico, Iztapalapa,, CDMX, 09208, México',
  SRG: 'Javier Rojo Gómez 1121-A, Guadalupe del Moral, Iztapalapa,, CDMX, 09300, México',
};
// Direcciones fiscales/billing que NO son plantas de entrega (no deben resolver).
const TRAPS = [
  '5914 San Bernardo, Suite 4-960, Laredo,, Texas, 78041, USA',
  '1415 S. Roselle Road, Palatine,, Illinois, 60067, México',
];

test('resolvePlant: cada dirección real resuelve a su planta', () => {
  for (const code of Object.keys(REAL)) {
    const p = resolvePlant(REAL[code]);
    assert.ok(p, `${code}: no resolvió`);
    assert.equal(p.code, code, `${code}: resolvió a ${p && p.code}`);
  }
});

test('resolvePlant: sin colisiones — cada dirección real matchea exactamente 1 planta', () => {
  for (const code of Object.keys(REAL)) {
    const addr = REAL[code].toLowerCase();
    const matches = SCHNEIDER_PLANTS.filter((p) => p.needles.some((n) => addr.includes(n)));
    assert.equal(matches.length, 1, `${code}: matchea ${matches.map((m) => m.code).join(',')}`);
  }
});

test('resolvePlant: direcciones trampa (fiscales) → null', () => {
  for (const t of TRAPS) assert.equal(resolvePlant(t), null, `trampa resolvió: ${t}`);
});

test('resolvePlant: vacío/null/undefined → null', () => {
  assert.equal(resolvePlant(''), null);
  assert.equal(resolvePlant(null), null);
  assert.equal(resolvePlant(undefined), null);
});

test('plantLabelVerdict: ok cuando trae la planta esperada', () => {
  const r = plantLabelVerdict(['NIQ', 'STX'], 'STX');
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.plantLabels, ['STX']);
});

test('plantLabelVerdict: missing cuando no trae ninguna etiqueta de planta', () => {
  const r = plantLabelVerdict(['NIQ', 'EST'], 'STX');
  assert.equal(r.verdict, 'missing');
  assert.deepEqual(r.plantLabels, []);
});

test('plantLabelVerdict: mismatch cuando trae otra planta', () => {
  const r = plantLabelVerdict(['NIQ', 'SMY'], 'STX');
  assert.equal(r.verdict, 'mismatch');
  assert.deepEqual(r.plantLabels, ['SMY']);
});

test('plantLabelVerdict: multi-planta pasa si la esperada está entre ellas', () => {
  assert.equal(plantLabelVerdict(['STX', 'SMY'], 'SMY').verdict, 'ok');
});

test('plantLabelVerdict: labels null/undefined → missing', () => {
  assert.equal(plantLabelVerdict(null, 'STX').verdict, 'missing');
  assert.equal(plantLabelVerdict(undefined, 'STX').verdict, 'missing');
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `node --test tools/test/received-order-plant.test.js`
Expected: FAIL — `Cannot find module '../lib/schneider-plants'`.

- [ ] **Step 3: Implementar el módulo mínimo**

Crear `tools/lib/schneider-plants.js`:

```js
// tools/lib/schneider-plants.js
// Fuente de verdad de la validación de etiqueta de planta Schneider vs ship-to.
// El hook Power Tool powertools/synced/received-order/received-order.ts transcribe
// esta lógica inline (no puede importar). Si cambias datos/lógica aquí, espéjalo en el .ts.
// Probado en tools/test/received-order-plant.test.js.
// SQR fue renombrada a SQ1 por el equipo (no usar alias SQR).

const SCHNEIDER_PLANTS = [
  { code: 'STX', name: 'Tlaxcala',     needles: ['acuamanala', 'santa ana', '90860'] },
  { code: 'SXC', name: 'Xicohténcatl', needles: ['ocotitla', '90434'] },
  { code: 'SMY', name: 'Monterrey',    needles: ['apodaca', 'escobedo 317', '66627'] },
  { code: 'SQ1', name: 'Querétaro 1',  needles: ['vesta', 'vpq07', '76294'] },
  { code: 'SQ2', name: 'Querétaro 2',  needles: ['parque industrial aeropuerto', 'lote 56', '76295'] },
  { code: 'SCM', name: 'CDMX',         needles: ['michoacán 20', 'michoacan 20', 'complejo industrial tecnológico', '09208'] },
  { code: 'SRG', name: 'Rojo Gómez',   needles: ['rojo gómez', 'rojo gomez', '09300'] },
];

const SCHNEIDER_PLANT_CODES = new Set(SCHNEIDER_PLANTS.map((p) => p.code));

// Resuelve la planta Schneider desde la dirección de entrega. null si no matchea.
function resolvePlant(shipToAddress) {
  const addr = String(shipToAddress || '').toLowerCase();
  if (!addr) return null;
  return SCHNEIDER_PLANTS.find((p) => p.needles.some((n) => addr.includes(n))) || null;
}

// Veredicto de las etiquetas de un NP vs el código de planta esperado:
// 'ok' (trae la esperada) | 'missing' (no trae ninguna etiqueta de planta) |
// 'mismatch' (trae etiqueta(s) de planta pero no la esperada).
function plantLabelVerdict(partLabelNames, expectedCode) {
  const plantLabels = (partLabelNames || []).filter((n) => SCHNEIDER_PLANT_CODES.has(n));
  if (plantLabels.length === 0) return { verdict: 'missing', plantLabels };
  if (plantLabels.indexOf(expectedCode) !== -1) return { verdict: 'ok', plantLabels };
  return { verdict: 'mismatch', plantLabels };
}

module.exports = { SCHNEIDER_PLANTS, SCHNEIDER_PLANT_CODES, resolvePlant, plantLabelVerdict };
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `node --test tools/test/received-order-plant.test.js`
Expected: PASS — 9 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tools/lib/schneider-plants.js tools/test/received-order-plant.test.js
git commit -m "feat(received-order): módulo canónico + tests de planta Schneider vs ship-to"
```

---

## Task 2: Transcribir la validación al hook `received-order.ts`

**Files:**
- Modify: `powertools/synced/received-order/received-order.ts`

Aplicar 6 ediciones por anclas de texto exacto (los números de línea cambian al editar; usa el `anchor`).

- [ ] **Step 1: Constantes de plantas**

Anchor (existe en el archivo):
```ts
  const LOTE_UNIT_ID = 5348;
  const LOTE_LABEL_NAME = "Lote";
```
Insertar JUSTO DESPUÉS:
```ts

  // ── Plantas Schneider: código de etiqueta SXX → substrings que la identifican
  // dentro de shipToAddress.address (lowercased). Fuente de verdad/lógica:
  // tools/lib/schneider-plants.js (probado en tools/test/received-order-plant.test.js).
  // Esto es transcripción para el runtime low-code. SQR fue renombrada a SQ1 (sin alias).
  const SCHNEIDER_PLANTS: { code: string; name: string; needles: string[] }[] = [
    { code: "STX", name: "Tlaxcala", needles: ["acuamanala", "santa ana", "90860"] },
    { code: "SXC", name: "Xicohténcatl", needles: ["ocotitla", "90434"] },
    { code: "SMY", name: "Monterrey", needles: ["apodaca", "escobedo 317", "66627"] },
    { code: "SQ1", name: "Querétaro 1", needles: ["vesta", "vpq07", "76294"] },
    { code: "SQ2", name: "Querétaro 2", needles: ["parque industrial aeropuerto", "lote 56", "76295"] },
    { code: "SCM", name: "CDMX", needles: ["michoacán 20", "michoacan 20", "complejo industrial tecnológico", "09208"] },
    { code: "SRG", name: "Rojo Gómez", needles: ["rojo gómez", "rojo gomez", "09300"] },
  ];
  const SCHNEIDER_PLANT_CODES = new Set(SCHNEIDER_PLANTS.map((p) => p.code));
```

- [ ] **Step 2: Resolver la planta de la OV**

Anchor (existe):
```ts
  const isSchneiderJavierRojo =
    customerName.includes("schneider") &&
    customerName.includes("mexico") &&
    shipToAddr.includes("javier rojo");
```
Insertar JUSTO DESPUÉS:
```ts

  // Planta esperada de la OV (solo aplica a clientes Schneider). `shipToAddr` ya
  // viene lowercased. `expectedPlant` null si no resuelve → se reporta como error.
  const isSchneider = customerName.includes("schneider");
  const expectedPlant = isSchneider
    ? SCHNEIDER_PLANTS.find((p) => p.needles.some((n) => shipToAddr.includes(n))) ?? null
    : null;
  const shipToPlantUnresolved = isSchneider && expectedPlant == null;
```

- [ ] **Step 3: Buffers nuevos**

Anchor (existe, última línea del bloque de buffers):
```ts
  const infoChips: string[] = [];
```
Insertar JUSTO DESPUÉS:
```ts
  // Etiqueta de planta Schneider vs ship-to (dedup por partNumber.id).
  const plantCheckedSet = new Set<number>();
  const plantMissingChips: string[] = [];
  const plantMismatchChips: string[] = [];
```

- [ ] **Step 4: Chequeo por NP dentro del loop de rows**

Anchor (existe, inicio del bloque Info):
```ts
    // ── Info: nombre del Spec + rango de Espesor ──
```
Insertar JUSTO ANTES de esa línea:
```ts
    // ── Etiqueta de planta Schneider vs ship-to ──
    // Cada NP de una OV Schneider debe traer la etiqueta de su planta (SXX) y debe
    // coincidir con expectedPlant. Pasa si alguna etiqueta de planta del NP == esperada
    // (cubre NPs multi-planta). partNumberLabels es de solo lectura (input del runtime).
    if (isSchneider && expectedPlant && !plantCheckedSet.has(partNumber.id)) {
      plantCheckedSet.add(partNumber.id);
      const plantLabels = (partNumber.partNumberLabels ?? [])
        .map((l) => l?.name)
        .filter((n): n is string => !!n && SCHNEIDER_PLANT_CODES.has(n));
      if (plantLabels.length === 0) {
        plantMissingChips.push(`'${partNumber.name}'`);
      } else if (plantLabels.indexOf(expectedPlant.code) === -1) {
        plantMismatchChips.push(`'${partNumber.name}' [${plantLabels.join("/")}]`);
      }
    }

```

- [ ] **Step 5: Emisión de los chips de planta (error rojo)**

Anchor (existe, bloque de emisión de NP Desconocido):
```ts
  if (errorChips.length > 0) {
    helpers.addErrorMessage({
      severity: "error",
      message: `NP Desconocido — ${errorChips.join(" · ")}. Cancela esta OV, etiqueta cada NP con 'NP Desconocido' y avisa a Ingeniería.`,
    });
  }
```
Insertar JUSTO DESPUÉS:
```ts
  // ── Etiqueta de planta Schneider (error rojo, su propia row) ──
  if (shipToPlantUnresolved) {
    const addr = inputs.receivedOrder?.shipToAddress?.address ?? "(sin dirección)";
    helpers.addErrorMessage({
      severity: "error",
      message: `Planta Schneider no identificada — el ship-to «${addr}» no corresponde a ninguna de las 7 plantas (STX/SXC/SMY/SQ1/SQ2/SCM/SRG). Corrige la dirección de entrega de la OV; no validé etiquetas de planta.`,
    });
  } else if (plantMissingChips.length > 0 || plantMismatchChips.length > 0) {
    const partes: string[] = [];
    if (plantMissingChips.length > 0) {
      partes.push(`Sin etiqueta de planta: ${plantMissingChips.join(", ")}`);
    }
    if (plantMismatchChips.length > 0) {
      partes.push(`Etiqueta equivocada: ${plantMismatchChips.join(", ")}`);
    }
    helpers.addErrorMessage({
      severity: "error",
      message: `Etiqueta de planta ≠ ship-to (${expectedPlant!.code} ${expectedPlant!.name}) — ${partes.join(". ")}. No agregues estos NP a la OV/OT hasta corregir su etiqueta de planta SXX.`,
    });
  }
```

- [ ] **Step 6: Suprimir el "Todo en Orden" verde cuando hay error de planta**

Anchor (existe, guarda del chip verde):
```ts
  if (
    errorChips.length === 0 &&
    sinPrecioChips.length === 0 &&
    schneiderChips.length === 0
  ) {
```
Reemplazar por:
```ts
  if (
    errorChips.length === 0 &&
    sinPrecioChips.length === 0 &&
    schneiderChips.length === 0 &&
    plantMissingChips.length === 0 &&
    plantMismatchChips.length === 0 &&
    !shipToPlantUnresolved
  ) {
```

- [ ] **Step 7: Auto-revisión de gotchas del runtime low-code**

Releer el diff y confirmar:
- No se introdujo `??=` ni features ES2021+ (solo `??` y `?.`, que el archivo ya usa).
- Las 6 keys de `result` siguen intactas (no se tocó el `return result`).
- `expectedPlant!` solo se usa en la rama `else if` (donde `shipToPlantUnresolved` es false ⇒ es no-null).

Run (sanity de que el archivo sigue siendo parseable como TS/JS — no hay build en el repo, así que solo chequeo sintáctico best-effort):
```bash
node --check <(npx --yes esbuild powertools/synced/received-order/received-order.ts --loader=ts 2>/dev/null) 2>/dev/null && echo "sintaxis OK" || echo "revisar a mano en Steelhead Test panel"
```
Expected: idealmente "sintaxis OK"; si `esbuild` no está disponible, la verificación real es el Test panel (Task 3). No bloquea.

- [ ] **Step 8: Commit**

```bash
git add powertools/synced/received-order/received-order.ts
git commit -m "feat(received-order): valida etiqueta de planta Schneider vs ship-to (error rojo)"
```

---

## Task 3: Verificación end-to-end en Steelhead (manual — gate real)

**Files:** ninguno (operación en el editor low-code de Steelhead).

> Los Power Tools no son node-testables; esta es la verificación real. La conduce el usuario (acceso a Steelhead).

- [ ] **Step 1: Phase-0 — confirmar que `partNumberLabels` es legible**

En el Power Tool `received-order` de Steelhead, pegar **temporalmente** este snippet de debug al inicio del loop de rows (justo después de `if (!partNumber) continue;`):

```ts
    helpers.addErrorMessage({
      severity: "info",
      message: `DEBUG labels '${partNumber.name}': ${JSON.stringify((partNumber.partNumberLabels ?? []).map((l) => l?.name))}`,
    });
```

Correr el Test panel con una OV Schneider que tenga ≥1 NP con etiqueta de planta conocida.
Expected: el chip info muestra los nombres de etiqueta (p. ej. `["NIQ","STX"]`).

**Gate:** si `partNumberLabels` viene `[]`/ausente para NPs que SÍ tienen etiqueta de planta en su ficha → este hook NO es el vehículo. PARAR y replanear (mover la validación a un applet de extensión con GraphQL). Si trae las etiquetas → quitar el snippet de debug y continuar.

- [ ] **Step 2: Pegar el hook final y probar casos**

Pegar el contenido completo de `powertools/synced/received-order/received-order.ts` (ya con la validación, sin el debug) en el editor.

Probar 4 escenarios en el Test panel / operación real:
1. **OK:** OV que entrega en Tlaxcala (ship-to "Vía Corta Santa Ana… 90860") + NP con etiqueta `STX` → chip verde "Todo en Orden" (si no hay otros bloqueantes).
2. **Mismatch:** misma OV Tlaxcala + NP con etiqueta `SMY` → chip rojo "Etiqueta de planta ≠ ship-to (STX Tlaxcala) — Etiqueta equivocada: 'NP' [SMY]…".
3. **Missing:** misma OV Tlaxcala + NP sin etiqueta de planta → chip rojo "…Sin etiqueta de planta: 'NP'…".
4. **Ship-to no resuelto:** OV Schneider cuyo ship-to sea una dirección fiscal (Laredo/Roselle) → chip rojo "Planta Schneider no identificada…".

Expected: cada escenario produce exactamente el chip descrito; una OV no-Schneider no dispara nada de planta.

- [ ] **Step 3: Confirmar no-regresión de validaciones existentes**

En las mismas pruebas, confirmar que NP Desconocido, Sin precio default, Lote mínimo, Spec (info) y el verde "Todo en Orden" siguen comportándose como antes (la nueva lógica solo agrega; no toca esos paths).

---

## Task 4: Bitácora

**Files:**
- Modify: `docs/applets/powertools-ordendeventa.md`

- [ ] **Step 1: Agregar entrada de bitácora**

Agregar al final de `docs/applets/powertools-ordendeventa.md`:

```markdown

## Validación de etiqueta de planta Schneider vs ship-to (2026-06-06)

Cada NP de una OV Schneider (`customerName.includes("schneider")`, cubre razón social MEXICO y USA INC) debe traer la etiqueta de su planta (`SXX`) y coincidir con la planta del `shipToAddress`. Si no → chip rojo (`severity:'error'`), patrón advisory igual a "NP Desconocido" (no bloquea el Save por API; guía al operador a no agregar el NP).

- **Resolución de planta** desde `shipToAddress.address` por substrings discriminantes (no por dirección completa, que cambia). Mapa código→substrings y lógica en `tools/lib/schneider-plants.js` (canónico, probado en `tools/test/received-order-plant.test.js`); el hook lo **transcribe** inline (los Power Tools no importan).
- **7 plantas:** STX (acuamanala/90860), SXC (ocotitla/90434), SMY (apodaca/66627), SQ1 (vesta/76294), SQ2 (aeropuerto/lote 56/76295), SCM (michoacán 20/09208), SRG (rojo gómez/09300). `SQR` renombrada a `SQ1` por el equipo — sin alias.
- **2 direcciones trampa** (fiscales Laredo/Roselle Illinois) no resuelven a planta → caen en error "ship-to no identificado" (correcto, no son plantas de entrega).
- **Veredicto por NP:** lee `partNumber.partNumberLabels[].name` (solo lectura); `missing` (sin etiqueta SXX) / `mismatch` (otra planta) / `ok` (multi-planta pasa si la esperada está entre sus etiquetas). Dedup por `partNumber.id`.
- **Severidades (decisión usuario):** missing, mismatch y ship-to-no-resoluble = error rojo. Los 3 buckets nuevos suprimen el "Todo en Orden" verde.
- **Phase-0 (rellenar tras verificar):** confirmar en el Test panel que `partNumber.partNumberLabels` se puebla como input en "Add Parts to Sales Order". Si viniera vacío, mover la validación a un applet de extensión con GraphQL.
```

- [ ] **Step 2: Commit**

```bash
git add docs/applets/powertools-ordendeventa.md
git commit -m "docs(received-order): bitácora validación de planta Schneider vs ship-to"
```

---

## Pendientes fuera de este plan (no bloquean)

- **Sweep `SQR`→`SQ1`** (config.json + tests + docs) ya aplicado en el working tree; falta **bump de `config.json` version + deploy a `gh-pages`** y commit. Coordinar (hot-file, una sesión deploya a la vez).
- **Test stale pre-existente** `bulk-upload-helpers.test.js:56` (`isNonFinishLabel('smy')` espera case-sensitive pero la impl es case-insensitive a propósito). Decidir si se actualiza el test o la impl.
- **One-off NPs** (`isOneOffPartNumber`): hoy también se validan; si genera ruido, eximirlos (cambio de una línea en el `if` del Step 4 de Task 2).
```
