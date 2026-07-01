// Vale de Almacén — motor puro (sin DOM, sin API).
// Construye y parsea los COMENTARIOS ESTRUCTURADOS que registran un vale en el
// evento de mantenimiento. El formato es machine-parseable y sobrevive edición
// humana gracias a los sentinels literales [VALE]…[/VALE].
//
// Una línea del vale → un comentario:
//   [VALE] art:"Guante Nitrilo T/L" cant:2 unidad:"PZA" user:"Juan Pérez" emp:ABC1234 linea:"T205 Linea de Zinc" [/VALE]
// Encabezado/cierre del vale (1 c/u):
//   [VALE-INI] fecha:<ISO> equipo:"…" nodo:"…" recoge:"…" items:N [/VALE-INI]
//   [VALE-FIN] items:N completedAt:<ISO> [/VALE-FIN]
//
// Un parser externo reconstruye la base de datos de entregas por usuario con
// SteelheadValeEngine.parseAllLines(textoCompletoDeComentarios).
(function (root) {
  'use strict';

  // Quote un valor string: envuelve en comillas dobles, escapando \ y " internos.
  function quote(v) {
    return '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // Normaliza una cantidad numérica a string ("3", "3.5"); no inventa decimales.
  function formatNum(q) {
    const n = Number(q);
    return Number.isFinite(n) ? String(n) : '0';
  }

  // Tokeniza el contenido interno de un bloque en pares clave:valor.
  // El valor puede ir entre comillas (con escapes \" y \\) o ser un token sin espacios.
  function parseKeyVals(inner) {
    const out = {};
    const s = String(inner || '');
    const n = s.length;
    let i = 0;
    while (i < n) {
      while (i < n && /\s/.test(s[i])) i++;
      if (i >= n) break;
      let key = '';
      while (i < n && s[i] !== ':' && !/\s/.test(s[i])) { key += s[i]; i++; }
      if (i >= n || s[i] !== ':') { // clave malformada sin ':'; saltar token
        while (i < n && !/\s/.test(s[i])) i++;
        continue;
      }
      i++; // saltar ':'
      let val = '';
      if (s[i] === '"') {
        i++; // saltar comilla de apertura
        while (i < n) {
          const c = s[i];
          if (c === '\\' && i + 1 < n) { val += s[i + 1]; i += 2; continue; }
          if (c === '"') { i++; break; }
          val += c; i++;
        }
      } else {
        while (i < n && !/\s/.test(s[i])) { val += s[i]; i++; }
      }
      out[key.trim()] = val;
    }
    return out;
  }

  // line: { articleName, quantity, unidad?, assigneeName, employeeNumber|null, equipmentName }
  function buildLineComment(line) {
    const l = line || {};
    const emp = (l.employeeNumber == null || l.employeeNumber === '') ? '?' : String(l.employeeNumber);
    const parts = [
      'art:' + quote(l.articleName),
      'cant:' + formatNum(l.quantity),
    ];
    if (l.unidad != null && l.unidad !== '') parts.push('unidad:' + quote(l.unidad));
    parts.push('user:' + quote(l.assigneeName));
    parts.push('emp:' + emp);
    parts.push('linea:' + quote(l.equipmentName));
    return '[VALE] ' + parts.join(' ') + ' [/VALE]';
  }

  // Parsea UN comentario [VALE]…[/VALE] (el primero que encuentre). null si no hay sentinel.
  function parseLineComment(text) {
    const m = /\[VALE\]\s*([\s\S]*?)\s*\[\/VALE\]/.exec(String(text == null ? '' : text));
    if (!m) return null;
    const kv = parseKeyVals(m[1]);
    if (!('art' in kv)) return null;
    return {
      articleName: kv.art || '',
      quantity: kv.cant != null ? Number(kv.cant) : null,
      unidad: kv.unidad || '',
      assigneeName: kv.user || '',
      employeeNumber: (kv.emp == null || kv.emp === '?' || kv.emp === '') ? null : kv.emp,
      equipmentName: kv.linea || '',
    };
  }

  // Extrae TODOS los bloques [VALE]…[/VALE] de un texto (varios comentarios concatenados).
  function parseAllLines(text) {
    const re = /\[VALE\]\s*[\s\S]*?\s*\[\/VALE\]/g;
    const src = String(text == null ? '' : text);
    const res = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const parsed = parseLineComment(m[0]);
      if (parsed) res.push(parsed);
    }
    return res;
  }

  // opts: { fecha:<ISO>, equipmentName, nodeName, pickupName, items }
  function buildHeaderComment(opts) {
    const o = opts || {};
    const parts = [
      'fecha:' + String(o.fecha || ''),
      'equipo:' + quote(o.equipmentName),
      'nodo:' + quote(o.nodeName),
      'recoge:' + quote(o.pickupName),
      'items:' + (Number(o.items) || 0),
    ];
    return '[VALE-INI] ' + parts.join(' ') + ' [/VALE-INI]';
  }

  // opts: { items, completedAt:<ISO> }
  function buildFooterComment(opts) {
    const o = opts || {};
    return '[VALE-FIN] items:' + (Number(o.items) || 0) + ' completedAt:' + String(o.completedAt || '') + ' [/VALE-FIN]';
  }

  // line de la UI: { articleSensorId, articleName, quantity, assigneeId, assigneeName, equipmentName }
  function validateValeLine(line) {
    const l = line || {};
    const errors = [];
    if (!l.articleSensorId) errors.push('Falta el artículo');
    if (l.articleName == null || String(l.articleName).trim() === '') errors.push('Falta el nombre del artículo');
    const q = Number(l.quantity);
    if (!Number.isFinite(q) || q <= 0) errors.push('La cantidad debe ser mayor a 0');
    if (!l.assigneeId) errors.push('Falta el usuario asignado');
    if (l.assigneeName == null || String(l.assigneeName).trim() === '') errors.push('Falta el nombre del usuario asignado');
    if (l.equipmentName == null || String(l.equipmentName).trim() === '') errors.push('Falta la línea/equipo');
    return { valid: errors.length === 0, errors };
  }

  const api = {
    buildLineComment,
    parseLineComment,
    parseAllLines,
    buildHeaderComment,
    buildFooterComment,
    validateValeLine,
    // expuestos para tests/depuración
    _parseKeyVals: parseKeyVals,
    _quote: quote,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SteelheadValeEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
