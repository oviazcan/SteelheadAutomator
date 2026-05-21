# Delete Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir un applet defensivo cross-plataforma (extensión MV3 desktop + userscript Safari iPad) que evite deletes accidentales en Steelhead, escondiendo elementos UI de borrado e interceptando mutations GraphQL destructivas.

**Architecture:** Defensa en dos capas dentro de un solo archivo JS.
- **Capa A (UI):** `MutationObserver` esconde / deshabilita botones de Delete que matcheen los selectores configurados.
- **Capa B (red):** monkey-patch a `window.fetch` intercepta `POST /graphql` y bloquea las `operationName` configuradas como destructivas.

El mismo archivo fuente corre como applet remoto cargado por la extensión (el header `// ==UserScript==` es comentario inocuo para `new Function(c)()` de `background.js:66`) y como userscript en Safari iPad vía la app **Userscripts** (gratis, open source). Gating por allowlist de user id leída de `config.json` y resuelta vía `CurrentUserDetails` (la op viva que reemplaza al deprecado `CurrentUser`, ver lección en CLAUDE.md de `paros-linea`).

**Tech Stack:** JS vanilla (browser APIs), `MutationObserver`, parche a `window.fetch`, GraphQL Apollo Persisted Queries (Apollo client `4.0.8`), `remote/config.json` para allowlist + selectores + lista de mutations. Distribución desktop: extensión MV3 + remote loader vía gh-pages. Distribución iPad: app Userscripts en Safari (instalación manual por dispositivo en el PoC).

**Phasing:** Este plan cubre **solo el PoC (Phase 1)** — una mutation, un selector de botón, un usuario en allowlist, modo `block`. Las Phases 2-6 (generalización, modo confirm, logging de auditoría, build automatizado del `.user.js`, fallback server-side) quedan listadas como "Out of Scope" al final.

**Pre-requisito explícito:** la Task 1 es de descubrimiento puro (capturar operationName, hash, DOM real). Per CLAUDE.md ("ANTES de empezar a escribir selectores o autollenadores DOM, pídele al usuario el wrapper HTML completo" + "Captura el request del UI antes de adivinar shapes"), nada de código antes de tener esa captura. Ciclos de fix a ciegas tipo `process-canon` 0.5.52-55 o `invoice-autofill` 0.5.16-25 nacen exactamente de saltarse esto.

---

## File Structure

**Crear:**
- `remote/scripts/delete-guard.js` — body del applet, con header `// ==UserScript==` arriba (comentario para el extension loader, header efectivo para Safari Userscripts).
- `docs/superpowers/specs/2026-05-07-delete-guard-design.md` — captura concreta de Task 1 (operationName, hash, variablesShape, DOM wrappers, `CurrentUserDetails` shape, ids elegidos).
- `docs/delete-guard/ipad-onboarding.md` — guía 1-página que el equipo de ops manda a usuarios iPad para instalar el userscript.

**Modificar:**
- `remote/config.json` — agregar bloque `deleteGuard` (mode, allowlistUserIds, blockedOperations, hiddenSelectors, logBlocks) y bumpear `version` + `lastUpdated` en cada deploy.
- `extension/background.js` — registrar `delete-guard` en el applet loader (en el patrón que usen los demás applets; verificar antes de tocar).
- `CLAUDE.md` — append de la sección de lecciones del ciclo del PoC.

**No tocar:**
- `extension/manifest.json` — los `host_permissions` actuales ya cubren `app.gosteelhead.com`. No agregar CSP en este PoC (item separado del audit).

---

## Discovery Tasks (deben correr primero)

Todo el resto del plan depende de saber, con captura real (no adivinada):

1. `operationName` exacta de la mutation que dispara el botón Delete.
2. Selector(es) DOM del botón Delete (con su wrapper HTML completo, no solo el botón).
3. Hash SHA-256 de la persisted query (para reproducir el bloqueo desde consola en pruebas manuales).
4. Shape actual de `CurrentUserDetails` y user id(s) que deben ir en allowlist.
5. Cómo registran los demás applets su carga en `extension/background.js` (o equivalente).

