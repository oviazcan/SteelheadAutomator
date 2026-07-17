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
// ── maintenanceNode: create-event-capture ──────────────────────────────────
// Los 3 hashes (CreateMaintenanceEvent / CreateMaintenanceEventComment /
// UpdateMaintenanceEvent) se disparan al CREAR un evento de mantenimiento sobre el
// nodo sentinela y recorrer su ciclo (comentar + completar). UN solo flujo captura
// los 3; como el sink es compartido en el run, cuando ya están los 3 los ciclos
// siguientes hacen no-op (no crean otro evento). Al final se ARCHIVA el evento
// (limpieza). Fail-closed: si no aparece la opción "Sentinela" en el combobox del
// nodo, aborta SIN crear evento (no toca datos reales).
const MAINT_OPS = ['CreateMaintenanceEvent', 'CreateMaintenanceEventComment', 'UpdateMaintenanceEvent'];
async function archiveCurrentMaintenanceEvent(page) {
  // Togglear el checkbox "Archived" del evento hace DOS cosas a la vez: dispara
  // UpdateMaintenanceEvent (update de archivedAt — verificado con el sink, paralelo a
  // UpdatePartNumber) Y archiva el evento (limpieza). CheckBoxOutlineBlankIcon = NO
  // archivado → click archiva. Espera el POST async para que el hash se capture.
  const box = page.locator('.MuiCheckbox-root:has(svg[data-testid="CheckBoxOutlineBlankIcon"])').first();
  if (await box.count().catch(() => 0)) {
    await box.scrollIntoViewIfNeeded().catch(() => {});
    await box.click().catch(() => {});
    await page.waitForTimeout(4000);
    if (process.env.SA_DBG) console.log('       [dbg] maint: evento archivado → UpdateMaintenanceEvent + limpieza');
    return true;
  }
  return false;
}
async function createMaintenanceEventOnSentinela(page, domain, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.hashes && MAINT_OPS.every((op) => sink.hashes[op])) {
    if (dbg) console.log('       [dbg] maint: 3 ops ya en sink → skip (no crea otro evento)');
    return;
  }
  await page.goto(`${BASE}/Domains/${domain}/Maintenance`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  // "New Maintenance Event" (NO "New Maintenance Node" — desambiguar por texto; ambos usan AddBoxIcon)
  await page.locator('button', { hasText: /New Maintenance Event/ }).first().click({ timeout: 20000 });
  await page.waitForTimeout(2000);
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (dbg) console.log('       [dbg] maint: modal Nuevo Evento abierto');
  // toggle "Node" del grupo (Event puede abrir por equipo o por nodo)
  await dialog.locator('button', { hasText: /^Node$/ }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // combobox react-select "Select a node": escribir "Sentinela" y elegir la opción (fail-closed)
  const combo = dialog.locator('input[role="combobox"]').first();
  await combo.click();
  await combo.fill('Sentinela');
  await page.waitForTimeout(2000);
  const opt = page.locator('[role="option"]', { hasText: /Sentinela/i }).first();
  if (!(await opt.count().catch(() => 0))) {
    throw new Error('fail-closed: no apareció opción "Sentinela" en el combobox de nodo — no se crea evento');
  }
  await opt.click({ timeout: 8000 });
  await page.waitForTimeout(800);
  if (dbg) console.log('       [dbg] maint: nodo Sentinela seleccionado');
  // Save & Begin → CreateMaintenanceEvent
  await page.locator('button', { hasText: /Save & Begin/ }).first().click({ timeout: 12000 });
  await page.waitForTimeout(4000);
  if (dbg) console.log('       [dbg] maint: Save & Begin (evento creado)');
  // comentario → Submit → CreateMaintenanceEventComment
  await page.locator('textarea[placeholder="Write a comment..."]').first().fill('SA-SENTINEL-CAP').catch(() => {});
  await page.locator('button', { hasText: /^Submit$/ }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (dbg) console.log('       [dbg] maint: comentario enviado');
  // UpdateMaintenanceEvent + limpieza en UNA acción: togglear el checkbox "Archived"
  // del evento (dispara el update de archivedAt Y archiva el evento). Ni "Complete
  // Maintenance Event" ni "Save & Begin" disparan UpdateMaintenanceEvent (verificado
  // con el sink); el toggle de Archived sí.
  await archiveCurrentMaintenanceEvent(page);
}
// receivedOrderEdit: UpdateReceivedOrder se dispara al GUARDAR el header de una OV
// EXISTENTE en el modal "Edit Sales Order" (botón SAVE). Cambiamos el PO# (campo inocuo,
// placeholder estable) y lo restauramos. Modal + PO# + SAVE VALIDADOS headless
// (2026-07-14); el CICLO completo requiere una OV Sentinela real (id en config, hoy 0).
// Deuda bilingüe: el placeholder "…PO# or PO Name" y el selector de NAME son EN-only.
async function editSalesOrderPoAndSave(page, value) {
  const openBtn = page.locator('button, [role="button"]').filter({ hasText: /edit sales order|editar orden de venta/i }).first();
  await openBtn.scrollIntoViewIfNeeded().catch(() => {});
  await openBtn.click({ timeout: 8000 }).catch(() => {});
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Edit Sales Order|Editar Orden de Venta/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const po = dialog.locator('input[placeholder*="PO#"], input[placeholder*="no PO"]').first();
  await po.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await po.fill(String(value)).catch(() => {});
  // SAVE dispara UpdateReceivedOrder (requiere un cambio real en el header)
  await dialog.locator('button').filter({ hasText: /^(SAVE|Guardar)$/i }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);
}
// ── partNumberPrice: captura-y-aborta (precios) ─────────────────────────────
// Captura el hash de SaveManyPartNumberPrices SIN persistir. Marca la op en
// sink.abortOps (el interceptor la aborta tras leer el hash), abre el modal "Part
// Number Price" (botón "+" AddCircleOutlineIcon de la sección de precios), llena los
// required mínimos (Divisa) + un precio, y clica "Save" → la mutation sale, el
// interceptor registra el hash y ABORTA el request → cero escritura. Selectores del
// HTML real (2026-07-15): título "Part Number Price"; select RJSF #root_DatosPrecio_Divisa
// (required, USD/MXN); input decimal del precio; botón Save data-testid=SaveOutlinedIcon.
async function savePriceSentinelaAborted(page, sink, ctx = {}) {
  const dbg = process.env.SA_DBG;
  // MARCAR la op ANTES de cualquier clic que pueda disparar el Save → el interceptor
  // aborta (cero persistencia) aunque el Save salga antes de lo previsto.
  if (sink && sink.abortOps) sink.abortOps.add('SaveManyPartNumberPrices');
  // PRE-CALENTAR la SPA: el detalle del PN se queda en "Loading..." con page.goto
  // directo (SPA fría); navegar primero a la LISTA /PartNumbers calienta la sección y
  // luego el detalle hidrata (validado headless 2026-07-15). Espera activa al name.
  await page.goto(`${BASE}/PartNumbers`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(5000);
  if (ctx.url) await page.goto(ctx.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => /Sentinela/i.test(document.body ? document.body.innerText : '')).catch(() => false)) break;
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log('       [dbg] PN detalle hidratado');
  // El botón "+" de precio vive en la fila "Pricing" del detalle: un div.css-xd9ivb
  // cuyo label (div.css-re0j1l) es "Pricing" + el IconButton AddCircleOutlineIcon.
  // Esto lo DISTINGUE de los "+" de OEMs (mismo icono, otra fila). Bilingüe (Pricing/Precios).
  // HIJO DIRECTO (>): un css-xd9ivb ANCESTRO engloba OEMs+Pricing y capturaría ambos "+";
  // anclar al css-xd9ivb cuyo hijo directo ES el label "Pricing" toma SOLO su botón.
  const openBtn = page.locator(
    'div.css-xd9ivb:has(> div.css-re0j1l:text-matches("^(Pricing|Precios)$", "i")) > button:has(svg[data-testid="AddCircleOutlineIcon"])'
  ).first();
  await openBtn.scrollIntoViewIfNeeded().catch(() => {});
  await openBtn.click({ timeout: 12000 });
  // fail-closed: verificar que abrió el modal CORRECTO ("Part Number Price").
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Part Number Price/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  if (dbg) console.log('       [dbg] modal Part Number Price abierto');
  // Divisa (REQUIRED): sin ella RJSF valida en cliente y el Save NO envía la mutation.
  await dialog.locator('#root_DatosPrecio_Divisa').selectOption('USD').catch(() => {});
  // precio > 0 (el input arranca en "0"; por si 0 no valida). NO persiste (se aborta).
  await dialog.locator('input[inputmode="decimal"]').first().fill('0.01').catch(() => {});
  await page.waitForTimeout(600);
  if (dbg) console.log('       [dbg] Divisa=USD + precio 0.01 → clic Save (se abortará)');
  await dialog.locator('button:has(svg[data-testid="SaveOutlinedIcon"])').first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

// quotePrice: SaveManyPartNumberPrices BATCH (9da1874e, el que usa bulk-upload), distinto
// del modal individual (72946d). Se dispara desde la COTIZACIÓN sentinela #288. El quote NO
// hidrata por deep-link → se navega client-side desde el dashboard (patrón findQuoteDashboard,
// validado con UpdateQuote) y se ABRE el quote (clic el <a> con rev). Luego "Edit this Part"
// de la línea del PN activa el botón "Save Parts", cuyo clic manda el batch → captura-y-aborta.
// DOM confirmado por el operador 2026-07-16. Usa DOM click() (evaluate) porque el div
// aria-label="Edit this Part" y "Save Parts" viven en zonas que Playwright da por cubiertas.
async function savePartsQuoteAborted(page, sink, { id, domain }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('SaveManyPartNumberPrices');
  const { found } = await findQuoteDashboard(page, id, domain);
  if (!found) throw new Error('quotePrice: no aparece el quote sentinela en el dashboard (sistema lento / no hidrató)');
  await page.locator(`tr:has(a[href$="/Quotes/${id}"]) a[href*="/Quotes/${id}/"]`).first().click({ timeout: 10000 }).catch(() => {});
  let ok = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !ok) {
    ok = await page.evaluate(() => document.querySelectorAll('[aria-label="Edit this Part"]').length > 0).catch(() => false);
    if (!ok) await page.waitForTimeout(1500);
  }
  if (!ok) throw new Error('quotePrice: el quote no hidrató ("Edit this Part" ausente)');
  if (dbg) console.log('       [dbg] quote abierto → Edit this Part');
  await page.evaluate(() => { const d = [...document.querySelectorAll('[aria-label="Edit this Part"]')][0]; if (d) d.click(); });
  // ESPERA ACTIVA a que aparezca "Save Parts" (Edit this Part lo activa; el sistema puede
  // ser lento → un timeout fijo lo perdía). Reintenta el clic hasta capturar la mutation.
  const d2 = Date.now() + 25000;
  while (Date.now() < d2 && !(sink && sink.hashes && sink.hashes.SaveManyPartNumberPrices)) {
    const has = await page.evaluate(() => [...document.querySelectorAll('button')].some((x) => (x.textContent || '').includes('Save Parts'))).catch(() => false);
    if (has) {
      await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('Save Parts')); if (b) b.click(); });
      await page.waitForTimeout(3000);
    } else {
      await page.waitForTimeout(1500);
    }
  }
  if (dbg) console.log(`       [dbg] Save Parts → ${sink && sink.hashes && sink.hashes.SaveManyPartNumberPrices ? 'CAPTURADO' : 'sin hash aún'}`);
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
  receivedOrderEdit: {
    async load(page, { id, domain }) {
      // OV EXISTENTE marcada "Sentinela" (edit-restore). Fail-closed: si el detalle NO
      // contiene "Sentinela", name='' → runMutationCycle NO muta ni restaura.
      // Espera ACTIVA a que el nombre renderice: el detalle de OV hidrata tarde y un
      // timeout fijo daba FALSO NEGATIVO (isSentinela=false sobre una OV que SÍ lo es).
      await page.goto(`${BASE}/Domains/${domain}/SalesOrders/${id}`, { waitUntil: 'domcontentloaded' });
      let isSent = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !isSent) {
        isSent = await page.evaluate(() => /Sentinela/i.test(document.body ? document.body.innerText : '')).catch(() => false);
        if (!isSent) await page.waitForTimeout(500);
      }
      if (process.env.SA_DBG) console.log(`       [dbg] receivedOrderEdit load id=${id} isSentinela=${isSent}`);
      return { name: isSent ? 'Sentinela' : '' };
    },
    async mutate(page) {
      // cambio real del PO# → SAVE dispara UpdateReceivedOrder
      await editSalesOrderPoAndSave(page, 'SA-SENTINEL-CAP');
    },
    async restore(page) {
      // restaurar el PO# a vacío (base del sentinela) — SIEMPRE
      await editSalesOrderPoAndSave(page, '');
    },
  },
  partNumberPrice: {
    // SaveManyPartNumberPrices (precios) se captura CON CAPTURA-Y-ABORTA: marcamos la
    // mutation en sink.abortOps ANTES del "Save" → el interceptor registra el sha256Hash
    // que el frontend IBA a enviar y ABORTA el request → NUNCA llega al server → cero
    // persistencia (no se guarda un precio real). Sin respuesta → sin responseOk → el motor
    // la trata 'sospechoso' si difiere del config (notifica, NO auto-deploya: precios = ojo humano).
    async load(page, { url }) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const nameEl = page.locator('div.css-re0j1l', { hasText: 'Name:' })
        .locator('xpath=following-sibling::*[1]').first();
      await nameEl.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      return { name: (await nameEl.textContent().catch(() => '')).trim() };
    },
    async mutate(page, ctx) {
      await savePriceSentinelaAborted(page, ctx.sink, ctx);
    },
    async restore(page, { sink }) {
      // El Save se ABORTÓ → no se persistió ningún precio → nada que restaurar.
      // Solo desmarcar la op (higiene del sink) para no abortar requests futuras.
      if (sink && sink.abortOps) sink.abortOps.delete('SaveManyPartNumberPrices');
    },
  },
  quotePrice: {
    // load: verifica que el quote sentinela existe (fail-closed). NO abre el quote — de eso
    // se encarga el mutate (savePartsQuoteAborted). id COMPARTIDO con 'quote' (288): entityFor
    // devuelve 'quote' para el load, pero el ciclo usa entityType='quotePrice' para mutate/restore.
    async load(page, { id, domain }) {
      const { found } = await findQuoteDashboard(page, id, domain);
      return { name: found ? 'Sentinela' : '' };
    },
    async mutate(page, ctx) { await savePartsQuoteAborted(page, ctx.sink, ctx); },
    async restore(page, ctx) {
      // Save Parts se ABORTÓ → nada persistió → nada que restaurar. Solo desmarcar la op.
      if (ctx.sink && ctx.sink.abortOps) ctx.sink.abortOps.delete('SaveManyPartNumberPrices');
    },
  },
  maintenanceNode: {
    async load(page, { domain }) {
      // create-event-capture: no muta un nodo existente, crea un EVENTO sobre el nodo
      // sentinela. Verifica que la pantalla de Mantenimiento carga (botón "New
      // Maintenance Event" presente) → contexto OK. La salvaguarda real es seleccionar
      // el nodo "Sentinela" por nombre en el combobox (fail-closed si no aparece).
      await page.goto(`${BASE}/Domains/${domain}/Maintenance`, { waitUntil: 'domcontentloaded' });
      const btn = page.locator('button', { hasText: /New Maintenance Event/ }).first();
      await btn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      const ok = await page.locator('button', { hasText: /New Maintenance Event/ }).count().catch(() => 0);
      if (process.env.SA_DBG) console.log(`       [dbg] maint dash: newEventBtn=${ok}`);
      return { name: ok ? 'Sentinela (maint-capture)' : '' };
    },
    async mutate(page, { domain, sink }) {
      // crear evento + comentar + completar sobre el nodo Sentinela → dispara los 3
      await createMaintenanceEventOnSentinela(page, domain, sink);
    },
    async restore() {
      // no-op: el mutate ya archiva el evento creado con el mismo toggle que dispara
      // UpdateMaintenanceEvent (self-clean). Evitamos re-buscar un checkbox aquí para
      // no clicar por error otro checkbox si la página navegó. Un run INTERRUMPIDO
      // podría dejar un evento sin archivar (fuga menor, evento sentinela inofensivo).
    },
  },
};

// ── Ensamblado de deps para runMutationCycle ────────────────────────────────
export function makeDeps(config, sink) {
  const domain = config.domain || 344;
  const ctxFor = (type) => {
    const ent = config.entities[type];
    // sink expuesto al handler (maintenanceNode lo usa para no crear un evento por
    // cada op stale: un solo flujo captura los 3, los ciclos siguientes hacen no-op).
    return { id: ent.id, domain, url: resolveUrl(ent, ent.id, domain), sink };
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
