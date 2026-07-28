// auto-router.js — Orquestador del autoruteador.
//
// · Intercepta StationTreatmentByWorkOrder (la query que dispara el modal de
//   ruteo nativo de Steelhead) para capturar GRATIS el contexto de la orden:
//   workOrderId, partNumberId y el árbol completo de recipeNodes. El modal nativo
//   funciona como "selector de orden" — el applet no necesita pedir IDs internos.
// · Dos FABs en la ficha de una OT, con roles separados: 🔀 RUTEA (la orden completa o
//   cada grupo de piezas) y ✂️ PARTE/REAGRUPA las piezas — que es lo que va antes, porque
//   un grupo no se puede rutear hasta que existe. En el board el 🔀 conserva su batch.
// · Expone las entradas del popup (`AutoRouter.open*FromPopup`), que el background
//   ejecuta con executeScript en el mundo MAIN — ver §"Entradas desde el popup".
//
// Depende de: SteelheadAPI, AutoRouterAPI, AutoRouterEngine, AutoRouterPanel,
//             ProcessShared (opcional).
// NOTA (audit memoria #113): NO usa SteelheadHostCleanup (el comentario previo lo declaraba
//   pero nunca se importó ni invocó). auto-router-batch.js tiene pool propio (concurrencia 3)
//   y state=fresh() al cerrar, pero sin Datadog stop / Apollo drain / mem monitor. Candidato a
//   ADOPTAR el shared si "Rutear TODAS" (cap 60 WOs, cada una carga su árbol) presiona memoria.

