// packing-slip-drawings-core.js — Planos en Remisión · núcleo PURO de decisión.
// Sin DOM ni red: decide si el cliente pide planos, qué es plano y qué es foto,
// qué se premarca, y CUÁLES números de parte se quedan sin plano.
// Dual export: module.exports (tests con node) + root.PackingSlipDrawingsCore (browser).
// Golden tests: tools/test/packing-slip-drawings-core.test.js
//
// ── LO QUE MIDIÓ EL DISEÑO ────────────────────────────────────────────────────
// Contra el snapshot DuckDB de TLC (2026-08-04), el único cliente con
// `DatosLogisticos.IncluirPlanos = true` es FISHER CONTROLES DE MEXICO. De sus
// 1,726 números de parte activos:
//     125 (7.2%)  tienen PDF (plano)
//     272 (15.8%) sólo tienen fotos
//   1,329 (77.0%) NO TIENEN NINGÚN ARCHIVO
//
// O sea que "no hay nada que adjuntar" es el caso NORMAL, no el raro. Por eso
// este núcleo tiene dos salidas y no una: el plan de adjuntos **y** `pnsSinPlano`.
// Un applet que sólo adjuntara, y callara cuando no hay nada, haría creer al
// operador que el cliente recibió sus planos.
(function (root) {
  'use strict';

  // ── Lectura del check del cliente ───────────────────────────────────────────

  // Normaliza las formas en que el ERP entrega customInputs: objeto anidado o
  // string JSON. Devuelve objeto plano o null. (Mismo problema que resuelve
  // `duplicate-tiers.parseCustomInputs`.)
  function asObject(ci) {
    if (ci && typeof ci === 'object' && !Array.isArray(ci)) return ci;
    if (typeof ci === 'string') {
      try {
        const parsed = JSON.parse(ci);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) { return null; }
    }
    return null;
  }

  // ¿El cliente pide que le mandemos los planos?
  //   true  → sí
  //   false → no
  //   null  → NO PUDE LEERLO
  //
  // `null` NO es `false`, y la diferencia gobierna la UI: `false` apaga el applet
  // en silencio (es lo correcto para 74 de 81 clientes), mientras que `null`
  // obliga a la nota ámbar «no pude verificar». Ausente ≠ vacío.
  function readIncluirPlanos(customInputs) {
    const obj = asObject(customInputs);
    if (!obj) return null;
    const grupo = asObject(obj.DatosLogisticos);
    if (!grupo) return null;
    const v = grupo.IncluirPlanos;
    if (v === true || v === false) return v;
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (t === 'true') return true;
      if (t === 'false') return false;
    }
    return null;
  }

  // ── Clasificación de archivos ───────────────────────────────────────────────

  // Extensiones que cuentan como PLANO. Los formatos CAD entran porque el
  // criterio es «documento técnico que el cliente quiere ver», no «es un PDF».
  const PLANO_EXT = new Set(['pdf', 'dwg', 'dxf', 'step', 'stp', 'iges', 'igs']);
  // Extensiones de imagen. La convención de fotografía del repo
  // (<PN>_<VISTA>_<num> / <PN>__<descriptor>) siempre cae sobre estas.
  const FOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'heic']);

  // Última extensión, en minúsculas. '' si no tiene.
  function extOf(filename) {
    const s = String(filename == null ? '' : filename);
    const m = s.match(/\.([^.\/\\]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  // 'plano' | 'foto' | 'otro'.
  //
  // Esto SÓLO elige el DEFAULT del panel; el operador ve todo y marca lo que
  // quiera. Un plano escaneado en JPG cae en 'foto' y queda desmarcado — pero
  // VISIBLE y a un clic. Nada se oculta nunca.
  function classifyFile(originalName) {
    const e = extOf(originalName);
    if (!e) return 'otro';
    if (PLANO_EXT.has(e)) return 'plano';
    if (FOTO_EXT.has(e)) return 'foto';
    return 'otro';
  }

  // ── Plan de adjuntos ────────────────────────────────────────────────────────

  // Arma lo que pinta el panel. Determinista: conserva el orden de `pns` y, en
  // cada NP, el orden en que llegaron los archivos.
  //
  // `pnsSinPlano` incluye tanto al NP sin ningún archivo como al que sólo tiene
  // fotos: ambos dejan al cliente sin el plano que pidió, que es lo único que
  // importa para avisar.
  function buildAttachmentPlan(input) {
    const pns = (input && input.pns) || [];
    const filesByPn = (input && input.filesByPn) || {};
    const groups = [];
    const pnsSinPlano = [];
    let archivos = 0, preseleccionados = 0, pnsSinArchivo = 0;

    for (const pn of pns) {
      if (!pn || pn.id == null) continue;
      const raw = filesByPn[pn.id] || [];
      // Dedup POR NP: el ERP admite vincular el MISMO archivo dos veces al mismo
      // número de parte (medido: S2N1317A01 tenía dos vínculos al mismo
      // `user_file_name`). Sin esto se pintarían dos casillas idénticas que
      // comparten clave: marcar una y desmarcar la otra deja el estado mintiendo.
      const vistos = new Set();
      const files = [];
      for (const f of raw) {
        const filename = (f && f.name) || '';
        if (!filename || vistos.has(filename)) continue;
        vistos.add(filename);
        const displayName = (f && f.originalName) || filename;
        const kind = classifyFile(displayName);
        const preselected = kind === 'plano';
        archivos++;
        if (preselected) preseleccionados++;
        files.push({ filename, displayName, kind, preselected });
      }
      groups.push({ pnId: pn.id, pnName: pn.name || '', files });
      if (!files.length) pnsSinArchivo++;
      if (!files.some((f) => f.kind === 'plano')) {
        pnsSinPlano.push({ pnId: pn.id, pnName: pn.name || '' });
      }
    }

    return { groups, pnsSinPlano, totals: { archivos, preseleccionados, pnsSinArchivo } };
  }

  // Proyecta la selección al shape de la mutation, deduplicando por `filename`:
  // un mismo archivo puede colgar de dos NP de la misma remisión y el cliente no
  // debe recibirlo dos veces.
  //
  // Shape CONFIRMADO en vivo (2026-08-05): `SendEmailChecked.variables.attachments`
  // es un array; `cfdi-attacher` ya lo alimenta con {filename, displayName}.
  function toAttachments(files) {
    const seen = new Set();
    const out = [];
    for (const f of files || []) {
      if (!f || !f.filename || seen.has(f.filename)) continue;
      seen.add(f.filename);
      out.push({ filename: f.filename, displayName: f.displayName || f.filename });
    }
    return out;
  }

  const api = { readIncluirPlanos, classifyFile, buildAttachmentPlan, toAttachments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PackingSlipDrawingsCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
