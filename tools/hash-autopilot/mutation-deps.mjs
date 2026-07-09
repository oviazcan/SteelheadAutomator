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
// quote: se des/archiva desde el DASHBOARD (?archived=…&searchQuery=<id> filtra a la
// fila exacta), y ESO dispara UpdateQuote — no la página del quote. El PN togglea inline;
// el quote navega a otra URL para mutar. loadObject lee "Name" de la página del quote.
function quoteRowBtn(page, id, label) {
  return page.locator(`tr:has(a[href$="/Quotes/${id}"]) button[aria-label="${label}"]`).first();
}
// Unarchive/Archive de un quote abre un modal "Confirm … Quote" con NO/YES.
// Hay que clickear YES para que la mutation (UpdateQuote) realmente se dispare.
async function confirmYes(page) {
  const yes = page.locator('[role="dialog"]').getByRole('button', { name: /^yes$/i }).first();
  await yes.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if (await yes.count().catch(() => 0)) await yes.click({ timeout: 8000 });
}
// El quote aparece en archived=true (si archivado) o archived=false (si activo). Busca
// en ambos y devuelve {found, archived} + deja la page en el dashboard donde está.
async function findQuoteDashboard(page, id, domain) {
  for (const arch of [true, false]) {
    await page.goto(`${BASE}/Domains/${domain}/Quotes?archived=${arch}&hasRfq=false&searchQuery=${id}`, { waitUntil: 'domcontentloaded' });
    const row = page.locator(`tr:has(a[href$="/Quotes/${id}"])`).first();
    await row.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    if (await row.count().catch(() => 0)) return { found: true, archived: arch };
  }
  return { found: false, archived: null };
}
const HANDLERS = {
  partNumber: {
    async load(page, { url }) {
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
  quote: {
    async load(page, { id, domain }) {
      // el name link (a /Quotes/<id>/<rev>) de la fila del dashboard — confiable (la página
      // del quote tiene otros <p>Name ambiguos). Robusto al estado: busca archivado o activo.
      const { found } = await findQuoteDashboard(page, id, domain);
      if (!found) return { name: '' };
      const nameLink = page.locator(`tr:has(a[href$="/Quotes/${id}"]) a[href*="/Quotes/${id}/"]`).first();
      return { name: (await nameLink.textContent().catch(() => '')).trim() };
    },
    async mutate(page, { id, domain }) {
      // navegar client-side a la página del quote (goto directo sale vacío) → clickear el Edit
      // de "External Notes" (1er EditOutlinedIcon) → editor. DIAGNÓSTICO del editor.
      await findQuoteDashboard(page, id, domain);
      await page.locator(`tr:has(a[href$="/Quotes/${id}"]) a[href*="/Quotes/${id}/"]`).first().click();
      await page.waitForTimeout(4000);
      const editBtn = page.locator('button:has(svg[data-testid="EditOutlinedIcon"])').first();
      await editBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await editBtn.click({ timeout: 15000 });
      await page.waitForTimeout(1500);
      if (process.env.SA_DBG) {
        const dlg = await page.locator('[role="dialog"]').count().catch(() => -1);
        const ta = await page.locator('textarea').count().catch(() => -1);
        console.log(`       [dbg] tras Edit External Notes: dialog=${dlg} textarea=${ta}`);
        await page.screenshot({ path: '/tmp/sa-quote-noteedit.png', fullPage: true }).catch(() => {});
      }
    },
    async restore(_page) {
      // (temporal) — se completa al ver el editor de notas
    },
  },
};

// ── Ensamblado de deps para runMutationCycle ────────────────────────────────
export function makeDeps(config, _sink) {
  const domain = config.domain || 344;
  const ctxFor = (type) => {
    const ent = config.entities[type];
    return { id: ent.id, domain, url: resolveUrl(ent, ent.id, domain) };
  };
  return {
    readJournal() { try { return JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')); } catch { return {}; } },
    writeJournal(j) { mkdirSync(dirname(JOURNAL_PATH), { recursive: true }); writeFileSync(JOURNAL_PATH, JSON.stringify(j, null, 2)); },
    async loadObject(page, id) {
      const found = entityFor(config, id);
      const h = found && HANDLERS[found.type];
      if (!h) return null;
      return h.load(page, { id, domain, url: resolveUrl(found.ent, id, domain) });
    },
    async doMutate(page, route) {
      const type = route?.sentinel?.entityType;
      const h = HANDLERS[type];
      if (!h) throw new Error(`sin handler DOM para entidad ${type}`);
      return h.mutate(page, ctxFor(type));
    },
    async doRestore(page, route) {
      const type = route?.sentinel?.entityType;
      const h = HANDLERS[type];
      if (h && h.restore) return h.restore(page, ctxFor(type));
    },
  };
}
