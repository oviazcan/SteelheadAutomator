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
    const resp = await route.fetch();
    let json = null;
    try { json = await resp.json(); } catch { json = null; }
    await route.fulfill({ response: resp });
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
      await page.goto(url(step.goto), { waitUntil: 'domcontentloaded' });
    } else if (step.clickFirst) {
      await page.waitForTimeout(2000);
      const handle = await page.evaluateHandle(({ sel, reSrc }) => {
        const re = reSrc ? new RegExp(reSrc) : null;
        const els = [...document.querySelectorAll(sel)];
        return els.find((a) => !re || re.test(a.getAttribute('href') || '')) || null;
      }, { sel: step.clickFirst, reSrc: step.hrefMatches || null });
      const el = handle.asElement();
      if (el) await el.click();
    }
    // espera activa: pollea hasta capturar las ops de la receta o vencer timeout
    const start = Date.now();
    while (!haveAll() && Date.now() - start < stepTimeoutMs) {
      await page.waitForTimeout(600);
    }
  }
}
