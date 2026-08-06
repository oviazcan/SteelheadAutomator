// tools/hash-autopilot/mutation-deps.mjs
// deps headless por entidad para runMutationCycle. Cada handler sabe cargar,
// mutar y restaurar SU objeto centinela vía Playwright. Los helpers puros
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
// partNumber: el centinela "Centinela" vive ARCHIVADO. El TOGGLE del checkbox
// "Archived" dispara UpdatePartNumber (update de archivedAt) — NO el Save del modal
// (ese dispara SavePartNumber, verificado por el sink). Desarchivar captura la mutation;
// re-archivar restaura. loadObject verifica name="Centinela" (isSentinel fail-closed).
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
// portal-importer). Cada corrida crea una OV "Centinela" y archiva la recién creada
// (limpieza). El modal pide OC#, Cliente y 2 custom inputs obligatorios (Razón Social, Divisa).
// dashboard SIMPLE (sin searchQuery en la URL — el deep-link con searchQuery no hidrata las
// filas). Las OV "Centinela" (recientes, orderBy Created desc) salen al inicio; filtro por td.
const OV_DASH = (domain) => `${BASE}/Domains/${domain}/SalesOrders?receivedOrderStatusFilter=OPEN`;
async function createCentinelaOV(page, domain) {
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
  await page.locator('.MuiInputBase-root:has(svg[data-testid="AssignmentIcon"]) input').first().fill('Centinela');
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
async function archiveCentinelaOVs(page, domain) {
  // archivar TODAS las OV "Centinela" activas (la 1594 de referencia está archivada → sólo
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
      const sentRows = await page.locator('tr:has(td:has-text("Centinela"))').count().catch(() => -1);
      console.log(`       [dbg] OV_DASH archivar: hydrated=${ok} sentRows=${sentRows}`);
      await page.screenshot({ path: '/tmp/sa-ov-archive.png', fullPage: true }).catch(() => {});
    }
    const archBtn = page.locator('tr:has(td:has-text("Centinela")) button[aria-label="Archivar"], tr:has(td:has-text("Centinela")) button[aria-label="Archive"]').first();
    if (!(await archBtn.count().catch(() => 0))) { if (dbg) console.log(`       [dbg] OVs Centinela archivadas: ${i}`); break; }
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
// nodo centinela y recorrer su ciclo (comentar + completar). UN solo flujo captura
// los 3; como el sink es compartido en el run, cuando ya están los 3 los ciclos
// siguientes hacen no-op (no crean otro evento). Al final se ARCHIVA el evento
// (limpieza). Fail-closed: si no aparece la opción "Centinela" en el combobox del
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
async function createMaintenanceEventOnCentinela(page, domain, sink) {
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
  // combobox react-select "Select a node": escribir "Centinela" y elegir la opción (fail-closed)
  const combo = dialog.locator('input[role="combobox"]').first();
  await combo.click();
  await combo.fill('Centinela');
  await page.waitForTimeout(2000);
  const opt = page.locator('[role="option"]', { hasText: /Centinela/i }).first();
  if (!(await opt.count().catch(() => 0))) {
    throw new Error('fail-closed: no apareció opción "Centinela" en el combobox de nodo — no se crea evento');
  }
  await opt.click({ timeout: 8000 });
  await page.waitForTimeout(800);
  if (dbg) console.log('       [dbg] maint: nodo Centinela seleccionado');
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
// (2026-07-14); el CICLO completo requiere una OV Centinela real (id en config, hoy 0).
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
// El handler savePriceCentinelaAborted (modal "Part Number Price" individual) se
// eliminó al UNIFICAR Steelhead las dos variantes de SaveManyPartNumberPrices en un
// solo hash (72946d4d…, ver config.json). La captura de precios vive en el flujo de
// COTIZACIÓN: quotePrice #288 → savePartsQuoteAborted, validado end-to-end headless
// 2026-07-17. El andamiaje id:0 del modal era deuda redundante (nunca se ejecutaba:
// mutEntityType lo saltaba por id falsy). Ver sentinels-config.json entidad quotePrice.

// Abre la FICHA del quote centinela por DEEP-LINK y verifica su identidad in situ.
// Devuelve true si la ficha hidrató Y dice "Centinela" Y ya rindió 'Edit this Part'.
//
// POR QUÉ DEEP-LINK AL DETALLE (rediseño 2026-08-05): la versión anterior buscaba el <a>
// del quote EN LA LISTA (home → clic al link /Quotes → esperar `a[href*="/Quotes/288/"]`).
// Esa ruta murió por DOS razones independientes, ambas medidas en vivo:
//   1. LA LISTA ESTÁ PAGINADA y el centinela SE CAYÓ DE LA PÁGINA 1. Sale ordenada por
//      "Created At Descending", 20 por página; el 2026-08-05 arrancaba en #321 con 167
//      quotes activos, así que #288 quedó fuera. El comentario viejo ("#288, reciente,
//      aparece en la 1ª página") era cierto en julio y CADUCÓ solo, sin que nadie tocara
//      nada: bastó que el negocio cotizara 33 veces más. El síntoma fue un falso
//      "CENTINELA ROTO/ARCHIVADO" en el correo, pidiendo desarchivar un quote que estaba
//      perfectamente ACTIVO — un diagnóstico que manda al operador a la reparación
//      equivocada.
//   2. El clic a `a[href$="/Quotes"]` YA NO ES POSIBLE: el link del sidebar sale
//      `visibility:hidden` en x=-169 (menú colapsado) y `/Domains/{d}` REDIRIGE a `/`.
// Medido 2026-08-05: `/Domains/344/Quotes/288` hidrata a los ~14 s (a los ~4 s si el SPA
// ya está caliente) y rinde 'Edit this Part' + 'Save Parts'. El deep-link al DETALLE no
// depende de paginación, orden, tamaño de página ni del sidebar — las cuatro cosas que
// pueden cambiar sin avisar. (Lo que NO hidrata sigue siendo la LISTA con searchQuery,
// hallazgo 2026-07-17 que se mantiene.)
//
// REGLA GENERAL: un ancla que depende de "está en la primera página" no es un ancla, es
// una carrera contra el uso normal del sistema. Ancla por ID, no por posición.
async function openQuoteSentinelDetail(page, id, domain, intentos = 2) {
  for (let i = 0; i < intentos; i++) {
    await page.goto(`${BASE}/Domains/${domain}/Quotes/${id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const ok = await page.evaluate(
        () => /Centinela/i.test(document.body ? document.body.innerText : '')
          && !!document.querySelector('[aria-label="Edit this Part"]')
      ).catch(() => false);
      if (ok) return true;
      await page.waitForTimeout(1000);
    }
    if (process.env.SA_DBG) console.log(`       [dbg] quote #${id}: la ficha no hidrató/no dice Centinela (intento ${i + 1}/${intentos})`);
  }
  return false;
}

// quotePrice: SaveManyPartNumberPrices — hash unificado VIVO 72946d4d (Steelhead fusionó las
// dos variantes el 2026-07-17; el viejo batch 9da1874e murió y el 'individual' 72946d quedó como
// el único). Se dispara desde la COTIZACIÓN centinela #288. FLUJO REAL del
// operador (2026-07-17): abrir el quote client-side → clic 'Edit this Part' (lapicito) → 'Save
// Parts' se HABILITA solo → clic 'Save Parts' SIN editar nada → dispara el batch "tiro por viaje".
// CLAVE: NO tocar Divisa/precio — editar rompe el estado y Save Parts se deshabilita (por eso la
// captura fallaba antes). PRECONDICIÓN: el quote #288 DEBE estar ACTIVO (desarchivado); archivado
// = read-only. El price-confirm-guard NO aparece (guard = modal individual 'Part Number Price', no
// este 'Save Parts' del quote) y en headless no hay extensión.
async function savePartsQuoteAborted(page, sink, { id, domain }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('SaveManyPartNumberPrices');
  // Deep-link al DETALLE: al volver, la ficha ya rindió 'Edit this Part' (lo verifica el
  // propio helper), así que no hace falta clicar en ninguna lista ni esperar de nuevo.
  const found = await openQuoteSentinelDetail(page, id, domain);
  if (!found) throw new Error('quotePrice: la ficha del quote centinela no hidrató o no dice "Centinela" (¿archivado? ¿id cambiado?)');
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

// ── Familia de PARAMETROS DE SPEC del PN Centinela (captura-y-aborta) ────────
// Cubre SaveMultipleSpecFieldParams y UpdatePartNumberSpecParam en UN solo flujo, como el
// nodo #55 cubre las 3 de mantenimiento. Descubierto en vivo el 2026-08-05 con el DOM que
// aporto el operador; "el sink es el juez" corrigio DOS suposiciones:
//   - El lapiz individual (aria-label="Edit Spec Field Parameter") NO dispara
//     UpdatePartNumberSpecParam: dispara el MISMO SaveMultipleSpecFieldParams que el modal
//     multiple. Steelhead unifico ambos caminos.
//   - "Add Spec" NO dispara AddParamsToPartNumber sino ApplySpecsToPartNumber (otra op).
//     Por eso AddParamsToPartNumber sigue SIN ruta (ver _paraPendiente en sentinels-config).
// UpdatePartNumberSpecParam sale de ARCHIVAR un parametro (aria-label="Archive Parameter"
// + confirmacion), que es exactamente para lo que la usa spec-migrator (archivedAt ISO).
//
// RUTA: /PartNumbers/{id} SIN /Domains/{d} — con el dominio delante la ficha NO hidrata.
//
// ANCLAJES: aria-label estructural + FORMA del icono. Las clases css-<hash> del DOM
// (css-mfslm7, css-15k6obg…) NO se usan: emotion las regenera cuando alguien mueve un
// padding. ⚠️ DEUDA BILINGUE: los aria-label de esta pantalla vienen MEZCLADOS — "Show
// Spec"/"Archive Parameter"/"Edit Spec Field Parameter" en INGLES, pero "Cambiar Nodo de
// Proceso"/"Copiar arriba" en ESPAÑOL. Los tres que usamos estan en ingles HOY; si SH los
// traduce, el ciclo se apaga en silencio. No se inventa la traduccion (regla dura del repo).
async function openPartNumberSentinel(page, id, intentos = 2) {
  for (let i = 0; i < intentos; i++) {
    await page.goto(`${BASE}/PartNumbers/${id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const ok = await page.evaluate(() => /Specs for Part Number/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      if (ok) return true;
      await page.waitForTimeout(1000);
    }
    if (process.env.SA_DBG) console.log(`       [dbg] PN #${id}: la ficha no hidrató (intento ${i + 1}/${intentos})`);
  }
  return false;
}

async function specParamsAborted(page, sink, ctx) {
  const dbg = process.env.SA_DBG;
  const { id } = ctx;
  if (sink && sink.abortOps) {
    sink.abortOps.add('SaveMultipleSpecFieldParams');
    sink.abortOps.add('UpdatePartNumberSpecParam');
  }
  if (!(await openPartNumberSentinel(page, id))) {
    throw new Error('specParams: la ficha del PN centinela no hidrató (¿id cambiado?)');
  }
  // FALLBACK pedido por el operador (2026-08-05): el estado BASE de este centinela fue
  // ARCHIVADO durante meses, y archivado => la seccion de specs sale READ-ONLY (el aviso
  // "This is an archived part number" y los botones deshabilitados). Hoy esta activo, pero
  // si alguien lo re-archiva el ciclo se auto-repara: desarchiva, captura y RE-ARCHIVA en el
  // restore. La marca viaja en el sink para que restore() sepa si debe revertir.
  const estabaArchivado = await archivedChecked(page);
  if (estabaArchivado === true) {
    if (dbg) console.log('       [dbg] PN archivado → desarchivando (fallback) para poder editar specs');
    await archivedToggle(page);
    if (sink) sink.__saPnDesarchivado = true;
    await page.waitForTimeout(2500);
  }
  // Abrir la spec: chevron con aria-label "Show Spec" (+ respaldo por FORMA del icono
  // ExpandMore, que SH no puede cambiar sin cambiar lo que el operador VE).
  const CHEVRON = 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z';
  const abierto = await page.locator('button[aria-label="Show Spec"]').first().click({ timeout: 10000 }).then(() => true).catch(() => false);
  if (!abierto) {
    await page.evaluate((d) => {
      const b = [...document.querySelectorAll('button')].find((x) => [...x.querySelectorAll('svg path')].some((p) => (p.getAttribute('d') || '').trim() === d));
      if (b) b.click();
    }, CHEVRON);
  }
  await page.waitForTimeout(4000);
  if (dbg) console.log(`       [dbg] spec abierta (${abierto ? 'aria' : 'forma'})`);

  // ── 1) SaveMultipleSpecFieldParams: seleccionar un param → "Edit Selected Params" → Save
  const sel = await page.evaluate(() => {
    for (const c of document.querySelectorAll('input[type="checkbox"]')) {
      const tr = c.closest('tr');
      if (tr && !c.checked && !c.disabled && c.offsetParent !== null) { c.click(); return true; }
    }
    return false;
  });
  if (dbg) console.log(`       [dbg] param seleccionado: ${sel}`);
  await page.waitForTimeout(1500);
  await page.locator('button').filter({ hasText: /Edit Selected Params/i }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3000);
  // El Save del modal construye la mutation y el interceptor la ABORTA → cero persistencia.
  for (const re of [/^Save$/i, /^Guardar$/i]) {
    const b = page.locator('[role="dialog"] button').filter({ hasText: re }).first();
    if (await b.count().catch(() => 0)) { await b.click({ timeout: 5000 }).catch(() => {}); break; }
  }
  await page.waitForTimeout(3500);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('[role="dialog"] button')].find((b) => /^(Cancel|Cancelar)$/i.test((b.textContent || '').trim()));
    if (c) c.click();
  });
  await page.waitForTimeout(2000);

  // ── 2) UpdatePartNumberSpecParam: "Archive Parameter" → Confirm (ABORTADA: no archiva)
  await page.locator('button[aria-label="Archive Parameter"]').first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(Confirm|Confirmar|Archive|Archivar)$/i.test((x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(3500);
  if (dbg) console.log(`       [dbg] capturados: ${Object.keys((sink && sink.hashes) || {}).filter((o) => /SpecFieldParams|SpecParam/.test(o)).join(', ') || '(ninguno aún)'}`);
}

// workOrderPartCount: AddPartsToWorkOrders vía CAPTURA-Y-ABORTA. La mutation se dispara al
// GUARDAR el modal "Ajustar Cantidad de Piezas de OT" (icono IsoIcon) de una OT en el detalle
// de la OV Centinela #1603. Marca la op en abortOps ANTES de tocar el DOM → el interceptor
// registra el sha256Hash y ABORTA el request → cero persistencia (la OT no cambia de conteo,
// verificado: sigue 1/1). Ancla del botón IDIOMA-INDEPENDIENTE (aria-label PRESENTE + IsoIcon;
// el otro IsoIcon de la sección BOM no tiene aria-label; NO usa el texto). Verificado en vivo
// 2026-07-17 (hash rotó a5cc8991→70d5a792). Ver sentinels-config.json entidad workOrderPartCount.
async function saveWoPartCountAborted(page, sink, { url }) {
  const dbg = process.env.SA_DBG;
  // MARCAR la op ANTES de cualquier clic que pueda disparar el Save → aborta aunque salga antes.
  if (sink && sink.abortOps) sink.abortOps.add('AddPartsToWorkOrders');
  // navegar al detalle de la OV; hidrata tarde headless → espera ACTIVA al name "Centinela".
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false)) break;
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

// Carga la ficha de la OT Centinela y confirma el marcador. Fail-closed: si el texto
// "Centinela" no aparece, devuelve name vacío y el runner aborta el ciclo sin mutar.
async function loadWorkOrderSentinel(page, { url }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  let isSent = false;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !isSent) {
    isSent = await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false);
    if (!isSent) await page.waitForTimeout(700);
  }
  if (process.env.SA_DBG) console.log(`       [dbg] OT centinela load esCentinela=${isSent}`);
  return { name: isSent ? 'Centinela' : '' };
}

// ── Mutations del AUTO-RUTEADOR y de GRUPOS DE PIEZAS (captura-y-aborta) ────
// Las tres escriben, así que se capturan marcando la op en sink.abortOps ANTES de tocar el
// disparador: el interceptor registra el sha256Hash y ABORTA el request → cero persistencia.
// Doble candado: la OT es la Centinela 11677 (isSentinel fail-closed) + el abort.
// Flujo y DOM confirmados por el operador 2026-07-27.
//
// Los anclajes usan `data-steelhead-component-id`, que es IDIOMA-INDEPENDIENTE y estable
// (mejor que el texto: esta pantalla mezcla español e inglés — "Enrutamiento de Estación"
// junto a "Create Default Routes" y "Select All").

// Abre el diálogo "Agrupar/Serializar Piezas" de la primera partida de la OT.
// Devuelve el locator del diálogo, o null si no abrió.
async function openGroupPartsDialog(page, url) {
  const dbg = process.env.SA_DBG;
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false)) break;
    await page.waitForTimeout(1500);
  }
  // "Más Opciones" (tres puntos) de la primera partida.
  const masOpciones = page.locator('[data-steelhead-component-id="WORK_ORDER_PAGE_PARTS_OPTIONS_ALL_OPTIONS"] button').first();
  await masOpciones.waitFor({ state: 'visible', timeout: 20000 });
  await masOpciones.scrollIntoViewIfNeeded().catch(() => {});
  await masOpciones.click({ timeout: 10000 });
  // "Agrupar/Serializar Piezas" — por component-id, no por texto.
  const item = page.locator('[data-steelhead-component-id="WORK_ORDER_PAGE_PARTS_OPTIONS_GROUP_SERIALIZE_PARTS"] li').first();
  await item.waitFor({ state: 'visible', timeout: 15000 });
  await item.click({ timeout: 10000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  const abierto = await dialog.count().catch(() => 0);
  if (dbg) console.log(`       [dbg] diálogo Agrupar/Serializar ${abierto ? 'abierto' : 'NO abrió'}`);
  return abierto ? dialog : null;
}

// CreateNewPartGroup: se dispara al teclear un nombre INEXISTENTE en el react-select
// "Crear o buscar grupos" y confirmar la opción "Crear …". Se aborta → el grupo no nace.
async function createPartGroupAborted(page, sink, { url }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('CreateNewPartGroup');
  const dialog = await openGroupPartsDialog(page, url);
  if (!dialog) return;
  // "+ Agregar" añade el renglón con el combo. Bilingüe; si no aparece, el combo ya está.
  await dialog.locator('button').filter({ hasText: /^\+\s*(Agregar|Add)$/i }).first()
    .click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  // El input del react-select: aria-label del contenedor + role=combobox (idioma-agnóstico
  // por el role; el aria-label es solo un desempate si hubiera varios).
  const combo = dialog.locator('input[role="combobox"]').first();
  await combo.waitFor({ state: 'visible', timeout: 10000 });
  await combo.click({ timeout: 5000 }).catch(() => {});
  // Nombre que NO existe → el menú ofrece "Crear …"; Enter dispara CreateNewPartGroup.
  await combo.type('CentinelaHashAutopilot', { delay: 40 }).catch(() => {});
  await page.waitForTimeout(1200);
  await combo.press('Enter').catch(() => {});
  await page.waitForTimeout(2500);
  if (dbg) console.log(`       [dbg] crear grupo → ${sink?.hashes?.CreateNewPartGroup ? 'CAPTURADO' : 'sin hash aún'}`);
}

// CreateManyPartsTransfersChecked: se dispara al GUARDAR el diálogo de agrupación con al
// menos un grupo y su cantidad. Se elige un grupo EXISTENTE (primera opción del menú) para
// no depender de CreateNewPartGroup, que en este mismo ciclo va abortado.
async function splitPartsAborted(page, sink, { url }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) {
    sink.abortOps.add('CreateManyPartsTransfersChecked');
    sink.abortOps.add('CreateNewPartGroup'); // por si el combo intentara crear: tampoco escribe
  }
  const dialog = await openGroupPartsDialog(page, url);
  if (!dialog) return;
  await dialog.locator('button').filter({ hasText: /^\+\s*(Agregar|Add)$/i }).first()
    .click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  const combo = dialog.locator('input[role="combobox"]').first();
  await combo.waitFor({ state: 'visible', timeout: 10000 });
  await combo.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await combo.press('ArrowDown').catch(() => {});   // primera opción EXISTENTE del menú
  await combo.press('Enter').catch(() => {});
  await page.waitForTimeout(600);
  // Cantidad: el input de texto del renglón (el combo es role=combobox, no matchea).
  await dialog.locator('input[type="text"]:not([role="combobox"])').first()
    .fill('1').catch(() => {});
  await page.waitForTimeout(500);
  await dialog.locator('button').filter({ hasText: /^(Guardar|Save)$/i }).first()
    .click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (dbg) console.log(`       [dbg] Guardar agrupación → ${sink?.hashes?.CreateManyPartsTransfersChecked ? 'CAPTURADO' : 'sin hash aún'}`);
}

