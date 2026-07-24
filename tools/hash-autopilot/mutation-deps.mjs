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
      const sentRows = await page.locator('tr:has(td:has-text("Sentinela")), tr:has(td:has-text("Centinela"))').count().catch(() => -1);
      console.log(`       [dbg] OV_DASH archivar: hydrated=${ok} sentRows=${sentRows}`);
      await page.screenshot({ path: '/tmp/sa-ov-archive.png', fullPage: true }).catch(() => {});
    }
    const archBtn = page.locator('tr:has(td:has-text("Sentinela")) button[aria-label="Archivar"], tr:has(td:has-text("Sentinela")) button[aria-label="Archive"], tr:has(td:has-text("Centinela")) button[aria-label="Archivar"], tr:has(td:has-text("Centinela")) button[aria-label="Archive"]').first();
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
// ── partNumberPrice (modal individual): RETIRADO 2026-07-17 ──────────────────
// El handler savePriceSentinelaAborted (modal "Part Number Price" individual) se
// eliminó al UNIFICAR Steelhead las dos variantes de SaveManyPartNumberPrices en un
// solo hash (72946d4d…, ver config.json). La captura de precios vive en el flujo de
// COTIZACIÓN: quotePrice #288 → savePartsQuoteAborted, validado end-to-end headless
// 2026-07-17. El andamiaje id:0 del modal era deuda redundante (nunca se ejecutaba:
// mutEntityType lo saltaba por id falsy). Ver sentinels-config.json entidad quotePrice.

// Navegación CLIENT-SIDE a la lista de Quotes. HALLAZGO 2026-07-17: el dashboard de quotes
// NO hidrata por deep-link (searchQuery sale vacío, tanto headless como en navegador real);
// SÍ hidrata navegando dentro del SPA ya cargado (home → clic al link /Quotes → la lista
// rinde filas). El quote sentinela #288 (nombre 'Sentinela', reciente) aparece en la 1ª
// página de la lista ACTIVA. Devuelve true si el <a> del quote {id} (con rev) aparece.
async function openQuotesListAndFind(page, id, domain) {
  await page.goto(`${BASE}/Domains/${domain}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.locator('a[href$="/Quotes"]').first().click({ timeout: 12000 }).catch(async () => {
    await page.goto(`${BASE}/Domains/${domain}/Quotes`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  });
  return page.locator(`a[href*="/Quotes/${id}/"]`).first()
    .waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false);
}

// quotePrice: SaveManyPartNumberPrices — hash unificado VIVO 72946d4d (Steelhead fusionó las
// dos variantes el 2026-07-17; el viejo batch 9da1874e murió y el 'individual' 72946d quedó como
// el único). Se dispara desde la COTIZACIÓN sentinela #288. FLUJO REAL del
// operador (2026-07-17): abrir el quote client-side → clic 'Edit this Part' (lapicito) → 'Save
// Parts' se HABILITA solo → clic 'Save Parts' SIN editar nada → dispara el batch "tiro por viaje".
// CLAVE: NO tocar Divisa/precio — editar rompe el estado y Save Parts se deshabilita (por eso la
// captura fallaba antes). PRECONDICIÓN: el quote #288 DEBE estar ACTIVO (desarchivado); archivado
// = read-only. El price-confirm-guard NO aparece (guard = modal individual 'Part Number Price', no
// este 'Save Parts' del quote) y en headless no hay extensión.
async function savePartsQuoteAborted(page, sink, { id, domain }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('SaveManyPartNumberPrices');
  const found = await openQuotesListAndFind(page, id, domain);
  if (!found) throw new Error('quotePrice: el link del quote sentinela no apareció en la lista (¿archivado? ¿no hidrató?)');
  await page.locator(`a[href*="/Quotes/${id}/"]`).first().click({ timeout: 10000 }).catch(() => {});
  await page.locator('[aria-label="Edit this Part"]').first().waitFor({ state: 'visible', timeout: 25000 });
  if (dbg) console.log('       [dbg] quote abierto → Edit this Part (sin editar nada)');
  // Click REAL de Playwright (force: el div puede quedar "cubierto" para el hit-test, pero el
  // click dispara el handler React; evaluate().click() a veces no lo activa → Save Parts no se
  // habilitaba). Fallback a evaluate si el force falla.
  await page.locator('[aria-label="Edit this Part"]').first().click({ force: true, timeout: 10000 }).catch(async () => {
    await page.evaluate(() => { const d = [...document.querySelectorAll('[aria-label="Edit this Part"]')][0]; if (d) d.click(); });
  });
  await page.waitForTimeout(1500);
  if (dbg) {
    const st = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /^Save Parts$/i.test((b.textContent || '').trim())).map((b) => b.disabled)).catch(() => []);
    console.log(`       [dbg] tras Edit: Save Parts botones=${JSON.stringify(st)}`);
  }
  // 'Save Parts' se habilita solo tras 'Edit this Part'. Clic REAL (force) tal cual (SIN editar)
  // → dispara SaveManyPartNumberPrices → interceptor captura y ABORTA. Reintenta hasta capturar.
  const d2 = Date.now() + 25000;
  while (Date.now() < d2 && !(sink && sink.hashes && sink.hashes.SaveManyPartNumberPrices)) {
    await page.locator('button').filter({ hasText: /^Save Parts$/i }).first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] Save Parts → ${sink && sink.hashes && sink.hashes.SaveManyPartNumberPrices ? 'CAPTURADO' : 'sin hash aún'}`);
}

