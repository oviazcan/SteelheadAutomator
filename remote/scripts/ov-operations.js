// OV Operations — shared module for ReceivedOrder creation, adoption, and helpers
// Consumed by po-comparator.js and portal-importer.js
// Depends on: SteelheadAPI

const OVOperations = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;
  const log = (m) => api().log(m);
  const warn = (m) => api().warn(m);

  // ── Shared helpers ─────────────────────────────────────────

  function normalizePN(pn) {
    if (pn == null) return null;
    return String(pn).trim().toLowerCase();
  }

  function aggressiveNormalizePN(pn) {
    if (pn == null) return null;
    return String(pn).trim().toLowerCase().replace(/[\s\-\._]/g, '');
  }

  function normalizeCurrency(val) {
    if (!val) return null;
    const s = String(val).trim().toUpperCase();
    if (s.includes('USD') || s.includes('$') || s.includes('DLLS')) return 'USD';
    if (s.includes('MXN') || s.includes('PESO') || s.includes('MXP')) return 'MXN';
    return s.substring(0, 3);
  }

  function fuzzyMatchStr(a, b) {
    if (!a || !b) return false;
    const na = String(a).trim().toLowerCase();
    const nb = String(b).trim().toLowerCase();
    return na.includes(nb) || nb.includes(na);
  }

  function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toNumber(val) {
    if (val == null) return null;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }

  // ── UI helpers (overlay/modal — duplicated from po-comparator styles) ─

  function createOverlay() {
    const ov = document.createElement('div');
    ov.id = 'dl9-ovop-overlay';
    ov.className = 'dl9-overlay';
    return ov;
  }

  function createModal() {
    const md = document.createElement('div');
    md.className = 'dl9-poc-modal';
    return md;
  }

  function removeOverlay() {
    const ov = document.getElementById('dl9-ovop-overlay');
    if (ov) ov.remove();
  }

  // Placeholder — functions below populated in later tasks

  return {
    normalizePN,
    aggressiveNormalizePN,
    normalizeCurrency,
    fuzzyMatchStr,
    escHtml,
    toNumber,
    createOverlay,
    createModal,
    removeOverlay
  };
})();

window.OVOperations = OVOperations;
