# Popup Layout Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign popup menu with grid/list toggle, category support, and quick record button.

**Architecture:** All changes in the extension (popup.html + popup.js) and config.json. No remote script changes. View mode persisted via `chrome.storage.local`. Categories defined in config.json per applet.

**Tech Stack:** Vanilla HTML/CSS/JS, Chrome Extension APIs.

---

### Task 1: Add categories to config.json applets

**Files:**
- Modify: `remote/config.json`

- [ ] **Step 1: Add `category` field to each applet**

Add `"category": "..."` to each object in the `apps` array. Insert it right after `"icon"`:

| Applet ID | Category |
|---|---|
| `carga-masiva` | `Números de Parte` |
| `archiver` | `Números de Parte` |
| `auditor` | `Números de Parte` |
| `file-uploader` | `Números de Parte` |
| `spec-migrator` | `Números de Parte` |
| `wo-deadline` | `Órdenes de Trabajo` |
| `inventory-reset` | `Inventario & Facturación` |
| `po-comparator` | `Inventario & Facturación` |
| `cfdi-attacher` | `Inventario & Facturación` |
| `report-liberator` | `Herramientas` |
| `hash-scanner` | `Herramientas` |

- [ ] **Step 2: Commit**

```bash
git add remote/config.json
git commit -m "feat(config): add category field to applets"
```

---

### Task 2: Add CSS for grid and list view modes

**Files:**
- Modify: `extension/popup.html`

- [ ] **Step 1: Add CSS rules**

In the `<style>` block, add after the `.app-card.disabled:hover` rule (around line 114):

```css
/* Grid view (3 columns) */
.app-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; padding: 10px; max-height: 480px; overflow-y: auto; }
.app-grid::-webkit-scrollbar { width: 6px; }
.app-grid::-webkit-scrollbar-thumb { background: #c0c0c0; border-radius: 3px; }
.app-grid::-webkit-scrollbar-track { background: transparent; }
.app-tile {
  background: var(--bg-card); border: 1px solid var(--border-card); border-radius: 8px;
  padding: 10px 4px; text-align: center; cursor: pointer; transition: all 0.15s ease;
}
.app-tile:hover { border-color: #38bdf8; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
.app-tile:active { transform: scale(0.96); }
.app-tile .tile-icon { font-size: 26px; }
.app-tile .tile-name { font-size: 9px; font-weight: 600; color: var(--text-body); margin-top: 3px; line-height: 1.2; }

/* List view (categorized) */
.app-list { padding: 8px 12px; max-height: 480px; overflow-y: auto; }
.app-list::-webkit-scrollbar { width: 6px; }
.app-list::-webkit-scrollbar-thumb { background: #c0c0c0; border-radius: 3px; }
.app-list::-webkit-scrollbar-track { background: transparent; }
.app-list-cat {
  font-size: 9px; font-weight: 700; color: var(--text-soft); text-transform: uppercase;
  letter-spacing: 1px; padding: 8px 4px 4px; border-bottom: 1px solid var(--border-card);
}
.app-list-cat:first-child { padding-top: 4px; }
.app-list-row {
  display: flex; align-items: center; gap: 8px; padding: 8px 4px;
  border-bottom: 1px solid var(--border-card); cursor: pointer; transition: background 0.1s;
}
.app-list-row:hover { background: var(--bg-app-header-hover); }
.app-list-row:active { background: var(--bg-app-header); }
.app-list-row .row-icon { font-size: 16px; width: 20px; text-align: center; }
.app-list-row .row-name { flex: 1; font-size: 11px; font-weight: 600; color: var(--text-body); }
.app-list-row .row-chevron { font-size: 11px; color: var(--text-soft); }

/* View mode toggle button */
.btn-view-toggle {
  background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px 4px;
  opacity: 0.6; transition: opacity 0.2s; color: inherit;
}
.btn-view-toggle:hover { opacity: 1; }

/* Rec button */
.btn-rec {
  background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px 4px;
  opacity: 0.6; transition: opacity 0.2s;
}
.btn-rec:hover { opacity: 1; }
.btn-rec.recording { opacity: 1; animation: blink 1s infinite; }
```

- [ ] **Step 2: Commit**

