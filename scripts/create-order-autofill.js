// Create Order Autofill
// Auto-llena las Entradas Personalizadas del modal de creación de OV. Dos pantallas:
//   1. /Receiving/CustomerParts → "RECEIVE" → "+ / Create"  → título "Crear Orden de Venta" (ES),
//      cliente pre-cargado, expone "Enviar a:" (ship-to).
//   2. /Domains/<id>/SalesOrders → "New Sales Order"          → título "Create Sales Order" (EN),
//      cliente vacío (el operador lo elige a mano), SIN ship-to.
// Mismos IDs RJSF en ambos modales (root_RazonSocialVenta / root_Divisa / root_ConsolidarPorProducto),
// así que el mismo autofill sirve para los dos; solo cambia el gate de URL y el título.
//
// Reglas:
//   - Razón Social  ← customer.customInputs.DatosFactura.RazonSocialVenta (match exacto contra <option>)
//   - Divisa        ← customer.customInputs.DatosFactura.Divisa            (match exacto/substring contra <option>)
//   - Consolidar    ← ship-to-driven: marca checkbox si "Enviar a:" del modal contiene "javier rojo"
//                     (en la pantalla SalesOrders no hay ship-to → Consolidar no aplica, se omite)
//
// Depende de: SteelheadAPI, CreateOrderAutofillCore (create-order-autofill-core.js)
//
// FIX 2026-08-07 (v0.1.8): reporte de piso — "falla en equipos Windows de menor desempeño".
// Tres causas, dos de ellas MEDIDAS en producción (/Domains/344/SalesOrders):
//   1. EL DISPARO SE MORÍA AL REGRESAR. `setupObserver()` hacía `if (observerActive) return`
//      ANTES de `startDetectPoll()`, y el observer nunca se desconectaba ⇒ el latch seguía en
//      true al volver por navegación SPA y el poll ya no arrancaba. Sonda en vivo: 4 ticks/3.5s
//      en la primera visita, **0 al volver**. Sin poll, el applet queda colgado del
//      MutationObserver, que en esa pantalla despierta UNA vez —al montarse el modal, o sea
//      ANTES de que el operador elija cliente— y ya no vuelve a mirar. Ahora cada recurso se
//      enciende por su propio estado (`Core.lifecycleActions`).
//   2. UN FALLO DE RED SE REPORTABA COMO "FALTA CONFIGURAR EL CLIENTE" y se CACHEABA. Un
//      timeout dejaba al cliente marcado como sin `DatosFactura` para el resto de la sesión.
//   3. EL TICK PAGABA DE MÁS. Con el modal abierto, cada pasada barría los headings de TODO
//      el documento 3 veces + `label,span,div,p` del documento entero (el walk del wizard, que
//      en la pantalla de OVs nunca encuentra nada). Medido: 2.94 ms/tick en una Mac con un DOM
//      de 2308 nodos — en un equipo de piso con la lista cargada, decenas de ms cada segundo,
//      en el mismo hilo con el que el operador teclea. Ahora el root sale de un `closest()`.
//
// FIX 2026-08-05 (v0.1.4): SH cambió el control de "Cliente:" — al confirmar la selección
// YA NO monta un <div …singleValue>NOMBRE (#N)</div>; escribe el label del valor en el
// `value` del <input role="combobox">. Como el applet solo leía singleValues, el cliente
// quedó invisible y el fallback por label se robaba el singleValue del CONTACTO
// ("Miguel Castillo") → sin (#N) → "sin idInDomain" → cero autofill. Ahora se leen las DOS
// formas (collectComboboxValues + Core.pickCustomerFromCandidates) y el fallback por label
// se acotó al bloque del propio campo. Medido en vivo, no adivinado.
//
// FIX 2026-07-03: la extracción del cliente ya NO depende del label-walk frágil
// (findSingleValueByLabel hacía `return null` al toparse el input[role=combobox]
// del react-select ANTES de hallar el singleValue → "(sin cliente)" → "sin idInDomain"
// para TODOS los clientes). Ahora el cliente se elige por el singleValue que trae el
// badge "(#N)" (único en el modal), y como red de seguridad se resuelve el idInDomain
// por nombre vía CustomerSearchByName si faltara el badge. Ver bitácora + core.