// workOrderPartCount: AddPartsToWorkOrders vía CAPTURA-Y-ABORTA. La mutation se dispara al
// GUARDAR el modal "Ajustar Cantidad de Piezas de OT" (icono IsoIcon) de una OT en el detalle
// de la OV Sentinela #1603. Marca la op en abortOps ANTES de tocar el DOM → el interceptor
// registra el sha256Hash y ABORTA el request → cero persistencia (la OT no cambia de conteo,
// verificado: sigue 1/1). Ancla del botón IDIOMA-INDEPENDIENTE (aria-label PRESENTE + IsoIcon;
// el otro IsoIcon de la sección BOM no tiene aria-label; NO usa el texto). Verificado en vivo
// 2026-07-17 (hash rotó a5cc8991→70d5a792). Ver sentinels-config.json entidad workOrderPartCount.
async function saveWoPartCountAborted(page, sink, { url }) {
  const dbg = process.env.SA_DBG;
  // MARCAR la op ANTES de cualquier clic que pueda disparar el Save → aborta aunque salga antes.
  if (sink && sink.abortOps) sink.abortOps.add('AddPartsToWorkOrders');
  // navegar al detalle de la OV; hidrata tarde headless → espera ACTIVA al name "Sentinela".
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => /Sentinela/i.test(document.body ? document.body.innerText : '')).catch(() => false)) break;
    await page.waitForTimeout(1500);
  }
  if (dbg) console.log('       [dbg] OV detalle hidratado');
  // botón IsoIcon "Ajustar Cantidad" — idioma-independiente: aria-label presente + IsoIcon.
  const isoBtn = page.locator('button[aria-label]:has(svg[data-testid="IsoIcon"])').first();
  await isoBtn.waitFor({ state: 'visible', timeout: 15000 });
  await isoBtn.scrollIntoViewIfNeeded().catch(() => {});
  await isoBtn.click({ timeout: 10000 });
  // fail-closed: verificar que abrió el modal CORRECTO ("Ajustar Cantidad"/"Adjust…" bilingüe).
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Ajustar Cantidad|Adjust/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  if (dbg) console.log('       [dbg] modal Ajustar Cantidad abierto');
  // cambiar el "Conteo Deseado" a un valor != actual → habilita Guardar y construye la mutation.
  // NO persiste (se aborta). El input es el único del dialog; fill maneja el setter de React.
  await dialog.locator('input').first().fill('2').catch(() => {});
  await page.waitForTimeout(700);
  // Guardar/Save (bilingüe) → dispara AddPartsToWorkOrders → el interceptor captura y ABORTA.
  await dialog.locator('button').filter({ hasText: /^(Guardar|Save)$/i }).first().click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (dbg) console.log(`       [dbg] Save → ${sink && sink.hashes && sink.hashes.AddPartsToWorkOrders ? 'CAPTURADO' : 'sin hash aún'}`);
}

// ── Mutations de REPORTES (captura-y-aborta) ────────────────────────────────
// Las 4 mutations del módulo Reporting rotaron el 2026-07-20 (report-liberator usa las 3 de
// /Reporting/Edit; report-regen usa GenerateDuckDb). Se recapturan por CAPTURA-Y-ABORTA: se
// marca la op en sink.abortOps ANTES de clicar el disparador → el interceptor registra el
// sha256Hash y ABORTA el request → CERO efecto (no borra carpeta, no archiva, no crea reporte,
// no regenera la DB). Doble candado: el loadObject verifica que existe el objeto "Sentinela"
// (isSentinel fail-closed) + el abort. Selectores idioma-independientes por data-testid/aria-label
// (el DOM real los trae en inglés aunque la UI esté en español); botones de modal bilingües.
// Flujo y DOM confirmados por el operador 2026-07-20.
const REPORTING_EDIT = '/Reporting/Edit';