const AutoRouter = (() => {
  'use strict';

  const VERSION = '0.3.4';
  const LOG = '[AR]';
  const api = () => window.SteelheadAPI;
  const log = (m) => api()?.log?.(m) ?? console.log(LOG, m);

  // Último contexto de ruteo capturado del modal nativo.
  // { workOrderId, partNumberId, routeData, capturedAt }
  let captured = null;

  // Selección RASTREADA del Scheduling board (idInDomain de cada orden marcada).
  // La lista del board es virtualizada (solo renderiza filas visibles), así que en
  // vez de leer el DOM al momento, acumulamos la selección conforme el usuario
  // marca/desmarca — así sobrevive el scroll.
  const boardSelection = new Set();

  // Clave de "tarjeta" = path + estación (?stationId). Cambiar de ESTACIÓN en el board
  // NO cambia el pathname (solo el ?stationId) → hay que limpiar la selección al cambiar
  // de estación, no solo de board. (Bug: la selección de una estación se arrastraba a otra.)
  function boardKey() {
    const m = (typeof location !== 'undefined' ? location.search : '').match(/[?&]stationId=(\d+)/);
    return (typeof location !== 'undefined' ? location.pathname : '') + '|' + (m ? m[1] : '');
  }
  let lastKey = boardKey();
  function checkBoardChange() {
    const k = boardKey();
    if (k !== lastKey) { lastKey = k; boardSelection.clear(); captured = null; return true; }
    return false;
  }

  function getContext() { return captured; }

  function patchFetch() {
    if (window.__saAutoRouterFetchPatched) return;
    window.__saAutoRouterFetchPatched = true;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isGraphql = typeof url === 'string' && url.includes('/graphql');
      let op = null;
      let vars = null;
      if (isGraphql && opts?.body && typeof opts.body === 'string') {
        try {
          const b = JSON.parse(opts.body);
          op = b.operationName;
          vars = b.variables;
        } catch (_) { /* no-json body */ }
      }

      const resp = await origFetch.apply(this, args);

      if (op === 'StationTreatmentByWorkOrder' && vars) {
        // lee la respuesta sin consumir el stream original. Soporta 1 o N órdenes
        // (multi-selección del board → workOrderIds:[…] + partNumberIds:[…]).
        try {
          resp.clone().json().then((j) => {
            if (!j || !j.data) return;
            const wos = window.AutoRouterAPI.parseAllRouteData(j.data, vars);
            if (!wos.length) return;
            captured = { wos, capturedAt: Date.now() };
            log(`Contexto capturado: ${wos.length} orden(es) — #${wos.map((w) => w.idInDomain).join(', #')}`);
            window.dispatchEvent(new Event('sa-ar-context'));
          }).catch(() => {});
        } catch (_) { /* swallow */ }
      }
      return resp;
    };
  }

  // ── FAB ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sa-ar-style')) return;
    const css = `
      .sa-ar-fab{position:fixed;bottom:20px;right:20px;z-index:2147483600;
        width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;
        background:#0b6e4f;color:#fff;font-size:24px;box-shadow:0 3px 10px rgba(0,0,0,.3);
        display:flex;align-items:center;justify-content:center;transition:transform .12s;}
      .sa-ar-fab:hover{transform:scale(1.08);background:#0d8a63;}
      .sa-ar-fab .sa-ar-badge{position:absolute;top:-4px;right:-4px;background:#e8513a;
        color:#fff;font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;
        display:flex;align-items:center;justify-content:center;padding:0 4px;}
      /* FAB de PARTIR piezas: se apila ENCIMA del 🔀 y vive solo en la ficha de una OT.
         Oscuro y con tijeras porque es OTRO trabajo — mueve material real y hay que
         hacerlo ANTES de poder rutear un grupo. Verde = rutear, oscuro = cortar. */
      .sa-ar-fab-split{bottom:82px;background:#1c2430;border:1px solid #2c3a4b;font-size:22px;}
      .sa-ar-fab-split:hover{background:#26364a;}`;
    const s = document.createElement('style');
    s.id = 'sa-ar-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Scheduling board: rutear directo desde la selección, sin abrir el modal ──
  function isBoardPage() {
    return /\/Schedules\/\d+\/ScheduleBoard\/\d+/i.test(location.pathname);
  }

  // idInDomain de la orden de una fila (del link /Domains/N/WorkOrders/<id>).
  function woIdFromRow(tr) {
    const a = tr && tr.querySelector('a[href*="/WorkOrders/"]');
    const m = a && (a.getAttribute('href') || '').match(/\/WorkOrders\/(\d+)/);
    return m ? m[1] : null;
  }

  // Selección efectiva. Parte de la rastreada (boardSelection, sobrevive la virtualización)
  // pero RECONCILIA contra el DOM visible: marca las visibles que estén checked y, sobre
  // todo, QUITA las visibles que ya NO estén checked (el usuario las desmarcó o se
  // desmarcaron al rutear y el evento change pudo no capturarse → eran el "fantasma 2-3").
  // Las filas no visibles (virtualizadas) se conservan tal cual.
  function readBoardSelection() {
    checkBoardChange(); // si cambió de estación, descarta la selección de la anterior
    document.querySelectorAll('tr input[type="checkbox"]').forEach((cb) => {
      const id = woIdFromRow(cb.closest('tr'));
      if (!id) return; // solo filas de orden (con link a /WorkOrders/)
      if (cb.checked) boardSelection.add(id);
      else boardSelection.delete(id);
    });
    return [...boardSelection];
  }

  function fabCount() {
    if (isBoardPage()) return readBoardSelection().length;
    return captured && captured.wos ? captured.wos.length : 0;
  }

  function syncFab() {
    const onBoard = isBoardPage();
    // En la ficha se monta SIEMPRE: es la puerta del ruteo y el panel de pistas no
    // necesita el contexto capturado (se carga solo desde el número de orden de la URL).
    const show = onBoard || isWorkOrderDetail() || (captured && captured.wos && captured.wos.length > 0);
    let fab = document.getElementById('sa-ar-fab');
    if (show && !fab) {
      fab = document.createElement('button');
      fab.id = 'sa-ar-fab';
      fab.className = 'sa-ar-fab';
      fab.onclick = onFab;
      document.body.appendChild(fab);
    } else if (!show && fab) {
      fab.remove();
      return;
    }
    if (fab) {
      // En la ficha el badge no aplica: el panel de pistas es de UNA orden (la de la URL),
      // no de las que el modal nativo haya capturado.
      const n = isWorkOrderDetail() && !onBoard ? 0 : fabCount();
      fab.title = onBoard
        ? (n ? `Rutear ${n} orden(es) seleccionada(s)` : 'Selecciona órdenes en el board y presiona 🔀')
        : 'Rutear esta orden — completa o por grupos de piezas';
      fab.textContent = '🔀';
      if (n > 0) {
        const b = document.createElement('span');
        b.className = 'sa-ar-badge';
        b.textContent = String(n);
        fab.appendChild(b);
      }
    }
  }

  // ── FAB de partir piezas ───────────────────────────────────────────────────
  // Vive SOLO en la ficha de una OT y NO depende del contexto capturado. Es la puerta
  // del trabajo que va ANTES del ruteo: un grupo no se puede rutear hasta que existe.
  function isWorkOrderDetail() {
    return /\/Domains\/\d+\/WorkOrders\/\d+/i.test(location.pathname);
  }

  function syncSplitFab() {
    const show = isWorkOrderDetail();
    let fab = document.getElementById('sa-ar-fab-split');
    if (show && !fab) {
      fab = document.createElement('button');
      fab.id = 'sa-ar-fab-split';
      fab.className = 'sa-ar-fab sa-ar-fab-split';
      fab.textContent = '✂️';
      fab.title = 'Partir o reagrupar las piezas en grupos (mueve material real)';
      fab.onclick = openSplit;
      document.body.appendChild(fab);
    } else if (!show && fab) {
      fab.remove();
    }
  }

  function syncFabs() {
    syncFab();
    syncSplitFab();
  }

  function onFab() {
    if (isBoardPage()) {
      if (!window.AutoRouterBatch) { alert('Auto-Ruteador: módulo batch no cargado.'); return; }
      const nums = readBoardSelection();
      if (nums.length) { window.AutoRouterBatch.openWithNumbers(nums); return; }
      void rerouteActiveStation(); // sin selección → rutear las de la ESTACIÓN ACTIVA (stationId de la URL)
      return;
    }
    // En la ficha de una OT: panel de PISTAS — cubre la orden completa Y cada grupo, así
    // que es superset del single-order. Ése sigue disponible desde el popup y desde el
    // board, donde el contexto capturado del modal nativo es lo que hay.
    if (isWorkOrderDetail()) { openLanes(); return; }
    openPanel();
  }

  // "Rutear toda la estación activa": sin órdenes seleccionadas, carga las de la ESTACIÓN
  // ACTIVA (la del ?stationId= de la URL — el selector de estación del board la cambia) vía
  // SchedulablePartLocations y abre el batch. NO es "todo el board" (cada tarjeta es una
  // estación distinta). CAP anti-carga: si la estación tiene demasiadas órdenes, cargar el
  // árbol de cada una martillaría /graphql (lo que Steelhead reportó) → pide selección.
  const REROUTE_STATION_CAP = 60;
  async function rerouteActiveStation() {
    const sm = location.pathname.match(/\/Schedules\/(\d+)\/ScheduleBoard\/\d+/i);
    const stm = location.search.match(/[?&]stationId=(\d+)/);
    if (!sm || !stm) {
      alert('Auto-Ruteador: no pude leer la estación de la URL (falta ?stationId). Marca las órdenes con checkbox para rutearlas.');
      return;
    }
    let wos;
    try { wos = await window.AutoRouterAPI.fetchBoardWorkOrders(sm[1], stm[1]); }
    catch (e) { alert('Auto-Ruteador: error cargando órdenes de la estación: ' + e.message); return; }
    if (!wos.length) { alert('Auto-Ruteador: no hay órdenes en esta estación para rutear.'); return; }
    if (wos.length > REROUTE_STATION_CAP) {
      alert(`Auto-Ruteador: esta estación tiene ${wos.length} órdenes — son demasiadas para "rutear todas" (cargar el árbol de cada una es pesado para Steelhead). Marca con los checkboxes solo las que quieras mover y presiona 🔀.`);
      return;
    }
    if (!confirm(`Auto-Ruteador: cargar y rutear las ${wos.length} órdenes de ESTA estación a otra línea.\nSe carga el proceso de cada una; revisarás el preview antes de aplicar. ¿Continuar?`)) return;
    window.AutoRouterBatch.openWithWorkOrders(wos);
  }

  function openPanel() {
    if (!captured || !captured.wos || !captured.wos.length) {
      alert('Auto-Ruteador: abre primero el modal de ruteo de una orden (o selecciona varias en el board y abre el ruteo) para capturarlas, luego presiona 🔀.');
      return;
    }
    if (captured.wos.length > 1) {
      if (!window.AutoRouterBatch) { alert('Auto-Ruteador: módulo batch no cargado.'); return; }
      window.AutoRouterBatch.open(captured.wos.map((w) => ({
        idInDomain: w.idInDomain, workOrderId: w.workOrderId, partNumberId: w.partNumberId,
        partGroupId: null, routeData: w,
      })));
    } else {
      if (!window.AutoRouterPanel) { alert('Auto-Ruteador: panel no cargado.'); return; }
      const w = captured.wos[0];
      window.AutoRouterPanel.open({ workOrderId: w.workOrderId, partNumberId: w.partNumberId, routeData: w });
    }
  }

  function openBatch() {
    if (!window.AutoRouterBatch) { alert('Auto-Ruteador: módulo batch no cargado.'); return; }
    // Modo manual (sin contexto capturado): pegar números de orden.
    window.AutoRouterBatch.open();
  }

  // Ruteo POR PISTAS (la orden completa y/o cada grupo de piezas a su propia línea).
  // La orden sale de la URL de su ficha; si no estamos ahí, se pide el número. No usa
  // el contexto capturado del modal: ese trae UN grupo y aquí se necesitan todos.
  function openLanes() { void openLanesAt('open'); }
  function openSplit() { void openLanesAt('openSplit'); }

  function openLanesAt(metodo) {
    if (!window.AutoRouterLanes) { alert('Auto-Ruteador: módulo de grupos no cargado.'); return; }
    const m = location.pathname.match(/\/WorkOrders\/(\d+)/);
    let idInDomain = m ? Number(m[1]) : null;
    if (!idInDomain) {
      const v = prompt('Número de orden (el que ves en Steelhead):');
      if (!v) return;
      idInDomain = Number(String(v).trim());
      if (!Number.isFinite(idInDomain)) { alert('Ese no es un número de orden válido.'); return; }
    }
    window.AutoRouterLanes[metodo]({ idInDomain });
  }

  // ── Entradas desde el popup ────────────────────────────────────────────────
  // El popup NO habla con la página: manda el mensaje al background, que resuelve
  // la acción en config, inyecta los scripts del app y ejecuta `action.fn` con
  // `executeScript({world:'MAIN'})`. Por eso `chrome.runtime.onMessage` NO es una
  // entrada válida — en el mundo MAIN ese API no existe, y el background ni
  // siquiera reenvía el mensaje a la pestaña (cae en su handler genérico, que
  // exige `fn`). Las tres acciones del auto-ruteador vivieron sin `fn` desde su
  // fase 1: el botón del popup contestaba "Acción desconocida" y el applet solo
  // se podía abrir por el FAB 🔀 — que necesita contexto capturado del modal
  // nativo y NUNCA ofreció el ruteo por grupos. De ahí el "no me sale".
  //
  // Las tres devuelven de INMEDIATO y difieren la apertura: `openLanes()` puede
  // pedir el número de orden con `prompt()`, que bloquearía el `executeScript`
  // (el popup se quedaría colgado en "Procesando…" hasta que el operador
  // contestara). `{started:true}` hace que el popup muestre el mensaje y ya.
  function openPanelFromPopup() {
    if (!captured || !captured.wos || !captured.wos.length) {
      return { error: 'Abre primero el modal de ruteo de una orden (o selecciona varias en el board) para capturar el contexto, y vuelve a intentar.' };
    }
    setTimeout(openPanel, 0);
    return { started: true, message: `Abriendo el Auto-Ruteador (${captured.wos.length} orden(es))…` };
  }

  function openBatchFromPopup() {
    if (!window.AutoRouterBatch) return { error: 'Módulo batch no cargado.' };
    setTimeout(openBatch, 0);
    return { started: true, message: 'Abriendo el ruteo por lotes…' };
  }

  function openLanesFromPopup() { return desdePopup(openLanes, 'el ruteo'); }
  function openSplitFromPopup() { return desdePopup(openSplit, 'partir/reagrupar piezas'); }

  function desdePopup(fn, que) {
    if (!window.AutoRouterLanes) return { error: 'Módulo de grupos no cargado.' };
    setTimeout(fn, 0);
    const m = location.pathname.match(/\/WorkOrders\/(\d+)/);
    return {
      started: true,
      message: m
        ? `Abriendo ${que} de la OT ${m[1]}…`
        : 'Escribe el número de orden en la ventana que se abrió sobre Steelhead.',
    };
  }

  function installUrlListener() {
    if (window.__saAutoRouterUrlListener) return;
    window.__saAutoRouterUrlListener = true;
    const fire = () => window.dispatchEvent(new Event('sa-ar-url'));
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); fire(); return r; };
    });
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  function init() {
    if (window.__saAutoRouterInit) return;
    window.__saAutoRouterInit = true;
    const disabled = document.documentElement.dataset.saAutoRouterEnabled === 'false';
    if (disabled) { log('Deshabilitado'); return; }
    injectStyles();
    patchFetch();
    installUrlListener();
    window.addEventListener('sa-ar-context', syncFabs);
    window.addEventListener('sa-ar-url', () => {
      checkBoardChange(); // cambio de board O de estación → limpia selección + contexto (FAB se quita al salir)
      syncFabs();
    });
    // Rastreo de selección del board + badge en vivo: al marcar/desmarcar un checkbox,
    // acumula/quita el idInDomain de esa fila (sobrevive la virtualización del scroll).
    document.addEventListener('change', (e) => {
      if (!isBoardPage()) return;
      const t = e.target;
      if (!t || typeof t.matches !== 'function' || !t.matches('input[type="checkbox"]')) return;
      checkBoardChange(); // por si el selector de estación cambió sin disparar sa-ar-url
      const id = woIdFromRow(t.closest('tr'));
      if (id) { if (t.checked) boardSelection.add(id); else boardSelection.delete(id); }
      syncFabs();
    }, true);
    syncFabs();
    log(`cargado · v${VERSION}`);
  }

  if (typeof window !== 'undefined') {
    window.AutoRouter = {
      VERSION, init, getContext,
      openPanel, openBatch, openLanes, openSplit,
      openPanelFromPopup, openBatchFromPopup, openLanesFromPopup, openSplitFromPopup,
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return { VERSION, init, openPanel, openLanes, openSplit, getContext, openLanesFromPopup, openSplitFromPopup };
})();
