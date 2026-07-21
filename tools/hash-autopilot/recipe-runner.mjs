// tools/hash-autopilot/recipe-runner.mjs
// Instala el interceptor de /graphql en una page de Playwright y ejecuta recetas
// de navegación mínimas para que el frontend dispare cada op y capturemos su hash.
const BASE = 'https://app.gosteelhead.com';

// PURO (testeable): dado el body de un POST a /graphql y el set de ops a
// "capturar-y-abortar", decide si abortar y qué hash(es) registrar. Para mutations
// de ESCRITURA (precios): capturamos el sha256Hash que el frontend IBA a enviar y
// ABORTAMOS el request → NUNCA llega al server → cero efecto (no se guarda el precio).
export function shouldAbortAndCapture(body, abortOps) {
  const out = { abort: false, captures: {} };
  if (!abortOps || !abortOps.size) return out;
  const ops = Array.isArray(body) ? body : [body];
  for (const op of ops) {
    const name = op && op.operationName;
    const hash = op && op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
    if (name && abortOps.has(name)) { out.abort = true; if (hash) out.captures[name] = hash; }
  }
  return out;
}

// Registra op→{hash,data} de cada POST a /graphql que pase por la page.
export async function installInterceptor(page, sink) {
  await page.route('**/*graphql*', async (route) => {
    const req = route.request();
    let body = null;
    try { body = req.postDataJSON(); } catch { try { body = JSON.parse(req.postData() || '{}'); } catch { body = null; } }
    // Captura-y-aborta (mutations de escritura en sink.abortOps, p.ej. AddPartsToWorkOrders,
    // precios): registra el hash y ABORTA el request ANTES del fetch → el server NUNCA lo
    // recibe (cero persistencia). Sin respuesta no hay responseOk, pero el motor luego PRUEBA
    // el liveHash (variables vacías, sin ejecutar) → si el server lo reconoce, se auto-deploya
    // igual que las queries (isValidatedCapture); si no, queda 'sospechoso' → revisión humana.
    const ab = shouldAbortAndCapture(body, sink.abortOps);
    if (ab.abort) {
      Object.assign(sink.hashes, ab.captures);
      // Registrar las ops capturadas-y-abortadas → el motor luego PRUEBA su liveHash
      // (variables vacías, sin ejecutar la escritura) para validarlas y poder
      // auto-deployarlas aunque no haya responseOk (ver isValidatedCapture).
      if (sink.abortedOps) for (const name of Object.keys(ab.captures)) sink.abortedOps.add(name);
      try { await route.abort(); } catch { /* route ya resuelta */ }
      return;
    }
    // Re-fetch + fulfill DEFENSIVO: si el re-fetch truena (blip de red, request
    // abortada por navegación) NO debe tumbar toda la corrida. Deja pasar la
    // request normal (continue) o la aborta; solo se pierde esa captura.
    let resp = null, json = null;
    try {
      resp = await route.fetch();
      try { json = await resp.json(); } catch { json = null; }
      await route.fulfill({ response: resp });
    } catch (e) {
      try { await route.continue(); } catch { try { await route.abort(); } catch { /* route ya resuelta */ } }
      return;
    }
    const ops = Array.isArray(body) ? body : [body];
    const datas = Array.isArray(json) ? json : [json];
    ops.forEach((op, i) => {
      const name = op && op.operationName;
      const hash = op && op.extensions && op.extensions.persistedQuery && op.extensions.persistedQuery.sha256Hash;
      if (name && hash) {
        sink.hashes[name] = hash;
        const d = datas[i] || datas[0] || {};
        if (d && d.data) sink.data[name] = d.data;
        // responseOk: el frontend obtuvo data sin errors → el hash es válido de facto
        if (d && d.data && !(d.errors && d.errors.length)) sink.responseOk[name] = true;
      }
    });
  });
}

