// find-rich-ci-pns.js
// DevTools script: encontrar 10 PNs con customInputs RICOS (QuoteIBMS +
// BaseMetal + opcionalmente DatosFacturacion / Plano) para usarlos como
// pilot del fix 1.5.10 — quiero saber que el archive-dups completa sin
// HTTP 400 Y que el customInputs se preserva intacto.
//
// Estrategia:
//   1. SearchPartNumbers con un cliente "rico" (recently quoted, no IMP).
//      Default: tomamos 200 PNs activos ordenados por ID_DESC.
//   2. Para cada uno, GetPartNumber → revisar customInputs.
//   3. Filtrar los que tienen, al menos:
//        - QuoteIBMS  no-null
//        - BaseMetal  no-null
//      Bonus si traen DatosFacturacion o Plano.
//   4. Reportar los primeros 10 → console.table + download JSON con ID,
//      name, customer y customInputs full para que el siguiente paso
//      genere el CSV.
//
// Cómo correr:
//   1. Steelhead → DevTools → Console.
//   2. Pegar y enter. Toma ~30-40s (200 PNs × 1 call + 50ms gap).
//   3. Si quieres más coverage cambia SCAN_SIZE abajo.
//
// NO modifica nada.

(async () => {
  const SCAN_SIZE  = 300;   // cuántos PNs escanear (subir si encontramos pocos rich)
  const TARGET_RICH = 10;   // cuántos queremos en el output final
  const GAP_MS     = 50;

  const HASHES = {
    SearchPartNumbers: '63ba50ed71fbf40476f1844b841351766eefbb147613b51b33919b4f4b2d4d91',
    GetPartNumber:     '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2'
  };

  async function gql(op, vars) {
    const body = {
      operationName: op,
      variables: vars,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: HASHES[op] }
      }
    };
    const r = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  // Paginar SearchPartNumbers hasta llenar SCAN_SIZE
  async function fetchCandidates() {
    const PAGE = 100;
    const out = [];
    let offset = 0;
    while (out.length < SCAN_SIZE) {
      const d = await gql('SearchPartNumbers', {
        searchQuery: '',
        first: PAGE,
        offset,
        orderBy: ['ID_DESC']
      });
      const nodes = d?.searchPartNumbers?.nodes || d?.pagedData?.nodes || [];
      if (!nodes.length) break;
      for (const n of nodes) {
        // Skip archivados e IMP prefix
        if (n.archivedAt) continue;
        const nm = (n.name || '').toUpperCase();
        if (nm.startsWith('IMP')) continue;
        out.push({ id: n.id, name: n.name });
        if (out.length >= SCAN_SIZE) break;
      }
      offset += PAGE;
      if (nodes.length < PAGE) break;
      await new Promise(r => setTimeout(r, GAP_MS));
    }
    return out;
  }

  function scoreCI(ci) {
    if (!ci || typeof ci !== 'object') return 0;
    const ibms = ci?.QuoteIBMS;
    const base = ci?.DatosAdicionalesNP?.BaseMetal;
    const fact = ci?.DatosFacturacion;
    const plano = ci?.DatosAdicionalesNP?.Plano;
    let s = 0;
    if (ibms) s += 4;          // peso fuerte — esto es el campo más blanqueado
    if (base) s += 3;
    if (plano) s += 2;
    if (fact && Object.keys(fact || {}).length > 0) s += 2;
    return s;
  }

  console.log(`Escaneando ${SCAN_SIZE} PNs candidatos…`);
  const cands = await fetchCandidates();
  console.log(`  → obtenidos ${cands.length}`);

  const rich = [];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    try {
      const d = await gql('GetPartNumber', { partNumberId: c.id });
      const pn = d?.partNumberById;
      if (!pn) continue;
      const ci = pn.customInputs || null;
      const s = scoreCI(ci);
      if (s >= 7) {  // QuoteIBMS + BaseMetal minimum
        rich.push({
          id: pn.id,
          name: pn.name,
          customer: pn.customerByCustomerId?.name || null,
          score: s,
          ibms: ci?.QuoteIBMS || null,
          baseMetal: ci?.DatosAdicionalesNP?.BaseMetal || null,
          plano: ci?.DatosAdicionalesNP?.Plano || null,
          datosFact: ci?.DatosFacturacion ? Object.keys(ci.DatosFacturacion) : [],
          customInputs: ci
        });
        if (i % 10 === 0) console.log(`[${i + 1}/${cands.length}] rich=${rich.length}`);
        if (rich.length >= TARGET_RICH) break;
      }
    } catch (e) {
      // ignorar individuales
    }
    if (i % 50 === 0) await new Promise(r => setTimeout(r, GAP_MS * 2));
    await new Promise(r => setTimeout(r, GAP_MS));
  }

  console.log(`✅ Encontrados ${rich.length} PNs con customInputs ricos`);
  console.table(rich.map(r => ({
    id: r.id,
    name: r.name,
    customer: r.customer,
    score: r.score,
    ibms: r.ibms,
    baseMetal: r.baseMetal,
    plano: r.plano ? r.plano.slice(0, 30) : null,
    factKeys: r.datosFact.length
  })));

  const blob = new Blob([JSON.stringify(rich, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `rich_ci_pns_${ts}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log(`📥 Descargado rich_ci_pns_${ts}.json`);
})();
