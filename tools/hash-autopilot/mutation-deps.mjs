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
// quote: UpdateQuote se dispara al EDITAR las External Notes de la cotización (bulk-upload
// lo usa así), NO al archivar (eso es ArchiveUnArchiveQuote, que ni está en config, verificado
// por el sink). La página del quote sólo hidrata por navegación client-side desde el dashboard.
// El quote aparece en archived=true (si archivado) o archived=false (si activo). Busca
// en ambos y devuelve {found, archived} + deja la page en el dashboard donde está.
async function findQuoteDashboard(page, id, domain) {
  // el dashboard con searchQuery en la URL hidrata inconsistentemente (deep-link) → recargar
  // hasta que la fila aparezca. Busca en archivado y activo.
  const dbg = process.env.SA_DBG;
  for (const arch of [true, false]) {
    for (let r = 0; r < 3; r++) {
      await page.goto(`${BASE}/Domains/${domain}/Quotes?archived=${arch}&hasRfq=false&searchQuery=${id}`, { waitUntil: 'domcontentloaded' });
      // el dashboard puede quedarse en "Loading..." un rato → esperar a que se vaya primero
      await page.locator('text=/^Loading/').first().waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {});
      const ok = await page.locator(`tr:has(a[href$="/Quotes/${id}"])`).first()
        .waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
      if (dbg) {
        const rows = await page.locator('tr:has(a[href*="/Quotes/"])').count().catch(() => -1);
        console.log(`       [dbg] quote dash archived=${arch} try=${r} ok=${ok} rows=${rows}`);
      }
      if (ok) return { found: true, archived: arch };
    }
  }
  if (dbg) await page.screenshot({ path: '/tmp/sa-quote-dash.png', fullPage: true }).catch(() => {});
  return { found: false, archived: null };
}
// Editar "External Notes" del quote: navega client-side a la cotización (goto directo sale
// vacío), abre el editor (1er EditOutlinedIcon → modal rich), cambia a Markdown (textarea
// simple), escribe y guarda (SAVE). El SAVE dispara UpdateQuote (requiere cambio real).
async function editExternalNote(page, id, domain, value) {
  await findQuoteDashboard(page, id, domain);
  await page.locator(`tr:has(a[href$="/Quotes/${id}"]) a[href*="/Quotes/${id}/"]`).first().click();
  await page.waitForTimeout(4000);
  await page.locator('button:has(svg[data-testid="EditOutlinedIcon"])').first().click({ timeout: 15000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await dialog.getByText('Markdown', { exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
  await dialog.locator('textarea').first().fill(value);
  await dialog.getByRole('button', { name: /^save$/i }).first().click({ timeout: 10000 });
  await page.waitForTimeout(2500);
}
// ── receivedOrder (OV): create-capture-cleanup ─────────────────────────────
// CreateReceivedOrder se dispara al CREAR una OV vacía (paso 1 del flujo, playbook
// portal-importer). Cada corrida crea una OV "Sentinela" y archiva la recién creada
// (limpieza). El modal pide OC#, Cliente y 2 custom inputs obligatorios (Razón Social, Divisa).
// dashboard SIMPLE (sin searchQuery en la URL — el deep-link con searchQuery no hidrata las
// filas). Las OV "Sentinela" (recientes, orderBy Created desc) salen al inicio; filtro por td.
const OV_DASH = (domain) => `${BASE}/Domains/${domain}/SalesOrders?receivedOrderStatusFilter=OPEN`;
async function createSentinelaOV(page, domain) {
  const dbg = process.env.SA_DBG;
  await page.goto(`${BASE}/Domains/${domain}/SalesOrders?receivedOrderStatusFilter=OPEN`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // botón crear OV: el botón con AddIcon del header (independiente del idioma)
  const newBtn = page.locator('button:has(svg[data-testid="AddIcon"])').first();
  await newBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await newBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  if (dbg) console.log('       [dbg] modal Nueva OV abierto');
  // OC#: input con AssignmentIcon adornment (independiente del idioma)
  await page.locator('.MuiInputBase-root:has(svg[data-testid="AssignmentIcon"]) input').first().fill('Sentinela');
  // Cliente (react-select): label "Cliente:"/"Customer:" → el react-select siguiente
  const cliente = page.locator('p', { hasText: /^(Cliente|Customer):/ }).locator('xpath=following-sibling::div[1]').locator('input[role="combobox"]').first();
  await cliente.click();
  await cliente.fill('ECOPLATING');
  await page.waitForTimeout(1800);
  await page.locator('[role="option"]', { hasText: 'ECOPLATING' }).first().click({ timeout: 8000 });
  if (dbg) console.log('       [dbg] OC# + Cliente listos');
  // custom inputs obligatorios (RJSF <select> por ids — NO se traducen); value ECOPLATING dinámico
  const razonVal = await page.locator('#root_RazonSocialVenta option').filter({ hasText: 'ECOPLATING' }).first().getAttribute('value').catch(() => null);
  if (razonVal) await page.selectOption('#root_RazonSocialVenta', razonVal);
  await page.selectOption('#root_Divisa', 'USD');
  if (dbg) console.log('       [dbg] Razón Social + Divisa');
  // Guardar/Save
  await page.locator('button', { hasText: /^(Guardar|Save)$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(6000); // dar tiempo a que la OV nueva se indexe antes de archivarla
  if (dbg) console.log('       [dbg] Guardar clickeado');
}
async function archiveSentinelaOVs(page, domain) {
  // archivar TODAS las OV "Sentinela" activas (la 1594 de referencia está archivada → sólo
  // aparecen las creadas por el ciclo). Loop hasta que no queden — evita acumular basura.
  const dbg = process.env.SA_DBG;
  for (let i = 0; i < 12; i++) {
    // el dashboard de OVs a veces no hidrata las filas con goto directo → recargar hasta que sí
    let ok = false;
    for (let r = 0; r < 4 && !ok; r++) {
      await page.goto(OV_DASH(domain), { waitUntil: 'domcontentloaded' });
      ok = await page.locator('tr:has(a[href*="/SalesOrders/"])').first()
        .waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    }
    if (dbg && i === 0) {
      const sentRows = await page.locator('tr:has(td:has-text("Sentinela"))').count().catch(() => -1);
      console.log(`       [dbg] OV_DASH archivar: hydrated=${ok} sentRows=${sentRows}`);
      await page.screenshot({ path: '/tmp/sa-ov-archive.png', fullPage: true }).catch(() => {});
    }
    const archBtn = page.locator('tr:has(td:has-text("Sentinela")) button[aria-label="Archivar"], tr:has(td:has-text("Sentinela")) button[aria-label="Archive"]').first();
    if (!(await archBtn.count().catch(() => 0))) { if (dbg) console.log(`       [dbg] OVs Sentinela archivadas: ${i}`); break; }
    await archBtn.click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    const yes = page.locator('[role="dialog"]').getByRole('button', { name: /^(yes|sí|si|confirmar|archivar|archive)$/i }).first();
    if (await yes.count().catch(() => 0)) await yes.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
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
      // cambio real de External Notes → SAVE dispara UpdateQuote
      await editExternalNote(page, id, domain, 'SA-SENTINEL-CAP');
    },
    async restore(page, { id, domain }) {
      // restaurar el valor base del sentinela ('.') → deja el quote como estaba
      await editExternalNote(page, id, domain, '.');
    },
  },
  receivedOrder: {
    async load(page, { domain }) {
      // salvaguarda C.3 (create-capture-cleanup): NO requiere una OV existente (la 1594 de
      // referencia está archivada). Verifica que el dashboard de OVs carga en el dominio correcto
      // (botón crear OV = MuiButton-contained con AddIcon presente) → contexto OK, fail-closed.
      // La OV se CREA marcada "Sentinela" y se archiva; la salvaguarda real es esa marca.
      await page.goto(`${BASE}/Domains/${domain}/SalesOrders?receivedOrderStatusFilter=OPEN`, { waitUntil: 'domcontentloaded' });
      const newBtn = page.locator('button:has(svg[data-testid="AddIcon"])').first();
      await newBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      const hasNewBtn = await page.locator('button:has(svg[data-testid="AddIcon"])').count().catch(() => 0);
      if (process.env.SA_DBG) console.log(`       [dbg] OV dash: addIcon btns=${hasNewBtn}`);
      return { name: hasNewBtn ? 'Sentinela (create-capture)' : '' };
    },
    async mutate(page, { domain }) {
      // crear una OV nueva "Sentinela" → dispara CreateReceivedOrder
      await createSentinelaOV(page, domain);
    },
    async restore(page, { domain }) {
      // archivar TODAS las OV Sentinela creadas por el ciclo (limpieza) — SIEMPRE
      await archiveSentinelaOVs(page, domain);
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