// Aísla la fila "Sentinela" del árbol de Saved Reports. Las clases jssNN del DOM que dio el
// operador son JSS DINÁMICAS (cambian por sesión) → NO se pueden usar. Se FILTRA por
// "Filter queries..." (el árbol es largo/virtualizado; la fila no está en el DOM hasta filtrar)
// y se ancla por aria-label + innerText de la fila vía evaluate-mark: se marca con data-sa-rep
// el svg[aria-label] cuya fila (ancestro) innerText==="Sentinela". Verificado headless 2026-07-20
// (hit 1/1 tras filtrar, con la carpeta+reporte "Sentinela" persistentes creados por el operador).
async function filterReportTree(page, term) {
  const f = page.locator('input[placeholder*="ilter quer" i], input[placeholder*="iltrar" i]').first();
  if (await f.count().catch(() => 0)) { await f.fill(term).catch(() => {}); await page.waitForTimeout(2000); }
}
async function markSentinelaAction(page, ariaLabel) {
  return page.evaluate((aria) => {
    document.querySelectorAll('[data-sa-rep]').forEach((e) => e.removeAttribute('data-sa-rep'));
    for (const svg of document.querySelectorAll(`svg[aria-label="${aria}"]`)) {
      let el = svg;
      for (let i = 0; i < 6 && el; i++) { el = el.parentElement; if (el && el.innerText && /^[sc]entinela$/i.test(el.innerText.trim())) { svg.setAttribute('data-sa-rep', '1'); return true; } }
    }
    return false;
  }, ariaLabel).catch(() => false);
}

// GenerateDuckDb: botón "Regenerate Database" (CloudDownloadIcon) en /Reporting/Databases.
async function generateDuckDbAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('GenerateDuckDb');
  await page.goto(`${BASE}/Reporting/Databases`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const btnSel = 'button:has(svg[data-testid="CloudDownloadIcon"])';
  await page.locator(btnSel).first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !(sink && sink.hashes && sink.hashes.GenerateDuckDb)) {
    await page.locator(btnSel).first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] Regenerate DB → ${sink && sink.hashes && sink.hashes.GenerateDuckDb ? 'CAPTURADO' : 'sin hash aún'}`);
}

// DeleteFolderById: basura de la carpeta "Sentinela" → modal "Delete Folder" → Delete.
async function deleteFolderSentinelaAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('DeleteFolderById');
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('input[placeholder*="ilter quer" i]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await filterReportTree(page, 'Sentinela');
  if (!(await markSentinelaAction(page, 'Delete folder'))) { if (dbg) console.log('       [dbg] carpeta Sentinela no hallada'); return; }
  await page.locator('[data-sa-rep="1"]').scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('[data-sa-rep="1"]').click({ force: true, timeout: 10000 }).catch(() => {});
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Delete Folder|Eliminar/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(sink && sink.hashes && sink.hashes.DeleteFolderById)) {
    await dialog.locator('button').filter({ hasText: /^(Delete|Eliminar)$/i }).first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] Delete Folder → ${sink && sink.hashes && sink.hashes.DeleteFolderById ? 'CAPTURADO' : 'sin hash aún'}`);
}

// CreateUpdateReportWithPermissions: "Guardar informe" (SaveIcon) → nombre "Sentinela" → "Guardar como nuevo".
async function saveReportAsNewAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('CreateUpdateReportWithPermissions');
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const saveBtn = page.locator('button:has(svg[data-testid="SaveIcon"])').first();
  await saveBtn.waitFor({ state: 'visible', timeout: 25000 });
  await saveBtn.click({ force: true, timeout: 10000 });
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Guardar informe|Save Report/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 12000 });
  // input de NOMBRE (MUI, no los react-select de carpeta/permisos) → "Sentinela".
  await dialog.locator('input.MuiOutlinedInput-input').first().fill('Sentinela').catch(() => {});
  await page.waitForTimeout(500);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(sink && sink.hashes && sink.hashes.CreateUpdateReportWithPermissions)) {
    await dialog.locator('button').filter({ hasText: /Guardar como nuevo|Save as New/i }).first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] Save as New → ${sink && sink.hashes && sink.hashes.CreateUpdateReportWithPermissions ? 'CAPTURADO' : 'sin hash aún'}`);
}

// ArchiveReport: archivar la línea del reporte "Sentinela" (ArchiveIcon) → confirmar "Sí"/"Yes".
async function archiveReportSentinelaAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('ArchiveReport');
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('input[placeholder*="ilter quer" i]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await filterReportTree(page, 'Sentinela');
  if (!(await markSentinelaAction(page, 'Archive report'))) { if (dbg) console.log('       [dbg] reporte Sentinela no hallado'); return; }
  await page.locator('[data-sa-rep="1"]').scrollIntoViewIfNeeded().catch(() => {});
  await page.locator('[data-sa-rep="1"]').click({ force: true, timeout: 10000 }).catch(() => {});
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /archive this report|archivar/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(sink && sink.hashes && sink.hashes.ArchiveReport)) {
    await dialog.locator('button').filter({ hasText: /^(Sí|Si|Yes)$/i }).first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] Archive Report → ${sink && sink.hashes && sink.hashes.ArchiveReport ? 'CAPTURADO' : 'sin hash aún'}`);
}

