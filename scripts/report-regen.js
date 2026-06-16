// Report Regen — botón "Regenerar Reportes" inyectado en el header secundario de Steelhead.
//
// Qué hace:
//   Steelhead refresca su base de reportes (DuckDB) cada noche, pero también se puede
//   forzar manualmente — sólo que el botón nativo está enterrado 3-5 clicks. Este applet
//   expone un botón en la barra de breadcrumb (junto a play/correo) que dispara la
//   regeneración con un click.
//
// Timer GLOBAL del domain (sin backend propio):
//   El cooldown NO es local ni inventado. Steelhead lo impone server-side vía
//   `GetRecomputableAt.recomputableAt` (instante a partir del cual el domain puede volver
//   a regenerar). Cuando CUALQUIER usuario del domain regenera, ese timestamp salta al
//   futuro para TODOS. Así que el "todos ven el timer" se logra leyendo ese estado del
//   servidor por polling — no compartiendo estado entre navegadores.
//
// Gating de permisos:
//   autoInject NO respeta `requiredPermissions` (eso sólo gatea el popup). Por eso el
//   applet se auto-gatea en runtime: consulta CurrentUser y sólo se monta si el usuario
//   tiene MANAGE_REPORTING (o es admin/superuser). El gating de cliente es UX; el boundary
//   real es server-side (Steelhead rechaza GenerateDuckDb sin el permiso).
//
// Operaciones (hashes vivos en el proyecto Reportes SH, registrados en config.json):
//   GetRecomputableAt → { recomputableAt, transactionTime }
//   GenerateDuckDb({maxAttempts:3}) → addWorkerTask.bigInt (taskId)
//   JobQuery({jobId}) → getJobStatus.{ isDone, errorMessage, ... }

