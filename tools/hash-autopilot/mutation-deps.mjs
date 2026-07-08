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
// partNumber: el sentinela "Sentinela" vive ARCHIVADO. Togglear el checkbox
// "Archived" (desarchivar→archivar) dispara UpdatePartNumber y deja el PN en su
// estado original. loadObject verifica name="Sentinela" (isSentinel fail-closed).
async function openEditPartNumber(page) {
  await page.getByRole('button', { name: /Editar Número de Parte/i }).first().click();
  await page.locator('[role="dialog"]').filter({ hasText: 'Edit Part Number' }).first().waitFor({ timeout: 10000 });
}
async function saveDialog(page) {
  await page.locator('[role="dialog"] button:has(svg[data-testid="SaveOutlinedIcon"])').first().click();
  await page.waitForTimeout(2500);
}
const HANDLERS = {
  partNumber: {
    async load(page, url) {
      await page.goto(url, { waitUntil: 'networkidle' });
      const name = (await page.locator('div.css-re0j1l', { hasText: 'Name:' })
        .locator('xpath=following-sibling::*[1]').first().textContent().catch(() => '')).trim();
      return { name };
    },
    // El Save del modal Edit dispara SavePartNumber + UpdatePartNumber (confirmado por el usuario).
    // Funciona con el PN archivado SIN desarchivar. Campo reversible: Notas Adicionales (vacío).
    async mutate(page) {
      await openEditPartNumber(page);
      await page.locator('#root_NotasAdicionales').fill('SA-SENTINEL-CAPTURE');
      await saveDialog(page);
    },
    async restore(page) {
      // vaciar Notas → Save: deja el PN como estaba (Notas vacío, estado archivado intacto)
      await openEditPartNumber(page);
      await page.locator('#root_NotasAdicionales').fill('');
      await saveDialog(page);
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
