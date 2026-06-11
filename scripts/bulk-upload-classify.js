// bulk-upload-classify.js — funciones PURAS de clasificación/matching de PNs.
//
// Dual-export: window.SteelheadBulkClassify (browser) / module.exports (node --test).
// Copia FIEL de bulk-upload.js:6525-6984 (characterization refactor: comportamiento
// idéntico). Todas reciben sus datos por parámetro (csvRow, pnsForCustomer,
// nonFinishList, equivIndex). Única dependencia externa: window.SteelheadBulkCC
// (decideBlankAcabados — invariante #7 blank-acabados); en el browser cc.js carga antes.
(function (root) {
  'use strict';

  function normLabel(s) {
    if (s == null) return '';
    return String(s).trim().toUpperCase();
  }

  function isNonFinishLabel(name, nonFinishList) {
    if (!name || typeof name !== 'string') return false;
    const n = normLabel(name);
    if (!n) return false;
    return nonFinishList.some(nf => normLabel(nf) === n);
  }

  // 1.4.3: equivalencias semánticas configurables. Cada grupo es una lista de
  // sinónimos para match — si dos valores caen en el mismo grupo se consideran
  // equivalentes (no exactos). Se construye un mapa name→groupId una sola vez.
  function buildEquivIndex(groups) {
    const map = new Map();
    if (!Array.isArray(groups)) return map;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (!Array.isArray(g)) continue;
      for (const item of g) {
        const k = normLabel(item);
        if (k) map.set(k, gi);
      }
    }
    return map;
  }
  function equivGroup(map, value) {
    return map.get(normLabel(value));
  }
  function equivalentValues(map, a, b) {
    const na = normLabel(a), nb = normLabel(b);
    if (na === nb) return true;
    const ga = map.get(na), gb = map.get(nb);
    return ga != null && gb != null && ga === gb;
  }

  function acabadosOrdenados(labels, nonFinishList) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    const acabados = [];
    for (const l of labels) {
      if (!l || typeof l !== 'string') continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      const key = normLabel(l);
      if (seen.has(key)) continue;
      seen.add(key);
      acabados.push(key);
    }
    return acabados.sort().join('|');
  }

  // 1.4.3: misma función que acabadosOrdenados pero colapsa equivalentes a un
  // mismo token canonical "__G<id>" antes de ordenar. Permite que "Estaño" y
  // "Estaño s/Aluminio" cuenten como el mismo acabado para fines de match.
  // Si no hay equivIndex (config sin metalEquivalents) se comporta igual que
  // acabadosOrdenados.
  function acabadosCanonicos(labels, nonFinishList, equivIndex) {
    if (!Array.isArray(labels)) return '';
    const seen = new Set();
    const tokens = [];
    for (const l of labels) {
      if (!l || typeof l !== 'string') continue;
      if (isNonFinishLabel(l, nonFinishList)) continue;
      const norm = normLabel(l);
      let token = norm;
      if (equivIndex && equivIndex.size) {
        const g = equivIndex.get(norm);
        if (g != null) token = `__G${g}`;
      }
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
    return tokens.sort().join('|');
  }

  // 1.4.3: representación canonical de un metal — si está en un grupo
  // equivalente devuelve "__M<groupId>", si no devuelve el metal normalizado.
  function metalCanonico(metal, equivIndex) {
    const m = normLabel(metal);
    if (!m) return '';
    if (equivIndex && equivIndex.size) {
      const g = equivIndex.get(m);
      if (g != null) return `__M${g}`;
    }
    return m;
  }

  function buildCompositeKey(pn, nonFinishList, equivIndex) {
    const customerId = pn.customerId != null ? String(pn.customerId) : '';
    const name = (pn.name || '').toUpperCase();
    // 1.4.3: metal y acabados ahora se canonicalizan para que el composite
    // matchee aunque el CSV traiga "Estaño" y el PN tenga "Estaño s/Aluminio".
    // Sin equivIndex se comporta como antes (exacto).
    const metalBase = metalCanonico(pn.metalBase || '', equivIndex);
    const acabados = acabadosCanonicos(pn.labels || [], nonFinishList, equivIndex);
    return `${customerId}||${name}||${metalBase}||${acabados}`;
  }

  function rankCandidates(csvRow, candidates, nonFinishList, equivIndex) {
    const csvMetalCanon = metalCanonico(csvRow.metalBase || '', equivIndex);
    const csvAcabadosCanon = acabadosCanonicos(csvRow.labels || [], nonFinishList, equivIndex);
    const csvIbms = csvRow.quoteIBMS || '';

    function score(c) {
      let s = 0;
      if (metalCanonico(c.metalBase || '', equivIndex) === csvMetalCanon) s++;
      if (acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === csvAcabadosCanon) s++;
      return s;
    }

    function ibmsRank(c) {
      const ibms = c.quoteIBMS || '';
      if (csvIbms && ibms === csvIbms) return 0; // mismo IBMS gana
      if (!ibms) return 1;                       // IBMS vacío segundo
      return 2;                                  // IBMS distinto último
    }

    return [...candidates].sort((a, b) => {
      const sd = score(b) - score(a);
      if (sd !== 0) return sd;
      const id = ibmsRank(a) - ibmsRank(b);
      if (id !== 0) return id;
      // 1.5.21: a igualdad de score+ibms, preferir activos sobre archivados. El PN
      // vivo es el target natural; un archivado solo gana si matchea estrictamente
      // mejor (más score). Así se matchea el archivado para no duplicar, sin pisar
      // al activo cuando ambos coinciden por nombre.
      const ad = (a.archivedAt ? 1 : 0) - (b.archivedAt ? 1 : 0);
      if (ad !== 0) return ad;
      return (a.id || 0) - (b.id || 0);
    });
  }

  function classifyOnePN(csvRow, pnsForCustomer, nonFinishList, equivIndex) {
    const allPns = pnsForCustomer || [];
    // 1.2.12 + 1.5.21: TODOS los pases (incluido el match por nombre) ven archivados,
    // para NO duplicar PNs que están archivados en Steelhead. Un archivado matcheado se
    // devuelve como MODIFY con wasArchived=true; STEP 8 decide su estado final según el
    // Estatus tri-state (V re-archiva, F reactiva, blanco preserva). rankCandidates
    // prefiere activos a igualdad de score, así que el archivado solo gana si matchea mejor.
    const csvIbms = csvRow.quoteIBMS || '';
    const csvCompositeKey = buildCompositeKey(csvRow, nonFinishList, equivIndex);

    // ── Pase 1: QuoteIBMS autoritativo (1.2.12: incluye archivados) ──
    // 1.4.28 fix homónimos: cuando hay 2+ PNs con mismo QuoteIBMS (caso confirmado
    // en SCHNEIDER: 22 buckets con duplicados — un mismo IBMS recreado bajo dos
    // PNs con nombres ligeramente distintos, p.ej. "1221-086412" vs
    // "1221-086412 PROYECTO BARRAS"), el `find()` ciego escogía el primero del
    // array (típicamente el de mayor ID por orden ID_DESC de AllPartNumbers) y
    // resolvía al PN equivocado. El audit Phase 5.4b (post-fix-2026-05-23) sí
    // discrimina; faltaba el mismo patrón aquí.
    // Estrategia: (a) si hay match exacto name+IBMS, ganador claro; (b) si solo
    // hay 1 PN con ese IBMS, aceptarlo aunque name no matchee (compat renombres);
    // (c) si hay >1 PN con mismo IBMS y ninguno coincide en name, NO escogemos
    // ciegamente — caemos a Pase 2 (composite) que es más estricto.
    if (csvIbms) {
      const byIbmsAll = allPns.filter(p => (p.quoteIBMS || '') === csvIbms);
      if (byIbmsAll.length === 1) {
        const byIbms = byIbmsAll[0];
        const archSuffix = byIbms.archivedAt ? '-desarchiva' : '';
        return {
          classification: 'MODIFY',
          pase: 1,
          confidence: `ibms-exacto${archSuffix}`,
          targetPnId: byIbms.id,
          wasArchived: !!byIbms.archivedAt,
          candidates: [],
        };
      }
      if (byIbmsAll.length > 1) {
        const nameUpperCsv = (csvRow.name || '').toUpperCase().trim();
        const byIbmsExactName = byIbmsAll.find(p => (p.name || '').toUpperCase().trim() === nameUpperCsv);
        if (byIbmsExactName) {
          const archSuffix = byIbmsExactName.archivedAt ? '-desarchiva' : '';
          return {
            classification: 'MODIFY',
            pase: 1,
            confidence: `ibms+name-exacto${archSuffix}`,
            targetPnId: byIbmsExactName.id,
            wasArchived: !!byIbmsExactName.archivedAt,
            candidates: [],
          };
        }
        // Ambigüedad IBMS sin desempate por name → caer a Pase 2.
      }
    }

    // ── Pase 2: composite exacto con regla anti-colisión (1.2.12: incluye archivados) ──
    // Los PNs del catálogo pueden no traer customerId en su shape (ya están filtrados por cliente).
    // Normalizamos usando el customerId del csvRow para que la comparación de keys sea apples-to-apples.
    const csvCustomerId = csvRow.customerId;
    const byComposite = allPns.find(p => {
      const pNorm = (p.customerId != null) ? p : Object.assign({}, p, { customerId: csvCustomerId });
      return buildCompositeKey(pNorm, nonFinishList, equivIndex) === csvCompositeKey;
    });
    if (byComposite) {
      const pnIbms = byComposite.quoteIBMS || '';
      const colision = csvIbms && pnIbms && pnIbms !== csvIbms;
      if (!colision) {
        let confSuffix;
        if (!pnIbms && !csvIbms) confSuffix = 'ambos-sin-ibms';
        else if (!pnIbms) confSuffix = 'pn-sin-ibms';
        else if (!csvIbms) confSuffix = 'csv-sin-ibms';
        else confSuffix = 'ibms-coincide';
        const archSuffix = byComposite.archivedAt ? '-desarchiva' : '';
        return {
          classification: 'MODIFY',
          pase: 2,
          confidence: `composite-exacto-${confSuffix}${archSuffix}`,
          targetPnId: byComposite.id,
          wasArchived: !!byComposite.archivedAt,
          candidates: [],
        };
      }
      // colision → cae a Pase 3 (el PN aparecerá como candidato)
    }

    // ── Pase 3: near-match por nombre ──
    // 1.2.9: tres niveles de default según evidencia de match:
    //   1) Top match estricto (nombre + acabados exactos sin contar nonFinish)
    //      → MODIFY ranked[0]. Confianza alta, operador puede confirmar de un vistazo.
    //   2) Sin match estricto pero existe candidato sin-etiqueta (slate limpia)
    //      → MODIFY ese candidato. Es más seguro completar un PN vacío que crear
    //      un duplicado con etiquetas; el PN sin-etiq típicamente nació por accidente
    //      (creado sin clasificar) y este es el momento natural para corregirlo.
    //   3) Sin match estricto y sin candidato sin-etiq → NEW. El operador decide
    //      a mano si quiere pisar alguno de los candidatos con etiquetas distintas.
    // En los 3 casos el dropdown del panel muestra TODOS los candidatos por nombre
    // (1.2.8) para que el operador pueda override.
    const nameUpper = (csvRow.name || '').toUpperCase();
    const nameCandidates = allPns.filter(p => (p.name || '').toUpperCase() === nameUpper);
    if (nameCandidates.length > 0) {
      const ranked = rankCandidates(csvRow, nameCandidates, nonFinishList, equivIndex);
      // 1.4.3: comparación canonical para que "Estaño" vs "Estaño s/Cobre" o
      // mismo acabado con casing/espacios distintos cuenten como labelsMatchFull.
      const csvAcabados = acabadosCanonicos(csvRow.labels || [], nonFinishList, equivIndex);
      // 1.5.20 (Feature A): si el upload NO trae acabados (csvAcabados === ''),
      // no es señal de "quiero nuevo" — defaultear a MODIFICAR el PN activo más
      // reciente. Auto si hay 1 candidato; requiere confirmar si hay 2+. Va ANTES
      // de labelsMatchFull/blankCandidate para cubrir también el caso (común en TLC)
      // de CSV sin acabados + candidato sin acabados, que si no caería en
      // 'name+labels-match' sin auto-decidir. Si el upload trae acabados no vacíos,
      // NO entra acá (csvAcabados !== '') y sigue el flujo normal (labels-match/NEW).
      if (csvAcabados === '' && typeof window !== 'undefined' && window.SteelheadBulkCC) {
        const decision = window.SteelheadBulkCC.decideBlankAcabados(nameCandidates);
        if (decision) {
          return {
            classification: 'MODIFY',
            pase: 3,
            confidence: 'name+blank-csv-recent',
            targetPnId: decision.targetPnId,
            wasArchived: !!(nameCandidates.find(p => p.id === decision.targetPnId) || {}).archivedAt,
            candidates: ranked,
            autoDecided: decision.autoDecided,
          };
        }
      }
      const topAcabados = acabadosCanonicos(ranked[0].labels || [], nonFinishList, equivIndex);
      const labelsMatchFull = csvAcabados === topAcabados;
      if (labelsMatchFull) {
        return {
          classification: 'MODIFY',
          pase: 3,
          confidence: 'name+labels-match',
          targetPnId: ranked[0].id,
          wasArchived: !!ranked[0].archivedAt,
          candidates: ranked,
        };
      }
      // 1.2.9: fallback a candidato sin-etiqueta si existe.
      const blankCandidate = ranked.find(c => acabadosCanonicos(c.labels || [], nonFinishList, equivIndex) === '');
      if (blankCandidate) {
        return {
          classification: 'MODIFY',
          pase: 3,
          confidence: 'name+blank-candidate',
          targetPnId: blankCandidate.id,
          wasArchived: !!blankCandidate.archivedAt,
          candidates: ranked,
        };
      }
      return {
        classification: 'NEW',
        pase: 3,
        confidence: 'name-only-labels-differ',
        targetPnId: null,
        wasArchived: false,
        candidates: ranked,
      };
    }

    // ── Sin candidatos en ningún pase ──
    return {
      classification: 'NEW',
      pase: null,
      confidence: 'sin-match',
      targetPnId: null,
      wasArchived: false,
      candidates: [],
    };
  }

  // 1.2.10/1.2.11: dedup MODIFY targets para evitar que dos filas del CSV apunten
  // al mismo PN existente. La regla del usuario: si el CSV trae dos veces el mismo
  // nombre y el catálogo tiene dos PNs distintos con ese nombre, AMBAS filas
  // pueden ser MODIFY pero a IDs distintos; lo que NO se permite es que ambas
  // pisen el mismo id (perdería datos en silencio y el log mentiría diciendo
  // que las dos cargaron).
  //
  // Precedencia (gana el target primero): Pase 1 > Pase 2 > Pase 3 strict
  // > Pase 3 blank > Pase 3 id asc. Empate → idx ascendente (orden de CSV).
  //
  // 1.2.11: el loser solo se re-asigna a un alternate que pase strict-match
  // (mismas acabados ignorando nonFinishList) o blank candidate (sin acabados).
  // Antes (1.2.10) se aceptaba el primer alternate disponible aunque las
  // etiquetas fueran distintas, lo que violaba la regla "si no hay match de
  // etiquetas, default a crear nuevo". Mismo 3-level fallback que classifyOnePN.
  //
  // Mutaciones (en place) por loser:
  //   - Alternate strict (acabados iguales) → re-asigna. confidence='name+labels-match',
  //     pase=3, dedupReassigned=true, dedupOriginalTargetPnId guarda el id original.
  //   - Alternate blank (sin acabados) → re-asigna. confidence='name+blank-candidate'.
  //   - Sin alternate aceptable → demota a NEW. dedupConflict=true,
  //     dedupConflictTargetPnId guarda el id originalmente propuesto.
  function dedupModifyTargets(pnStatus, nonFinishList, equivIndex) {
    const nfList = nonFinishList || [];
    const eIdx = equivIndex || null;
    const confRank = {
      'ibms-exacto': 0,
      'composite-exacto-ambos-sin-ibms': 1,
      'composite-exacto-ibms-coincide': 1,
      'composite-exacto-pn-sin-ibms': 1,
      'composite-exacto-csv-sin-ibms': 1,
      'name+labels-match': 2,
      'name+blank-candidate': 3,
      'name+blank-csv-recent': 3,
    };
    const claimers = [];
    for (let i = 0; i < pnStatus.length; i++) {
      const s = pnStatus[i];
      if ((s.status === 'existing' || s.status === 'forceDup') && s.existingId != null) {
        claimers.push({ idx: i, s });
      }
    }
    if (claimers.length === 0) return { reassigned: 0, demoted: 0 };

    // 1.2.12: el confidence puede traer suffix '-desarchiva' (Pase 1/2 con PN
    // archivado); el rank es el mismo que su variante activa.
    const stripArch = (c) => (c || '').replace(/-desarchiva$/, '');
    claimers.sort((a, b) => {
      const pa = a.s.pase == null ? 99 : a.s.pase;
      const pb = b.s.pase == null ? 99 : b.s.pase;
      if (pa !== pb) return pa - pb;
      const ra = confRank[stripArch(a.s.confidence)] == null ? 99 : confRank[stripArch(a.s.confidence)];
      const rb = confRank[stripArch(b.s.confidence)] == null ? 99 : confRank[stripArch(b.s.confidence)];
      if (ra !== rb) return ra - rb;
      return a.idx - b.idx;
    });

    const used = new Set();
    let reassigned = 0, demoted = 0;
    for (const { s } of claimers) {
      if (!used.has(s.existingId)) {
        used.add(s.existingId);
        continue;
      }
      // Target tomado por una fila de precedencia mayor. Buscar alterno strict
      // o blank entre s.candidates (poblado solo en Pase 3; Pase 1/2 traen [] → demote).
      const candidates = s.candidates || [];
      const csvAcabados = acabadosCanonicos(s.csvLabels || [], nfList, eIdx);
      let alternative = null;
      let altConfidence = null;
      // Nivel 1: alternate con acabados estrictamente iguales al CSV.
      for (const c of candidates) {
        if (c.id === s.existingId || used.has(c.id)) continue;
        const candAcabados = acabadosCanonicos(c.labels || [], nfList, eIdx);
        if (candAcabados === csvAcabados) {
          alternative = c;
          altConfidence = 'name+labels-match';
          break;
        }
      }
      // Nivel 2: alternate sin acabados (slate limpia).
      if (!alternative) {
        for (const c of candidates) {
          if (c.id === s.existingId || used.has(c.id)) continue;
          const candAcabados = acabadosCanonicos(c.labels || [], nfList, eIdx);
          if (candAcabados === '') {
            alternative = c;
            altConfidence = 'name+blank-candidate';
            break;
          }
        }
      }
      if (alternative) {
        s.dedupOriginalTargetPnId = s.existingId;
        s.dedupReassigned = true;
        s.existingId = alternative.id;
        s.targetPnId = alternative.id;
        s.existingProcessId = alternative.defaultProcessNodeId || null;
        s.confidence = altConfidence;
        s.pase = 3;
        used.add(alternative.id);
        reassigned++;
      } else {
        s.dedupConflict = true;
        s.dedupConflictTargetPnId = s.existingId;
        s.status = 'new';
        s.classification = 'NEW';
        s.existingId = null;
        s.targetPnId = null;
        s.existingProcessId = null;
        demoted++;
      }
    }
    return { reassigned, demoted };
  }

  // 1.2.11: detectar duplicados internos del CSV (mismo PN+customer en 2+ filas).
  // Marca TODAS las filas del grupo (incluyendo la 1ª) con flags para UI y para
  // que SavePartNumber decida la asignación a Capa A/B. No fuerza status — el
  // clasificador (Pase 1 IBMS / Pase 2 composite / Pase 3 near-match) decide
  // independientemente; dedupModifyTargets ya maneja conflictos por existingId.
  function detectCsvDuplicates(parts) {
    const groups = new Map(); // key → [idx]
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.pn && !p.idSh) continue;
      if (p.customerId == null) continue;
      const key = (p.pn ? p.pn.toUpperCase() : `__idsh:${p.idSh}`) + '|' + (p.customerId ?? '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    let dupGroups = 0;
    let dupRows = 0;
    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      dupGroups++;
      for (let n = 0; n < indices.length; n++) {
        const idx = indices[n];
        parts[idx].isCsvDuplicate = true;
        parts[idx].csvDuplicateIndex = n + 1;
        parts[idx].csvDuplicateGroupSize = indices.length;
        if (n > 0) dupRows++;
      }
    }
    return { dupGroups, dupRows };
  }

  // 1.3.0: chunking helpers — partir corridas grandes COTIZACIÓN+NP en cotizaciones
  // de hasta `chunkSize` líneas. Contiguous slicing, no agrupa duplicados a través
  // de fronteras (los duplicados internos del CSV se distribuyen libremente).
  function chunkParts(arr, chunkSize) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const size = Math.max(1, Math.floor(Number(chunkSize) || 1));
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  // 1.3.0: nombre derivado para chunks. 1 chunk → nombre original (sin sufijo).
  // >1 chunks → "<name> 01", "<name> 02", ..., padStart(2,'0') deja 3+ dígitos si pasamos 99.
  function makeChunkQuoteName(originalName, chunkIndex, totalChunks) {
    if (totalChunks <= 1) return originalName;
    return `${originalName} ${String(chunkIndex + 1).padStart(2, '0')}`;
  }

  const api = {
    normLabel, isNonFinishLabel, buildEquivIndex, equivGroup, equivalentValues,
    acabadosOrdenados, acabadosCanonicos, metalCanonico, buildCompositeKey,
    rankCandidates, classifyOnePN, dedupModifyTargets, detectCsvDuplicates,
    chunkParts, makeChunkQuoteName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadBulkClassify = api;
})(typeof window !== 'undefined' ? window : globalThis);
