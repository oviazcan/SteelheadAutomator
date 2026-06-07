// inspect-archive-dups-21.js
// One-shot DevTools script: para los 21 PNs que erroraron con
// `Archive dups … HTTP 400 Variable "$input" got invalid value {} at "input[0].partNum…"`
// en la corrida bulk-upload-report-82432bc9 (recovery_dualsource_v104).
//
// Qué hace:
//   1. Por cada PN, resuelve id(s) via SearchPartNumbers (puede haber matches
//      bajo varios customers — los lista todos).
//   2. Llama GetPartNumber.
//   3. Reporta:
//      a) dims:        items de partNumberDimensionsByPartNumberId (vivos) —
//         marca badShape si dimensionId o unitId vienen null
//         (esa es la hipótesis del HTTP 400 — el mapper de 1.5.6
//         genera {dimensionId:null, microQuantity:0, unitId:null} y SH
//         lo rechaza como `{}`).
//      b) dupsSF:      groups de specFieldParams vivos con >=2 rows en el
//         mismo SpecField (los que el cleanup regla 1.4.38 quería archivar
//         y no pudo porque la mutación fue rechazada).
//   4. Descarga `archive_dups_21_inspection.json` con el detalle full.
//
// Cómo correrlo:
//   1. Abrir Steelhead (app.gosteelhead.com), loguearse.
//   2. DevTools → Console.
//   3. Pegar este archivo y enter. Tarda ~10 s (21 PNs × 2 calls + 200 ms gap).
//
// NO modifica nada — sólo lee.

(async () => {
  const HASHES = {
    SearchPartNumbers: '63ba50ed71fbf40476f1844b841351766eefbb147613b51b33919b4f4b2d4d91',
    GetPartNumber:     '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2'
  };

  const PNS = [
    'CXC7800526-03OS', 'CXC7800526-09OS', 'CXC7800525-04OS', 'CXC7800946-07',
    'S2J3328A01', '2810D19G2', '40529-142-01', '46015-985-50',
    '46040-566-50', '46040-583-01', '73298-179-01', '80282-657-50',
    '80283-216-58', '80283-220-50', '80283-218-56', '80283-618-50',
    'NNZ76913', 'NNZ76912', 'PZ4-00001-04018', 'QGH92258', 'SUR-00000164'
  ];

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
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 400)}`);
    }
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 600));
    return j.data;
  }

  async function findPNMatches(name) {
    const d = await gql('SearchPartNumbers', {
      searchQuery: name, first: 20, offset: 0, orderBy: ['ID_DESC']
    });
    const nodes = d?.searchPartNumbers?.nodes || d?.pagedData?.nodes || [];
    const wanted = name.toUpperCase().trim();
    return nodes.filter(n => (n.name || '').toUpperCase().trim() === wanted);
  }

  function analyzeDims(pn) {
    const raw = (pn?.partNumberDimensionsByPartNumberId?.nodes || [])
      .filter(d => !d.archivedAt);
    return raw.map(d => ({
      dimensionId: d.dimensionId,
      microQuantity: d.microQuantity,
      unitId: d.unitId,
      badShape: !d.dimensionId || d.unitId == null
    }));
  }

  function analyzeDups(pn) {
    const params = (pn?.partNumberSpecFieldParamsByPartNumberId?.nodes || [])
      .filter(p => !p.archivedAt);
    const bySF = new Map();
    for (const p of params) {
      const sfp = p.specFieldParamBySpecFieldParamId;
      const sfId   = sfp?.specFieldSpecBySpecFieldSpecId?.specFieldBySpecFieldId?.id;
      const sfName = sfp?.specFieldSpecBySpecFieldSpecId?.specFieldBySpecFieldId?.name;
      if (!sfId) continue;
      if (!bySF.has(sfId)) bySF.set(sfId, { sfName, rows: [] });
      bySF.get(sfId).rows.push({
        id: p.id,
        specFieldParamId: sfp?.id,
        paramName: sfp?.name,
        processNodeId: p.processNodeId
      });
    }
    const dups = [];
    for (const [sfId, { sfName, rows }] of bySF) {
      if (rows.length < 2) continue;
      const nulls    = rows.filter(r => !r.processNodeId);
      const nonNulls = rows.filter(r =>  r.processNodeId);
      if (nulls.length >= 1 && nonNulls.length >= 1) {
        dups.push({
          sfId, sfName,
          nullsCount: nulls.length,
          nonNullCount: nonNulls.length,
          archiveTargets: nonNulls.map(r => ({ id: r.id, processNodeId: r.processNodeId, paramName: r.paramName }))
        });
      } else if (nulls.length > 1) {
        dups.push({
          sfId, sfName,
          nullsCount: nulls.length,
          nonNullCount: 0,
          archiveTargets: nulls.slice(0, -1).map(r => ({ id: r.id, processNodeId: null, paramName: r.paramName }))
        });
      }
    }
    return dups;
  }

  async function inspect(name) {
    const matches = await findPNMatches(name);
    if (!matches.length) return { name, error: 'NOT FOUND' };
    const out = [];
    for (const m of matches) {
      try {
        const d = await gql('GetPartNumber', { partNumberId: m.id });
        const pn = d?.partNumberById;
        if (!pn) { out.push({ id: m.id, error: 'partNumberById null' }); continue; }
        const dims = analyzeDims(pn);
        const dups = analyzeDups(pn);
        out.push({
          id: m.id,
          name: pn.name,
          customer: pn.customerByCustomerId?.name || null,
          archivedAt: pn.archivedAt || null,
          dimsTotal: dims.length,
          dimsBadShape: dims.filter(d => d.badShape).length,
          dims,
          dupsSFCount: dups.length,
          dups
        });
      } catch (e) {
        out.push({ id: m.id, error: String(e).slice(0, 300) });
      }
    }
    return { name, matches: out };
  }

  console.log(`Inspeccionando ${PNS.length} PNs…`);
  const results = [];
  for (let i = 0; i < PNS.length; i++) {
    const n = PNS[i];
    console.log(`[${i + 1}/${PNS.length}] ${n}`);
    try { results.push(await inspect(n)); }
    catch (e) { results.push({ name: n, error: String(e).slice(0, 300) }); }
    await new Promise(r => setTimeout(r, 200));
  }

  // Tabla resumida
  const flat = results.flatMap(r => {
    if (r.error) return [{ name: r.name, error: r.error }];
    return (r.matches || []).map(m => ({
      name: r.name,
      id: m.id,
      customer: m.customer,
      archived: m.archivedAt ? 'YES' : 'no',
      dims: m.dimsTotal,
      dimsBad: m.dimsBadShape,
      dupsSF: m.dupsSFCount,
      err: m.error || ''
    }));
  });
  console.table(flat);

  // Descarga
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'archive_dups_21_inspection.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log('✅ Descargado archive_dups_21_inspection.json — revísalo en ~/Downloads');
})();
