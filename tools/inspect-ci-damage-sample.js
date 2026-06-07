// inspect-ci-damage-sample.js
// Muestra empírica del alcance del blanqueo de customInputs por bulk-upload
// 1.5.x en la corrida v104. NO modifica nada — sólo lee.
//
// Hipótesis: STEP 6 Call A/B en bulk-upload manda `customInputs: {}` o
// `customInputs: {DatosAdicionalesNP:{QuoteIBMS:'X'}}` porque extractPNShape
// no guarda customInputs completo en el cache. SH hace REPLACE-semantics y
// borra todo lo que no se mandó.
//
// El script:
//   1. Te pide cargar el v104.csv con el file picker.
//   2. Selecciona 50 PNs aleatorios (estratificados: 25 con QuoteIBMS y 25
//      sin QuoteIBMS en el CSV).
//   3. Por cada uno fetcha GetPartNumber y reporta qué hay en customInputs:
//      DatosAdicionalesNP.{BaseMetal,QuoteIBMS,NumeroParteAlterno,
//      EstacionIBMS,Plano}, DatosFacturacion.CodigoSAT, DatosPlanificacion.*,
//      NotasAdicionales.
//   4. Cuenta cuántos perdieron qué.
//   5. Descarga `ci_damage_sample.json`.
//
// Cómo correrlo:
//   1. SH → DevTools → Console → pega y enter.
//   2. Click "Cargar CSV" → seleccionar recovery_dualsource_v104.csv.
//   3. Click "Inspeccionar 50". Tarda ~30 s.

