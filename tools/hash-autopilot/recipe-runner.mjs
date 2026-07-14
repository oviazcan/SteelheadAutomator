// tools/hash-autopilot/recipe-runner.mjs
// Instala el interceptor de /graphql en una page de Playwright y ejecuta recetas
// de navegación mínimas para que el frontend dispare cada op y capturemos su hash.
const BASE = 'https://app.gosteelhead.com';

// Registra op→{hash,data} de cada POST a /graphql que pase por la page.
export async function installInterceptor(page, sink) {
  await page.route('**/*graphql*', async (route) => {
    const req = route.request();
    let body = null;
    try { body = req.postDataJSON(); } catch { try { body = JSON.parse(req.postData() || '{}'); } catch { body = null; } }
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