Si cualquiera de estas cinco no está capturada, **detener el plan** y volver a Task 1. No improvisar.

---

### Task 1: Discovery — captura mutation + DOM + user shape

**Files:**
- Create: `docs/superpowers/specs/2026-05-07-delete-guard-design.md`

- [ ] **Step 1: Decidir con el usuario qué Delete proteger en el PoC**

Abrir Steelhead en Chrome desktop. Acordar con el usuario cuál botón Delete es el target del PoC (candidatos típicos: Delete Received Order, Delete Invoice, Delete Sensor Dashboard, Void Invoice). Documentar el caso de uso: en qué pantalla aparece, quién hace clic, qué destruye.

Append al design doc:

```markdown
## Caso de uso PoC
- Pantalla: <URL pattern>
- Acción: <Delete X>
- Quién la dispara: <rol/usuario>
- Qué destruye: <entidad>
- Por qué nos preocupa: <accidente común>
```

- [ ] **Step 2: Capturar la mutation GraphQL**

DevTools → Network → filter `/graphql`. Hacer clic en Delete (confirmar dialog si lo hay). En el body del POST resultante, copiar:
- `operationName` (ej. `DeleteReceivedOrder`)
- `variables` completo (ej. `{ id: "..." }` o `{ input: {...} }`)
- `extensions.persistedQuery.sha256Hash`

Append al design doc:

```markdown
## Mutation
- operationName: <name>
- variablesShape: <JSON pegado>
- hash: <sha256>
- response esperado (success): <JSON pegado>
```

- [ ] **Step 3: Capturar el wrapper DOM del botón Delete**

DevTools → Elements, click derecho en el botón → Copy → Copy outerHTML. Después subir al **wrapper semántico** (toolbar, action menu, action bar, etc. — el padre cercano que da contexto), copiar también su outerHTML. Esta es la regla de CLAUDE.md sin excepciones.

Identificar un selector que matchee SOLO el botón Delete y no otros botones (Edit, Save, etc.). Si el botón no tiene id ni clase únicos, el selector debe anclarse al wrapper (ej. `[data-testid="actions-bar"] button[aria-label*="Delete"]`).

Append al design doc:

```markdown
## DOM Selectors
- buttonOuterHTML: <pegado>
- wrapperOuterHTML: <pegado>
- proposedSelector: <CSS selector>
- justificación de unicidad: <por qué no matchea otros botones>
```

- [ ] **Step 4: Capturar `CurrentUserDetails` y elegir allowlist**

DevTools → Network, encontrar el request `CurrentUserDetails` (dispara en page load). Copiar el response body. Identificar los campos disponibles: `id`, `isAdmin`, `name`, `email`. Decidir con el usuario qué user id(s) van en `allowlistUserIds` (los que SÍ pueden borrar).

Append al design doc:

```markdown
## User shape
- response CurrentUserDetails: <JSON pegado>
- campos disponibles para gating: <lista>
- allowlistUserIds elegidos: ["<id1>", "<id2>"]
- justificación: <por qué estos>
```

- [ ] **Step 5: Verificar cómo se registran applets en `background.js`**

Leer `extension/background.js` enfocándose en cómo otros applets (ej. `invoice-autofill`, `sensor-status-autofill`, `invoice-auto-regen`) se cargan. Documentar:

```markdown
## Loader pattern
- archivo: extension/background.js
- línea(s) relevantes: <#-#>
- patrón actual: <descripción de cómo se llama fetch + new Function(c)()>
- dónde inyectar delete-guard: <específico>
- cómo se expone window.__steelheadConfig (o equivalente): <si existe>
```

- [ ] **Step 6: Commit del design doc**

```bash
git add docs/superpowers/specs/2026-05-07-delete-guard-design.md
git commit -m "docs(delete-guard): captura inicial de mutation, DOM, user shape y loader"
```

---

### Task 2: Agregar bloque `deleteGuard` a `config.json`

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Insertar el bloque de config**

Reemplazar `<...>` con valores de Task 1:

```json
"deleteGuard": {
  "enabled": true,
  "mode": "block",
  "allowlistUserIds": ["<id-de-task-1-step-4>"],
  "blockedOperations": ["<operationName-de-task-1-step-2>"],
  "hiddenSelectors": ["<selector-de-task-1-step-3>"],
  "logBlocks": true
}
```

