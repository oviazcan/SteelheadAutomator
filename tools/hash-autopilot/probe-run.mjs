// tools/hash-autopilot/probe-run.mjs
// Ejecuta el PROBE directo dentro de una `page` de Playwright ya autenticada como
// el frontend (mismo origen). Usa la COOKIE de sesión (credentials:'include'),
// NO Authorization: Bearer — el /graphql gateway rechaza el JWT crudo del ROCP con
// 403 "invalid algorithm"; la cookie es la vía correcta (validado 2026-07-13).
// Reintento corto ante blips de red. Devuelve [{op, http, message, hasData}].
//
// entries: [[op, cfgHash], …]. La clasificación (stale/vigente) va en
// probe-classify.mjs (puro). Este módulo es el I/O.
export async function probeOnPage(page, entries) {
  return page.evaluate(async ({ entries }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const once = async (op, hash) => {
      const r = await fetch('/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'apollographql-client-version': '4.0.8' },
        credentials: 'include',
        body: JSON.stringify({ operationName: op, variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
      });
      const j = await r.json().catch(() => ({}));
      return { op, http: r.status, message: (j.errors && j.errors[0] && j.errors[0].message) || null, hasData: !!(j && j.data) };
    };
    const results = [];
    for (const [op, hash] of entries) {
      let res = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { res = await once(op, hash); break; }
        catch (e) { res = { op, http: null, message: String(e).slice(0, 140), hasData: false }; await sleep(300); }
      }
      results.push(res);
    }
    return results;
  }, { entries });
}