```bash
git add extension/popup.html
git commit -m "feat(popup): add CSS for grid/list view modes and rec button"
```

---

### Task 3: Add HTML elements for toggle and rec buttons

**Files:**
- Modify: `extension/popup.html`

- [ ] **Step 1: Add view toggle button and rec button to status bar**

In the status bar, find the `<span>` that contains the buttons (line 227). Replace:

```html
<span style="display:flex;align-items:center;gap:8px">
  <span id="version-text">v--</span>
  <button class="btn-theme-toggle" id="btn-theme-toggle" title="Modo claro/oscuro">🌙</button>
  <button class="btn-theme-toggle" id="btn-settings" title="Configuración">⚙️</button>
  <button class="btn-reload-inline" id="btn-copy-log" title="Copiar último log">📋</button>
  <button class="btn-reload-inline" id="btn-reload" title="Recargar Steelhead">🔃</button>
</span>
```

with:

```html
<span style="display:flex;align-items:center;gap:8px">
  <span id="version-text">v--</span>
  <button class="btn-theme-toggle" id="btn-theme-toggle" title="Modo claro/oscuro">🌙</button>
  <button class="btn-view-toggle" id="btn-view-toggle" title="Cambiar vista">▦</button>
  <button class="btn-theme-toggle" id="btn-settings" title="Configuración">⚙️</button>
  <button class="btn-rec" id="btn-rec" title="Iniciar captura">🔴</button>
  <button class="btn-reload-inline" id="btn-copy-log" title="Copiar último log">📋</button>
  <button class="btn-reload-inline" id="btn-reload" title="Recargar Steelhead">🔃</button>
</span>
```

- [ ] **Step 2: Commit**

```bash
git add extension/popup.html
git commit -m "feat(popup): add view toggle and rec button elements to status bar"
```

---

### Task 4: Implement dual-mode renderAppMenu in popup.js

**Files:**
- Modify: `extension/popup.js`

- [ ] **Step 1: Add view mode state and persistence**

After the line `let currentApp = null;` (line 6), add:

```javascript
let viewMode = 'grid'; // 'grid' | 'list'
```

Add a new function after `initTheme`:

```javascript
function initViewMode() {
  chrome.storage.local.get(['sa_view_mode'], (result) => {
    viewMode = result.sa_view_mode || 'grid';
    applyViewMode(viewMode);
  });
}

function applyViewMode(mode) {
  viewMode = mode;
  const btn = document.getElementById('btn-view-toggle');
  if (btn) {
    btn.textContent = mode === 'grid' ? '≡' : '▦';
    btn.title = mode === 'grid' ? 'Cambiar a vista de lista' : 'Cambiar a vista de grid';
  }
  renderAppMenu();
}

function toggleViewMode() {
  const newMode = viewMode === 'grid' ? 'list' : 'grid';
  applyViewMode(newMode);
  chrome.storage.local.set({ sa_view_mode: newMode });
}
```

- [ ] **Step 2: Replace the renderAppMenu function**

Replace the entire `renderAppMenu` function (lines 98-137) with:

