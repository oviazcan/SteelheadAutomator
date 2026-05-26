// host-cleanup-shared.js — Helpers compartidos para detener jobs del SPA host
// de Steelhead (Datadog RUM session replay, Apollo InMemoryCache) y monitorear
// memoria del tab. Se importa desde applets de larga duración (bulk-upload,
// spec-migrator dup-params, etc) para no copiar el patrón inline.
//
// Versión 0.1.0 (2026-05-26): extracción inicial desde bulk-upload.js 1.4.42.
// Latches en window.__sa_dd_stopped / __sa_fetch_patched / __sa_xhr_patched
// — idempotente entre applets si el usuario abre varios en la misma tab.
//
// API:
//   SteelheadHostCleanup.stopDatadogSessionReplay()
//     Detiene Datadog RUM + monkey-patchea fetch/sendBeacon/XHR para descartar
//     requests a *.datadoghq.com / *.datadog-rum / browser-intake-ddog-gov.
//     Idempotente vía latch. Segundo+ call solo re-intenta Apollo drain.
//
//   SteelheadHostCleanup.apolloCacheDrain()
//     clearStore() o cache.reset() del Apollo Client del host (busca en
//     window.__APOLLO_CLIENT__, window.apolloClient, window.__APOLLO__.client).
//     Idempotente y silencioso si no encuentra cliente.
//
//   SteelheadHostCleanup.createMemMonitor({ getElement, onWarn, onGuardrail,
//                                            warnPct=70, critPct=85, guardrailPct=88,
//                                            intervalMs=2000 })
//     → { start(), stop(), reset() }
//     Polling de performance.memory cada 2s. Pinta "Mem: XXMB/YYMB (NN%)" en el
//     elemento que devuelva getElement(). A warnPct invoca stopDatadogSessionReplay()
//     (re-aplica Apollo drain). A guardrailPct dispara onGuardrail(pct) UNA vez.
//
//   SteelheadHostCleanup.makePeriodicDrain(everyN)
//     → fn() — Invocar al final de cada PN procesado en un pool. Llama
//     apolloCacheDrain() cada `everyN` invocaciones. Mantiene contador interno.

window.SteelheadHostCleanup = (() => {
  'use strict';

  const VERSION = '0.1.0';

  const DD_URL_RE = /browser-intake-ddog-gov\.com|datadoghq\.com|datadog-rum/i;
  const DD_BEACON_RE = /browser-intake-ddog-gov\.com|datadoghq\.com/i;

  function apolloCacheDrain() {
    try {
      const candidates = [
        window.__APOLLO_CLIENT__,
        window.apolloClient,
        window.__APOLLO__?.client,
      ].filter(Boolean);
      for (const client of candidates) {
        try {
          if (typeof client.clearStore === 'function') {
            client.clearStore().catch(() => {});
          } else if (client.cache && typeof client.cache.reset === 'function') {
            client.cache.reset();
          }
        } catch (_) { /* defensa */ }
      }
    } catch (_) { /* defensa */ }
  }

  function stopDatadogSessionReplay() {
    if (window.__sa_dd_stopped) {
      apolloCacheDrain();
      return;
    }
    try {
      const dd = window.DD_RUM || window.datadogRum || window.__DD_RUM__;
      if (dd) {
        try { dd.stopSessionReplayRecording?.(); } catch (_) {}
        try { dd.stopSession?.(); } catch (_) {}
        try { dd.setTrackingConsent?.('not-granted'); } catch (_) {}
      }
    } catch (_) { /* defensa */ }
    if (!window.__sa_fetch_patched) {
      try {
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input?.url || '');
          if (DD_URL_RE.test(url)) {
            return Promise.resolve(new Response('', { status: 204 }));
          }
          return origFetch.call(this, input, init);
        };
        if (navigator.sendBeacon) {
          const origBeacon = navigator.sendBeacon.bind(navigator);
          navigator.sendBeacon = function (url, data) {
            if (DD_BEACON_RE.test(url)) return true;
            return origBeacon(url, data);
          };
        }
        if (window.XMLHttpRequest && !window.__sa_xhr_patched) {
          const origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function (method, url) {
            this.__sa_url = url;
            return origOpen.apply(this, arguments);
          };
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send = function (body) {
            const url = this.__sa_url || '';
            if (DD_URL_RE.test(url)) {
              try { this.abort(); } catch (_) {}
              return;
            }
            return origSend.apply(this, arguments);
          };
          window.__sa_xhr_patched = true;
        }
        window.__sa_fetch_patched = true;
      } catch (_) { /* defensa */ }
    }
    apolloCacheDrain();
    window.__sa_dd_stopped = true;
  }

  function createMemMonitor(opts = {}) {
    const {
      getElement = () => null,
      onWarn = null,
      onCrit = null,
      onGuardrail = null,
      intervalMs = 2000,
      warnPct = 70,
      critPct = 85,
      guardrailPct = 88,
      warnClass = 'sa-mem-warn',
      critClass = 'sa-mem-crit',
    } = opts;

    let timer = null;
    let guardrailFired = false;

    function tick() {
      if (!(performance && performance.memory)) return;
      const used = performance.memory.usedJSHeapSize;
      const limit = performance.memory.jsHeapSizeLimit;
      const usedMB = Math.round(used / 1024 / 1024);
      const limitMB = Math.round(limit / 1024 / 1024);
      const pct = limit > 0 ? Math.round(used / limit * 100) : 0;
      const el = getElement();
      if (el) {
        el.textContent = `Mem: ${usedMB}MB / ${limitMB}MB (${pct}%)`;
        if (el.classList) {
          el.classList.remove(warnClass, critClass);
          if (pct >= critPct) el.classList.add(critClass);
          else if (pct >= warnPct) el.classList.add(warnClass);
        }
      }
      if (pct >= warnPct) {
        stopDatadogSessionReplay();
        try { onWarn?.(pct); } catch (_) {}
      }
      if (pct >= critPct) {
        try { onCrit?.(pct); } catch (_) {}
      }
      if (pct >= guardrailPct && !guardrailFired) {
        guardrailFired = true;
        try { onGuardrail?.(pct); } catch (_) {}
      }
    }

    return {
      start() {
        if (timer) return;
        if (!(performance && performance.memory)) return;
        tick();
        timer = setInterval(tick, intervalMs);
      },
      stop() {
        if (timer) { clearInterval(timer); timer = null; }
      },
      reset() { guardrailFired = false; },
    };
  }

  function makePeriodicDrain(everyN) {
    let counter = 0;
    return () => {
      counter++;
      if (counter % everyN === 0) {
        try { apolloCacheDrain(); } catch (_) {}
      }
    };
  }

  return {
    VERSION,
    stopDatadogSessionReplay,
    apolloCacheDrain,
    createMemMonitor,
    makePeriodicDrain,
  };
})();
