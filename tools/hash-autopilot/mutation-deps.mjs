// tools/hash-autopilot/mutation-deps.mjs
// deps headless por entidad para runMutationCycle. Cada handler sabe cargar,
// mutar y restaurar SU objeto sentinela vía Playwright. Los helpers puros
// (entityFor/resolveUrl) son testeables sin navegador; los handlers DOM se
// validan en corrida supervisada.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = join(__dirname, '.state', 'journal.json');
const BASE = process.env.SH_BASE_URL || 'https://app.gosteelhead.com';

// ── Helpers puros (testeables) ──────────────────────────────────────────────
export function entityFor(config, id) {
  for (const [type, ent] of Object.entries(config.entities || {})) {
    if (ent && ent.id === id) return { type, ent };
  }
  return null;
}
export function resolveUrl(ent, id, domain) {
  const p = (ent.screenPath || '').replace('{domain}', String(domain)).replace('{id}', String(id));
  return `${BASE}${p}`;
}

// ── Handlers DOM por entidad ────────────────────────────────────────────────
// partNumber: el sentinela "Sentinela" vive ARCHIVADO. El TOGGLE del checkbox
// "Archived" dispara UpdatePartNumber (update de archivedAt) — NO el Save del modal
// (ese dispara SavePartNumber, verificado por el sink). Desarchivar captura la mutation;
// re-archivar restaura. loadObject verifica name="Sentinela" (isSentinel fail-closed).
function archivedRow(page) {
  return page.locator('div.css-re0j1l', { hasText: 'Archived:' })
    .locator('xpath=following-sibling::div[1]').first();
}
async function archivedChecked(page) {
  return archivedRow(page).locator('input[type="checkbox"]').first().isChecked().catch(() => null);
}
async function archivedToggle(page) {
  // el input real está oculto (MUI) → se clickea el span visual .MuiCheckbox-root
  const span = archivedRow(page).locator('.MuiCheckbox-root').first();
  await span.scrollIntoViewIfNeeded().catch(() => {});
  await span.click();
  await page.waitForTimeout(2500);
}
const HANDLERS = {
  partNumber: {
    async load(page, url) {
      // networkidle es frágil aquí (SPA con polling constante). Espera al ELEMENTO DEL NAME
      // (lo que verifica la identidad), no al botón — el name renderiza un instante después.
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const nameEl = page.locator('div.css-re0j1l', { hasText: 'Name:' })
        .locator('xpath=following-sibling::*[1]').first();
      await nameEl.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      return { name: (await nameEl.textContent().catch(() => '')).trim() };
    },
    async mutate(page) {
      // desarchivar → dispara UpdatePartNumber (el sink del motor captura el hash)
      await archivedToggle(page);
    },
    async restore(page) {
      // dejar el PN ARCHIVADO como estaba (si quedó desarchivado, re-archivar) — SIEMPRE
      if ((await archivedChecked(page)) === false) await archivedToggle(page);
    },
  },
};

// ── Ensamblado de deps para runMutationCycle ────────────────────────────────
export function makeDeps(config, _sink) {
  const domain = config.domain || 344;
  const handlerFor = (route) => HANDLERS[route?.sentinel?.entityType];
  return {
    readJournal() { try { return JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')); } catch { return {}; } },
    writeJournal(j) { mkdirSync(dirname(JOURNAL_PATH), { recursive: true }); writeFileSync(JOURNAL_PATH, JSON.stringify(j, null, 2)); },
    async loadObject(page, id) {
      const found = entityFor(config, id);
      const h = found && HANDLERS[found.type];
      if (!h) return null;
      return h.load(page, resolveUrl(found.ent, id, domain));
    },
    async doMutate(page, route) {
      const h = handlerFor(route);
      if (!h) throw new Error(`sin handler DOM para entidad ${route?.sentinel?.entityType}`);
      return h.mutate(page);
    },
    async doRestore(page, route) {
      const h = handlerFor(route);
      if (h && h.restore) return h.restore(page);
    },
  };
}
