// applet-gate.js — Lógica PURA del loader de applets (sin APIs de Chrome).
//
// Por qué existe (medido el 2026-07-27, config 1.7.213):
//   `background.js` inyectaba los 28 applets `autoInject` en TODAS las páginas de
//   Steelhead — 79 descargas, 79 verificaciones de firma y 79 `executeScript` en
//   CADA carga, en SERIE. En /Purchasing/PurchaseOrders eso incluía vale-almacen,
//   paros-linea, invoice-* … ninguno aplica ahí. Reporte del operador:
//   "conforme vamos agregando applets, cada vez tardan más en cargar".
//
// Este módulo concentra las cuatro decisiones del loader, para poder probarlas en
// Node sin navegador (tools/test/applet-gate.test.js):
//   1. GATE POR RUTA        — `selectAutoInjectApps` filtra por `app.urlPatterns`.
//   2. DEDUP DE ARCHIVOS    — `dedupeScriptPaths`: steelhead-api.js aparecía 24 veces.
//   3. LOTES DE INYECCIÓN   — `chunkScripts`: N `executeScript` → unos pocos.
//   4. CONCURRENCIA ACOTADA — `runPool`: descargas en paralelo, no en serie.
//
// Invariante de seguridad del gate: es FAIL-OPEN. Un app sin `urlPatterns`, con la
// lista vacía, o cuyos patrones no compilan, se inyecta en todas partes — igual que
// antes de este cambio. Un patrón mal escrito nunca deja al operador sin su applet;
// a lo sumo lo carga de más. El gate es un filtro de CARGA, no de EJECUCIÓN: el gate
// real de cada applet sigue viviendo dentro del applet (y es el que manda cuando la
// SPA navega sin recargar).
(function () {
  'use strict';

  // Clave de storage con la que el popup apaga un applet.
  // Convención histórica: appId camelCase + "Enabled" (cfdi-attacher → cfdiAttacherEnabled).
  function storageKeyForApp(appId) {
    return String(appId || '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + 'Enabled';
  }

  // ¿La ruta actual cae dentro de los patrones declarados por el app?
  // `patterns` son strings de regex (case-insensitive) probados contra location.pathname.
  // Sin patrones válidos → true (fail-open, ver cabecera).
  function matchesUrlPatterns(patterns, pathname) {
    if (!Array.isArray(patterns) || patterns.length === 0) return true;
    const p = String(pathname == null ? '' : pathname);
    let compiled = 0;
    for (const raw of patterns) {
      let re = null;
      try { re = new RegExp(String(raw), 'i'); } catch (_) { continue; }  // patrón roto → se ignora
      compiled++;
      if (re.test(p)) return true;
    }
    return compiled === 0;   // ningún patrón compiló → tratamos al app como sin gate
  }

  // Applets que deben inyectarse en esta ruta.
  //   apps      — config.apps
  //   pathname  — location.pathname de la pestaña
  //   disabled  — mapa de chrome.storage.local (solo `=== false` apaga; undefined = encendido)
  function selectAutoInjectApps(apps, pathname, disabled) {
    const off = disabled || {};
    return (Array.isArray(apps) ? apps : [])
      .filter(a => a && a.autoInject)
      .filter(a => off[storageKeyForApp(a.id)] !== false)
      .filter(a => matchesUrlPatterns(a.urlPatterns, pathname));
  }

  // Todas las claves de storage que hay que leer para conocer el estado on/off.
  // Sirve para pedirlas en UNA sola llamada a chrome.storage.local.get (antes: una por app).
  function storageKeysForApps(apps) {
    return (Array.isArray(apps) ? apps : [])
      .filter(a => a && a.id)
      .map(a => storageKeyForApp(a.id));
  }

  // Lista de archivos a inyectar, sin repetir, respetando el orden de dependencia.
  // Cada app lista sus scripts en orden (steelhead-api.js primero, luego core, luego glue);
  // conservar la PRIMERA aparición preserva ese orden entre apps que comparten dependencias.
  function dedupeScriptPaths(apps) {
    const seen = new Set();
    const out = [];
    for (const app of (Array.isArray(apps) ? apps : [])) {
      for (const s of (app && Array.isArray(app.scripts) ? app.scripts : [])) {
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  // ¿El orden dedupeado deja a cada applet con sus dependencias YA evaluadas?
  //
  // La convención del repo es que el ÚLTIMO script de un app es su glue (el que se monta
  // y usa a los demás: steelhead-api, su *-core/-engine, host-cleanup-shared…). El orden
  // relativo ENTRE dependencias no importa (no dependen unas de otras); lo que no puede
  // pasar es que el glue quede antes de alguna de ellas. Eso es lo que se verifica.
  function findDependencyViolations(apps) {
    const order = new Map();
    dedupeScriptPaths(apps).forEach((p, i) => order.set(p, i));
    const bad = [];
    for (const app of (Array.isArray(apps) ? apps : [])) {
      const list = (app && Array.isArray(app.scripts)) ? app.scripts : [];
      if (list.length < 2) continue;
      const glue = list[list.length - 1];
      const gi = order.get(glue);
      for (let i = 0; i < list.length - 1; i++) {
        if (order.get(list[i]) > gi) bad.push({ app: app.id, dep: list[i], glue });
      }
    }
    return bad;
  }

  // Agrupa {path, code} en lotes para mandarlos en pocos executeScript.
  // Cada round-trip a la pestaña cuesta; mandar 79 de uno en uno era el grueso del retardo.
  // Se corta por tamaño acumulado (structured clone de megas es contraproducente) y por
  // cantidad. Un script que por sí solo excede el presupuesto va en su propio lote.
  function chunkScripts(items, maxBytes, maxCount) {
    const limitBytes = maxBytes > 0 ? maxBytes : 1000000;
    const limitCount = maxCount > 0 ? maxCount : 12;
    const out = [];
    let cur = [];
    let size = 0;
    for (const it of (Array.isArray(items) ? items : [])) {
      const len = (it && typeof it.code === 'string') ? it.code.length : 0;
      if (cur.length && (cur.length >= limitCount || size + len > limitBytes)) {
        out.push(cur); cur = []; size = 0;
      }
      cur.push(it);
      size += len;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // Ejecuta `worker(item, i)` sobre todos los items con concurrencia acotada.
  // Nunca rechaza: devuelve [{ok:true,value}|{ok:false,error}] en el orden de entrada,
  // para que un applet que falle no impida que carguen los demás (allSettled explícito).
  async function runPool(items, worker, limit) {
    const list = Array.isArray(items) ? items : [];
    const width = Math.max(1, Math.min(limit || 4, list.length || 1));
    const results = new Array(list.length);
    let next = 0;
    async function lane() {
      while (true) {
        const i = next++;
        if (i >= list.length) return;
        try { results[i] = { ok: true, value: await worker(list[i], i) }; }
        catch (e) { results[i] = { ok: false, error: e }; }
      }
    }
    await Promise.all(Array.from({ length: width }, lane));
    return results;
  }

  // Clave de caché del código de un script. El código se re-verifica contra
  // config.scriptIntegrity ANTES de ejecutarse, venga de red o de caché, así que
  // el caché no relaja la integridad; solo evita volver a bajarlo.
  function codeCacheKey(scriptPath, version) {
    return 'sac_' + String(version || '0') + '_' + String(scriptPath || '');
  }

  // Claves de caché huérfanas (de versiones anteriores del config) para limpiar.
  function staleCacheKeys(allKeys, version) {
    const prefix = 'sac_';
    const keep = 'sac_' + String(version || '0') + '_';
    return (Array.isArray(allKeys) ? allKeys : [])
      .filter(k => typeof k === 'string' && k.indexOf(prefix) === 0 && k.indexOf(keep) !== 0);
  }

  const api = {
    storageKeyForApp,
    storageKeysForApps,
    matchesUrlPatterns,
    selectAutoInjectApps,
    dedupeScriptPaths,
    findDependencyViolations,
    chunkScripts,
    runPool,
    codeCacheKey,
    staleCacheKeys
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.SAAppletGate = api;
})();