// Corre una receta: navega los pasos y ESPERA ACTIVAMENTE a que el frontend
// dispare las ops de `captures` (la SPA tarda en montar tras el bootstrap; un
// timeout fijo no basta). El sink lo llena el interceptor de installInterceptor().
export async function runRecipe(page, recipe, domain, sink, stepTimeoutMs = 25000) {
  const url = (p) => BASE + p.replace('{domain}', String(domain));
  const need = recipe.captures || [];
  const haveAll = () => need.length > 0 && need.every((op) => sink && sink.hashes[op]);

  for (const step of recipe.steps) {
    if (step.goto) {
      // domcontentloaded es rápido; el SPA hidrata después. Timeout amplio (red lenta
      // headless) y no-throw: seguimos aunque la carga no "complete" del todo.
      await page.goto(url(step.goto), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } else if (step.clickFirst) {
      // CLIENT-SIDE nav: espera ACTIVA a que la lista rinda el <Link> de detalle
      // (headless tarda en hidratar + fetchear filas) y hace CLIC REAL → dispara la
      // query de detalle sin re-bootstrapear el SPA (page.goto sí lo re-bootstrapea
      // y por eso NO fetcheaba). Reintenta el clic hasta capturar o vencer.
      await clickFirstMatching(page, step.clickFirst, step.hrefMatches || null, sink, need, stepTimeoutMs);
    } else if (step.clickButton) {
      // Clic en un BOTÓN por TEXTO (abre un modal cuyo schema/query es la op a
      // capturar; p.ej. "Edit Sales Order" → CreateEditReceivedOrderDialogQuery,
      // "Add Parts (Table)" → GetAddPartsReceivedOrder). El regex es BILINGÜE ES+EN
      // (el headless corre en INGLÉS, pero el operador puede verlo en español).
      await clickButtonMatching(page, step.clickButton, sink, need, stepTimeoutMs);
    } else if (step.selectFirstOption) {
      // Abre un react-select (clic en el combobox) y elige su PRIMERA opción → algunos
      // queries solo se disparan al SELECCIONAR (p.ej. "Add Spec" → elegir un spec del
      // dropdown dispara SpecFieldsAndOptions). step.selectFirstOption = selector del input
      // combobox (típ. '[role="dialog"] input[role="combobox"]').
      await selectFirstOptionMatching(page, step.selectFirstOption, sink, need, stepTimeoutMs);
    }
    // espera activa: pollea hasta capturar las ops de la receta o vencer timeout
    const start = Date.now();
    while (!haveAll() && Date.now() - start < stepTimeoutMs) {
      await page.waitForTimeout(600);
    }
  }
}

// Espera hasta timeoutMs a que aparezca un <a> que matchee sel (+ hrefMatches) y
// hace CLIC REAL (client-side). Reintenta si la lista aún no rindió filas. Para en
// cuanto captura las ops o vence. Devuelve true si logró clicar.
async function clickFirstMatching(page, sel, hrefMatches, sink, need, timeoutMs) {
  const haveAll = () => need.length > 0 && need.every((op) => sink && sink.hashes[op]);
  const deadline = Date.now() + timeoutMs;
  let clickedOnce = false;
  while (Date.now() < deadline && !haveAll()) {
    let handle = null;
    try {
      handle = await page.evaluateHandle(({ sel, reSrc }) => {
        const re = reSrc ? new RegExp(reSrc) : null;
        const els = [...document.querySelectorAll(sel)];
        return els.find((a) => !re || re.test(a.getAttribute('href') || '')) || null;
      }, { sel, reSrc: hrefMatches });
      const el = handle.asElement();
      if (el) {
        await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await el.click({ timeout: 5000 });
        clickedOnce = true;
        // Tras clicar, dale una ventana a que dispare la query antes de reintentar.
        const t = Date.now();
        while (!haveAll() && Date.now() - t < 4000) await page.waitForTimeout(400);
      } else {
        await page.waitForTimeout(600); // lista aún sin filas → reintentar
      }
    } catch { await page.waitForTimeout(500); }
    finally { if (handle) await handle.dispose().catch(() => {}); }
    if (clickedOnce && haveAll()) break;
  }
  return clickedOnce;
}

// Matcher PURO (testeable sin browser): ¿el texto de un botón matchea el patrón
// bilingüe? Case-insensitive, tolera espacios (el innerText headless llega en
// MAYÚSCULAS por text-transform, y con \s colapsables).
export function buttonTextMatches(text, reSrc) {
  if (!text || !reSrc) return false;
  try { return new RegExp(reSrc, 'i').test(String(text).trim().replace(/\s+/g, ' ')); }
  catch { return false; }
}

// Espera hasta timeoutMs a que aparezca un <button>/[role=button] cuyo texto matchee
// reSrc (BILINGÜE ES+EN, case-insensitive) y lo CLICA → abre el modal cuyo schema/query
// es la op a capturar. Reintenta si el botón aún no rindió. Para al capturar o vencer.
async function clickButtonMatching(page, reSrc, sink, need, timeoutMs) {
  const haveAll = () => need.length > 0 && need.every((op) => sink && sink.hashes[op]);
  const deadline = Date.now() + timeoutMs;
  let clickedOnce = false;
  while (Date.now() < deadline && !haveAll()) {
    let handle = null;
    try {
      handle = await page.evaluateHandle((src) => {
        const re = new RegExp(src, 'i');
        const els = [...document.querySelectorAll('button, [role="button"], a.MuiButton-root')];
        return els.find((b) => re.test(((b.innerText || b.textContent || '').trim().replace(/\s+/g, ' ')))) || null;
      }, reSrc);
      const el = handle.asElement();
      if (el) {
        await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await el.click({ timeout: 5000 });
        clickedOnce = true;
        // Tras abrir el modal, ventana para que dispare su query antes de reintentar.
        const t = Date.now();
        while (!haveAll() && Date.now() - t < 4000) await page.waitForTimeout(400);
      } else {
        await page.waitForTimeout(600); // el botón aún no rinde → reintentar
      }
    } catch { await page.waitForTimeout(500); }
    finally { if (handle) await handle.dispose().catch(() => {}); }
    if (clickedOnce && haveAll()) break;
  }
  return clickedOnce;
}

// Abre un react-select (clic en su input combobox) y elige la PRIMERA opción del
// listbox → dispara la query que carga los datos de esa selección. Reintenta hasta
// capturar `need` o vencer. Es LECTURA (no guarda) — solo poblar el dropdown y elegir.
async function selectFirstOptionMatching(page, comboSel, sink, need, timeoutMs) {
  const haveAll = () => need.length > 0 && need.every((op) => sink && sink.hashes[op]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !haveAll()) {
    try {
      const combo = page.locator(comboSel).first();
      if (await combo.count()) {
        await combo.click({ timeout: 5000 });
        await page.waitForTimeout(1500); // dejar que el listbox renderice las opciones
        const opt = page.locator('[role="option"]').first();
        if (await opt.count()) await opt.click({ timeout: 5000 });
        const t = Date.now();
        while (!haveAll() && Date.now() - t < 4000) await page.waitForTimeout(400);
      } else {
        await page.waitForTimeout(600); // el combobox aún no rinde → reintentar
      }
    } catch { await page.waitForTimeout(500); }
  }
}