```javascript
function renderAppMenu() {
  const menuWrap = document.querySelector('.app-menu-wrap');
  // Remove existing menu content (grid, list, or old app-menu)
  const oldMenu = menuWrap.querySelector('.app-menu, .app-grid, .app-list');
  if (oldMenu) oldMenu.remove();

  const apps = config?.apps || [];

  if (viewMode === 'grid') {
    renderGridMenu(menuWrap, apps);
  } else {
    renderListMenu(menuWrap, apps);
  }

  // Update scroll fade
  const fade = document.getElementById('scroll-fade');
  const scrollEl = menuWrap.querySelector('.app-grid, .app-list');
  if (scrollEl && fade) {
    const updateFade = () => {
      const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight;
      const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 4;
      fade.classList.toggle('visible', scrollable && !atBottom);
    };
    scrollEl.addEventListener('scroll', updateFade);
    setTimeout(updateFade, 0);
  }
}

function renderGridMenu(container, apps) {
  const grid = document.createElement('div');
  grid.className = 'app-grid';

  for (const app of apps) {
    const tile = document.createElement('div');
    tile.className = 'app-tile';
    tile.innerHTML = `
      <div class="tile-icon">${app.icon || '📦'}</div>
      <div class="tile-name">${app.name}</div>`;
    tile.addEventListener('click', () => selectApp(app));
    grid.appendChild(tile);
  }

  container.insertBefore(grid, document.getElementById('scroll-fade'));
}

function renderListMenu(container, apps) {
  const list = document.createElement('div');
  list.className = 'app-list';

  // Group by category, preserving order of first appearance
  const categories = [];
  const catMap = new Map();
  for (const app of apps) {
    const cat = app.category || 'Otros';
    if (!catMap.has(cat)) {
      catMap.set(cat, []);
      categories.push(cat);
    }
    catMap.get(cat).push(app);
  }

  for (const cat of categories) {
    const header = document.createElement('div');
    header.className = 'app-list-cat';
    header.textContent = cat;
    list.appendChild(header);

    for (const app of catMap.get(cat)) {
      const row = document.createElement('div');
      row.className = 'app-list-row';
      row.innerHTML = `
        <span class="row-icon">${app.icon || '📦'}</span>
        <span class="row-name">${app.name}</span>
        <span class="row-chevron">›</span>`;
      row.addEventListener('click', () => selectApp(app));
      list.appendChild(row);
    }
  }

  container.insertBefore(list, document.getElementById('scroll-fade'));
}
```

- [ ] **Step 3: Wire up the view toggle in init()**

In the `init()` function, after `initTheme();` (line 15), add:

```javascript
initViewMode();
```

After the theme toggle listener (line 21), add:

```javascript
document.getElementById('btn-view-toggle').addEventListener('click', toggleViewMode);
```

- [ ] **Step 4: Commit**

```bash
git add extension/popup.js
git commit -m "feat(popup): implement grid/list dual-mode rendering with toggle"
```

---

### Task 5: Implement quick record button

**Files:**
- Modify: `extension/popup.js`

- [ ] **Step 1: Add rec button handler in init()**

In `init()`, after the view toggle listener added in Task 4, add:

```javascript
document.getElementById('btn-rec').addEventListener('click', async () => {
  try {
    const result = await sendToBackground('toggle-scan');
    const scanning = result?.started === true;
    updateScanIndicator(scanning);
    updateRecButton(scanning);
  } catch (e) { /* ignore */ }
});
```

- [ ] **Step 2: Add updateRecButton function**

After the existing `updateScanIndicator` function (around line 378-380), add:

```javascript
function updateRecButton(active) {
  const btn = document.getElementById('btn-rec');
  if (!btn) return;
  btn.classList.toggle('recording', !!active);
  btn.textContent = active ? '⏹' : '🔴';
  btn.title = active ? 'Detener captura' : 'Iniciar captura';
}
```

- [ ] **Step 3: Initialize rec button state on startup**

In the `checkStatus` function, inside the try block where `updateScanIndicator` is called (around line 370), add right after that call:

```javascript
updateRecButton(scanStatus?.scanning);
```

Also add in the catch block (line 371):

```javascript
updateRecButton(false);
```

- [ ] **Step 4: Sync rec button when toggle-scan is triggered from inside the applet**

In the `handleAction` function, inside the `toggle-scan` branch (around line 209-219), after `updateScanIndicator(scanning);` add:

```javascript
updateRecButton(scanning);
```

- [ ] **Step 5: Commit**

```bash
git add extension/popup.js
git commit -m "feat(popup): add quick record button in status bar"
```

---

### Task 6: Deploy

**Files:**
- Deploy: `remote/config.json` to gh-pages, rebuild extension zip

- [ ] **Step 1: Deploy config.json to gh-pages (categories)**

Standard gh-pages deploy recipe for config.json.

- [ ] **Step 2: Rebuild extension zip and deploy to gh-pages**

```bash
zip -r /tmp/steelhead-automator.zip extension/ -x "extension/.DS_Store" "extension/icons/.DS_Store"
```

Copy zip to gh-pages and push both branches.

- [ ] **Step 3: Verify in browser**

1. Open popup — should show grid view by default
2. Click view toggle — switches to categorized list
3. Refresh popup — persists the chosen mode
4. Click 🔴 rec button — should start scanning, button changes to ⏹
5. Click ⏹ — stops scanning
6. Enter Explorador API applet — toggle-scan button state matches