// Load compartido: verifica que la fila "Sentinela" del tipo dado existe (isSentinel fail-closed).
async function loadReportingRow(page, ariaLabel) {
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('input[placeholder*="ilter quer" i]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await filterReportTree(page, 'Sentinela');
  return { name: (await markSentinelaAction(page, ariaLabel)) ? 'Sentinela' : '' };
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
  quotePrice: {
    // load: verifica que el quote sentinela existe (fail-closed). NO abre el quote — de eso
    // se encarga el mutate (savePartsQuoteAborted). id COMPARTIDO con 'quote' (288): entityFor
    // devuelve 'quote' para el load, pero el ciclo usa entityType='quotePrice' para mutate/restore.
    async load(page, { id, domain }) {
      // client-side (deep-link no hidrata). El link con rev sólo aparece si el quote está
      // ACTIVO (desarchivado) — fail-closed: si no aparece, name='' → el ciclo NO muta.
      const found = await openQuotesListAndFind(page, id, domain);
      return { name: found ? 'Sentinela' : '' };
    },
    async mutate(page, ctx) { await savePartsQuoteAborted(page, ctx.sink, ctx); },
    async restore(page, ctx) {
      // Save Parts se ABORTÓ → nada persistió → nada que restaurar. Solo desmarcar la op.
      if (ctx.sink && ctx.sink.abortOps) ctx.sink.abortOps.delete('SaveManyPartNumberPrices');
    },
  },
  workOrderPartCount: {
    // load: verifica que la OV Sentinela hidrata + su nombre contiene 'Sentinela' (isSentinel
    // fail-closed). Si no hidrata / no es Sentinela → name='' → runMutationCycle NO muta.
    async load(page, { url }) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      let isSent = false;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !isSent) {
        isSent = await page.evaluate(() => /Sentinela/i.test(document.body ? document.body.innerText : '')).catch(() => false);
        if (!isSent) await page.waitForTimeout(500);
      }
      if (process.env.SA_DBG) console.log(`       [dbg] workOrderPartCount load isSentinela=${isSent}`);
      return { name: isSent ? 'Sentinela' : '' };
    },
    async mutate(page, ctx) { await saveWoPartCountAborted(page, ctx.sink, ctx); },
    async restore(page, { sink }) {
      // Save abortado → nada persistió → nada que restaurar. Solo desmarcar la op (higiene del sink).
      if (sink && sink.abortOps) sink.abortOps.delete('AddPartsToWorkOrders');
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
  // ── REPORTES (captura-y-aborta) — cero efecto, restore solo desmarca la op del sink ──
  reportGenerateDb: {
    async load(page) {
      await page.goto(`${BASE}/Reporting/Databases`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ok = await page.locator('button:has(svg[data-testid="CloudDownloadIcon"])').first()
        .waitFor({ state: 'visible', timeout: 20000 }).then(() => 1).catch(() => 0);
      return { name: ok ? 'Sentinela (regenerate-db capture-abort)' : '' };
    },
    async mutate(page, { sink }) { await generateDuckDbAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('GenerateDuckDb'); },
  },
  reportFolderDelete: {
    async load(page) { return loadReportingRow(page, 'Delete folder'); },
    async mutate(page, { sink }) { await deleteFolderSentinelaAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('DeleteFolderById'); },
  },
  reportSaveAsNew: {
    async load(page) {
      // No requiere el reporte Sentinela existente (crea uno nuevo y aborta): verifica el
      // botón "Guardar informe" (contexto del editor de reportes) → isSentinel fail-closed.
      await page.goto(`${BASE}/Reporting/Edit`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ok = await page.locator('button:has(svg[data-testid="SaveIcon"])').first()
        .waitFor({ state: 'visible', timeout: 20000 }).then(() => 1).catch(() => 0);
      return { name: ok ? 'Sentinela (save-as-new capture-abort)' : '' };
    },
    async mutate(page, { sink }) { await saveReportAsNewAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('CreateUpdateReportWithPermissions'); },
  },
  reportArchive: {
    async load(page) { return loadReportingRow(page, 'Archive report'); },
    async mutate(page, { sink }) { await archiveReportSentinelaAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('ArchiveReport'); },
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
    async loadObject(page, id, entityType) {
      // entityType explícito gana sobre entityFor: necesario cuando DOS entidades comparten
      // id (quote y quotePrice = #288) — el ciclo sabe cuál handler de load usar. Sin él,
      // entityFor devolvería el primero (quote/deep-link) y no el correcto (quotePrice/client-side).
      const found = (entityType && config.entities[entityType])
        ? { type: entityType, ent: config.entities[entityType] }
        : entityFor(config, id);
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