(function () {
  'use strict';

  const APPLET_VERSION = '0.2.0';

  // ── Singleton guard + teardown de versión previa (re-inyección en SPA / bump) ──
  if (window.ReportRegen && window.ReportRegen.__version === APPLET_VERSION) return;
  if (window.ReportRegen && typeof window.ReportRegen.destroy === 'function') {
    try { window.ReportRegen.destroy(); } catch (_) {}
  }

  // ── Constantes ──
  const BTN_ID = 'sa-report-regen-btn';
  const SEP_ID = 'sa-report-regen-sep';
  const STYLE_ID = 'sa-report-regen-style';
  const REQUIRED_PERMISSION = 'MANAGE_REPORTING';
  const OBSERVER_DEBOUNCE_MS = 300;
  const POLL_REGEN_MS = 10000;    // job propio activo → poll JobQuery
  const POLL_COOLDOWN_MS = 30000; // en enfriamiento → resync recomputableAt
  const POLL_AVAILABLE_MS = 60000;// idle → detectar que otro usuario disparó

  // Iconos (SVG estáticos — innerHTML seguro, sin datos del usuario).
  const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>';

  // ── Estado (cerrado en el closure, nada global salvo el handle público) ──
  let destroyed = false;
  let allowed = null;            // null=desconocido, true/false=veredicto de permiso
  let capturedPerms = null;      // { isAdmin, isSuperUser, perms[] } — leído del front, no de un fetch propio
  let booted = false;
  let bootPromise = null;
  let lastRecomputableAt = null; // ISO string del servidor
  let skewMs = 0;                // serverNow - clientNow (ms)
  let activeJob = null;          // { taskId, isDone, errorMessage } — sólo para quien disparó
  let lastError = null;
  let uiState = { status: 'loading', remainingMs: 0 };
  let pollTimer = null;
  let tickTimer = null;
  let observer = null;
  let debounceTimer = null;

  function log(msg) { try { (window.SteelheadAPI?.log || console.log)('[report-regen] ' + msg); } catch (_) {} }

  // ── Lógica pura (testeable) ───────────────────────────────────────────────
  function computeSkewMs(transactionTimeISO, clientNowMsAtFetch) {
    if (!transactionTimeISO) return 0;
    const t = Date.parse(transactionTimeISO);
    if (Number.isNaN(t)) return 0;
    return t - clientNowMsAtFetch;
  }

  // Estado del botón a partir del estado del servidor + reloj del servidor.
  //   input: { recomputableAt: ISO|null, activeJob: {isDone,errorMessage}|null }
  //   serverNowMs: Date.now() + skewMs
  //   → { status: 'regenerating'|'cooldown'|'available', remainingMs }
  function computeState(input, serverNowMs) {
    const recomputableAt = input && input.recomputableAt;
    const job = input && input.activeJob;
    let remainingMs = 0;
    if (recomputableAt) {
      const target = Date.parse(recomputableAt);
      if (!Number.isNaN(target)) remainingMs = Math.max(0, target - serverNowMs);
    }
    const jobRunning = !!(job && !job.isDone && !job.errorMessage);
    if (jobRunning) return { status: 'regenerating', remainingMs };
    if (remainingMs > 0) return { status: 'cooldown', remainingMs };
    return { status: 'available', remainingMs: 0 };
  }

  function formatCountdown(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function pickPollIntervalMs(status) {
    if (status === 'regenerating') return POLL_REGEN_MS;
    if (status === 'cooldown') return POLL_COOLDOWN_MS;
    if (status === 'available') return POLL_AVAILABLE_MS;
    return 15000; // loading/error
  }

  // ── Capa de red ───────────────────────────────────────────────────────────
  async function fetchRecomputable() {
    const data = await window.SteelheadAPI.query('GetRecomputableAt', {}, 'GetRecomputableAt');
    const rec = (data && data.getDuckdbRecomputableAt) || {};
    return { recomputableAt: rec.recomputableAt || null, transactionTime: rec.transactionTime || null };
  }

  async function fireRegen() {
    const data = await window.SteelheadAPI.query('GenerateDuckDb', { maxAttempts: 3 }, 'GenerateDuckDb');
    const taskId = data && data.addWorkerTask && data.addWorkerTask.bigInt;
    if (taskId === undefined || taskId === null) throw new Error('GenerateDuckDb no devolvió taskId');
    return String(taskId);
  }

  async function pollJobOnce(taskId) {
    const data = await window.SteelheadAPI.query('JobQuery', { jobId: taskId }, 'JobQuery');
    const st = (data && data.getJobStatus) || {};
    return {
      isDone: !!st.isDone,
      errorMessage: st.errorMessage || null,
      runAttempts: st.runAttempts,
      maxRunAttempts: st.maxRunAttempts
    };
  }

  // ── Gating de permisos ──────────────────────────────────────────────────
  function requiredPerms() {
    const apps = (window.REMOTE_CONFIG && window.REMOTE_CONFIG.apps) || [];
    const me = apps.find((a) => a.id === 'report-regen');
    const perms = me && me.requiredPermissions;
    return Array.isArray(perms) && perms.length ? perms : [REQUIRED_PERMISSION];
  }

  // ── Gating de permisos (reactivo) ─────────────────────────────────────────
  // `CurrentUser` es session-sensitive: rechaza el fetch de la extensión aunque el
  // hash sea válido. Así que NO lo llamamos; en su lugar interceptamos la respuesta
  // que el propio front de Steelhead hace (CurrentUser → perms completos; Profile →
  // isAdmin/isSuperUser). Fallback: leer del Apollo cache si está expuesto.

  // Lógica pura (testeable): dado caps + permisos requeridos → true|false|null.
  function evalAllowed(caps, req) {
    if (!caps) return null; // aún no se conocen permisos
    if (caps.isAdmin || caps.isSuperUser) return true;
    const perms = Array.isArray(caps.perms) ? caps.perms : [];
    return req.every((p) => perms.includes(p));
  }

  function reevaluateGate() {
    if (destroyed) return;
    const verdict = evalAllowed(capturedPerms, requiredPerms());
    if (verdict === allowed) return;
    allowed = verdict;
    if (allowed === true) {
      log('permiso confirmado (' + REQUIRED_PERMISSION + ' / admin) — montando botón');
      installObserver();
      ensureButton();
      if (!pollTimer && !tickTimer) pollOnce();
    } else if (allowed === false) {
      removeButton();
    }
  }

  // CurrentUser trae perms completos; Profile sólo isAdmin/isSuperUser (merge sin
  // pisar perms ya capturados). source = 'CurrentUser' | 'Profile'.
  function onUserData(data, source) {
    try {
      const u = data && data.data && data.data.currentSession && data.data.currentSession.userByUserId;
      if (!u) return;
      const partial = { isAdmin: !!u.isAdmin, isSuperUser: !!u.isSuperUser };
      if (source === 'CurrentUser' && Array.isArray(u.currentManagedPermissions)) {
        partial.perms = u.currentManagedPermissions;
      }
      capturedPerms = Object.assign({ isAdmin: false, isSuperUser: false, perms: [] }, capturedPerms || {}, partial);
      reevaluateGate();
    } catch (_) {}
  }

  // Parchea fetch UNA vez; siempre llama al hook actual (window.__saRRonUser) para
  // que la re-inyección (nueva versión) reconecte el closure vivo sin re-parchear.
  function installPermSniffer() {
    window.__saRRonUser = onUserData;
    if (window.__saRRSnifferInstalled) return;
    window.__saRRSnifferInstalled = true;
    const orig = window.fetch;
    window.fetch = function (...args) {
      const ret = orig.apply(this, args);
      try {
        const body = args[1] && args[1].body;
        if (typeof body === 'string' && (body.indexOf('"CurrentUser"') !== -1 || body.indexOf('"Profile"') !== -1)) {
          const parsed = JSON.parse(body);
          const op = parsed && parsed.operationName;
          if (op === 'CurrentUser' || op === 'Profile') {
            Promise.resolve(ret).then((res) => res.clone().json())
              .then((d) => { if (typeof window.__saRRonUser === 'function') window.__saRRonUser(d, op); })
              .catch(() => {});
          }
        }
      } catch (_) {}
      return ret;
    };
  }

  // Fallback inmediato: si el front expone su Apollo client, leer perms del cache.
  function tryApolloCache() {
    try {
      const client = window.__APOLLO_CLIENT__;
      if (!client || !client.cache || typeof client.cache.extract !== 'function') return;
      const data = client.cache.extract();
      for (const k in data) {
        const e = data[k];
        if (!e) continue;
        const isUser = /User/i.test(e.__typename || k);
        if (isUser && (Array.isArray(e.currentManagedPermissions) || e.isAdmin !== undefined)) {
          onUserData({ data: { currentSession: { userByUserId: e } } }, 'CurrentUser');
          return;
        }
      }
    } catch (_) {}
  }

  // ── DOM ─────────────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '@keyframes sa-rr-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' +
      '#' + BTN_ID + '{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;' +
        'border:1px solid #ccc;border-radius:5px;background:#fff;color:#595959;cursor:pointer;' +
        'font-size:11px;line-height:1;vertical-align:middle;font-family:inherit;}' +
      '#' + BTN_ID + ':disabled{cursor:default;opacity:.85;}' +
      '#' + BTN_ID + ' .sa-rr-ic{display:inline-flex;align-items:center;}' +
      '#' + BTN_ID + '.sa-rr-spinning .sa-rr-ic{animation:sa-rr-spin 1s linear infinite;}' +
      '#' + BTN_ID + ' .sa-rr-txt{display:none;}' +
      '#' + BTN_ID + '.sa-rr-haslabel .sa-rr-txt{display:inline;}';
    (document.head || document.documentElement).appendChild(st);
  }

  // Ancla definitiva: el contenedor que tiene play (PlayArrowIcon) Y correo
  // (EmailOutlinedIcon) como hermanos. El botón se inserta justo antes del correo.
  function findAnchor() {
    const emailSvgs = document.querySelectorAll('svg[data-testid="EmailOutlinedIcon"]');
    for (const svg of emailSvgs) {
      const btn = svg.closest('button');
      if (!btn || !btn.parentElement) continue;
      const container = btn.parentElement;
      if (container.querySelector('svg[data-testid="PlayArrowIcon"]')) {
        return { container, emailBtn: btn };
      }
    }
    return null;
  }

  function buildButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.innerHTML = '<span class="sa-rr-ic">' + ICON_REFRESH + '</span><span class="sa-rr-txt"></span>';
    btn.addEventListener('click', onButtonClick);
    return btn;
  }

  function ensureButton() {
    if (destroyed || allowed !== true) return;
    if (document.getElementById(BTN_ID)) { renderState(); return; }
    const anchor = findAnchor();
    if (!anchor) return; // esta vista no tiene el header — no es error
    ensureStyle();
    const btn = buildButton();
    // Clonar el separador nativo (css-* hasheado) para match visual sin hardcodear clases.
    const nativeSep = anchor.emailBtn.previousElementSibling;
    const sep = nativeSep ? nativeSep.cloneNode(true) : document.createElement('div');
    sep.id = SEP_ID;
    anchor.container.insertBefore(btn, anchor.emailBtn); // [play][sep0][BTN][email]
    anchor.container.insertBefore(sep, anchor.emailBtn); // [play][sep0][BTN][sepClone][email]
    renderState();
  }

  function renderState() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const txt = btn.querySelector('.sa-rr-txt');
    const status = uiState.status;
    btn.classList.toggle('sa-rr-spinning', status === 'regenerating' || status === 'loading');
    if (status === 'available') {
      btn.disabled = false;
      btn.classList.remove('sa-rr-haslabel');
      if (txt) txt.textContent = '';
      btn.title = 'Regenerar reportes (refresh global de la base)';
    } else if (status === 'regenerating') {
      btn.disabled = true;
      btn.classList.add('sa-rr-haslabel');
      if (txt) txt.textContent = 'Regenerando…';
      btn.title = 'Regeneración en curso…';
    } else if (status === 'cooldown') {
      btn.disabled = true;
      btn.classList.add('sa-rr-haslabel');
      const cd = formatCountdown(uiState.remainingMs);
      if (txt) txt.textContent = cd;
      btn.title = 'Reportes en enfriamiento. Disponible en ' + cd;
    } else { // loading / error
      btn.disabled = status === 'loading';
      btn.classList.toggle('sa-rr-haslabel', false);
      if (txt) txt.textContent = '';
      btn.title = lastError ? ('Reintentar (último error: ' + lastError + ')') : 'Cargando estado…';
    }
  }

  function removeButton() {
    const btn = document.getElementById(BTN_ID);
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    const sep = document.getElementById(SEP_ID);
    if (sep && sep.parentNode) sep.parentNode.removeChild(sep);
  }

  // ── Loops: tick UI (1s, sin red) + poll de red (adaptativo) ───────────────
  function recompute() {
    const serverNow = Date.now() + skewMs;
    const job = activeJob && !activeJob.isDone ? activeJob : null;
    uiState = computeState({ recomputableAt: lastRecomputableAt, activeJob: job }, serverNow);
    renderState();
    syncTick();
  }

  // El tick de 1s sólo corre cuando hay countdown que pintar.
  function syncTick() {
    const needsTick = uiState.status === 'cooldown' || uiState.status === 'regenerating';
    if (needsTick && !tickTimer) {
      tickTimer = setInterval(recompute, 1000);
    } else if (!needsTick && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  async function pollOnce() {
    if (destroyed) return;
    try {
      const fetchedAt = Date.now();
      const { recomputableAt, transactionTime } = await fetchRecomputable();
      skewMs = computeSkewMs(transactionTime, fetchedAt);
      lastRecomputableAt = recomputableAt;
      lastError = null;

      if (activeJob && !activeJob.isDone) {
        try {
          const js = await pollJobOnce(activeJob.taskId);
          activeJob = Object.assign({}, activeJob, js);
          if (js.errorMessage) {
            lastError = js.errorMessage;
            activeJob = null;
            log('job terminó con error: ' + js.errorMessage);
          } else if (js.isDone) {
            activeJob = null;
            log('regeneración completada');
          }
        } catch (e) {
          log('poll JobQuery falló: ' + e.message);
        }
      }
      recompute();
    } catch (e) {
      lastError = e.message;
      log('poll GetRecomputableAt falló: ' + e.message);
      if (uiState.status === 'loading') { uiState = { status: 'error', remainingMs: 0 }; renderState(); }
    } finally {
      scheduleNextPoll();
    }
  }

  function scheduleNextPoll() {
    if (destroyed) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollOnce, pickPollIntervalMs(uiState.status));
  }

  // ── Disparo de regeneración (compartido por botón y popup) ────────────────
  async function doRegen() {
    recompute();
    if (uiState.status === 'cooldown') {
      return { error: 'Reportes en enfriamiento. Disponible en ' + formatCountdown(uiState.remainingMs) };
    }
    if (uiState.status === 'regenerating') {
      return { error: 'Ya hay una regeneración en curso.' };
    }
    // Optimista: pinta "Regenerando…" de inmediato.
    uiState = { status: 'regenerating', remainingMs: 0 };
    renderState();
    syncTick();
    try {
      const taskId = await fireRegen();
      activeJob = { taskId, isDone: false, errorMessage: null };
      log('regeneración encolada — taskId=' + taskId);
      await pollOnce(); // resync inmediato (recomputableAt ya saltó al futuro) + reprograma poll
      return { started: true, message: 'Regeneración de reportes iniciada.' };
    } catch (e) {
      activeJob = null;
      lastError = e.message;
      await pollOnce(); // re-lee el estado real del servidor
      return { error: 'No se pudo iniciar la regeneración: ' + e.message };
    }
  }

  function onButtonClick() {
    if (allowed !== true) return;
    doRegen();
  }

  // Entrada desde el popup (background llama window.ReportRegen.triggerFromPopup).
  async function triggerFromPopup() {
    try {
      await ensureBooted();
    } catch (e) {
      return { error: 'No se pudo inicializar: ' + e.message };
    }
    // Espera breve a que el sniffer/cache confirme permisos (allowed pasa de null).
    for (let i = 0; i < 20 && allowed === null && !destroyed; i++) await sleep(150);
    if (allowed === false) {
      return { error: 'No tienes permiso ' + REQUIRED_PERMISSION + ' para regenerar reportes.' };
    }
    // allowed === true, o null tras el timeout (el server valida el permiso al ejecutar).
    return doRegen();
  }

  // ── Observer (persistencia del botón en SPA nav) ──────────────────────────
  function installObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(ensureButton, OBSERVER_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function waitForDeps(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function check() {
        if (destroyed) return resolve(false);
        if (window.REMOTE_CONFIG && window.SteelheadAPI && typeof window.SteelheadAPI.query === 'function') {
          return resolve(true);
        }
        if (Date.now() - start > (timeoutMs || 20000)) return resolve(false);
        setTimeout(check, 150);
      })();
    });
  }

  function ensureBooted() {
    if (booted) return Promise.resolve();
    if (bootPromise) return bootPromise;
    bootPromise = (async () => {
      const ok = await waitForDeps(20000);
      booted = true;
      if (!ok) return; // deps no llegaron; queda inerte
      installPermSniffer(); // captura permisos de CurrentUser/Profile que pida el front
      tryApolloCache();     // intento inmediato del cache (si el front lo expone)
      // El botón se monta vía reevaluateGate cuando se confirmen permisos (fail-closed
      // mientras tanto). El front pide CurrentUser/Profile seguido → llega en segundos.
    })();
    return bootPromise;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function destroy() {
    destroyed = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    // Desconectar el hook del sniffer sólo si sigue apuntando a ESTE closure
    // (no pisar el de una versión más nueva). El patch de fetch queda (es benigno).
    try { if (window.__saRRonUser === onUserData) window.__saRRonUser = null; } catch (_) {}
    removeButton();
  }

  // ── Export ──────────────────────────────────────────────────────────────
  window.ReportRegen = {
    __version: APPLET_VERSION,
    triggerFromPopup,
    destroy,
    _internals: { computeState, computeSkewMs, formatCountdown, pickPollIntervalMs, findAnchor, evalAllowed }
  };
  // Para los golden tests (node --test) y depuración manual.
  window.__SAReportRegen = window.ReportRegen._internals;

  ensureBooted();
})();
