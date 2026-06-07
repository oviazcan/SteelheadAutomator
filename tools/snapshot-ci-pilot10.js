// snapshot-ci-pilot10.js
// One-shot DevTools script: captura customInputs de los 10 PNs del pilot
// `recovery_pilot_10_v159.csv` para validar el fix 1.5.9.
//
// Uso:
//   1. Abrir app.gosteelhead.com, login.
//   2. DevTools → Console → pegar este archivo → enter.
//   3. Descarga `ci_snapshot_pilot10_<TIMESTAMP>.json` a ~/Downloads.
//
// Correr TRES veces:
//   (A) ANTES de cargar el CSV con 1.5.9 → snapshot_before.
//   (B) DESPUÉS de la corrida → snapshot_after.
//   (C) Si quieres, una semana después → snapshot_check.
//
// Diff esperado con 1.5.9:
//   - 9/10 PNs (diff-mode total): customInputs DEBE quedar idéntico A vs B.
//   - 1/10 (CXC7800526-09OS): customInputs debe preservar todo lo de antes
//     + agregar/actualizar DatosAdicionalesNP.Plano = "El campo de Pz/Carga
//     se capturó en Kg/carga".
//
// Si en 1.5.8 ↓ ves customInputs = {} post-run → ESE es el bug que 1.5.9 fixea.

(async () => {
  const HASHES = {
    GetPartNumber: '60bee2e1bf45e3fba1e763994ab9f2691d7de0f44809434bd1e810b5219436c2'
  };

  const PILOT_10 = [
    { idsh: 3028172, pn: 'CXC7800525-04OS' },
    { idsh: 3028174, pn: 'CXC7800526-03OS' },
    { idsh: 3028116, pn: 'CXC7800526-09OS' }, // CSV trae Plano explícito
    { idsh: 3028177, pn: 'CXC7800946-07'   },
    { idsh: 3017049, pn: 'S2J3328A01'      },
    { idsh: 3608951, pn: '2810D19G2'       },
    { idsh: 3029583, pn: '40529-142-01'    },
    { idsh: 3029822, pn: '46015-985-50'    },
    { idsh: 3030386, pn: '46040-566-50'    },
    { idsh: 3030335, pn: '46040-583-01'    }
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
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.errors && !j.data) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  console.log(`📸 Snapshot CI de ${PILOT_10.length} PNs…`);
  const results = [];
  for (let i = 0; i < PILOT_10.length; i++) {
    const { idsh, pn } = PILOT_10[i];
    try {
      const d = await gql('GetPartNumber', { partNumberId: idsh });
      const node = d?.partNumberById;
      let ci = node?.customInputs;
      if (typeof ci === 'string') {
        try { ci = JSON.parse(ci); } catch { /* keep as string */ }
      }
      const ciKeys = ci && typeof ci === 'object' ? Object.keys(ci).sort() : [];
      const datosAdicKeys = ci?.DatosAdicionalesNP
        ? Object.keys(ci.DatosAdicionalesNP).sort() : [];
      const facturacionKeys = ci?.DatosFacturacion
        ? Object.keys(ci.DatosFacturacion).sort() : [];
      const planifKeys = ci?.DatosPlanificacion
        ? Object.keys(ci.DatosPlanificacion).sort() : [];
      results.push({
        idsh, pn,
        archivedAt: node?.archivedAt || null,
        ciTopKeys: ciKeys,
        ciTopKeysCount: ciKeys.length,
        DatosAdicionalesNP_keys: datosAdicKeys,
        DatosFacturacion_keys: facturacionKeys,
        DatosPlanificacion_keys: planifKeys,
        QuoteIBMS: ci?.DatosAdicionalesNP?.QuoteIBMS || null,
        BaseMetal: ci?.DatosAdicionalesNP?.BaseMetal || null,
        EstacionIBMS: ci?.DatosAdicionalesNP?.EstacionIBMS || null,
        Plano: ci?.DatosAdicionalesNP?.Plano || null,
        NotasAdicionales: ci?.NotasAdicionales || null,
        customInputs_full: ci || null
      });
      console.log(`  [${i+1}/${PILOT_10.length}] ${pn} (id=${idsh}) — CI keys: ${ciKeys.length ? ciKeys.join(', ') : '(empty)'}`);
    } catch (e) {
      results.push({ idsh, pn, error: String(e).slice(0, 200) });
      console.warn(`  [${i+1}/${PILOT_10.length}] ${pn} (id=${idsh}) — ERROR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // Resumen
  console.log('\n=== RESUMEN ===');
  console.table(results.map(r => ({
    pn: r.pn,
    idsh: r.idsh,
    ciKeys: r.ciTopKeysCount ?? '-',
    QuoteIBMS: r.QuoteIBMS || '-',
    BaseMetal: r.BaseMetal || '-',
    Plano: r.Plano || '-',
    err: r.error || ''
  })));

  // Descargar
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ci_snapshot_pilot10_${ts}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log(`✅ Descargado ci_snapshot_pilot10_${ts}.json — guárdalo y compara antes vs después.`);
})();
