// unit-autoconvert-core.js — funciones PURAS de conversión de unidades por parte.
//
// Dual-export: window.UnitAutoConvertCore (browser) / module.exports (node --test).
// SIN dependencias de DOM, API ni closure. El valor "X / Part" que el usuario
// escribe ES el factor per-part de esa unidad (mismo número que guarda la API).
(function (root) {
  'use strict';

  // factor = (unidades de esta unidad) por 1 unidad base. Conversión lineal sin offset.
  const UNIT_GROUPS = [
    { type: 'peso',       units: { KG: 1, LBR: 2.2046226218 } },
    { type: 'longitud',   units: { LM: 1, FOT: 3.280839895 } },
    { type: 'superficie', units: { CMK: 1, DMK: 0.01, FTK: 0.001076391041670972 } },
  ];

  const CONVERTIBLE = new Set(UNIT_GROUPS.flatMap((g) => Object.keys(g.units)));

  // Alias de códigos: SH muestra el código UN/CEFACT como primer token del label (DMK, FTK,
  // CMK, FOT, LBR…) EXCEPTO kilogramo, que aparece como "KG" en vez del UN/CEFACT "KGM".
  // Canonizamos "KGM" → "KG" para que el grupo de peso matchee en cualquier dominio (algunos
  // podrían mostrar "KGM"). Sin esto, editar kilogramos no convertía a libra (bug reportado).
  const UNIT_ALIASES = { KGM: 'KG' };
  function canonCode(code) {
    const c = String(code || '').toUpperCase();
    return UNIT_ALIASES[c] || c;
  }

  function round4(x) {
    return Number(Number(x).toFixed(4));
  }

  function getGroup(code) {
    const c = canonCode(code);
    return UNIT_GROUPS.find((g) =>
      Object.prototype.hasOwnProperty.call(g.units, c)
    ) || null;
  }

  function isConvertible(code) {
    return CONVERTIBLE.has(canonCode(code));
  }

  // Dado (code, value) devuelve [{code, value}] de los demás pares del grupo.
  function computePeers(code, value) {
    const v = Number(value);
    if (!isFinite(v) || v <= 0) return [];
    const c = canonCode(code);
    const g = getGroup(c);
    if (!g) return [];
    const base = v / g.units[c];
    const out = [];
    for (const peer of Object.keys(g.units)) {
      if (peer === c) continue;
      out.push({ code: peer, value: round4(base * g.units[peer]) });
    }
    return out;
  }

  // Primer token (código de unidad) de "KG (kilogramos) / Part:" → "KG" (canonizado; "KGM"→"KG").
  function unitCodeFromText(text) {
    if (!text) return '';
    return canonCode(String(text).trim().split(/\s+/)[0]);
  }

  // El adorno recíproco del Panel B empieza con "Parts /".
  function isReciprocalAdornment(text) {
    return /^\s*parts\s*\//i.test(String(text || ''));
  }

  const api = {
    UNIT_GROUPS, CONVERTIBLE, round4, getGroup, isConvertible,
    computePeers, unitCodeFromText, isReciprocalAdornment,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UnitAutoConvertCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