const CreateOrderAutofill = (() => {
  'use strict';

  // Fallbacks locales por si el core no cargara (el core va ANTES en el array scripts,
  // así que normalmente se usan sus helpers homónimos vía urlMatches()/headingMatches()).
  const URL_RE = /\/Receiving\/CustomerParts(?:\/|$)|\/Domains\/\d+\/SalesOrders\/?$/;
  const MODAL_HEADING_RE = /^\s*(?:crear\s+orden\s+de\s+venta|create\s+sales\s+order)\s*$/i;
  const RJSF_RAZON_ID = 'root_RazonSocialVenta';
  const RJSF_DIVISA_ID = 'root_Divisa';
  const RJSF_CONSOLIDAR_ID = 'root_ConsolidarPorProducto';
  const ROJO_GOMEZ_RE = /javier\s*rojo/i;

  const api = () => window.SteelheadAPI;
  const core = () => window.CreateOrderAutofillCore;
  const log = (m) => (api()?.log ? api().log(`[create-order-autofill] ${m}`) : console.log('[create-order-autofill]', m));
  const warn = (m) => (api()?.warn ? api().warn(`[create-order-autofill] ${m}`) : console.warn('[create-order-autofill]', m));

  const urlMatches = (p) => {
    const c = core();
    return c?.matchesCreateOrderUrl ? c.matchesCreateOrderUrl(p) : URL_RE.test(p);
  };
  const headingMatches = (t) => {
    const c = core();
    return c?.isCreateOrderModalHeading ? c.isCreateOrderModalHeading(t) : MODAL_HEADING_RE.test(t);
  };

  const _customerCache = new Map();   // idInDomain → customer
  const _nameIdCache = new Map();     // normalizedName → idInDomain|null
  let observer = null;                // el MutationObserver vivo (null = desconectado)
  let debounceTimer = null;
  let detectPollTimer = null;
  let state = {
    runId: 0,
    lastSig: null,
    panel: null,
    wizardRoot: null,   // caché del wizard padre (se revalida con isConnected)
    wizardBox: null,    // caché del bloque del label "Cliente:" dentro del wizard
    results: { razon: null, divisa: null, consolidar: null }
  };

  function init() {
    if (window.__saCreateOrderAutofillVersion) return;
    if (document.documentElement.dataset.saCreateOrderAutofillEnabled === 'false') {
      log('deshabilitado');
      return;
    }
    setupUrlListener();
    // El latch marca el ÉXITO, no el intento: si algo de arriba tirara, la siguiente
    // evaluación reintenta en vez de congelar el fallo para toda la vida de la página.
    window.__saCreateOrderAutofillVersion = true;
    log(`init en ${location.pathname} (matches=${urlMatches(location.pathname)})`);
    checkUrl();
  }

  function setupUrlListener() {
    if (window.__saCreateOrderAutofillHistoryPatched) return;
    window.__saCreateOrderAutofillHistoryPatched = true;
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        checkUrl();
        return r;
      };
    });
    window.addEventListener('popstate', checkUrl);
  }

  // Cada recurso se enciende/apaga por SU PROPIO estado. La versión anterior colgaba el
  // arranque del poll del latch del observer (`if (observerActive) return` antes de
  // `startDetectPoll()`), y como el observer no se desconectaba nunca, al REGRESAR a la
  // pantalla por navegación SPA el poll ya no volvía a arrancar. Medido en producción el
  // 2026-08-07: 4 ticks/3.5 s en la primera visita, **0 al volver**. Decisión en el core
  // (`Core.lifecycleActions`), con test de regresión.
  function checkUrl() {
    const c = core();
    const st = {
      routeMatches: urlMatches(location.pathname),
      observerConnected: !!observer,
      pollRunning: !!detectPollTimer
    };
    const act = c?.lifecycleActions
      ? c.lifecycleActions(st)
      : (st.routeMatches
        ? { observer: st.observerConnected ? 'keep' : 'connect', poll: st.pollRunning ? 'keep' : 'start', scan: true, removePanel: false, resetSignature: false }
        : { observer: 'disconnect', poll: 'stop', scan: false, removePanel: true, resetSignature: true });

    if (act.observer === 'disconnect') stopObserver();
    else if (act.observer === 'connect') startObserver();
    if (act.poll === 'stop') stopDetectPoll();
    else if (act.poll === 'start') startDetectPoll();
    if (act.removePanel) removePanel();
    if (act.resetSignature) { state.lastSig = null; state.wizardRoot = null; state.wizardBox = null; }
    if (act.scan) scanForModal();
  }

  // El MutationObserver por sí solo NO es confiable para detectar este modal: medido en la
  // máquina del operador (2026-08-06), en `/Domains/<id>/SalesOrders` el modal se abría y el
  // applet no corría — pero al invocar `scanForModal()` a mano hacía todo el trabajo (o sea:
  // no era la firma ni la extracción, era el DISPARO). En `/Receiving/CustomerParts` el mismo
  // observer sí despertaba. Se adoptó el mecanismo que en ESTE repo ya detecta modales de forma
  // fiable en las mismas pantallas: `weight-quick-entry` no se fía del observer, agrega un
  // POLL acotado. El observer se queda (reacciona en el mismo frame cuando sí dispara) y el
  // poll es la red de seguridad.
  //
  // 2026-08-07 — MEDIDO por qué el observer no alcanza: con el modal abierto hubo **0
  // mutaciones de `childList` en el body durante 6 s**, incluso tecleando en el buscador de
  // cliente. No es un vigilante continuo: dispara en eventos discretos, y en esa pantalla el
  // único que llega es el montaje del modal — o sea, ANTES de que haya cliente que leer. El
  // poll no es "una red por si acaso": es el ÚNICO mecanismo que ve al operador elegir cliente.
  const DETECT_POLL_MS = 1000;

  function startObserver() {
    if (observer) return;
    const obs = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scanForModal, 350);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // El latch marca el ÉXITO, no el intento: si `observe` tirara, `observer` se queda en
    // null y el siguiente checkUrl() reintenta, en vez de congelar el fallo para siempre.
    observer = obs;
  }

  // Fuera de las pantallas del applet no hay nada que observar: dejar un observer de
  // `body + subtree` vivo cobra en CADA render de la SPA, en todas las demás pantallas.
  function stopObserver() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  // Tick barato: `scanForModal` arranca con tres getElementById y sale de inmediato si el
  // modal no está montado; es idempotente por `state.lastSig`, así que el poll no repite
  // trabajo ni refetchea (el customer va cacheado por idInDomain).
  //
  // Se llama SIEMPRE, sin filtrar antes por "¿hay modal?": ese camino es también el que
  // RESETEA `lastSig` al cerrarse el modal. Sin ese reset, abrir una segunda OV para el
  // MISMO cliente y destino produce una firma idéntica y el applet se salta el trabajo,
  // dejando el modal nuevo —que es DOM nuevo, con los campos vacíos— sin llenar.
  function startDetectPoll() {
    if (detectPollTimer) return;
    detectPollTimer = setInterval(() => {
      try {
        scanForModal();
      } catch (err) {
        warn(`poll de detección: ${err.message}`);
      }
    }, DETECT_POLL_MS);
  }

  function stopDetectPoll() {
    if (!detectPollTimer) return;
    clearInterval(detectPollTimer);
    detectPollTimer = null;
  }

  // ── Detección del modal ──

  function scanForModal() {
    const razonSel = document.getElementById(RJSF_RAZON_ID);
    const divisaSel = document.getElementById(RJSF_DIVISA_ID);
    const consolidarChk = document.getElementById(RJSF_CONSOLIDAR_ID);
    if (!razonSel || !divisaSel || !consolidarChk) {
      // Modal cerrado o aún no montado
      if (state.lastSig !== null) {
        state.lastSig = null;
        state.wizardRoot = null;
        state.wizardBox = null;
        removePanel();
      }
      return;
    }
    // El root se calcula UNA vez por pasada y se reparte. Antes lo recalculaba cada extractor
    // (`getModalRoot()` sin argumento) barriendo los headings de TODO el documento: 3 barridos
    // por tick, cada segundo, mientras el modal esté abierto. En un equipo de piso eso es
    // trabajo de sobra en el hilo que el operador está usando para teclear.
    const root = getModalRoot(razonSel);
    if (!root || !isCreateOrderModal(root)) return;

    const customerName = extractCustomerNameFromModal(root);
    const shipTo = extractShipToFromModal(root);
    const sig = `${customerName || '?'}||${shipTo || '?'}`;
    if (sig === state.lastSig) return;
    state.lastSig = sig;
    state.runId++;
    const myRun = state.runId;

    log(`modal detectado | cliente=${customerName || '(sin cliente)'} | shipTo=${shipTo || '(sin shipTo)'}`);

    runAutofill(myRun, { customerName, shipTo, razonSel, divisaSel, consolidarChk })
      .catch(err => {
        warn(`runAutofill: ${err.message}`);
        // La firma marcaba el INTENTO: si la corrida moría a medias (red caída, timeout de
        // 90 s, API sin cargar), el modal quedaba sin llenar y NADIE reintentaba, porque la
        // firma seguía igual. Al soltarla, el siguiente tick del poll vuelve a intentarlo.
        if (!isStale(myRun)) state.lastSig = null;
      });
  }

  function isStale(myRun) { return state.runId !== myRun; }

  const HEAD_SEL_SMALL = 'h1, h2, h3, h4, [class*="MuiTypography-h"]';

  function isCreateOrderModal(root) {
    const scope = root || document;
    for (const h of scope.querySelectorAll(HEAD_SEL_SMALL)) {
      if (headingMatches((h.textContent || '').trim())) return true;
    }
    // Degradación explícita: si el título no colgara del root, se busca en todo el documento
    // como siempre. Un gate que no matchea se apaga EN SILENCIO, así que el camino barato no
    // puede ser el único — solo el primero.
    if (scope !== document) {
      for (const h of document.querySelectorAll(HEAD_SEL_SMALL)) {
        if (headingMatches((h.textContent || '').trim())) return true;
      }
    }
    return false;
  }

  // Subir al paper/contenedor del MUI Dialog que contiene el modal "Crear Orden de
  // Venta" para anclar las búsquedas SOLO dentro del modal (no del wizard padre
  // "Recibir piezas del cliente").
  //
  // FIX 2026-07-03 (v0.1.2): el heading es un <h2 class="...MuiDialogTitle-root...">,
  // cuya clase contiene el substring "MuiDialog". El código viejo arrancaba el match
  // EN el heading con `[class*="MuiDialog"]`, así que devolvía el TÍTULO (vacío) en la
  // iteración 0 → svInRoot=0 → cliente=null → "sin idInDomain" para TODOS. Ahora se
  // sube desde el PADRE del heading y se acepta como root solo el paper/contenedor del
  // diálogo (Core.isDialogRootClass excluye Title/Content/Actions y el paper genérico
  // del accordion RJSF).
  function isDialogRoot(el) {
    if (!el) return false;
    if (el.matches?.('[role="dialog"]')) return true;
    const c = core();
    const cls = String(el.className || '');
    return c
      ? c.isDialogRootClass(cls)
      : (cls.includes('MuiDialog') && !/MuiDialog(Title|Content|Actions|ContentText)/.test(cls));
  }

  // `hint` = un campo RJSF ya localizado. Con él la vía normal es un `closest()` desde el
  // propio campo —O(profundidad del nodo)— en vez del barrido de headings de todo el
  // documento, que era lo que se pagaba antes en cada extracción.
  function getModalRoot(hint) {
    const field = hint || document.getElementById(RJSF_RAZON_ID) || document.getElementById(RJSF_DIVISA_ID);
    if (field) {
      const dlg = field.closest?.('[role="dialog"]');
      if (dlg) return dlg;
      // Sube PAST el paper chico del accordion (que no lleva "MuiDialog") y el DialogContent.
      let cur = field.parentElement;
      for (let i = 0; i < 24 && cur; i++) {
        if (isDialogRoot(cur)) return cur;
        cur = cur.parentElement;
      }
    }
    // Fallback histórico: desde el heading del modal. Arranca ARRIBA del heading, porque su
    // propia clase MuiDialogTitle-root es un cebo para `[class*="MuiDialog"]`.
    for (const h of document.querySelectorAll(HEAD_SEL_SMALL)) {
      if (!headingMatches((h.textContent || '').trim())) continue;
      let cur = h.parentElement;
      for (let i = 0; i < 14 && cur; i++) {
        if (isDialogRoot(cur)) return cur;
        cur = cur.parentElement;
      }
    }
    return null;
  }

  // ── Extracción dentro del modal ──

  // Junta los textos de todos los react-select singleValue del modal, quitando el
  // avatar/imagen (que se pega al nombre: "C"+"CONTROLES..." → "CCONTROLES...").
  function collectSingleValueTexts(root) {
    const out = [];
    const svs = root.querySelectorAll('[class*="singleValue"], [class*="SingleValue"]');
    for (const sv of svs) {
      const clone = sv.cloneNode(true);
      clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
      const t = (clone.textContent || '').trim();
      if (t) out.push(t);
    }
    return out;
  }

  // Los `value` de los react-select del modal. SH pinta el valor elegido de DOS formas:
  // como <div …singleValue> (histórica) o escribiéndolo en el <input role="combobox">
  // (forma nueva del campo Cliente, medida 2026-08-05). Leer solo la primera dejaba al
  // cliente invisible.
  function collectComboboxValues(root) {
    const out = [];
    for (const inp of root.querySelectorAll('input[role="combobox"]')) {
      const v = (inp.value || '').trim();
      if (v) out.push(v);
    }
    return out;
  }

  // Devuelve el nombre del cliente tal como aparece en el modal (con "(#N)" si lo trae).
  // Primario: el valor con badge "(#N)" entre TODOS los react-select del modal —
  // singleValues + values de los combobox (label-independiente).
  // Fallback: label-anchored, acotado al bloque del propio campo.
  function extractCustomerNameFromModal(rootHint) {
    const root = rootHint || getModalRoot();
    if (!root) return null;
    const c = core();
    if (c) {
      const picked = c.pickCustomerFromCandidates
        ? c.pickCustomerFromCandidates(collectSingleValueTexts(root), collectComboboxValues(root))
        : c.pickCustomerFromSingleValues(collectSingleValueTexts(root));
      if (picked) return picked.raw;
    }
    // maxHops=1: SOLO el bloque inmediato del label. Con el recorrido largo, al no haber
    // ya singleValue de Cliente el walk seguía a los campos vecinos y devolvía el
    // singleValue del CONTACTO ("Miguel Castillo") como si fuera el cliente — una mentira
    // coherente que el panel mostraba como dato bueno.
    const hit = findFieldTextByLabel(root, /^\s*(?:cliente|customer):?\s*$/i, 1);
    if (!hit) return extractCustomerFromReceiveWizard(root);
    // Un input sin "(#N)" es texto EN TRÁNSITO (el operador está tecleando la búsqueda),
    // no un cliente: aceptarlo dispararía un CustomerSearchByName por tecla contra un
    // /graphql que se cuelga bajo ráfaga. El singleValue sí puede ir sin badge — para eso
    // existe el fallback de resolver el idInDomain por nombre.
    if (hit.from === 'input' && !(c && c.extractCustomerIdInDomain(hit.text))) {
      return extractCustomerFromReceiveWizard(root);
    }
    if (hit.text) return c ? c.cleanCustomerName(hit.text) : hit.text;
    return extractCustomerFromReceiveWizard(root);
  }

  // Último recurso: el WIZARD PADRE de recepción. En /Receiving/CustomerParts el modal
  // "Crear Orden de Venta" nace con su campo "Cliente:" VACÍO (antes SH lo precargaba) y
  // el cliente real vive en el wizard "Recibir piezas del cliente", FUERA del
  // [role="dialog"] del modal — así que getModalRoot() no lo alcanza y el applet no
  // pintaba NADA, ni el panel. Ahí el nombre viene SIN "(#N)" (p. ej. "SCHNEIDER ELECTRIC
  // USA INC"), así que el idInDomain se resuelve por CustomerSearchByName.
  //
  // El anclaje (wizard = [role="dialog"] con heading bilingüe, y buscar el valor en el
  // CONTENEDOR del label leyendo singleValue **o** input) está copiado de
  // weight-quick-entry, que resuelve el cliente en esta misma pantalla en producción.
  const HEADING_SEL = 'h1, h2, h3, h4, h5, h6, [class*="MuiTypography"], [class*="heading"], [class*="title"]';
  const WIZARD_RE = /receive\s+parts\s+from\s+customer|recibir\s+piezas\s+del\s+cliente/i;

  // Mismo regex que weight-quick-entry: un combo sin elegir muestra "Select..." /
  // "Buscar..." como TEXTO, y tomarlo por nombre de cliente dispararía una búsqueda
  // inútil contra el /graphql (y peor: un cliente equivocado si algo hiciera match).
  const PLACEHOLDER_RE = /^(buscar|search|select|seleccionar|todo|all|elegir|choose)/i;
  const isPlaceholderText = (t) => !t || t.length < 3 || PLACEHOLDER_RE.test(t);

  // Contenedor del wizard. Cascada copiada de weight-quick-entry: el wizard NO siempre es
  // un [role="dialog"] (en la captura del 2026-08-05 se ve como pantalla completa), así
  // que se degrada a MuiDialog → MuiPaper → document.body. Con body de último recurso el
  // ancla nunca se apaga en silencio; el subárbol del modal se excluye aparte.
  function findReceiveWizardRoot(modalRoot) {
    if (state.wizardRoot && state.wizardRoot.isConnected) return state.wizardRoot;
    for (const h of document.querySelectorAll(HEADING_SEL)) {
      const t = (h.textContent || '').trim();
      if (!t || t.length > 60) continue;
      const c = core();
      const match = c?.isReceiveWizardHeading ? c.isReceiveWizardHeading(t) : WIZARD_RE.test(t);
      if (!match) continue;
      if (modalRoot && modalRoot.contains(h)) continue;   // el heading del propio modal, no
      const found = h.closest('[role="dialog"]')
        || h.closest('[class*="MuiDialog"]')
        || h.closest('[class*="MuiPaper"]')
        || document.body;
      state.wizardRoot = found;
      return found;
    }
    return null;
  }

  // Lee el valor de cliente de un bloque ya localizado (singleValue o input). Barato: es lo
  // único que se repite en cada pasada cuando el bloque ya está cacheado.
  function readCustomerFromBox(box) {
    const sv = box.querySelector('[class*="singleValue"], [class*="SingleValue"]');
    if (sv) {
      const clone = sv.cloneNode(true);
      clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
      const t = (clone.textContent || '').trim();
      if (!isPlaceholderText(t)) return t;
    }
    for (const inp of box.querySelectorAll('input')) {
      const v = (inp.value || '').trim();
      if (!isPlaceholderText(v)) return v;
    }
    return null;
  }

  const isReceivingRoute = () => /\/Receiving\/CustomerParts(?:\/|$)/.test(location.pathname);

  function extractCustomerFromReceiveWizard(modalRoot) {
    // 1) Bloque ya localizado: releerlo cuesta un querySelector acotado.
    if (state.wizardBox && state.wizardBox.isConnected
      && !(modalRoot && modalRoot.contains(state.wizardBox))) {
      const cached = readCustomerFromBox(state.wizardBox);
      if (cached) return cached;
    }
    // 2) El wizard de recepción SOLO existe en /Receiving/CustomerParts. En la pantalla de
    //    Órdenes de Venta este camino nunca encontraba nada y aun así pagaba, en CADA tick del
    //    poll, un `querySelectorAll('label, span, div, p')` sobre todo el documento leyendo el
    //    `textContent` de cada nodo — el barrido más caro del applet, corriendo justo mientras
    //    el operador teclea el nombre del cliente. Es el mismo regex de ruta con el que ya se
    //    gatea la carga del applet, no un ancla nueva.
    if (!isReceivingRoute()) return null;
    const wizard = findReceiveWizardRoot(modalRoot);
    if (wizard) {
      for (const el of wizard.querySelectorAll('label, span, div, p')) {
        const txt = (el.textContent || '').trim();
        if (!/^(?:customer|cliente):?$/i.test(txt)) continue;
        // El wizard ENVUELVE al modal: si el label es el del propio modal (vacío), fuera.
        if (modalRoot && modalRoot.contains(el)) continue;
        const box = el.closest('div[class*="field"]') || el.closest('div')?.parentElement || el.parentElement;
        if (!box || (modalRoot && modalRoot.contains(box))) continue;
        const v = readCustomerFromBox(box);
        if (v) { state.wizardBox = box; return v; }
      }
    }
    return null;
  }

  function extractShipToFromModal(rootHint) {
    const root = rootHint || getModalRoot();
    if (!root) return null;
    // Bilingüe: "Enviar a:" (ES) y "Ship To:" (EN, label real de SH observado en las pantallas
    // de facturación); si SH se muestra en inglés, el ancla mono-ES no encontraba el ship-to
    // → Consolidar no se marcaba. El OR no rompe el caso ES.
    const hit = findFieldTextByLabel(root, /^\s*(?:enviar\s+a|ship\s+to):?\s*$/i, 8);
    return hit ? hit.text : null;
  }

  // Localiza el VALOR de un react-select por su label de <p>label:</p>. Devuelve
  // { text, from: 'singleValue'|'input' } o null — el llamador necesita saber la fuente
  // (un input puede traer texto a medio teclear; un singleValue ya es un valor elegido).
  // Se prefiere la ÚLTIMA etiqueta que matchea (la del modal, no la del wizard padre).
  // `maxHops` acota cuántos hermanos se recorren: 1 = solo el bloque del propio campo.
  // NO se hace bail al toparse el input[role=combobox] (ese bail rompía la extracción:
  // el react-select SIEMPRE monta el combobox junto al valor).
  function findFieldTextByLabel(root, labelRe, maxHops = 8) {
    const candidates = [];
    for (const el of root.querySelectorAll('p, label, span')) {
      const raw = (el.textContent || '').trim();
      if (raw.length === 0 || raw.length > 40) continue;
      const cleaned = raw.replace(/[\s:*]+$/, '').trim();
      if (!labelRe.test(cleaned) && !labelRe.test(raw)) continue;
      if (el.querySelector('input, textarea, button, select')) continue;
      candidates.push(el);
    }
    // De la última a la primera (la del modal suele ser la última en el DOM).
    for (let i = candidates.length - 1; i >= 0; i--) {
      let labelRoot = candidates[i];
      while (labelRoot.parentElement
        && labelRoot.parentElement.children.length === 1
        && labelRoot.parentElement.firstElementChild === labelRoot
        && !['BODY', 'HTML'].includes(labelRoot.parentElement.tagName)) {
        labelRoot = labelRoot.parentElement;
      }
      let cursor = labelRoot.nextElementSibling;
      let hops = 0;
      while (cursor && hops < maxHops) {
        const sv = cursor.querySelector('[class*="singleValue"], [class*="SingleValue"]');
        if (sv) {
          const clone = sv.cloneNode(true);
          clone.querySelectorAll('[class*="avatar"], [class*="Avatar"], svg, img').forEach(a => a.remove());
          const t = (clone.textContent || '').trim();
          if (t) return { text: t, from: 'singleValue' };
        }
        const inp = cursor.querySelector('input[role="combobox"]');
        const v = inp ? (inp.value || '').trim() : '';
        if (v) return { text: v, from: 'input' };
        cursor = cursor.nextElementSibling;
        hops++;
      }
    }
    return null;
  }

  // ── Fetch del customer ──

  // Devuelve `{ customer, error }`. La distinción NO es cosmética: un cliente que de verdad
  // no tiene capturadas sus Entradas Personalizadas y un cliente que no pudimos LEER se veían
  // idénticos —`null`— y el panel acusaba al catálogo («el cliente no tiene DatosFactura…»,
  // en ámbar, con liga para ir a capturar algo que ya estaba capturado). Peor: ese `null` de
  // un timeout se guardaba en el caché por `idInDomain` y envenenaba el RESTO de la sesión,
  // así que cerrar y reabrir el modal ya no recuperaba. En un equipo lento o con red de planta
  // ése es el camino frecuente, no el excepcional.
  async function fetchCustomerCustomInputs(idInDomain) {
    if (idInDomain == null) return { customer: null, error: null };
    if (_customerCache.has(idInDomain)) return { customer: _customerCache.get(idInDomain), error: null };
    const c = core();
    try {
      const sdk = api();
      if (!sdk || typeof sdk.query !== 'function') {
        // Sin API no hay dato: se dice, no se inventa. (El array `scripts` carga
        // steelhead-api.js antes, pero un fetch que falló deja al glue solo y en silencio.)
        return { customer: null, error: 'la API de Steelhead no cargó' };
      }
      const data = await sdk.query('Customer', { idInDomain, includeAccountingFields: true });
      const customer = data?.customerByIdInDomain || null;
      if (!c || c.cacheableCustomerResult(customer, null)) _customerCache.set(idInDomain, customer);
      return { customer, error: null };
    } catch (err) {
      warn(`Customer(idInDomain=${idInDomain}) falló: ${err.message}`);
      // NO se cachea el fallo: el siguiente tick del poll reintenta.
      return { customer: null, error: err.message };
    }
  }

  // Fallback: resolver idInDomain desde el nombre del cliente (sin "(#N)") vía
  // CustomerSearchByName. Solo se usa si el badge "(#N)" no estuviera presente.
  async function resolveIdInDomainByName(rawName) {
    const c = core();
    const clean = (c ? c.cleanCustomerName(rawName) : String(rawName || ''))
      .replace(/\s*\(#\d+\)\s*$/, '').trim();
    if (!clean) return null;
    const key = c ? c.normalizeForMatch(clean) : clean.toLowerCase();
    if (_nameIdCache.has(key)) return _nameIdCache.get(key);
    try {
      // Variables COPIADAS de weight-quick-entry, que resuelve clientes por nombre en
      // producción (log real: "usarLBS=false (via Customer idInDomain=20)"). Las que había
      // aquí (searchText/name/query/first) no coinciden con ninguna firma viva — este
      // fallback dejó de ser teórico al volverse la vía principal del flujo de Recibo,
      // donde el nombre del wizard llega SIN "(#N)".
      const sdk = api();
      if (!sdk || typeof sdk.query !== 'function') {
        warn('la API de Steelhead no cargó — no puedo resolver el cliente por nombre');
        return null;
      }
      const r = await sdk.query('CustomerSearchByName',
        { nameLike: `%${clean}%`, orderBy: ['NAME_ASC'] }, 'CustomerSearchByName');
      const nodes = r?.searchCustomers?.nodes || r?.allCustomers?.nodes || [];
      let hit = nodes.find(n => (c ? c.normalizeForMatch(n.name) : String(n.name || '').toLowerCase()) === key);
      if (!hit) hit = nodes.find(n => String(n.name || '').toUpperCase().includes(clean.toUpperCase()));
      if (!hit && nodes.length === 1) hit = nodes[0];
      const id = hit ? hit.idInDomain : null;
      _nameIdCache.set(key, id);
      return id;
    } catch (err) {
      warn(`resolveIdInDomainByName("${clean}") falló: ${err.message}`);
      return null;
    }
  }

  // ── Fills ──

  function fillNativeSelectByText(sel, targetText) {
    if (!sel || !targetText) return { success: false, reason: 'sin select o target' };
    const c = core();
    if (!c) return { success: false, reason: 'core no cargado' };
    const targetNorm = c.normalizeForMatch(targetText);
    if (!targetNorm) return { success: false, reason: 'target vacío' };

    const optionTexts = [...sel.options].map(o => o.text || '');

    // ¿Ya está en el valor correcto? Se pregunta con la MISMA vara con la que se escribe
    // (scoreOptionMatch), no con igualdad exacta: el cliente puede guardar `"USD"` mientras
    // la opción dice `"USD - Dólar americano"`. Con la comparación exacta, la re-pasada del
    // poll no reconocía su propio trabajo y reportaba en rojo un campo BIEN puesto.
    const yaEsta = c.isSelectAlreadyOnTarget
      ? c.isSelectAlreadyOnTarget(optionTexts, sel.selectedIndex, targetText)
      : c.normalizeForMatch(sel.options?.[sel.selectedIndex]?.text || '') === targetNorm;
    if (yaEsta) {
      return { success: true, filled: sel.options[sel.selectedIndex].text, noop: true };
    }

    // Si el operador ya seleccionó algo distinto, NO sobreescribir. Sólo se llega aquí
    // cuando el valor actual NO es el que pondríamos ⇒ el cambio sí es del operador.
    if (sel.dataset.saAutofilled === 'done' && sel.value && sel.value !== '') {
      return { success: false, reason: 'usuario tocó después de autofill' };
    }

    const match = c.scoreOptionMatch(optionTexts, targetText);
    if (!match.pass) {
      return { success: false, reason: `sin match (mejor score=${match.score})` };
    }
    const best = sel.options[match.index];

    const tracker = sel._valueTracker;
    if (tracker) tracker.setValue('');
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(sel, best.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dataset.saAutofilled = 'done';
    return { success: true, filled: best.text };
  }

  function setCheckbox(chk, target) {
    if (!chk) return { success: false, reason: 'sin checkbox' };
    if (chk.dataset.saAutofilled === 'done') {
      return { success: true, noop: true, value: chk.checked };
    }
    if (chk.checked === target) {
      chk.dataset.saAutofilled = 'done';
      return { success: true, noop: true, value: chk.checked };
    }
    // RJSF acepta click() en boolean checkboxes
    chk.click();
    chk.dataset.saAutofilled = 'done';
    return { success: true, value: chk.checked };
  }

  // ── Run principal ──

  async function runAutofill(myRun, { customerName, shipTo, razonSel, divisaSel, consolidarChk }) {
    let idInDomain = core() ? core().extractCustomerIdInDomain(customerName) : null;

    // Fallback: si no vino el badge "(#N)", resolver por nombre.
    if (idInDomain == null && customerName) {
      idInDomain = await resolveIdInDomainByName(customerName);
      if (isStale(myRun)) return;
      if (idInDomain != null) log(`idInDomain resuelto por nombre → ${idInDomain}`);
    }

    if (idInDomain == null) {
      // Pantalla SalesOrders: el modal abre SIN cliente (el operador lo elige a mano).
      // No mostramos panel de error mientras no haya cliente — esperamos en silencio a
      // que lo seleccione (la firma cambia y re-dispara el scan). Solo reportamos error
      // si SÍ hay nombre de cliente pero no pudimos resolver su idInDomain.
      if (!customerName) {
        log('modal abierto sin cliente elegido aún — esperando selección');
        removePanel();
        return;
      }
      log(`sin idInDomain (cliente="${customerName}") — no autofill`);
      state.results = { razon: { ok: false, msg: 'sin idInDomain' }, divisa: { ok: false, msg: 'sin idInDomain' }, consolidar: null };
      renderPanel({ customerName, shipTo });
      return;
    }

    const { customer, error: fetchError } = await fetchCustomerCustomInputs(idInDomain);
    if (isStale(myRun)) return;

    const datos = customer?.customInputs?.DatosFactura || {};
    const targetRazon = datos.RazonSocialVenta || null;
    const targetDivisa = datos.Divisa || null;

    // `needsSetup` = falta el dato EN EL CLIENTE (el panel ofrece la liga a su ficha);
    // `retry` = no pudimos leerlo. Son cosas distintas y el operador hace algo distinto con
    // cada una, así que la decisión vive en el core (`customerFieldResult`) y no se confunden.
    const c2 = core();
    const fieldResult = (value, name) => (c2?.customerFieldResult
      ? c2.customerFieldResult(value, fetchError, name)
      : (fetchError ? { ok: false, retry: true, msg: `no pude leer al cliente (${fetchError})` }
        : (!value ? { ok: false, needsSetup: true, msg: `el cliente no tiene DatosFactura.${name}` } : null)));

    // Razón Social
    let razonResult = fieldResult(targetRazon, 'RazonSocialVenta');
    if (!razonResult) {
      const r = fillNativeSelectByText(razonSel, targetRazon);
      razonResult = r.success
        ? { ok: true, msg: r.noop ? `ya estaba: ${r.filled}` : `seleccionado: ${r.filled}` }
        : { ok: false, msg: r.reason };
    }

    // Divisa
    let divisaResult = fieldResult(targetDivisa, 'Divisa');
    if (!divisaResult) {
      const r = fillNativeSelectByText(divisaSel, targetDivisa);
      divisaResult = r.success
        ? { ok: true, msg: r.noop ? `ya estaba: ${r.filled}` : `seleccionado: ${r.filled}` }
        : { ok: false, msg: r.reason };
    }

    // Consolidar (ship-to-driven, independiente del customer). En la pantalla SalesOrders
    // el modal NO expone "Enviar a:" → sin destino no aplica la regla Rojo Gómez; lo
    // dejamos en el default RJSF (false) y lo marcamos como omitido, no como fallo.
    let consolidarResult;
    if (!shipTo) {
      consolidarResult = { ok: true, msg: 'no aplica (sin destino en esta pantalla)', skipped: true };
    } else if (ROJO_GOMEZ_RE.test(shipTo)) {
      const r = setCheckbox(consolidarChk, true);
      consolidarResult = r.success
        ? { ok: true, msg: r.noop ? 'ya estaba marcado' : 'marcado (Rojo Gómez)' }
        : { ok: false, msg: r.reason };
    } else {
      // No es Rojo Gómez — dejamos el checkbox tal cual (default RJSF=false)
      consolidarResult = { ok: true, msg: 'no aplica (otra planta)', skipped: true };
    }

    state.results = { razon: razonResult, divisa: divisaResult, consolidar: consolidarResult };
    log(`autofill | razon=${razonResult.ok ? 'OK' : 'FAIL'} | divisa=${divisaResult.ok ? 'OK' : 'FAIL'} | consolidar=${consolidarResult.ok ? 'OK' : 'FAIL'}`);

    renderPanel({ customerName, shipTo, idInDomain });

    // No haber podido LEER es reintentable: se suelta la firma para que el siguiente tick del
    // poll lo intente otra vez. Sin esto, un timeout dejaba el modal con el error puesto hasta
    // que el operador cambiara de cliente.
    if ([razonResult, divisaResult].some(r => r && r.retry) && !isStale(myRun)) state.lastSig = null;
  }

  // ── Panel UI ──

  const STATUS = {
    ok: { color: '#10b981', icon: '✓' },
    fail: { color: '#ef4444', icon: '✗' },
    skip: { color: '#94a3b8', icon: '·' }
  };

  function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function row(label, res) {
    if (!res) return '';
    const tone = res.skipped ? STATUS.skip : (res.ok ? STATUS.ok : STATUS.fail);
    return `
      <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;">
        <span style="color:${tone.color};font-weight:700;min-width:14px;">${tone.icon}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;">${escHtml(label)}</div>
          <div style="color:#e2e8f0;font-size:12px;word-break:break-word;">${escHtml(res.msg || '')}</div>
        </div>
      </div>`;
  }

  // Dominio actual: de la ruta cuando estamos bajo /Domains/<id>/… y, si no (flujo de
  // Recibo, cuya URL no lo trae), del config que ya carga SteelheadAPI. Si ninguno lo da,
  // devuelve null y el aviso se muestra SIN liga — antes que mandar al operador a la ficha
  // de otro dominio.
  function currentDomainId() {
    const c = core();
    const fromPath = c?.domainIdFromPath ? c.domainIdFromPath(location.pathname) : null;
    if (fromPath) return fromPath;
    try {
      const d = api()?.getDomain ? api().getDomain() : null;
      return d && d.id != null ? String(d.id) : null;
    } catch (_) { return null; }
  }

  // Bloque de ayuda cuando lo que falta son los customInputs DEL CLIENTE (no un fallo del
  // applet). Explica dónde se configura y ofrece la ficha del cliente en pestaña aparte.
  function setupHintHtml({ customerName, idInDomain }) {
    const c = core();
    const url = c?.customerUrl ? c.customerUrl(currentDomainId(), idInDomain) : null;
    const quien = customerName ? escHtml(customerName) : 'este cliente';
    const liga = url
      ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer"
            style="display:inline-block;margin-top:6px;background:#13a36f;color:#0b1220;font-weight:700;
                   text-decoration:none;border-radius:6px;padding:5px 9px;font-size:11px;">
           Abrir ficha del cliente ↗
         </a>`
      : `<div style="margin-top:6px;font-size:11px;color:#fca5a5;">
           No pude armar la liga (falta el dominio) — búscalo en el Catálogo de Clientes.
         </div>`;
    return `
      <div style="margin-top:8px;padding:8px;border-radius:8px;background:#2a2113;border:1px solid #a16207;">
        <div style="color:#fbbf24;font-weight:700;font-size:11px;margin-bottom:4px;">⚠️ Falta configurar el cliente</div>
        <div style="color:#e2e8f0;font-size:11px;line-height:1.45;">
          ${quien} no tiene sus <b>Entradas Personalizadas</b> en el <b>Catálogo de Clientes</b>.
          Captura ahí <b>DatosFactura → Razón Social de la Venta</b> y <b>Divisa</b>; desde la
          próxima orden se llenan solas.
        </div>
        ${liga}
      </div>`;
  }

  function renderPanel({ customerName, shipTo, idInDomain }) {
    let panel = document.getElementById('sa-create-order-autofill-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sa-create-order-autofill-panel';
      panel.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483646;background:#1e293b;color:#e2e8f0;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;font-size:13px;padding:10px 12px;min-width:240px;max-width:320px;';
      document.body.appendChild(panel);
    }
    state.panel = panel;
    const { razon, divisa, consolidar } = state.results;
    const allOk = [razon, divisa, consolidar].every(r => r && (r.ok || r.skipped));
    // Lo que falta es configuración DEL CLIENTE, no un fallo nuestro: se ofrece la ficha.
    const needsSetup = [razon, divisa].some(r => r && r.needsSetup);
    const headerColor = allOk ? '#10b981' : '#f59e0b';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-weight:700;color:${headerColor};">📝 Crear OV — Autofill</span>
        <button id="sa-coa-close" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;line-height:1;">×</button>
      </div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">${escHtml(customerName || '(sin cliente)')} → ${escHtml(shipTo || '(sin shipTo)')}</div>
      ${row('Razón Social', razon)}
      ${row('Divisa', divisa)}
      ${row('Consolidar', consolidar)}
      ${needsSetup ? setupHintHtml({ customerName, idInDomain }) : ''}
      <div style="text-align:right;margin-top:6px;">
        <button id="sa-coa-redo" style="background:#334155;color:#e2e8f0;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;">Re-aplicar</button>
      </div>`;
    panel.querySelector('#sa-coa-close')?.addEventListener('click', () => removePanel());
    panel.querySelector('#sa-coa-redo')?.addEventListener('click', (ev) => {
      // MUI marca `aria-hidden` en todo el fondo al abrir su modal, y nuestro panel vive en
      // el <body> ⇒ queda dentro. Un control NUESTRO con el foco dentro de un subárbol
      // aria-hidden es un error real de accesibilidad, y la consola de SH lo reporta:
      // "Blocked aria-hidden on an element because its descendant retained focus".
      // Soltar el foco tras el clic lo evita sin tocar el DOM de SH.
      ev.currentTarget.blur();
      // Forzar re-run reseteando las marcas dataset y la firma
      [RJSF_RAZON_ID, RJSF_DIVISA_ID, RJSF_CONSOLIDAR_ID].forEach(id => {
        const el = document.getElementById(id);
        if (el) delete el.dataset.saAutofilled;
      });
      state.lastSig = null;
      scanForModal();
    });

    // Auto-colapsar si todo OK tras 1.8s
    if (allOk) {
      setTimeout(() => {
        if (!state.panel || !document.body.contains(state.panel)) return;
        if (state.lastSig === null) return;
        state.panel.style.opacity = '0.45';
      }, 1800);
    }
  }

  function removePanel() {
    const p = document.getElementById('sa-create-order-autofill-panel');
    if (p) p.remove();
    state.panel = null;
  }

  return { init, scanForModal };
})();

if (typeof window !== 'undefined') {
  window.CreateOrderAutofill = CreateOrderAutofill;
  CreateOrderAutofill.init();
}
