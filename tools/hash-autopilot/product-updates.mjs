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
    await page.waitForFunction(() => (document.body && document.body.innerText || '').trim().length > 400, { timeout: 8000 });
  } catch { try { await page.waitForTimeout(2500); } catch {} }
  return page.evaluate((limit) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    let entries = [];
    // Candidatos típicos de un changelog: article / cards con "update|release|changelog|note".
    const sel = 'article, [class*="update" i], [class*="release" i], [class*="changelog" i], [class*="note" i], [class*="card" i], li';
    for (const c of document.querySelectorAll(sel)) {
      const txt = clean(c.innerText || c.textContent);
      if (txt && txt.length > 25 && txt.length < 900) entries.push(txt);
      if (entries.length >= limit * 4) break;
    }
    entries = [...new Set(entries)].slice(0, limit);
    const bodyText = clean(document.body ? document.body.innerText : '');
    const snippet = bodyText.slice(0, 2500);
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