// CreateUpdateDeleteRoutes: la mutation del AUTO-RUTEADOR, que nunca tuvo ruta de
// regeneración (deuda desde su fase 1). Se dispara al GUARDAR el modal "Crear rutas", que
// abre el botón "Create Default Routes" de la sección "Enrutamiento de Estación" al final
// de la ficha de la OT, tras marcar el checkbox de "Rutas Predeterminadas de Orden de
// Trabajo". Ancla: el id `#stationRouting-section`, estable e idioma-independiente.
async function createRoutesAborted(page, sink, { url }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('CreateUpdateDeleteRoutes');
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false)) break;
    await page.waitForTimeout(1500);
  }
  const seccion = page.locator('#stationRouting-section');
  await seccion.waitFor({ state: 'attached', timeout: 20000 });
  await seccion.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);
  // Primer checkbox de la sección = la fila del PN en "Rutas Predeterminadas".
  const cb = seccion.locator('input[type="checkbox"]').first();
  await cb.waitFor({ state: 'attached', timeout: 15000 });
  await cb.click({ force: true, timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  // El botón aparece SOLO con algo marcado. En el DOM real sale en inglés aunque la UI
  // esté en español; se acepta el español por si lo traducen.
  const btn = seccion.locator('button')
    .filter({ hasText: /Create Default Routes|Crear Rutas Predeterminadas/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click({ timeout: 10000 });
  // fail-closed: confirmar que abrió el modal correcto antes de guardar.
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Crear rutas|Create routes/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  if (dbg) console.log('       [dbg] modal "Crear rutas" abierto');
  await dialog.locator('button').filter({ hasText: /^(Guardar|Save)$/i }).first()
    .click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (dbg) console.log(`       [dbg] Guardar rutas → ${sink?.hashes?.CreateUpdateDeleteRoutes ? 'CAPTURADO' : 'sin hash aún'}`);
}

// UpdateManyScheduleTasks — FIJAR la hora de una tarea de programación (wo-schedule-button
// Fase 2a). Se dispara desde la ficha de la OT: botón 📅 del header
// (`svg[data-steelhead…]` no aplica aquí; el ancla real es `svg[data-testid="CalendarMonthIcon"]`
// dentro de un `button[aria-label="View Schedule"]` — VERIFICADO EN VIVO 2026-07-28) → abre un
// modal con un FullCalendar (`.fc-*`) de las tareas de esa OT → clic en el evento → formulario
// con el botón `Update`, que es el que dispara la mutación (breadcrumb `button:Update` del scan
// 2026-07-23 sobre la OT 14983).
//
// ⚠️ REQUISITO DE DATOS: la OT Centinela 11677 **NO tiene ninguna tarea programada** (verificado
// en vivo: el FullCalendar del modal sale vacío), así que HOY este ciclo no puede disparar nada.
// El `load` lo detecta y devuelve name:'' → el ciclo NO corre (fail-closed limpio, sin clicar a
// ciegas) en vez de fingir cobertura. Para habilitarlo basta programar la OT Centinela en el
// tablero (una tarea, estación cualquiera, fecha lejana). Mientras tanto, el DOM del formulario
// del evento es lo ÚNICO no verificado de esta ruta: el botón se ancla por texto EN+ES.
async function fixScheduleTaskAborted(page, sink, { url }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('UpdateManyScheduleTasks');
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false)) break;
    await page.waitForTimeout(1500);
  }
  // 📅 del header (ancla estructural, idioma-independiente).
  const cal = page.locator('button:has(svg[data-testid="CalendarMonthIcon"])').first();
  await cal.waitFor({ state: 'visible', timeout: 20000 });
  await cal.click({ timeout: 10000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  // El calendario es FullCalendar: cada tarea es un `.fc-event`. Sin eventos no hay nada
  // que fijar → se sale sin clicar (la OT centinela debe estar programada, ver nota).
  const evento = dialog.locator('.fc-event, .fc-daygrid-event, .fc-timegrid-event').first();
  const hayEvento = await evento.count().catch(() => 0);
  if (!hayEvento) {
    if (dbg) console.log('       [dbg] calendario de la OT centinela SIN tareas → nada que disparar');
    return;
  }
  await evento.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  // El formulario del evento trae el botón Update (única parte NO verificada de la ruta).
  const btn = page.locator('[role="dialog"] button')
    .filter({ hasText: /^(Update|Actualizar)$/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await btn.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (dbg) console.log(`       [dbg] Update tarea → ${sink?.hashes?.UpdateManyScheduleTasks ? 'CAPTURADO' : 'sin hash aún'}`);
}

// ── Mutations de REPORTES (captura-y-aborta) ────────────────────────────────
// Las 4 mutations del módulo Reporting rotaron el 2026-07-20 (report-liberator usa las 3 de
// /Reporting/Edit; report-regen usa GenerateDuckDb). Se recapturan por CAPTURA-Y-ABORTA: se
// marca la op en sink.abortOps ANTES de clicar el disparador → el interceptor registra el
// sha256Hash y ABORTA el request → CERO efecto (no borra carpeta, no archiva, no crea reporte,
// no regenera la DB). Doble candado: el loadObject verifica que existe el objeto "Centinela"
// (isSentinel fail-closed) + el abort. Selectores idioma-independientes por data-testid/aria-label
// (el DOM real los trae en inglés aunque la UI esté en español); botones de modal bilingües.
// Flujo y DOM confirmados por el operador 2026-07-20.
const REPORTING_EDIT = '/Reporting/Edit';

// Aísla la fila "Centinela" del árbol de Saved Reports. Las clases jssNN del DOM que dio el
// operador son JSS DINÁMICAS (cambian por sesión) → NO se pueden usar. Se FILTRA por
// "Filter queries..." (el árbol es largo/virtualizado; la fila no está en el DOM hasta filtrar)
// y se ancla por aria-label + innerText de la fila vía evaluate-mark: se marca con data-sa-rep
// el svg[aria-label] cuya fila (ancestro) innerText==="Centinela". Verificado headless 2026-07-20
// (hit 1/1 tras filtrar, con la carpeta+reporte "Centinela" persistentes creados por el operador).
async function filterReportTree(page, term) {
  const f = page.locator('input[placeholder*="ilter quer" i], input[placeholder*="iltrar" i]').first();
  if (await f.count().catch(() => 0)) { await f.fill(term).catch(() => {}); await page.waitForTimeout(2000); }
}
async function markCentinelaAction(page, ariaLabel) {
  return page.evaluate((aria) => {
    document.querySelectorAll('[data-sa-rep]').forEach((e) => e.removeAttribute('data-sa-rep'));
    for (const svg of document.querySelectorAll(`svg[aria-label="${aria}"]`)) {
      let el = svg;
      for (let i = 0; i < 6 && el; i++) { el = el.parentElement; if (el && el.innerText && /^centinela$/i.test(el.innerText.trim())) { svg.setAttribute('data-sa-rep', '1'); return true; } }
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

// DeleteFolderById: basura de la carpeta "Centinela" → modal "Delete Folder" → Delete.
async function deleteFolderCentinelaAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('DeleteFolderById');
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('input[placeholder*="ilter quer" i]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await filterReportTree(page, 'Centinela');
  if (!(await markCentinelaAction(page, 'Delete folder'))) { if (dbg) console.log('       [dbg] carpeta Centinela no hallada'); return; }
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

// CreateUpdateReportWithPermissions: "Guardar informe" (SaveIcon) → nombre "Centinela" → "Guardar como nuevo".
async function saveReportAsNewAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('CreateUpdateReportWithPermissions');
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const saveBtn = page.locator('button:has(svg[data-testid="SaveIcon"])').first();
  await saveBtn.waitFor({ state: 'visible', timeout: 25000 });
  await saveBtn.click({ force: true, timeout: 10000 });
  const dialog = page.locator('[role="dialog"]').filter({ hasText: /Guardar informe|Save Report/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: 12000 });
  // input de NOMBRE (MUI, no los react-select de carpeta/permisos) → "Centinela".
  await dialog.locator('input.MuiOutlinedInput-input').first().fill('Centinela').catch(() => {});
  await page.waitForTimeout(500);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(sink && sink.hashes && sink.hashes.CreateUpdateReportWithPermissions)) {
    await dialog.locator('button').filter({ hasText: /Guardar como nuevo|Save as New/i }).first().click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] Save as New → ${sink && sink.hashes && sink.hashes.CreateUpdateReportWithPermissions ? 'CAPTURADO' : 'sin hash aún'}`);
}

// ArchiveReport: archivar la línea del reporte "Centinela" (ArchiveIcon) → confirmar "Sí"/"Yes".
async function archiveReportCentinelaAborted(page, sink) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('ArchiveReport');
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('input[placeholder*="ilter quer" i]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await filterReportTree(page, 'Centinela');
  if (!(await markCentinelaAction(page, 'Archive report'))) { if (dbg) console.log('       [dbg] reporte Centinela no hallado'); return; }
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

// ── Mutation de INVOICE PDF (captura-y-aborta) ──────────────────────────────
// CreateInvoicePdf (usedBy invoice-auto-regen) es VIGENTE (verificado por hash-scanner 2026-07-24:
// aafd22aa…, count 3, errorCount 0). Ruta: /Invoices?mode=PackingSlips → flecha 'Open PDF'
// (OpenInNewIcon) → modal → icono RestorePageOutlinedIcon → CONFIRMAR. Se marca la op en
// sink.abortOps ANTES de disparar → el interceptor registra el sha256Hash y ABORTA → CERO efecto.
// CAVEAT: el modal del PDF NO abre confiable en headless (abrió 1/~10) → captura best-effort;
// fallback real = hash-scanner (ver nota en sentinels-config invoicePdf).
async function createInvoicePdfAborted(page, { domain, sink }) {
  const dbg = process.env.SA_DBG;
  if (sink && sink.abortOps) sink.abortOps.add('CreateInvoicePdf');
  await page.goto(`${BASE}/Domains/${domain}/Invoices?mode=PackingSlips&roOffset=0`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const openPdf = page.locator('svg[data-testid="OpenInNewIcon"]').first();
  await openPdf.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  // Reintenta abrir el modal (flaky headless): clic al icono hasta que aparezca el regen icon.
  const openDeadline = Date.now() + 30000;
  while (Date.now() < openDeadline && !(await page.locator('svg[data-testid="RestorePageOutlinedIcon"]').count().catch(() => 0))) {
    await openPdf.click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  const regen = page.locator('svg[data-testid="RestorePageOutlinedIcon"]').first();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(sink && sink.hashes && sink.hashes.CreateInvoicePdf)) {
    await regen.click({ force: true, timeout: 5000 }).catch(() => {});
    // El clic abre un mini-modal 'Are you sure you would like to regenerate this pdf?'
    // → botón Confirmar/Confirm dispara CreateInvoicePdf (el interceptor lo ABORTA → NO regenera).
    const confirm = page.locator('button').filter({ hasText: /^(Confirmar|Confirm)$/i }).first();
    await confirm.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    await confirm.click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  if (dbg) console.log(`       [dbg] CreateInvoicePdf → ${sink && sink.hashes && sink.hashes.CreateInvoicePdf ? 'CAPTURADO' : 'sin hash (modal no abrió — usar hash-scanner)'}`);
}

// Load compartido: verifica que la fila "Centinela" del tipo dado existe (isSentinel fail-closed).
async function loadReportingRow(page, ariaLabel) {
  await page.goto(`${BASE}${REPORTING_EDIT}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.locator('input[placeholder*="ilter quer" i]').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  await filterReportTree(page, 'Centinela');
  return { name: (await markCentinelaAction(page, ariaLabel)) ? 'Centinela' : '' };
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
      // restaurar el valor base del centinela ('.') → deja el quote como estaba
      await editExternalNote(page, id, domain, '.');
    },
  },
  receivedOrder: {
    async load(page, { domain }) {
      // salvaguarda C.3 (create-capture-cleanup): NO requiere una OV existente (la 1594 de
      // referencia está archivada). Verifica que el dashboard de OVs carga en el dominio correcto
      // (botón crear OV = MuiButton-contained con AddIcon presente) → contexto OK, fail-closed.
      // La OV se CREA marcada "Centinela" y se archiva; la salvaguarda real es esa marca.
      await page.goto(`${BASE}/Domains/${domain}/SalesOrders?receivedOrderStatusFilter=OPEN`, { waitUntil: 'domcontentloaded' });
      const newBtn = page.locator('button:has(svg[data-testid="AddIcon"])').first();
      await newBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      const hasNewBtn = await page.locator('button:has(svg[data-testid="AddIcon"])').count().catch(() => 0);
      if (process.env.SA_DBG) console.log(`       [dbg] OV dash: addIcon btns=${hasNewBtn}`);
      return { name: hasNewBtn ? 'Centinela (create-capture)' : '' };
    },
    async mutate(page, { domain }) {
      // crear una OV nueva "Centinela" → dispara CreateReceivedOrder
      await createCentinelaOV(page, domain);
    },
    async restore(page, { domain }) {
      // archivar TODAS las OV Centinela creadas por el ciclo (limpieza) — SIEMPRE
      await archiveCentinelaOVs(page, domain);
    },
  },
  receivedOrderEdit: {
    async load(page, { id, domain }) {
      // OV EXISTENTE marcada "Centinela" (edit-restore). Fail-closed: si el detalle NO
      // contiene "Centinela", name='' → runMutationCycle NO muta ni restaura.
      // Espera ACTIVA a que el nombre renderice: el detalle de OV hidrata tarde y un
      // timeout fijo daba FALSO NEGATIVO (isCentinela=false sobre una OV que SÍ lo es).
      await page.goto(`${BASE}/Domains/${domain}/SalesOrders/${id}`, { waitUntil: 'domcontentloaded' });
      let isSent = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !isSent) {
        isSent = await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false);
        if (!isSent) await page.waitForTimeout(500);
      }
      if (process.env.SA_DBG) console.log(`       [dbg] receivedOrderEdit load id=${id} isCentinela=${isSent}`);
      return { name: isSent ? 'Centinela' : '' };
    },
    async mutate(page) {
      // cambio real del PO# → SAVE dispara UpdateReceivedOrder
      await editSalesOrderPoAndSave(page, 'SA-SENTINEL-CAP');
    },
    async restore(page) {
      // restaurar el PO# a vacío (base del centinela) — SIEMPRE
      await editSalesOrderPoAndSave(page, '');
    },
  },
  quotePrice: {
    // load: abre la FICHA del quote centinela por deep-link y verifica su identidad ahí
    // mismo (fail-closed). id COMPARTIDO con 'quote' (288): entityFor devuelve 'quote' para
    // el load, pero el ciclo usa entityType='quotePrice' para mutate/restore.
    async load(page, { id, domain }) {
      // La ficha sólo rinde 'Edit this Part' si el quote está ACTIVO (archivado = read-only)
      // — fail-closed: si no hidrata o no dice "Centinela", name='' → el ciclo NO muta.
      // Verifica el NOMBRE del objeto, no su presencia en una lista paginada (2026-08-05).
      const found = await openQuoteSentinelDetail(page, id, domain);
      return { name: found ? 'Centinela' : '' };
    },
    async mutate(page, ctx) { await savePartsQuoteAborted(page, ctx.sink, ctx); },
    async restore(page, ctx) {
      // Save Parts se ABORTÓ → nada persistió → nada que restaurar. Solo desmarcar la op.
      if (ctx.sink && ctx.sink.abortOps) ctx.sink.abortOps.delete('SaveManyPartNumberPrices');
    },
  },
  partNumberSpecParams: {
    // load: abre la ficha del PN centinela y verifica identidad ahi mismo (fail-closed).
    // NO exige que este activo: si esta archivado, el mutate lo desarchiva (fallback) y el
    // restore lo devuelve a archivado. Verificar el NOMBRE, no el estado.
    async load(page, { id }) {
      const ok = await openPartNumberSentinel(page, id);
      if (!ok) return { name: '' };
      const cent = await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      return { name: cent ? 'Centinela' : '' };
    },
    async mutate(page, ctx) { await specParamsAborted(page, ctx.sink, ctx); },
    async restore(page, ctx) {
      const sink = ctx.sink;
      // Las mutations se ABORTARON => nada que revertir de las specs. Lo unico que SI
      // persiste es el desarchivado del fallback: hay que re-archivar SIEMPRE. Va antes de
      // limpiar el sink para que un fallo aqui no se coma la marca.
      if (sink && sink.__saPnDesarchivado) {
        try {
          if ((await archivedChecked(page)) === false) {
            await archivedToggle(page);
            if (process.env.SA_DBG) console.log('       [dbg] PN re-archivado (restore del fallback)');
          }
        } finally { sink.__saPnDesarchivado = false; }
      }
      if (sink && sink.abortOps) {
        sink.abortOps.delete('SaveMultipleSpecFieldParams');
        sink.abortOps.delete('UpdatePartNumberSpecParam');
      }
    },
  },
  workOrderPartCount: {
    // load: verifica que la OV Centinela hidrata + su nombre contiene 'Centinela' (isSentinel
    // fail-closed). Si no hidrata / no es Centinela → name='' → runMutationCycle NO muta.
    async load(page, { url }) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      let isSent = false;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !isSent) {
        isSent = await page.evaluate(() => /Centinela/i.test(document.body ? document.body.innerText : '')).catch(() => false);
        if (!isSent) await page.waitForTimeout(500);
      }
      if (process.env.SA_DBG) console.log(`       [dbg] workOrderPartCount load isCentinela=${isSent}`);
      return { name: isSent ? 'Centinela' : '' };
    },
    async mutate(page, ctx) { await saveWoPartCountAborted(page, ctx.sink, ctx); },
    async restore(page, { sink }) {
      // Save abortado → nada persistió → nada que restaurar. Solo desmarcar la op (higiene del sink).
      if (sink && sink.abortOps) sink.abortOps.delete('AddPartsToWorkOrders');
    },
  },
  // ── OT Centinela 11677: grupos de piezas y rutas (todas captura-y-aborta) ──
  // Las tres comparten el mismo load: la ficha de la OT debe decir "Centinela".
  partGroupCreate: {
    async load(page, ctx) { return loadWorkOrderSentinel(page, ctx); },
    async mutate(page, ctx) { await createPartGroupAborted(page, ctx.sink, ctx); },
    async restore(page, { sink }) {
      if (sink && sink.abortOps) sink.abortOps.delete('CreateNewPartGroup');
    },
  },
  partsSplitTransfer: {
    async load(page, ctx) { return loadWorkOrderSentinel(page, ctx); },
    async mutate(page, ctx) { await splitPartsAborted(page, ctx.sink, ctx); },
    async restore(page, { sink }) {
      if (sink && sink.abortOps) {
        sink.abortOps.delete('CreateManyPartsTransfersChecked');
        sink.abortOps.delete('CreateNewPartGroup');
      }
    },
  },
  workOrderRoutes: {
    async load(page, ctx) { return loadWorkOrderSentinel(page, ctx); },
    async mutate(page, ctx) { await createRoutesAborted(page, ctx.sink, ctx); },
    async restore(page, { sink }) {
      if (sink && sink.abortOps) sink.abortOps.delete('CreateUpdateDeleteRoutes');
    },
  },
  workOrderScheduleFix: {
    // load reforzado: además del marcador Centinela, exige que la OT TENGA una tarea en el
    // calendario. Sin tarea no hay `Update` que clicar, y un ciclo que clica a ciegas en una
    // pantalla de programación es peor que uno que no corre.
    async load(page, ctx) {
      const base = await loadWorkOrderSentinel(page, ctx);
      if (!base.name) return base;
      const cal = page.locator('button:has(svg[data-testid="CalendarMonthIcon"])').first();
      const ok = await cal.waitFor({ state: 'visible', timeout: 15000 }).then(() => 1).catch(() => 0);
      if (!ok) return { name: '' };
      await cal.click({ timeout: 10000 }).catch(() => {});
      const dialog = page.locator('[role="dialog"]').first();
      await dialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      const n = await dialog.locator('.fc-event, .fc-daygrid-event, .fc-timegrid-event').count().catch(() => 0);
      if (process.env.SA_DBG) console.log(`       [dbg] tareas en el calendario de la OT centinela: ${n}`);
      return { name: n > 0 ? 'Centinela' : '' };
    },
    async mutate(page, ctx) { await fixScheduleTaskAborted(page, ctx.sink, ctx); },
    async restore(page, { sink }) {
      if (sink && sink.abortOps) sink.abortOps.delete('UpdateManyScheduleTasks');
    },
  },
  maintenanceNode: {
    async load(page, { domain }) {
      // create-event-capture: no muta un nodo existente, crea un EVENTO sobre el nodo
      // centinela. Verifica que la pantalla de Mantenimiento carga (botón "New
      // Maintenance Event" presente) → contexto OK. La salvaguarda real es seleccionar
      // el nodo "Centinela" por nombre en el combobox (fail-closed si no aparece).
      await page.goto(`${BASE}/Domains/${domain}/Maintenance`, { waitUntil: 'domcontentloaded' });
      const btn = page.locator('button', { hasText: /New Maintenance Event/ }).first();
      await btn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      const ok = await page.locator('button', { hasText: /New Maintenance Event/ }).count().catch(() => 0);
      if (process.env.SA_DBG) console.log(`       [dbg] maint dash: newEventBtn=${ok}`);
      return { name: ok ? 'Centinela (maint-capture)' : '' };
    },
    async mutate(page, { domain, sink }) {
      // crear evento + comentar + completar sobre el nodo Centinela → dispara los 3
      await createMaintenanceEventOnCentinela(page, domain, sink);
    },
    async restore() {
      // no-op: el mutate ya archiva el evento creado con el mismo toggle que dispara
      // UpdateMaintenanceEvent (self-clean). Evitamos re-buscar un checkbox aquí para
      // no clicar por error otro checkbox si la página navegó. Un run INTERRUMPIDO
      // podría dejar un evento sin archivar (fuga menor, evento centinela inofensivo).
    },
  },
  // ── REPORTES (captura-y-aborta) — cero efecto, restore solo desmarca la op del sink ──
  reportGenerateDb: {
    async load(page) {
      await page.goto(`${BASE}/Reporting/Databases`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ok = await page.locator('button:has(svg[data-testid="CloudDownloadIcon"])').first()
        .waitFor({ state: 'visible', timeout: 20000 }).then(() => 1).catch(() => 0);
      return { name: ok ? 'Centinela (regenerate-db capture-abort)' : '' };
    },
    async mutate(page, { sink }) { await generateDuckDbAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('GenerateDuckDb'); },
  },
  reportFolderDelete: {
    async load(page) { return loadReportingRow(page, 'Delete folder'); },
    async mutate(page, { sink }) { await deleteFolderCentinelaAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('DeleteFolderById'); },
  },
  reportSaveAsNew: {
    async load(page) {
      // No requiere el reporte Centinela existente (crea uno nuevo y aborta): verifica el
      // botón "Guardar informe" (contexto del editor de reportes) → isSentinel fail-closed.
      await page.goto(`${BASE}/Reporting/Edit`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ok = await page.locator('button:has(svg[data-testid="SaveIcon"])').first()
        .waitFor({ state: 'visible', timeout: 20000 }).then(() => 1).catch(() => 0);
      return { name: ok ? 'Centinela (save-as-new capture-abort)' : '' };
    },
    async mutate(page, { sink }) { await saveReportAsNewAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('CreateUpdateReportWithPermissions'); },
  },
  reportArchive: {
    async load(page) { return loadReportingRow(page, 'Archive report'); },
    async mutate(page, { sink }) { await archiveReportCentinelaAborted(page, sink); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('ArchiveReport'); },
  },
  // ── INVOICE PDF (captura-y-aborta) — VIGENTE; captura headless best-effort, fallback hash-scanner ──
  invoicePdf: {
    async load(page, { domain }) {
      await page.goto(`${BASE}/Domains/${domain}/Invoices?mode=PackingSlips&roOffset=0`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const ok = await page.locator('svg[data-testid="OpenInNewIcon"]').first()
        .waitFor({ state: 'visible', timeout: 20000 }).then(() => 1).catch(() => 0);
      return { name: ok ? 'Centinela (invoice-pdf capture-abort)' : '' };
    },
    async mutate(page, ctx) { await createInvoicePdfAborted(page, ctx); },
    async restore(page, { sink }) { if (sink && sink.abortOps) sink.abortOps.delete('CreateInvoicePdf'); },
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