Insertar dentro del objeto `applets` (o en la ubicación que el design doc de Task 1 Step 5 confirme como correcta para que el loader lo recoja).

- [ ] **Step 2: Bumpear version**

En el mismo archivo: `version` `0.5.63` → `0.5.64`, `lastUpdated` → `2026-05-07`.

- [ ] **Step 3: Validar JSON**

Run: `python3 -m json.tool remote/config.json > /dev/null`
Expected: sin output (JSON válido). Si falla, fix de sintaxis.

- [ ] **Step 4: Commit**

```bash
git add remote/config.json
git commit -m "chore(config): añadir deleteGuard PoC + bump 0.5.64"
```

**No deployar a gh-pages todavía.** El applet aún no existe; deployar config sin el archivo rompe el cache-bust.

---

### Task 3: Crear esqueleto del applet con header de userscript

**Files:**
- Create: `remote/scripts/delete-guard.js`

- [ ] **Step 1: Escribir el archivo con header + IIFE skeleton**

```javascript
// ==UserScript==
// @name         Steelhead Delete Guard
// @namespace    https://github.com/Ecoplating/SteelheadAutomator
// @version      0.1.0
// @description  Esconde UI de Delete y bloquea mutations destructivas en Steelhead
// @match        https://app.gosteelhead.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const APPLET = 'delete-guard';
  const log = (...args) => console.log(`[${APPLET}]`, ...args);

  // En extensión: window.__steelheadConfig lo inyecta el loader (verificar contra el patrón
  // documentado en design doc Task 1 Step 5).
  // En userscript: se reemplaza este fallback por config literal (ver Task 6).
  const CONFIG = (window.__steelheadConfig && window.__steelheadConfig.deleteGuard) || {
    enabled: false,
    mode: 'block',
    allowlistUserIds: [],
    blockedOperations: [],
    hiddenSelectors: [],
    logBlocks: true,
  };

  if (!CONFIG.enabled) {
    log('disabled (sin config)');
    return;
  }

  log('booted', { mode: CONFIG.mode, blocking: CONFIG.blockedOperations });
})();
```

- [ ] **Step 2: Registrar el applet en `extension/background.js`**

Seguir el patrón documentado en design doc Task 1 Step 5. NO inventar — replicar exactamente cómo se registra otro applet equivalente (`invoice-auto-regen` es buen referente: corre en `document-start`-style, intercepta fetch).

- [ ] **Step 3: Sync a gh-pages**

Per procedimiento documentado en CLAUDE.md ("Deploy a producción"):

```bash
git checkout gh-pages
cp ../<main-checkout>/remote/scripts/delete-guard.js scripts/delete-guard.js
cp ../<main-checkout>/remote/config.json config.json
git add scripts/delete-guard.js config.json
git commit -m "deploy: delete-guard skeleton + bump 0.5.64"
git push origin gh-pages
git checkout main
```

- [ ] **Step 4: Smoke test en desktop**

Esperar ~60s que GitHub Pages publique. `chrome://extensions` → reload. Abrir Steelhead. DevTools console.

Expected: `[delete-guard] booted { mode: 'block', blocking: ['<op>'] }`

Si no aparece el log: revisar registro en `background.js` (paso 2). Verificar que el script efectivamente se fetch-ea: Network tab → buscar `delete-guard.js`.

- [ ] **Step 5: Commit del lado main (gh-pages ya pushed)**

```bash
git checkout main
git add remote/scripts/delete-guard.js extension/background.js
git commit -m "feat(delete-guard): skeleton con header de userscript + registro en loader"
```

---

### Task 4: Implementar Capa A — esconder botones Delete

**Files:**
- Modify: `remote/scripts/delete-guard.js`

- [ ] **Step 1: Agregar helpers de allowlist**

Antes del `if (!CONFIG.enabled)`:

```javascript
let currentUserId = null;

async function fetchCurrentUserId() {
  const hash = window.__steelheadConfig?.hashes?.CurrentUserDetails;
  if (!hash) {
    log('no CurrentUserDetails hash en config; no se puede gatear por usuario');
    return null;
  }
  try {
    const res = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apollographql-client-name': 'web',
        'apollographql-client-version': '4.0.8',
      },
      credentials: 'include',
      body: JSON.stringify({
        operationName: 'CurrentUserDetails',
        variables: {},
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      }),
    });
    const json = await res.json();
    return json?.data?.currentUser?.id || null;
  } catch (err) {
    log('failed to fetch user id', err);
    return null;
  }
}

function isAllowed() {
  if (!currentUserId) return false;
  return CONFIG.allowlistUserIds.includes(currentUserId);
}
```

(El path exacto de `data.currentUser.id` puede variar — ajustar contra el response capturado en Task 1 Step 4.)

- [ ] **Step 2: Agregar `hideMatchingNodes` + `MutationObserver`**

```javascript
function hideMatchingNodes(root) {
  if (!CONFIG.hiddenSelectors.length) return;
  const selector = CONFIG.hiddenSelectors.join(',');
  const matches = root.querySelectorAll ? root.querySelectorAll(selector) : [];
  matches.forEach((node) => {
    if (node.dataset.deleteGuardHidden === '1') return;
    node.dataset.deleteGuardHidden = '1';
    node.style.display = 'none';
    if (CONFIG.logBlocks) log('hid node', node);
  });
}

function startDomObserver() {
  hideMatchingNodes(document);
  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) hideMatchingNodes(n);
      });
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}
```

- [ ] **Step 3: Wire bootstrap**

Reemplazar el `log('booted', ...)` final por:

```javascript
(async function bootstrap() {
  currentUserId = await fetchCurrentUserId();
  log('booted', { mode: CONFIG.mode, userId: currentUserId, allowed: isAllowed() });

  if (isAllowed()) {
    log('user allowlisted; no se esconde UI');
    return;
  }

  startDomObserver();
})();
```

- [ ] **Step 4: Deploy + manual test**

Sync a gh-pages, bump `version` a `0.5.65`. Reload extensión. Navegar a la pantalla protegida.

Expected (usuario NO allowlisted):
- Console: `[delete-guard] booted { mode: 'block', userId: '...', allowed: false }`
- Botón Delete invisible. Otros botones intactos.
- Console: `[delete-guard] hid node <button>`

Test del path positivo: agregar temporalmente tu propio user id a `allowlistUserIds`, deploy, reload. Botón visible, sin logs `hid node`. Revertir el cambio si no te quieres dejar permanentemente allowlisted.

- [ ] **Step 5: Commit**

```bash
git add remote/scripts/delete-guard.js remote/config.json
git commit -m "feat(delete-guard): Capa A — esconde botones de Delete vía MutationObserver"
```

---

### Task 5: Implementar Capa B — interceptar mutations destructivas

**Files:**
- Modify: `remote/scripts/delete-guard.js`

- [ ] **Step 1: Agregar `patchFetch`**

Debajo de `startDomObserver`:

```javascript
function patchFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const isGraphql = url && url.includes('/graphql');
      const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      if (!isGraphql || method !== 'POST') return orig(input, init);

      const rawBody = init?.body;
      let body = null;
      if (typeof rawBody === 'string') {
        try { body = JSON.parse(rawBody); } catch (_) { body = null; }
      }
      const opName = body?.operationName;
      if (opName && CONFIG.blockedOperations.includes(opName) && !isAllowed()) {
        if (CONFIG.logBlocks) log('BLOCKED mutation', opName, body?.variables);
        if (CONFIG.mode === 'log-only') return orig(input, init);
        return new Response(
          JSON.stringify({
            errors: [{ message: `Operación bloqueada por delete-guard: ${opName}` }],
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
    } catch (err) {
      log('patchFetch error (passing through)', err);
    }
    return orig(input, init);
  };
}
```

- [ ] **Step 2: Llamar `patchFetch` PRIMERO en bootstrap**

