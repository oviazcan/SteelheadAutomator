// check-quote-lock.js
// DevTools: validar si la quote idInDomain=197 (cliente 166246) ya está
// desbloqueada para SaveManyPartNumberPrices.
//
// El error original era:
//   "Cannot modify quote - part number prices are referenced by ..."
// → algún PNPrice de la quote está referenciado por un invoiceLineItem
//   (la factura asociada). Hasta que el ref desaparezca, SH rechaza
//   cualquier modify.
//
// El script:
//   1. GetQuote(idInDomain=197, revisionNumber=1) — mismo persisted query
//      que usa bulk-upload.
//   2. Reporta estado general (id, archivedAt, quotedAt, lockReason…).
//   3. Cuenta cuántos PNPrice tiene la quote y cuántos están referenciados
//      por una invoiceLine (lo que la traba).
//   4. Si todo está libre → "✅ desbloqueada, puedes re-correr".
//   5. Si hay refs → lista las invoices que la trabban.
//
// NO modifica nada — sólo lee.
//
// Cambiar QUOTE_IDS abajo si necesitas validar otra (ej. una nueva).

(async () => {
  const QUOTE_IDS = [197];          // idInDomain de la(s) quote a validar
  const REVISION_NUMBER = 1;

  const HASHES = {
    GetQuote_v8:  '28ea8b40e659a812bd53ffb0c2faff561643258a357bfa8fd2661fb8952470f2',
    GetQuote_v71: '28ea8b40e659a812bd53ffb0c2faff561643258a357bfa8fd2661fb8952470f2'
  };

  async function gql(op, hash, vars) {
    const body = {
      operationName: op,
      variables: vars,
      extensions: {
        clientLibrary: { name: '@apollo/client', version: '4.0.8' },
        persistedQuery: { version: 1, sha256Hash: hash }
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

  async function fetchQuote(idInDomain) {
    try {
      return await gql('GetQuote', HASHES.GetQuote_v8, { idInDomain, revisionNumber: REVISION_NUMBER });
    } catch (e1) {
      try {
        return await gql('GetQuote', HASHES.GetQuote_v71, { idInDomain, revisionNumber: REVISION_NUMBER });
      } catch (e2) {
        throw new Error(`GetQuote ${idInDomain} falló v8(${String(e1).slice(0,80)}) y v71(${String(e2).slice(0,80)})`);
      }
    }
  }

  function summarize(d, idInDomain) {
    const q = d?.quoteByIdInDomainAndRevisionNumber || d?.quoteByIdInDomain;
    if (!q) return { ok: false, reason: `Quote ${idInDomain} no encontrada` };

    const qpnpNodes = q.quotePartNumberPricesByQuoteId?.nodes || [];
    const qlNodes   = q.quoteLinesByQuoteId?.nodes || [];

    // Buscar refs a invoice/invoiceLine en cualquier nivel del response.
    // El error de SH viene de partNumberPrices referenciados — el ref
    // puede vivir en pnp.invoiceLineItemsByPartNumberPriceId, en
    // pnp.partNumberPriceLineItems[].invoiceLineByInvoiceLineId, o en
    // metadata interna. Hacemos un walk defensivo.
    const invoiceRefs = [];
    function walk(node, path) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
      for (const [k, v] of Object.entries(node)) {
        if (v == null) continue;
        const kl = k.toLowerCase();
        if (kl.includes('invoice') && (typeof v === 'object')) {
          const idVal = v?.id || v?.idInDomain || (Array.isArray(v?.nodes) ? `${v.nodes.length} nodes` : null);
          if (idVal) invoiceRefs.push({ path: `${path}.${k}`, val: idVal });
          walk(v, `${path}.${k}`);
        } else if (typeof v === 'object') {
          walk(v, `${path}.${k}`);
        }
      }
    }
    walk(q, `quote#${idInDomain}`);

    return {
      ok: true,
      id: q.id,
      idInDomain: q.idInDomain,
      name: q.name || q.title || '(sin nombre)',
      customerId: q.customerByCustomerId?.id || q.customerId || null,
      customerName: q.customerByCustomerId?.name || null,
      archivedAt: q.archivedAt || null,
      quotedAt:   q.quotedAt   || null,
      approvedAt: q.approvedAt || null,
      acceptedAt: q.acceptedAt || null,
      lockReason: q.lockReason || q.statusReason || null,
      status: q.status || q.quoteStatus || null,
      qpnpCount: qpnpNodes.length,
      qlCount:   qlNodes.length,
      invoiceRefs
    };
  }

  console.log(`Validando ${QUOTE_IDS.length} quote(s)…`);
  for (const id of QUOTE_IDS) {
    let data;
    try { data = await fetchQuote(id); }
    catch (e) { console.error(`❌ quote ${id}: ${e.message}`); continue; }

    const s = summarize(data, id);
    if (!s.ok) { console.error(`❌ ${s.reason}`); continue; }

    console.log(`\n━━━━━━━ Quote idInDomain=${s.idInDomain} (id=${s.id}) ━━━━━━━`);
    console.log(`  Nombre:        ${s.name}`);
    console.log(`  Cliente:       ${s.customerName || s.customerId || '?'}`);
    console.log(`  archivedAt:    ${s.archivedAt || '—'}`);
    console.log(`  quotedAt:      ${s.quotedAt   || '—'}`);
    console.log(`  approvedAt:    ${s.approvedAt || '—'}`);
    console.log(`  acceptedAt:    ${s.acceptedAt || '—'}`);
    console.log(`  status:        ${s.status     || '—'}`);
    console.log(`  lockReason:    ${s.lockReason || '—'}`);
    console.log(`  PNPrices:      ${s.qpnpCount}`);
    console.log(`  QuoteLines:    ${s.qlCount}`);
    console.log(`  Refs a invoice (walk recursivo): ${s.invoiceRefs.length}`);
    if (s.invoiceRefs.length) {
      console.log(`  ── Refs encontradas (max 10) ──`);
      s.invoiceRefs.slice(0, 10).forEach(r => {
        console.log(`     ${r.path} → ${typeof r.val === 'object' ? JSON.stringify(r.val).slice(0, 80) : r.val}`);
      });
      if (s.invoiceRefs.length > 10) console.log(`     … ${s.invoiceRefs.length - 10} más`);
    }

    // Veredicto sencillo (heurístico — el ground truth siempre es intentar
    // un SaveManyPartNumberPrices real con bulk-upload).
    const seemsLocked = s.invoiceRefs.length > 0 || s.archivedAt;
    if (seemsLocked) {
      console.log(`\n  ⚠️  Quote SIGUE con referencias a invoice (o archivada).`);
      console.log(`     SaveManyPartNumberPrices probablemente rechace.`);
      console.log(`     Para desbloquear: cancela/borra los invoiceLineItems`);
      console.log(`     que referencian a sus PNPrices, o usa una quote nueva.`);
    } else {
      console.log(`\n  ✅ Quote SIN refs a invoice y NO archivada.`);
      console.log(`     SaveManyPartNumberPrices debería pasar — re-corre el CSV.`);
    }
  }

  console.log(`\nListo. Si quieres validar otra quote, edita QUOTE_IDS arriba.`);
})();
