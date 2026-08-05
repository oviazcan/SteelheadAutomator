// packing-slip-modal-core.js — Reconocimiento PURO del modal "Send Shipping Email".
// Recibe datos ya leídos del DOM (strings y números), nunca nodos, para poder
// testearse sin navegador.
// Dual export: module.exports (tests con node) + root.PackingSlipModalCore (browser).
// Golden tests: tools/test/packing-slip-modal-core.test.js
//
// ── POR QUÉ EXISTE LA DISTINCIÓN (riesgo R3) ─────────────────────────────────
// `cfdi-attacher` reconoce el modal de FACTURA por «>=2 MuiSwitch + icono de
// correo». El modal de REMISIÓN, medido en vivo el 2026-08-04, tiene 5 MuiSwitch
// y un icono de correo — o sea que también pasaría ese filtro. Si ambos applets
// se activaran en el mismo modal, los dos inyectarían panel y los dos tocarían
// `attachments`. Lo que los separa es el HEADING.
//
// ── POR QUÉ SE LEEN LOS NP DEL DOM ───────────────────────────────────────────
// El preview del correo YA trae la tabla `SO # | WO # | Part # | QTY`. Eso evita
// descubrir una query nueva sólo para saber qué va en la remisión. La API sigue
// siendo la fuente preferida; esto es el respaldo verificado.
(function (root) {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // Headings del modal de REMISIÓN.
  //   EN → MEDIDO en vivo ("Send Shipping Email").
  //   ES → NO medido: el modal salió en inglés con la app en español. Son
  //        candidatos razonables, declarados como DEUDA en la bitácora. Si SH
  //        usa otro texto, la red de seguridad estructural lo sostiene.
  const HEADING_PROPIO = [
    /send\s+shipping\s+email/,
    /enviar\s+correo\s+de\s+albar/,
    /enviar\s+(el\s+)?albar/,
    /enviar\s+(la\s+)?remisi/,
  ];

  // Headings AJENOS: si el título dice esto, el modal NO es nuestro pase lo que
  // pase. Gana sobre la estructura — un falso positivo aquí nos pondría a
  // inyectar adjuntos en el correo de una FACTURA.
  const HEADING_AJENO = [/invoice/, /factura/];

  // El modal de factura tiene 3 switches (Logo / Attach PDF / Visible to Others);
  // el de remisión, 5. El umbral de 4 los separa cuando no hay heading legible.
  const MIN_SWITCHES = 4;

  // info = { heading: string, switchCount: number, hasEmailIcon: boolean }
  function isShippingEmailModal(info) {
    if (!info) return false;
    if (!info.hasEmailIcon) return false;
    const h = norm(info.heading);
    if (h && HEADING_AJENO.some((re) => re.test(h))) return false;
    if (h && HEADING_PROPIO.some((re) => re.test(h))) return true;
    return Number(info.switchCount) >= MIN_SWITCHES;
  }

  // ── Extracción de los números de parte ──────────────────────────────────────

  // Encabezados de la tabla de partes, en los dos idiomas conocidos.
  const HEADER_RE = /^(so\s*#|wo\s*#|part\s*#|qty|ov\s*#|ot\s*#|parte\s*#|cant)/;

  // Entrada: el innerText de cada <tr> del diálogo (celdas separadas por tab).
  // Formato REAL medido:
  //   "#1770 - 4300016123\t#13667\t10-4307003-001\t2567"
  //    SO #                WO #    Part #          QTY
  //
  // Descarta lo que no calce en vez de adivinar: escribir el PN equivocado es
  // peor que no escribir ninguno. El preview repite el bloque "Parts List", así
  // que se deduplica por nombre de PN.
  function extractPartNumbers(rowTexts) {
    const out = [];
    const seen = new Set();
    for (const raw of rowTexts || []) {
      const line = String(raw == null ? '' : raw).trim();
      if (!line) continue;
      if (HEADER_RE.test(line.toLowerCase())) continue;
      const cells = line.split('\t').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length < 4) continue;
      const pnName = cells[2];
      if (!pnName || seen.has(pnName)) continue;
      seen.add(pnName);
      out.push({ pnName, soNumber: cells[0], woNumber: cells[1], qty: cells[3] });
    }
    return out;
  }

  const api = { isShippingEmailModal, extractPartNumbers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PackingSlipModalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