```javascript
(async function bootstrap() {
  patchFetch();                                          // armado síncrono primero
  currentUserId = await fetchCurrentUserId();            // este request pasa por el patch (no bloqueado: no está en blockedOperations)
  log('booted', { mode: CONFIG.mode, userId: currentUserId, allowed: isAllowed() });

  if (isAllowed()) {
    log('user allowlisted; no se esconde UI');
    return;
  }

  startDomObserver();
})();
```

Orden importante: `patchFetch()` antes del `await`. Si lo invocas después, las mutations que disparen entre el mount del script y la resolución del user id se cuelan. El check `isAllowed()` vive DENTRO del interceptor, así no necesita esperar al user id para armar.

- [ ] **Step 3: Deploy + manual test (path de bloqueo)**

Sync a gh-pages, bump a `0.5.66`. Reload. Navegar a Steelhead.

**Test 1 — bypass del botón escondido:**
- Console:
```javascript
fetch('/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'apollographql-client-name': 'web',
    'apollographql-client-version': '4.0.8',
  },
  credentials: 'include',
  body: JSON.stringify({
    operationName: '<op-de-task-1>',
    variables: {<vars-de-task-1>},
    extensions: { persistedQuery: { version: 1, sha256Hash: '<hash-de-task-1>' } },
  }),
}).then(r => r.json()).then(console.log);
```
- Expected response: `{ errors: [{ message: 'Operación bloqueada por delete-guard: <op>' }] }`
- Expected console: `[delete-guard] BLOCKED mutation <op> {<vars>}`
- Verificar que la entidad NO se borró: refresh la pantalla, sigue ahí.

**Test 2 — usuario allowlisted bypasea:**
- Agregar tu user id a `allowlistUserIds`. Bump `0.5.67`. Deploy. Reload.
- Repetir el `fetch` de arriba.
- Expected: response real de Steelhead (la entidad SÍ se borra — usar entidad de prueba). Sin log BLOCKED.
- Revertir el cambio de allowlist si no te quieres dejar permanentemente.

- [ ] **Step 4: Commit**

```bash
git add remote/scripts/delete-guard.js remote/config.json
git commit -m "feat(delete-guard): Capa B — intercepta y bloquea mutations destructivas"
```

---

### Task 6: Validar como userscript en Safari iPad

**Files:**
- Create: `docs/delete-guard/ipad-onboarding.md`

Esta task valida que el MISMO `delete-guard.js` corre en Safari iPad sin cambios de código fuente, solo con dos parches de distribución.

- [ ] **Step 1: Preparar copia local lista para userscript**

Userscripts (la app de iPad) no tiene loader que inyecte `window.__steelheadConfig` ni acceso al `config.json` de gh-pages. Hay que hornear esos valores en el archivo distribuido. NO modificar `remote/scripts/delete-guard.js` — esa fuente sigue siendo la canónica para la extensión.

```bash
cp remote/scripts/delete-guard.js /tmp/delete-guard.user.js
```

Editar `/tmp/delete-guard.user.js`:
1. Reemplazar el bloque `const CONFIG = (window.__steelheadConfig...)` por config literal con los mismos valores que `remote/config.json` → `deleteGuard`.
2. Agregar al inicio del IIFE una constante `HASHES = { CurrentUserDetails: '<hash-real>' }` con el hash de `remote/config.json` → `hashes.CurrentUserDetails`.
3. Cambiar la línea `const hash = window.__steelheadConfig?.hashes?.CurrentUserDetails;` dentro de `fetchCurrentUserId` por `const hash = HASHES.CurrentUserDetails;`.

- [ ] **Step 2: Instalar Userscripts en iPad**

App Store iPad → buscar "Userscripts" by Justin Wasack (gratis, open source). Instalar.

Settings (iPad) → Safari → Extensions → Userscripts → Enable. Permission: "All Websites" o específicamente `app.gosteelhead.com`.

- [ ] **Step 3: Cargar el script en el iPad**

Opción A (recomendada): AirDrop `/tmp/delete-guard.user.js` desde la Mac al iPad. iPad lo abre en Userscripts, prompt "Save". Confirmar.

Opción B: abrir Userscripts en iPad → "+" → New Script → pegar contenido completo.

- [ ] **Step 4: Test en iPad (con Web Inspector remoto)**