(async () => {
  const HASHES = {
    GetPartNumber: '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2'
  };

  async function gql(op, vars) {
    const r = await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        operationName: op,
        variables: vars,
        extensions: {
          clientLibrary: { name: '@apollo/client', version: '4.0.8' },
          persistedQuery: { version: 1, sha256Hash: HASHES[op] }
        }
      })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  }

  // --- UI ---
  const old = document.getElementById('sa-ci-damage'); if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'sa-ci-damage';
  panel.style.cssText = `
    position:fixed;top:12px;right:12px;z-index:9999999;width:560px;max-height:92vh;
    overflow:auto;background:#1e293b;color:#e2e8f0;border-radius:10px;padding:14px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;
    box-shadow:0 12px 40px rgba(0,0,0,0.5);
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="color:#38bdf8;font-size:15px">🔬 CI damage sample</b>
      <button id="sa-ci-x" style="background:#475569;color:#e2e8f0;border:none;border-radius:4px;padding:4px 10px;cursor:pointer">✕</button>
    </div>
    <div style="color:#94a3b8;font-size:12px;margin-bottom:8px">
      Cargá v104.csv y dale inspeccionar 50 PNs (25 c/Quote + 25 s/Quote).
    </div>
    <input type="file" id="sa-ci-csv" accept=".csv" style="width:100%;color:#e2e8f0;margin-bottom:8px">
    <div id="sa-ci-info" style="background:#0f172a;padding:8px;border-radius:4px;margin-bottom:8px;display:none;font-size:11px">
      <div>Total PNs en CSV: <b id="sa-ci-total" style="color:#38bdf8">—</b></div>
      <div>Con QuoteIBMS: <b id="sa-ci-qi" style="color:#4ade80">—</b></div>
      <div>Sin QuoteIBMS: <b id="sa-ci-noqi" style="color:#fbbf24">—</b></div>
    </div>
    <button id="sa-ci-run" disabled style="width:100%;background:#dc2626;color:white;border:none;border-radius:6px;padding:10px;font-weight:600;cursor:pointer;opacity:0.5">▶ Inspeccionar 50</button>
    <div id="sa-ci-bar" style="height:6px;background:#334155;border-radius:3px;overflow:hidden;display:none;margin-top:8px">
      <div id="sa-ci-fill" style="height:100%;background:#dc2626;transition:width .2s;width:0%"></div>
    </div>
    <div id="sa-ci-stats" style="font-size:11px;font-family:monospace;color:#cbd5e1;margin-top:8px;line-height:1.6"></div>
    <div id="sa-ci-log" style="margin-top:8px;max-height:300px;overflow:auto;background:#0f172a;padding:6px;border-radius:4px;font-family:monospace;font-size:10px;line-height:1.3;color:#94a3b8;display:none"></div>
  `;
  document.body.appendChild(panel);

  const $ = id => document.getElementById(id);
  $('sa-ci-x').onclick = () => panel.remove();

  let parsed = null;
  $('sa-ci-csv').onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    // simple csv parser (no escapes inside fields handled minimamente)
    const rows = [];
    let cur = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQ = false;
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { cur.push(field); field = ''; }
        else if (c === '\r') continue;
        else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
        else field += c;
      }
    }
    if (field || cur.length) { cur.push(field); rows.push(cur); }

    // data rows: skip primeros 8 (header), válido si row[4] (IdSH) es número
    const data = rows.slice(8).filter(r => r.length > 6 && r[6] && /^\d+$/.test((r[4] || '').trim()));
    parsed = data.map(r => ({
      idsh: r[4].trim(),
      cust:   r[5] || '',
      pn:     r[6] || '',
      metalBase:  (r[16] || '').trim(),
      codigoSAT:  '',  // not in known col
      notasPN:    (r[64] || '').trim(),
      quoteIBMS:  (r[65] || '').trim(),
      estIBMS:    (r[66] || '').trim(),
      plano:      (r[67] || '').trim()
    }));
    const withQI = parsed.filter(p => p.quoteIBMS).length;
    $('sa-ci-total').textContent = parsed.length;
    $('sa-ci-qi').textContent = withQI;
    $('sa-ci-noqi').textContent = parsed.length - withQI;
    $('sa-ci-info').style.display = 'block';
    $('sa-ci-run').disabled = false;
    $('sa-ci-run').style.opacity = '1';
  };

  function log(msg, cls = '') {
    const el = $('sa-ci-log'); el.style.display = 'block';
    const d = document.createElement('div');
    if (cls === 'bad') d.style.color = '#f87171';
    else if (cls === 'ok') d.style.color = '#4ade80';
    d.textContent = msg;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  }

  function pickStratified(rows, target = 50) {
    const withQI = rows.filter(r => r.quoteIBMS);
    const without = rows.filter(r => !r.quoteIBMS);
    const halfQI = Math.min(Math.floor(target / 2), withQI.length);
    const halfNQI = target - halfQI;
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    return [...shuffle(withQI.slice()).slice(0, halfQI), ...shuffle(without.slice()).slice(0, halfNQI)];
  }

  $('sa-ci-run').onclick = async () => {
    if (!parsed) return;
    $('sa-ci-run').disabled = true; $('sa-ci-run').style.opacity = '0.5';
    $('sa-ci-bar').style.display = 'block';

    const sample = pickStratified(parsed, 50);
    const results = [];
    const counts = {
      total: sample.length,
      ci_empty: 0,
      datosadic_empty: 0,
      quoteibms_present: 0, quoteibms_missing_expected: 0,
      basemetal_present: 0, basemetal_missing_expected: 0,
      datosfact_present: 0,
      datosplan_present: 0,
      notas_present: 0,
      with_csv_qi_kept_qi: 0,    // CSV traía QI y SH lo tiene
      with_csv_qi_lost_qi: 0,    // CSV traía QI y SH lo perdió
      no_csv_qi_kept_qi: 0,      // CSV sin QI, pero SH lo conserva (good = original quizá ya nada)
      errors: 0
    };

    for (let i = 0; i < sample.length; i++) {
      const item = sample[i];
      $('sa-ci-fill').style.width = ((i + 1) / sample.length * 100).toFixed(1) + '%';
      try {
        const d = await gql('GetPartNumber', { partNumberId: Number(item.idsh) });
        const pn = d?.partNumberById;
        if (!pn) { counts.errors++; results.push({ ...item, error: 'null' }); continue; }
        let ci = pn.customInputs;
        if (typeof ci === 'string') { try { ci = JSON.parse(ci); } catch { ci = null; } }
        const ciKeys = ci ? Object.keys(ci) : [];
        const da = ci?.DatosAdicionalesNP || {};
        const fact = ci?.DatosFacturacion || {};
        const plan = ci?.DatosPlanificacion || {};

        const r = {
          idsh: item.idsh, pn: item.pn, cust: item.cust.slice(0, 30),
          ci_keys_count: ciKeys.length,
          ci_keys: ciKeys,
          sh_quoteIBMS: da.QuoteIBMS || '',
          sh_baseMetal: da.BaseMetal || '',
          sh_numeroParteAlterno: Array.isArray(da.NumeroParteAlterno) && da.NumeroParteAlterno.length ? da.NumeroParteAlterno.join('|') : '',
          sh_estacionIBMS: da.EstacionIBMS || '',
          sh_plano: da.Plano || '',
          sh_codigoSAT: fact.CodigoSAT || '',
          sh_datosPlan_keys: Object.keys(plan),
          sh_notas: ci?.NotasAdicionales || '',
          csv_quoteIBMS: item.quoteIBMS,
          csv_baseMetal: item.metalBase,
          csv_estIBMS:   item.estIBMS,
          csv_plano:     item.plano,
          csv_notasPN:   item.notasPN
        };
        if (ciKeys.length === 0) counts.ci_empty++;
        if (Object.keys(da).length === 0) counts.datosadic_empty++;
        if (r.sh_quoteIBMS) counts.quoteibms_present++;
        if (r.sh_baseMetal) counts.basemetal_present++;
        if (Object.keys(fact).length) counts.datosfact_present++;
        if (Object.keys(plan).length) counts.datosplan_present++;
        if (r.sh_notas) counts.notas_present++;

        // Cross checks
        if (item.quoteIBMS) {
          if (r.sh_quoteIBMS) counts.with_csv_qi_kept_qi++;
          else counts.with_csv_qi_lost_qi++;
        } else {
          if (r.sh_quoteIBMS) counts.no_csv_qi_kept_qi++;
        }

        results.push(r);
        log(`${i+1}/${sample.length} ${item.pn.padEnd(18)} ci:${ciKeys.length} qi:${r.sh_quoteIBMS ? '✓' : '✗'} mb:${r.sh_baseMetal ? '✓' : '✗'}`,
            ciKeys.length === 0 ? 'bad' : (r.sh_quoteIBMS ? 'ok' : ''));
      } catch (e) {
        counts.errors++;
        results.push({ ...item, error: String(e).slice(0, 200) });
      }
    }

    const ciEmptyPct  = (counts.ci_empty / counts.total * 100).toFixed(1);
    const lossPct = counts.with_csv_qi_lost_qi && (counts.with_csv_qi_lost_qi + counts.with_csv_qi_kept_qi);
    const lossPctStr = lossPct ? (counts.with_csv_qi_lost_qi / (counts.with_csv_qi_lost_qi + counts.with_csv_qi_kept_qi) * 100).toFixed(1) : 'N/A';

    $('sa-ci-stats').innerHTML = `
      <div style="font-size:13px;color:#fbbf24;font-weight:600;margin-bottom:4px">RESUMEN</div>
      <div>Total inspeccionados: <b>${counts.total}</b> | errors: <b>${counts.errors}</b></div>
      <div>customInputs vacío total: <b style="color:#f87171">${counts.ci_empty}</b> (${ciEmptyPct}%)</div>
      <div>DatosAdicionalesNP vacío: <b style="color:#f87171">${counts.datosadic_empty}</b></div>
      <div>QuoteIBMS en SH: <b>${counts.quoteibms_present}</b></div>
      <div>BaseMetal en SH:  <b>${counts.basemetal_present}</b></div>
      <div>DatosFacturacion en SH: <b>${counts.datosfact_present}</b></div>
      <div>DatosPlanificacion en SH: <b>${counts.datosplan_present}</b></div>
      <div>NotasAdicionales en SH: <b>${counts.notas_present}</b></div>
      <div style="margin-top:6px;color:#fbbf24">--- Cross checks ---</div>
      <div>CSV traía QI → SH lo tiene: <b style="color:#4ade80">${counts.with_csv_qi_kept_qi}</b></div>
      <div>CSV traía QI → SH lo perdió: <b style="color:#f87171">${counts.with_csv_qi_lost_qi}</b> (${lossPctStr}%)</div>
      <div>CSV vacío → SH conserva QI: <b style="color:#4ade80">${counts.no_csv_qi_kept_qi}</b></div>
    `;

    const out = { generated: new Date().toISOString(), counts, sample: results };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ci_damage_sample.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('✓ Descargado ci_damage_sample.json', 'ok');
  };

  console.log('🔬 CI damage sample panel listo');
})();
