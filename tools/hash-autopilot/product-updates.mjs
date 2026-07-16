// tools/hash-autopilot/product-updates.mjs
// Antes de auto-corregir, el motor lee https://app.gosteelhead.com/ProductUpdates
// (changelog de Steelhead) para tener PISTAS de qué cambió — contexto que ayuda a
// entender por qué rotó un hash y a atribuir el cambio. Best-effort + fail-safe:
// si truena o no hay nada, devuelve {entries:[], snippet:''} y el motor sigue.

const BASE = 'https://app.gosteelhead.com';

// fetchProductUpdates(page, limit) → { entries:[str], snippet, title, url, fetchedAt:null }.
// Corre en la page ya autenticada (ROCP). La extracción DOM es best-effort porque
// no conocemos el markup exacto: intenta tarjetas/artículos y cae a innerText.
export async function fetchProductUpdates(page, limit = 8) {
  try {
    await page.goto(`${BASE}/ProductUpdates`, { waitUntil: 'domcontentloaded' });
  } catch { /* sigue: quizá cargó parcial */ }
  // El changelog es un SPA route: espera a que aparezca contenido real (poll hasta
  // ~8s), no un timeout fijo — igual que el resto del app tarda en hidratar.
  try {
    // El changelog renderiza vía "markdown renderer" que tarda: "Loading markdown
    // renderer..." repetido ya supera 400 chars, así que bodyLen NO basta. Esperar al
    // ancla real del changelog ("STEELHEAD PRODUCT UPDATES") y a que se vaya el loader.
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText) || '';
      return /STEELHEAD PRODUCT UPDATES/i.test(t) && !/Loading markdown renderer/i.test(t);
    }, { timeout: 15000 });
    await page.waitForTimeout(1500);
  } catch { try { await page.waitForTimeout(3000); } catch {} }
  return page.evaluate((limit) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const bodyText = clean(document.body ? document.body.innerText : '');
    // GUARD: confirmar que ES la página real del changelog (ancla estable "STEELHEAD
    // PRODUCT UPDATES" o el <title>). Sin esto, un selector amplio captura basura de
    // otras secciones (búsqueda, sugerencias del asistente AI) cuando el changelog no
    // cargó — que es lo que ensuciaba el correo. Si no es la página correcta → vacío.
    const ANCHOR = 'STEELHEAD PRODUCT UPDATES';
    const aidx = bodyText.toUpperCase().indexOf(ANCHOR);
    // Exigir el ancla EN EL BODY (el changelog realmente cargó). El <title> "Product
    // Updates" está aunque el markdown no haya renderizado → no basta. Sin ancla → vacío
    // (evita mandar "Loading markdown renderer..." o basura de otras secciones al correo).
    if (aidx === -1) return { entries: [], snippet: '', title: document.title || '', url: location.href, bodyLen: bodyText.length };
    // Contenido del changelog = desde el ancla en adelante (descarta header/nav/precios de metales).
    const content = aidx >= 0 ? clean(bodyText.slice(aidx + ANCHOR.length)) : bodyText;
    // Partir en entradas por bloque de fecha ("JULY 15, 2026"): fecha → texto del update.
    const dateRe = /([A-Z][a-zA-Z]+ \d{1,2}, \d{4})/g;
    const parts = content.split(dateRe);
    const entries = [];
    for (let i = 1; i < parts.length - 1; i += 2) {
      const date = clean(parts[i]);
      const body = clean(parts[i + 1]);
      if (body) entries.push(`${date}: ${body.length > 280 ? body.slice(0, 280) + '…' : body}`);
      if (entries.length >= limit) break;
    }
    const snippet = content.slice(0, 2000);
    return { entries, snippet, title: document.title || '', url: location.href, bodyLen: bodyText.length };
  }, limit).catch(() => ({ entries: [], snippet: '', title: '', url: '', bodyLen: 0 }));
}

// formatUpdatesContext(updates, maxEntries) → bloque de texto para el correo/log.
// PURO (testeable). Vacío si no hay pistas.
export function formatUpdatesContext(updates, maxEntries = 5) {
  const u = updates || {};
  const entries = (u.entries || []).slice(0, maxEntries);
  if (entries.length) {
    return `📰 CONTEXTO — ProductUpdates (posibles cambios recientes de Steelhead):\n${entries.map((e) => `   • ${e.length > 220 ? e.slice(0, 220) + '…' : e}`).join('\n')}`;
  }
  const snip = (u.snippet || '').trim();
  if (snip) return `📰 CONTEXTO — ProductUpdates (extracto):\n   ${snip.slice(0, 500)}${snip.length > 500 ? '…' : ''}`;
  return '';
}