Conectar iPad a Mac por USB. En Mac: Safari → Preferences → Advanced → ✓ "Show Develop menu". Después Develop → `<nombre del iPad>` → seleccionar la pestaña de Steelhead. Esto abre la consola JS de la pestaña real del iPad en la Mac. Sin esto, debug en iPad es a ciegas.

En iPad Safari: abrir `app.gosteelhead.com`, login, navegar a la pantalla protegida.

Expected:
- Capa A: botón Delete escondido.
- Console (vista desde Mac): `[delete-guard] booted { mode: 'block', userId: '...', allowed: false }`
- Repetir el `fetch` manual de Task 5 Step 3 desde la consola remota.
- Expected: response 403 con el mensaje de delete-guard. Entidad NO borrada server-side.

Gotchas de WebKit a vigilar:
- `MutationObserver` puede arrancar antes de `documentElement` con `@run-at document-start` — si rompe, envolver `startDomObserver()` en `if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startDomObserver); else startDomObserver();`.
- `dataset` y `fetch` patching funcionan igual que en Blink.
- Si `fetch` patching no toma: Userscripts a veces inyecta en wrapper aislado; ajustar a `unsafeWindow.fetch` si la app expone `unsafeWindow` (no aplica con `@grant none`, en cuyo caso ya corre en page context).

- [ ] **Step 5: Escribir el onboarding doc**

Crear `docs/delete-guard/ipad-onboarding.md`. Audiencia: usuario operativo (no técnico). Una página máximo. Estructura:

```markdown
# Instalación de Delete Guard en iPad

## Qué es
Una protección que esconde el botón "Delete" en Steelhead para evitar borrados accidentales.

## Pasos

1. Abrir App Store en el iPad. Buscar **Userscripts** (autor: Justin Wasack). Instalar (es gratis).
2. Abrir **Settings** (Configuración) → **Safari** → **Extensions** (Extensiones) → **Userscripts** → activar el toggle. Conceder permiso para "All Websites" o solo "app.gosteelhead.com".
3. Recibir el archivo `delete-guard.user.js` (te lo manda IT por AirDrop o correo). Tocar el archivo → "Open in Userscripts" → confirmar Save.
4. Abrir Safari en `app.gosteelhead.com`, hacer login normal.
5. Verificar: ir a la pantalla donde antes aparecía el botón Delete. Ahora no debe aparecer.

## Si algo no funciona
Avisar a IT con: (a) qué pantalla estabas viendo, (b) si Userscripts aparece activado en Settings → Safari → Extensions, (c) screenshot de la pantalla.
```

- [ ] **Step 6: Commit**

```bash
git add docs/delete-guard/ipad-onboarding.md
git commit -m "docs(delete-guard): guía de instalación en iPad vía Userscripts"
```

---

### Task 7: Append de lecciones a CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Agregar sección de lecciones**

Insertar después de la última sección de lecciones de applet existente (al cierre de la sección `sensor-status-autofill`):

