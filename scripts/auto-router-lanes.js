// auto-router-lanes.js — Panel de ruteo POR PISTAS de una orden con grupos de piezas.
//
// Una orden se rutea por pistas: la GLOBAL (toda la orden) y una por grupo de piezas.
// Cada pista elige su línea destino por separado, o se deja PENDIENTE y no se toca.
// Desde aquí también se parten las piezas en grupos nuevos y se reagrupan.
//
// Convive con auto-router-panel.js (single-order, ya validado en producción): este
// panel es la vista de órdenes CON grupos y no reemplaza aquel flujo.
//
// Depende de: AutoRouterEngine, AutoRouterGroups, AutoRouterAPI. Expone
// window.AutoRouterLanes. Toda decisión de qué se escribe vive en AutoRouterGroups
// (núcleo puro con golden tests); aquí solo hay DOM y orquestación.

const AutoRouterLanes = (() => {
  'use strict';

  const LOG = '[AR-Lanes]';
  const Engine = () => window.AutoRouterEngine;
  const Groups = () => window.AutoRouterGroups;
  const ARAPI = () => window.AutoRouterAPI;
  const log = (m) => window.SteelheadAPI?.log?.(m) ?? console.log(LOG, m);

  const PENDIENTE = '';   // valor del select cuando la pista no se rutea

  let state = fresh();
  function fresh() {
    return {
      ctx: null,          // { idInDomain, workOrderId, partNumberId, routeData }
      accounts: null,     // parseWorkOrderAccounts()
      lanes: [],          // buildLanes()
      destLines: [],
      choice: new Map(),  // partGroupId|null -> destLine ('' = pendiente)
      sourceLine: null,
      busy: false,
    };
  }

  // ── Estilos (dark mode: regla del repo — la UI propia NUNCA se confunde con la de SH) ──
  function injectStyles() {
    if (document.getElementById('sa-arl-style')) return;
    const s = document.createElement('style');
    s.id = 'sa-arl-style';
    s.textContent = `
      .sa-arl-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483641;
        display:flex;align-items:center;justify-content:center;}
      .sa-arl{background:#1c2430;width:min(820px,94vw);max-height:90vh;border-radius:10px;
        display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.55);
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e9ee;border:1px solid #33404f;}
      .sa-arl h2{margin:0;font-size:17px;color:#f0f3f7;}
      .sa-arl-hd{padding:16px 20px;border-bottom:1px solid #33404f;display:flex;
        align-items:center;justify-content:space-between;gap:12px;}
      .sa-arl-x{border:none;background:none;font-size:22px;cursor:pointer;color:#9aa7b5;}
      .sa-arl-x:hover{color:#e6e9ee;}
      .sa-arl-bd{padding:16px 20px;overflow:auto;}
      .sa-arl-ft{padding:14px 20px;border-top:1px solid #33404f;display:flex;
        align-items:center;justify-content:space-between;gap:12px;}
      .sa-arl-btn{border:none;border-radius:7px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;}
      .sa-arl-btn.primary{background:#13a36f;color:#fff;}
      .sa-arl-btn.primary:disabled{background:#3a5247;color:#8fa99c;cursor:not-allowed;}
      .sa-arl-btn.ghost{background:#33404f;color:#dfe5ec;}
      .sa-arl-btn.sm{padding:5px 11px;font-size:12.5px;}
      table.sa-arl-tb{width:100%;border-collapse:collapse;font-size:13px;}
      table.sa-arl-tb th,table.sa-arl-tb td{text-align:left;padding:8px;border-bottom:1px solid #2a3340;vertical-align:middle;}
      table.sa-arl-tb th{color:#9aa7b5;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;}
      tr.sa-arl-global td{background:#202a37;}
      .sa-arl select{font-size:13px;padding:5px 7px;border:1px solid #3a4757;border-radius:6px;
        background:#141a23;color:#e6e9ee;}
      .sa-arl-tag{font-size:10.5px;padding:1px 7px;border-radius:9px;font-weight:700;white-space:nowrap;}
      .sa-arl-tag.own{background:#163a2c;color:#5fd0a0;}
      .sa-arl-tag.inh{background:#2a3340;color:#9aa7b5;}
      .sa-arl-tag.def{background:#33302a;color:#c8ab74;}
      .sa-arl-warn{background:#3a2a1c;border:1px solid #6b4a2e;color:#f0a35e;padding:10px 12px;
        border-radius:7px;font-size:13px;margin-bottom:12px;}
      .sa-arl-note{font-size:12px;color:#9aa7b5;margin-bottom:10px;}
      .sa-arl-sec{display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px;}
      .sa-arl-sec h3{margin:0;font-size:13px;color:#9aa7b5;text-transform:uppercase;letter-spacing:.04em;}
      .sa-arl-split input{font-size:13px;padding:5px 7px;border:1px solid #3a4757;border-radius:6px;
        background:#141a23;color:#e6e9ee;width:100%;}
      .sa-arl-err{color:#f08a7a;font-size:12.5px;margin-top:8px;}`;
    document.head.appendChild(s);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];       // textContent: nunca innerHTML (anti-XSS)
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of children || []) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  const overlayId = 'sa-arl-ov';
  const removeOverlay = () => document.getElementById(overlayId)?.remove();

  function close() { removeOverlay(); state = fresh(); }

  function renderBody(node) {
    const bd = document.getElementById('sa-arl-bd');
    if (!bd) return;
    bd.textContent = '';
    bd.appendChild(node);
  }
  function renderFooter(...nodes) {
    const ft = document.getElementById('sa-arl-ft');
    if (!ft) return;
    ft.textContent = '';
    for (const n of nodes) if (n) ft.appendChild(n);
  }

  // El shell se monta una vez, pero cada vista es un TRABAJO distinto y lo dice en el
  // título: si no se actualiza, "Partir" se queda escrito encima de la tabla de rutas.
  function setTitulo(text) {
    const h = document.querySelector(`#${overlayId} .sa-arl-hd h2`);
    if (h) h.textContent = text;
  }

  function tituloOT() {
    const c = state.ctx || {};
    return c.idInDomain ?? c.workOrderId ?? '';
  }

  function renderShell(title) {
    removeOverlay();
    const ov = el('div', { id: overlayId, class: 'sa-arl-ov' });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    const panel = el('div', { class: 'sa-arl' }, [
      el('div', { class: 'sa-arl-hd' }, [
        el('h2', { text: title }),
        el('button', { class: 'sa-arl-x', text: '×', onclick: close }),
      ]),
      el('div', { class: 'sa-arl-bd', id: 'sa-arl-bd' }),
      el('div', { class: 'sa-arl-ft', id: 'sa-arl-ft' }),
    ]);
    ov.appendChild(panel);
    document.body.appendChild(ov);
  }

  // ── Apertura ────────────────────────────────────────────────────────────────
  // Dos puertas al mismo panel, con vistas de arranque distintas porque son trabajos
  // distintos: RUTEAR decide a qué línea va cada pista (no mueve nada hasta aplicar);
  // PARTIR/REAGRUPAR mueve material real y además es lo que TIENE QUE PASAR ANTES —
  // un grupo no se puede rutear hasta que existe. Arrancar las dos en la misma pantalla
  // las hacía indistinguibles desde el FAB.
  async function open(ctx) { return openAt(ctx, 'lanes'); }
  async function openSplit(ctx) { return openAt(ctx, 'split'); }

  async function openAt(ctx, vista) {
    injectStyles();
    state = fresh();
    state.ctx = ctx;
    const ot = ctx.idInDomain ?? ctx.workOrderId;
    renderShell(vista === 'split'
      ? `✂️ Partir / reagrupar piezas · OT ${ot}`
      : `🔀 Ruteo de la orden · OT ${ot}`);
    renderBody(el('div', { class: 'sa-arl-note', text: 'Cargando piezas y rutas…' }));
    try {
      await load();
      if (vista === 'split') renderSplit(); else renderLanes();
    } catch (e) {
      log(`Error cargando: ${e.message}`);
      renderBody(el('div', { class: 'sa-arl-warn', text: `No se pudo cargar la orden: ${e.message}` }));
      renderFooter(el('button', { class: 'sa-arl-btn ghost', text: 'Cerrar', onclick: close }));
    }
  }

  async function load() {
    const { ctx } = state;
    state.accounts = await ARAPI().fetchWorkOrderAccounts(ctx.idInDomain);
    // Las rutas activas de TODAS las pistas: se piden con todos los grupos para que
    // el diff por pista tenga el panorama completo (cada pista se aísla después).
    const groupIds = state.accounts.partLocations
      .map((l) => l.partGroup?.id).filter((id) => id != null);
    const partNumberId = ctx.partNumberId ?? state.accounts.partNumberId;
    state.ctx.routeData = await ARAPI().fetchWorkOrderRouteData(
      state.accounts.workOrderId, partNumberId, groupIds
    );
    state.ctx.partNumberId = partNumberId;
    state.ctx.workOrderId = state.accounts.workOrderId;

    state.lanes = Groups().buildLanes({
      partLocations: state.accounts.partLocations,
      activeRoutes: state.ctx.routeData.activeRoutes,
    });
    state.sourceLine = detectSourceLine(state.ctx.routeData.recipeNodes);
    state.destLines = Engine().destinationLines(
      state.ctx.routeData.candidatesByTreatment, state.sourceLine
    );
    for (const l of state.lanes) state.choice.set(l.partGroupId, PENDIENTE);
  }

  // Misma heurística que el panel single-order: el nodo "Listo para Procesar" ancla
  // la sección de línea; si no aparece, la línea más frecuente entre tinas de proceso.
  function detectSourceLine(recipeNodes) {
    const lc = Engine().extractLineCode;
    const listo = (recipeNodes || []).find((n) => /listo para procesar/i.test(n.name || '') && n.defaultStation);
    if (listo) {
      const code = lc(listo.defaultStation.name);
      if (code) return code;
    }
    const freq = new Map();
    for (const n of recipeNodes || []) {
      if (!n.defaultStation || !/-TI\d{2}-/.test(n.defaultStation.name)) continue;
      const code = lc(n.defaultStation.name);
      if (code) freq.set(code, (freq.get(code) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [code, n] of freq) if (n > bestN) { best = code; bestN = n; }
    return best;
  }

  // Rutas que quedarían para una pista si se manda a `destLine`.
  function routesFor(lane, destLine) {
    if (!destLine) return null;
    const res = Engine().computeRoutes({
      recipeNodes: state.ctx.routeData.recipeNodes,
      candidatesByTreatment: state.ctx.routeData.candidatesByTreatment,
      sourceLineCode: state.sourceLine,
      destLineCode: destLine,
      partNumberId: state.ctx.partNumberId,
      workOrderId: state.ctx.workOrderId,
      partGroupId: lane.partGroupId,
    });
    return res;
  }

  function changeCountFor(lane, destLine) {
    const res = routesFor(lane, destLine);
    if (!res) return 0;
    return Engine().effectiveChangeCount(
      state.ctx.routeData.recipeNodes, res.routes,
      state.ctx.routeData.activeRoutes, lane.partGroupId
    );
  }

  const ESTADO = {
    own: { cls: 'own', text: 'ruta propia' },
    inherited: { cls: 'inh', text: 'hereda la orden' },
    default: { cls: 'def', text: 'default de receta' },
  };

  // ── Vista principal: una fila por pista ─────────────────────────────────────
  function renderLanes() {
    setTitulo(`🔀 Ruteo de la orden · OT ${tituloOT()}`);
    const cont = el('div');

    if (!state.sourceLine) {
      cont.appendChild(el('div', { class: 'sa-arl-warn',
        text: 'No se pudo detectar la línea origen de esta orden.' }));
    }
    cont.appendChild(el('div', { class: 'sa-arl-note',
      text: `PN ${state.accounts.partNumberId ?? '—'} · ${state.accounts.partLocations.length} cuenta(s) de piezas · origen ${state.sourceLine || '—'}. `
          + 'Las pistas en "— pendiente —" no se tocan.' }));

    const tb = el('table', { class: 'sa-arl-tb' });
    tb.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Pista' }), el('th', { text: 'Piezas' }),
      el('th', { text: 'Rutas hoy' }), el('th', { text: 'Línea destino' }),
      el('th', { text: 'Tinas' }),
    ])]));
    const tbody = el('tbody');

    for (const lane of state.lanes) {
      const tr = el('tr', lane.kind === 'global' ? { class: 'sa-arl-global' } : {});
      tr.appendChild(el('td', { text: lane.kind === 'global' ? '📋 Toda la orden' : `📦 Grupo ${lane.name}` }));
      tr.appendChild(el('td', { text: lane.partCount != null ? String(lane.partCount) : '—' }));
      const est = ESTADO[lane.state] || ESTADO.default;
      tr.appendChild(el('td', {}, [el('span', { class: `sa-arl-tag ${est.cls}`, text: est.text })]));

      const tinasCell = el('td', { text: '—' });
      const sel = el('select', {
        onchange: (e) => {
          state.choice.set(lane.partGroupId, e.target.value);
          const n = e.target.value ? changeCountFor(lane, e.target.value) : 0;
          tinasCell.textContent = e.target.value ? String(n) : '—';
          refreshFooter();
        },
      }, [el('option', { value: PENDIENTE, text: '— pendiente —' })].concat(
        state.destLines.map((d) => el('option', { value: d, text: d }))
      ));
      tr.appendChild(el('td', {}, [sel]));
      tr.appendChild(tinasCell);
      tbody.appendChild(tr);
    }
    tb.appendChild(tbody);
    cont.appendChild(tb);

    // Partir/reagrupar NO viven aquí: son otro trabajo (mueven material real) y tienen
    // su propia puerta, el FAB ✂️. Mezclarlos en esta pantalla era lo que hacía que las
    // dos entradas se sintieran "el mismo link".
    cont.appendChild(el('div', { class: 'sa-arl-note',
      text: 'Esta pantalla solo decide RUTAS. Para partir las piezas en grupos o reagruparlas '
          + 'usa el botón ✂️ de la esquina — eso mueve material real y hay que hacerlo antes '
          + 'de poder rutear un grupo.' }));

    renderBody(cont);
    refreshFooter();
  }

  function pistasElegidas() {
    return state.lanes.filter((l) => state.choice.get(l.partGroupId));
  }

  function refreshFooter() {
    const n = pistasElegidas().length;
    const btn = el('button', {
      class: 'sa-arl-btn primary',
      text: state.busy ? 'Aplicando…' : (n ? `Aplicar · ${n} pista${n > 1 ? 's' : ''}` : 'Elige una línea destino'),
      onclick: apply,
    });
    if (state.busy || !n) btn.disabled = true;
    renderFooter(el('button', { class: 'sa-arl-btn ghost', text: 'Cerrar', onclick: close }), btn);
  }

  // ── Aplicar el ruteo de las pistas elegidas ─────────────────────────────────
  async function apply() {
    const elegidas = pistasElegidas();
    if (state.busy || !elegidas.length) return;
    state.busy = true;
    refreshFooter();
    try {
      // load-before-save: Steelhead exige una lectura RECIENTE de
      // StationTreatmentByWorkOrder o acepta la mutación y crea 0 rutas en silencio.
      const groupIds = state.lanes.map((l) => l.partGroupId).filter((g) => g != null);
      let activeRoutes = state.ctx.routeData.activeRoutes;
      try {
        const data = await ARAPI().fetchWorkOrderRouteData(
          state.ctx.workOrderId, state.ctx.partNumberId, groupIds
        );
        state.ctx.routeData = data;
        activeRoutes = data.activeRoutes;
      } catch (e) {
        log(`re-fetch previo a aplicar falló (uso el contexto capturado): ${e.message}`);
      }

      // Una mutación por pista: el diff aísla cada una, así que un grupo nunca pisa
      // a otro ni a la global.
      const resumen = [];
      for (const lane of elegidas) {
        const destLine = state.choice.get(lane.partGroupId);
        const res = routesFor(lane, destLine);
        if (!res || !res.routes.length) { resumen.push(`${etiqueta(lane)}: sin rutas que aplicar`); continue; }
        const split = Engine().diffRoutes(res.routes, activeRoutes);
        const wantC = split.routesToCreate.length;
        if (!wantC && !split.routesToUpdate.length && !split.routesToDelete.length) {
          resumen.push(`${etiqueta(lane)}: ya estaba en ${destLine}`);
          continue;
        }
        const out = await ARAPI().applyRoutes(split.routesToCreate, split.routesToUpdate, split.routesToDelete);
        const created = (out.createdRoutes || []).length;
        if (wantC > 0 && created === 0) {
          resumen.push(`⚠️ ${etiqueta(lane)}: el servidor creó 0 de ${wantC} rutas (estado obsoleto)`);
          continue;
        }
        resumen.push(`✅ ${etiqueta(lane)} → ${destLine}: +${created} ~${(out.updatedRoutes || []).length} -${(out.deletedRouteIds || []).length}`);
      }

      renderBody(el('div', {}, [
        el('h2', { text: 'Resultado' }),
        el('div', { class: 'sa-arl-note', text: ' ' }),
        ...resumen.map((r) => el('div', { class: 'sa-arl-note', text: r })),
        el('div', { class: 'sa-arl-note', text: 'Recarga la pantalla de Enrutamiento de Estación para verlas.' }),
      ]));
      renderFooter(el('button', { class: 'sa-arl-btn primary', text: 'Cerrar', onclick: close }));
    } catch (e) {
      state.busy = false;
      log(`Error aplicando: ${e.message}`);
      const bd = document.getElementById('sa-arl-bd');
      if (bd) bd.insertBefore(el('div', { class: 'sa-arl-warn', text: `Error al aplicar: ${e.message}` }), bd.firstChild);
      refreshFooter();
    }
  }

  const etiqueta = (lane) => (lane.kind === 'global' ? 'Toda la orden' : `Grupo ${lane.name}`);

  // ── Partir piezas ───────────────────────────────────────────────────────────
  // Se elige UNA cuenta origen y se reparte entre grupos con su cantidad. La suma
  // debe cuadrar exacto: el núcleo no emite payload si no.
  function renderSplit() {
    setTitulo(`✂️ Partir piezas · OT ${tituloOT()}`);
    const cuentas = state.accounts.partLocations;
    if (!cuentas.length) {
      renderBody(el('div', { class: 'sa-arl-warn', text: 'Esta orden no tiene cuentas de piezas que partir.' }));
      renderFooter(el('button', { class: 'sa-arl-btn ghost', text: '🔀 Rutear', onclick: renderLanes }));
      return;
    }

    let origen = cuentas[0];
    const filas = [{ name: '', partCount: '' }, { name: '', partCount: '' }];
    const errBox = el('div', { class: 'sa-arl-err' });

    const cuentaSel = el('select', {
      onchange: (e) => { origen = cuentas[Number(e.target.value)]; pinta(); },
    }, cuentas.map((c, i) => el('option', {
      value: String(i),
      text: `${c.partGroup ? `Grupo ${c.partGroup.name}` : 'Sin grupo'} · ${c.partCount} pzas`,
    })));

    const tbody = el('tbody');
    const cont = el('div', { class: 'sa-arl-split' }, [
      el('div', { class: 'sa-arl-note',
        text: 'Las piezas de la cuenta origen se reparten entre los grupos. Las cantidades deben sumar exactamente el total.' }),
      el('div', { class: 'sa-arl-sec' }, [el('h3', { text: 'Cuenta origen' }), cuentaSel]),
    ]);
    const tb = el('table', { class: 'sa-arl-tb' });
    tb.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Grupo destino' }), el('th', { text: 'Piezas' }), el('th', { text: '' }),
    ])]));
    tb.appendChild(tbody);
    cont.appendChild(tb);
    cont.appendChild(el('div', {}, [
      el('button', { class: 'sa-arl-btn ghost sm', text: '＋ Otro grupo',
        onclick: () => { filas.push({ name: '', partCount: '' }); pinta(); } }),
    ]));
    cont.appendChild(errBox);

    function pinta() {
      tbody.textContent = '';
      filas.forEach((f, i) => {
        const tr = el('tr');
        const nombre = el('input', { type: 'text', value: f.name, placeholder: 'nombre del grupo' });
        nombre.addEventListener('input', (e) => { f.name = e.target.value; });
        const cant = el('input', { type: 'number', min: '1', step: '1', value: f.partCount, placeholder: '0' });
        cant.addEventListener('input', (e) => { f.partCount = e.target.value; });
        tr.appendChild(el('td', {}, [nombre]));
        tr.appendChild(el('td', {}, [cant]));
        tr.appendChild(el('td', {}, [el('button', {
          class: 'sa-arl-btn ghost sm', text: '✕',
          onclick: () => { filas.splice(i, 1); pinta(); },
        })]));
        tbody.appendChild(tr);
      });
      const total = filas.reduce((s, f) => s + (Number(f.partCount) || 0), 0);
      errBox.textContent = `Suman ${total} de ${origen.partCount} piezas.`;
    }
    pinta();

    renderBody(cont);
    // La vista de partir es autosuficiente: reagrupar es su operación hermana (también
    // mueve material) y "🔀 Rutear" es el paso SIGUIENTE natural, no un "volver".
    const pie = [el('button', { class: 'sa-arl-btn ghost', text: '🔀 Rutear', onclick: renderLanes })];
    if (cuentas.length > 1) {
      pie.push(el('button', { class: 'sa-arl-btn ghost', text: '🔗 Reagrupar', onclick: renderRegroup }));
    }
    pie.push(el('button', { class: 'sa-arl-btn primary', text: '✂️ Partir', onclick: () => confirmarSplit(origen, filas, errBox) }));
    renderFooter.apply(null, pie);
  }

  async function confirmarSplit(origen, filas, errBox) {
    if (state.busy) return;
    const nombres = filas.map((f) => String(f.name || '').trim());
    if (nombres.some((n) => !n)) { errBox.textContent = 'Cada grupo necesita un nombre.'; return; }

    // Validación PREVIA con nombres, antes de crear nada: si las cantidades no cuadran
    // no tiene caso dejar grupos huérfanos en el catálogo del cliente.
    const previo = Groups().planSplit({
      fromAccountId: origen.partsTransferAccountId,
      partCount: origen.partCount,
      splits: filas.map((f, i) => ({ partGroupId: -(i + 1), partCount: Number(f.partCount) })),
    });
    if (!previo.valid) { errBox.textContent = previo.errors.join(' '); return; }

    state.busy = true;
    errBox.textContent = 'Preparando los grupos…';
    try {
      const customerId = state.accounts.customerId;
      if (customerId == null) throw new Error('La orden no tiene cliente; no se pueden crear grupos.');

      // CreateNewPartGroup no es idempotente → reúsa los que ya existan por nombre.
      const existentes = await ARAPI().searchPartGroups(customerId, '');
      const plan = Groups().reuseOrCreate(nombres, existentes);
      const idPorNombre = new Map(plan.reuse.map((r) => [String(r.name).trim().toLowerCase(), r.id]));
      for (const name of plan.create) {
        const g = await ARAPI().createPartGroup(name, customerId);
        idPorNombre.set(String(name).trim().toLowerCase(), g.id);
      }

      const splits = filas.map((f) => ({
        partGroupId: idPorNombre.get(String(f.name).trim().toLowerCase()),
        partCount: Number(f.partCount),
      }));
      const p = Groups().planSplit({
        fromAccountId: origen.partsTransferAccountId,
        partCount: origen.partCount,
        splits,
      });
      if (!p.valid) throw new Error(p.errors.join(' '));

      await ARAPI().splitParts(p.payload);
      log(`Partición aplicada: cuenta ${origen.partsTransferAccountId} → ${splits.length} grupos.`);

      state.busy = false;
      // Recarga: nacieron cuentas nuevas y las pistas cambiaron.
      renderBody(el('div', { class: 'sa-arl-note', text: 'Piezas partidas. Recargando pistas…' }));
      await load();
      renderLanes();
    } catch (e) {
      state.busy = false;
      log(`Error al partir: ${e.message}`);
      errBox.textContent = `No se pudo partir: ${e.message}`;
      refreshFooter();
    }
  }

  // ── Reagrupar piezas ────────────────────────────────────────────────────────
  // Varias cuentas caen en un mismo grupo destino. Las que ya viven ahí se omiten
  // solas (el núcleo las filtra), así que marcar todas es una petición válida.
  function renderRegroup() {
    setTitulo(`🔗 Reagrupar piezas · OT ${tituloOT()}`);
    const cuentas = state.accounts.partLocations;
    const marcadas = new Set();
    const errBox = el('div', { class: 'sa-arl-err' });

    // Destino: cualquiera de los grupos que ya están en la orden.
    const gruposEnOrden = [];
    const vistos = new Set();
    for (const c of cuentas) {
      if (!c.partGroup || vistos.has(c.partGroup.id)) continue;
      vistos.add(c.partGroup.id);
      gruposEnOrden.push(c.partGroup);
    }
    if (!gruposEnOrden.length) {
      renderBody(el('div', { class: 'sa-arl-warn',
        text: 'Esta orden no tiene grupos a los cuales reagrupar. Parte las piezas primero.' }));
      renderFooter(el('button', { class: 'sa-arl-btn ghost', text: '✂️ Partir', onclick: renderSplit }));
      return;
    }
    let destino = gruposEnOrden[0].id;

    const destSel = el('select', { onchange: (e) => { destino = Number(e.target.value); resumen(); } },
      gruposEnOrden.map((g) => el('option', { value: String(g.id), text: `Grupo ${g.name}` })));

    const tbody = el('tbody');
    for (const c of cuentas) {
      const tr = el('tr');
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', (e) => {
        if (e.target.checked) marcadas.add(c.partsTransferAccountId);
        else marcadas.delete(c.partsTransferAccountId);
        resumen();
      });
      tr.appendChild(el('td', {}, [cb]));
      tr.appendChild(el('td', { text: c.partGroup ? `Grupo ${c.partGroup.name}` : 'Sin grupo' }));
      tr.appendChild(el('td', { text: `${c.partCount} pzas` }));
      tbody.appendChild(tr);
    }

    const tb = el('table', { class: 'sa-arl-tb' });
    tb.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: '' }), el('th', { text: 'Cuenta' }), el('th', { text: 'Piezas' }),
    ])]));
    tb.appendChild(tbody);

    function resumen() {
      const mueven = cuentas.filter((c) => marcadas.has(c.partsTransferAccountId)
        && (c.partGroup?.id ?? null) !== destino);
      const total = mueven.reduce((s, c) => s + c.partCount, 0);
      errBox.textContent = mueven.length
        ? `Se moverán ${total} piezas de ${mueven.length} cuenta(s).`
        : 'Marca las cuentas que quieres juntar en el grupo destino.';
    }

    const cont = el('div', {}, [
      el('div', { class: 'sa-arl-note',
        text: 'Las cuentas marcadas se juntan en el grupo destino. Las que ya están ahí se omiten solas.' }),
      el('div', { class: 'sa-arl-sec' }, [el('h3', { text: 'Grupo destino' }), destSel]),
      tb, errBox,
    ]);
    resumen();

    renderBody(cont);
    renderFooter(
      el('button', { class: 'sa-arl-btn ghost', text: '✂️ Partir', onclick: renderSplit }),
      el('button', { class: 'sa-arl-btn ghost', text: '🔀 Rutear', onclick: renderLanes }),
      el('button', { class: 'sa-arl-btn primary', text: '🔗 Reagrupar',
        onclick: () => confirmarRegroup(cuentas, marcadas, () => destino, errBox) }),
    );
  }

  async function confirmarRegroup(cuentas, marcadas, getDestino, errBox) {
    if (state.busy) return;
    const p = Groups().planRegroup({
      targetGroupId: getDestino(),
      accounts: cuentas
        .filter((c) => marcadas.has(c.partsTransferAccountId))
        .map((c) => ({ accountId: c.partsTransferAccountId, partCount: c.partCount, partGroupId: c.partGroup?.id ?? null })),
    });
    if (!p.valid) { errBox.textContent = p.errors.join(' '); return; }

    state.busy = true;
    errBox.textContent = 'Reagrupando…';
    try {
      await ARAPI().regroupParts(p.payload);
      log(`Reagrupación aplicada hacia el grupo ${getDestino()}.`);
      state.busy = false;
      renderBody(el('div', { class: 'sa-arl-note', text: 'Piezas reagrupadas. Recargando pistas…' }));
      await load();
      renderLanes();
    } catch (e) {
      state.busy = false;
      log(`Error al reagrupar: ${e.message}`);
      errBox.textContent = `No se pudo reagrupar: ${e.message}`;
    }
  }

  if (typeof window !== 'undefined') window.AutoRouterLanes = { open, openSplit, close };
  return { open, close };
})();