```markdown
### `delete-guard`: PoC inicial 0.5.64 → 0.5.66
Applet defensivo de dos capas para evitar deletes accidentales. Capa A esconde botones Delete vía `MutationObserver`. Capa B intercepta `window.fetch` y devuelve 403 a mutations en `blockedOperations`. Allowlist de user ids en `config.json`.

- **Misma fuente para extensión y userscript.** El header `// ==UserScript==` es comentario inocuo para el extension loader (`background.js:66`, `new Function(c)()`), así que un solo `delete-guard.js` corre en MV3 desktop y en Safari iPad vía la app Userscripts. Para distribución iPad, copia local del archivo y reemplazo del lookup `window.__steelheadConfig` por config literal — Safari iPad no tiene loader equivalente.
- **`patchFetch` ANTES del `await fetchCurrentUserId`.** Si lo armas después del await, las mutations que disparen entre mount del script y resolución del user id se cuelan. El check `isAllowed()` vive DENTRO del interceptor (no afuera), así no requiere esperar al user id para armar. Patrón en `delete-guard.js` bootstrap.
- **Allowlist por user id, no por `isAdmin`.** `CurrentUserDetails` da `isAdmin` pero no `currentManagedPermissions` (la op vieja `CurrentUser` está deprecada server-side, ver lección de `paros-linea`). `isAdmin` es muy grueso. Allowlist explícito en `config.json` es lo correcto hasta que Steelhead exponga permisos granulares server-side.
- **Validar en iPad con Web Inspector remoto.** Conecta iPad a Mac por USB, Safari Mac → Develop → `<iPad>` → pestaña real. Sin esto el debug en iPad es a ciegas. Vale para CUALQUIER applet futuro que se distribuya como userscript.
- **iOS = WebKit siempre.** Chrome iPad / Edge iPad / Firefox iPad son skins sobre Safari. Si Steelhead corre en Chrome iPad, corre en Safari iPad — el motor es el mismo. La diferencia "Chrome funciona mejor" del usuario es solo de desktop.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: lecciones delete-guard PoC 0.5.64 → 0.5.66"
```

---

## Self-Review (al cerrar el PoC)

Antes de declarar el PoC completo, verificar:

1. **End-to-end desktop:**
   - Usuario allowlisted: botón visible, mutation pasa, entidad se borra.
   - Usuario NO allowlisted: botón escondido, fetch manual desde consola devuelve 403, entidad NO borrada.
2. **End-to-end iPad Safari + Userscripts:** mismos dos paths anteriores, verificados con Web Inspector remoto.
3. **No regresiones:** smoke-test de los applets que el usuario abre a diario (`invoice-autofill`, `invoice-auto-regen`, `portal-importer`, `paros-linea`, `sensor-status-autofill`). Especialmente: que `patchFetch` de `delete-guard` no rompa el `patchFetch` de `invoice-auto-regen` — verificar orden de carga; el último que parchea gana, pero ambos delegan al `orig` previo, así que la cadena debe funcionar.
4. **Config bumpeada en cada deploy:** `git log --oneline remote/config.json` muestra bumps por cada commit que tocó `delete-guard.js`.
5. **gh-pages en sync byte-a-byte con main:**
   ```bash
   git diff main:remote/scripts/delete-guard.js gh-pages:scripts/delete-guard.js
   git diff main:remote/config.json gh-pages:config.json
   ```
   Ambos sin output.
6. **Design doc completo:** `docs/superpowers/specs/2026-05-07-delete-guard-design.md` tiene las 5 capturas de Task 1 (caso de uso, mutation, DOM, user shape, loader pattern). Si falta alguna, el PoC se hizo a ciegas y hay que recapturar.

---

## Out of Scope (Phase 2+)

NO están en el PoC. Listadas para sesiones de planning futuras.

- **Phase 2 — generalización:** soporte para N mutations + N selectores; categorías separadas (delete vs archive vs void); selectores scopeados por pantalla en lugar de globales.
- **Phase 3 — modo confirm:** `mode: 'confirm'` muestra modal "escribe DELETE para confirmar" en lugar de bloqueo duro. Útil para Delete que SÍ se debe permitir pero con doble check.
- **Phase 4 — audit logging:** persistir intentos bloqueados (timestamp, user id, mutation, variables) en `chrome.storage` (extensión) o IndexedDB (userscript). Endpoint propio para subirlos centralmente. Surface en dashboard de admin.
- **Phase 5 — packaging automatizado del `.user.js`:** build step (npm script o GitHub Action) que genere `gh-pages/userscripts/delete-guard.user.js` con HASHES + CONFIG horneados. Hosted en URL estable que la app Userscripts puede auto-actualizar. Elimina el AirDrop manual por iPad y permite distribuir actualizaciones sin tocar cada dispositivo.
- **Phase 6 — fallback server-side:** cuando Steelhead exponga `managedPermissions` granulares, deprecar la Capa B y dejar solo la Capa A (UI cleanup). El bloqueo real lo hace el backend.
- **Pendiente cruzado con audit:** este applet usa `new Function(c)()` indirectamente igual que los demás (es lo que ejecuta el loader). Cuando se implemente el item #1 del audit (pinear hashes SHA-256 de cada script en `config.json`), `delete-guard.js` debe entrar en ese inventario también.
