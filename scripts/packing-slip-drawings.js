// packing-slip-drawings.js — Planos en Remisión
// Adjunta al correo del albarán los archivos de los NP que van en él, cuando el
// cliente tiene `DatosLogisticos.IncluirPlanos`. Delata en ámbar los NP que no
// tienen plano, e imprime remisión + selección en un solo PDF.
//
// Depende de: SteelheadAPI · MuiIconAnchorCore · PackingSlipDrawingsCore ·
//             PackingSlipModalCore · PackingSlipPrint
//
// ── RECONOCIMIENTO EN VIVO (2026-08-04/05, Ecoplating TLC dom 344) ───────────
// · El modal se llama "Send Shipping Email" y tiene 5 MuiSwitch.
// · Su fila `Attachments` ya trae un botón `+ ADD` → ahí se inserta el panel.
// · El preview del correo YA trae la tabla SO#/WO#/Part#/QTY.
// · El botón que lo abre NO tiene data-testid ni aria-label; sólo la FORMA del
//   icono (ya catalogada como EmailOutlinedIcon) lo identifica.
// · La mutation de envío es `SendEmailChecked` (CONFIRMADA), la misma que usa
//   cfdi-attacher, con `variables.attachments` array y payload de ~11.8 KB.
const PackingSlipDrawings = (() => {
  'use strict';

  const LOG = '[SA][planos-remision]';
  const Core = () => window.PackingSlipDrawingsCore;
  const Modal = () => window.PackingSlipModalCore;
  const api = () => window.SteelheadAPI;

  // Mutations que mandan el correo. `SendEmailChecked` está CONFIRMADA en vivo
  // (2026-08-05) y su hash coincide con el de config.json. Las otras quedan por
  // si SH renombra la operación: aceptar de más aquí no hace daño (sólo se toca
  // el payload si hay selección), aceptar de menos apagaría el applet en silencio.
  const SEND_OPS = ['SendEmailChecked', 'SendShippingEmail', 'SendPackingSlipEmail'];

  // Endpoint desde el que se sirve un userFile ya subido. Se usa SÓLO para
  // imprimir (el adjunto del correo viaja por nombre, no por URL), así que si
  // cambiara, lo único que se rompe es la impresión — y se avisa.
  const FILE_URL = (generatedName) => `/api/files/${encodeURIComponent(generatedName)}`;

  let enabled = true;
  let currentPlan = null;       // plan del modal abierto
  const selected = new Map();   // filename → {filename, displayName, kind, url}
  let observerActive = false;
  let origFetch = null;
  // Nombre del cliente visto en la última query del modal. Es el respaldo para
  // cuando el modal NO se abre desde la lista de albaranes (p. ej. el módulo de
  // Envío), donde no hay una tabla `#NNNN | Cliente` de dónde leerlo.
  let lastCustomerName = null;

  // ── Reconocimiento del modal ────────────────────────────────────────────────

  function readModalInfo(dlg) {
    const Icons = window.MuiIconAnchorCore;
    const h = dlg.querySelector('h1,h2,h3,h4,h5,h6');
    const heading = (h && h.textContent) || '';
    const switchCount = dlg.querySelectorAll('.MuiSwitch-root, [class*="Switch-root"]').length;
    // El path del sobre ya está catalogado como EmailOutlinedIcon (coincide byte
    // a byte con el medido en vivo). En ESTA pantalla no hay aria de respaldo:
    // la forma no es la segunda opción, es la única.
    const hasEmailIcon = Icons
      ? Icons.hasAnyIcon(dlg, ['EmailOutlinedIcon', 'SendIcon'])
      : !!dlg.querySelector('svg');
    return { heading, switchCount, hasEmailIcon };
  }

  // Localiza la fila "Attachments" por el TEXTO de su primera celda (ES+EN),
  // nunca por clase css-<hash>.
  function findAttachmentsRow(dlg) {
    const rows = dlg.querySelectorAll('tr');
    for (const tr of rows) {
      const first = tr.querySelector('td, th');
      if (!first) continue;
      const t = (first.textContent || '').trim().toLowerCase();
      if (/^(attachments?|adjuntos?|archivos adjuntos)$/.test(t)) return tr;
    }
    return null;
  }

  // Nombre del cliente: se lee de la fila de la lista que quedó DETRÁS del modal.
  // El modal no lo expone hasta el envío (`variables.customerId`), y para entonces
  // ya es tarde para pintar el panel.
  //
  // ⚠️ Se busca la fila POR SU NÚMERO DE REMISIÓN, no la primera de la tabla.
  // Tomar la primera daría el cliente de la remisión de arriba cuando el operador
  // abre el correo de una fila de más abajo — invisible mientras todas las filas
  // visibles sean del mismo cliente, y silenciosamente falso en cuanto no lo sean.
  // Sin número no se adivina: se devuelve null y el panel degrada a ámbar.
  function readCustomerNameFromList(psNumber) {
    if (!psNumber) return null;
    const rows = document.querySelectorAll('table tr');
    for (const tr of rows) {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 2) continue;
      const id = (cells[0].textContent || '').trim();
      if (id === `#${psNumber}`) {
        const name = (cells[1].textContent || '').trim();
        if (name) return name;
      }
    }
    return null;
  }

  // ── Resolución del cliente ──────────────────────────────────────────────────

  // Devuelve true | false | null. `null` = NO PUDE VERIFICAR, que NO es `false`.
  // Cadena idéntica a la de weight-quick-entry: nombre → CustomerSearchByName →
  // idInDomain → Customer → customInputs.
  async function resolveIncluirPlanos(customerName) {
    if (!customerName) return null;
    try {
      const data = await api().query('CustomerSearchByName',
        { nameLike: `%${customerName}%`, orderBy: ['NAME_ASC'] }, 'CustomerSearchByName');
      const nodes = (data && (data.searchCustomers || data.allCustomers) || {}).nodes || [];
      const found = nodes.find((c) => c && c.name
        && c.name.toUpperCase().includes(customerName.toUpperCase()));
      if (!found) return null;

      if (found.customInputs) return Core().readIncluirPlanos(found.customInputs);

      const displayId = found.idInDomain != null ? found.idInDomain : found.displayId;
      if (displayId == null) return null;
      const d2 = await api().query('Customer',
        { idInDomain: parseInt(displayId, 10), includeAccountingFields: false }, 'Customer');
      const cust = (d2 && (d2.customerByIdInDomain || d2.customerById)) || null;
      return cust && cust.customInputs ? Core().readIncluirPlanos(cust.customInputs) : null;
    } catch (e) {
      console.warn(LOG, 'no pude resolver la preferencia del cliente:', e && e.message);
      return null;
    }
  }

  // ── Resolución NP → archivos ────────────────────────────────────────────────

  // Cuántos registros homónimos se consultan como máximo por nombre de parte.
  // Cada uno cuesta una query extra; el tope evita que un nombre muy duplicado
  // dispare una ráfaga contra el /graphql.
  const MAX_HOMONIMOS = 3;

  // El modal da el NOMBRE del PN, no su id. SearchPartNumbers no devuelve
  // archivados, que es justo lo que queremos: un NP archivado no debería ir en
  // una remisión.
  //
  // ⚠️ DEVUELVE TODOS LOS HOMÓNIMOS, no uno.
  // El ERP tiene números de parte DUPLICADOS: medido, `S49B0531A7` existe dos
  // veces para FISHER, activos ambos, y los archivos cuelgan sólo del registro
  // VIEJO (id 3027607) mientras el nuevo (3657419) está vacío. Con `ID_DESC` se
  // tomaba justo el vacío y el panel decía «sin archivos cargados» sobre un NP
  // que sí tiene plano — el peor error posible aquí, porque es el que hace que
  // el cliente NO reciba lo que pidió sin que nadie se entere.
  //
  // Elegir «el que tenga archivos» sería adivinar de nuevo; se unen TODOS y el
  // dedup por `filename` se encarga de los repetidos.
  async function resolvePnIds(pnName) {
    const data = await api().query('SearchPartNumbers',
      { searchQuery: pnName, first: 20, offset: 0, orderBy: ['ID_DESC'] }, 'SearchPartNumbers');
    const nodes = (data && data.searchPartNumbers && data.searchPartNumbers.nodes) || [];
    const target = String(pnName).trim();
    const exactos = nodes.filter((n) => n && String(n.name).trim() === target);
    if (exactos.length > MAX_HOMONIMOS) {
      console.warn(LOG, `"${target}" tiene ${exactos.length} registros; sólo consulto ${MAX_HOMONIMOS}`);
    }
    return exactos.slice(0, MAX_HOMONIMOS).map((n) => ({ id: n.id, name: n.name }));
  }

  async function fetchPnFiles(pnId) {
    const data = await api().query('GetPartNumber',
      { partNumberId: pnId, usagesLimit: 10, usagesOffset: 0 }, 'GetPartNumber');
    const pn = (data && data.partNumberById) || {};
    const nodes = (pn.partNumberUserFilesByPartNumberId
      && pn.partNumberUserFilesByPartNumberId.nodes) || [];
    return nodes
      .map((n) => n && n.userFileByUserFileName)
      .filter(Boolean)
      .map((uf) => ({ name: uf.name, originalName: uf.originalName }));
  }

  // SERIAL a propósito: el /graphql de SH se cuelga bajo ráfaga (~40 requests) y
  // el límite es POR SESIÓN — tumbaría también la pantalla nativa. Una remisión
  // puede traer 88 NP (medido); no se paraleliza.
  async function loadFilesFor(parts, container, incluirPlanos) {
    const pns = [];
    const filesByPn = {};
    const noResueltos = [];
    for (const p of parts) {
      try {
        const matches = await resolvePnIds(p.pnName);
        if (!matches.length) { noResueltos.push(p.pnName); continue; }
        // Un solo grupo por NOMBRE (que es lo que el operador ve en la remisión),
        // alimentado con los archivos de TODOS sus registros homónimos.
        const primero = matches[0];
        const unidos = [];
        for (const m of matches) {
          const archivos = await fetchPnFiles(m.id);
          for (const a of archivos) unidos.push(a);
        }
        pns.push({ id: primero.id, name: p.pnName });
        filesByPn[primero.id] = unidos;
      } catch (e) {
        noResueltos.push(p.pnName);
        console.warn(LOG, 'no pude resolver', p.pnName, e && e.message);
      }
    }
    currentPlan = Core().buildAttachmentPlan({ pns, filesByPn });
    currentPlan.noResueltos = noResueltos;
    currentPlan.incluirPlanos = incluirPlanos;

    selected.clear();
    // Premarcado SÓLO si confirmamos que el cliente los pide. Con `null` (no
    // pude verificar) se muestra todo pero no se marca nada: el operador decide.
    if (incluirPlanos === true) {
      for (const g of currentPlan.groups) {
        for (const f of g.files) {
          if (f.preselected) selected.set(f.filename, Object.assign({}, f, { url: FILE_URL(f.filename) }));
        }
      }
    }
    renderPanel(container);
  }

  // ── Panel ───────────────────────────────────────────────────────────────────

  // Estilo NATIVO, no dark mode. Excepción deliberada a la regla del repo, con
  // precedente exacto en este mismo modal: SH ya tiene una fila «Incluir
  // Certificado» con checkbox y link. Nuestro panel es su hermano, y verse igual
  // es mejor UX que gritar «soy de la extensión». El marcador de autoría es el
  // 📐 del label y el atributo data-sa-ps-drawings.
  const AMBER = '#b26a00';
  const DIM = '#6b7280';

  // Los nombres de PN y de archivo vienen de GraphQL ⇒ vector cross-user.
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Devuelve true SÓLO si logró montar. El latch marca el ÉXITO, no el INTENTO:
  // si se marcara antes y el montaje fallara por un render a medias, el panel
  // se congelaría "desaparecido" para siempre.
  // El observer dispara en cuanto APARECE el diálogo, pero el preview del correo
  // —que es de donde salen el número de remisión y la tabla de partes— se carga
  // DESPUÉS, asíncrono. Leer de inmediato daba `psNumber = null` y con ello el
  // ámbar «no pude verificar» sobre datos que sí iban a llegar: una degradación
  // honesta pero prematura, que es su propio modo de falla (el operador aprende
  // a ignorar un aviso que casi siempre miente).
  //
  // Se espera al contenido con un tope corto. Si nunca llega, se degrada igual
  // —el ámbar sigue siendo la respuesta correcta cuando el dato REALMENTE falta.
  // Lee las partes del preview del correo, que es una tabla dentro del diálogo.
  function readParts(dlg) {
    return Modal().extractPartNumbers(
      [].map.call(dlg.querySelectorAll('tr'), (tr) => tr.innerText || '')
    );
  }

  // Espera a que el modal tenga LAS DOS COSAS que el panel necesita:
  //   · el cliente identificable — decide si el applet actúa;
  //   · la tabla de partes — decide qué se lista.
  //
  // Esperar sólo por el cliente fue un error real (v0.1.3): el nombre llega en
  // las respuestas del modal, ANTES de que se renderice el preview, así que el
  // panel se pintaba vacío sobre una remisión que sí tenía partes. Cada consumidor
  // tiene su propia condición de «listo»; esperar por la más rápida no sirve.
  //
  // Si se agota el tope, se sigue con lo que haya y se dice — un hueco real se
  // reporta, no se disfraza de panel vacío.
  function waitForModalContent(dlg, tries = 24, delayMs = 250) {
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        if (!dlg.isConnected) return resolve(false);
        const ps = Modal().extractPackingSlipNumber(dlg.innerText || '');
        const hayCliente = !!((ps && readCustomerNameFromList(ps)) || lastCustomerName);
        const hayPartes = readParts(dlg).length > 0;
        if (hayCliente && hayPartes) return resolve(true);
        if (++n >= tries) return resolve(false);
        setTimeout(tick, delayMs);
      };
      tick();
    });
  }

  async function mountPanel(dlg) {
    // Defensa en profundidad sobre el latch: se pregunta por el NODO, no sólo
    // por el atributo. Si ya hay una fila nuestra, no se monta otra.
    if (dlg.querySelector('tr[data-sa-ps-drawings]')) return true;
    const row = findAttachmentsRow(dlg);
    if (!row) return false;

    await waitForModalContent(dlg);
    if (!dlg.isConnected) return false;   // el operador cerró el modal mientras tanto

    const parts = readParts(dlg);
    const psNumber = Modal().extractPackingSlipNumber(dlg.innerText || '');
    const customerName = readCustomerNameFromList(psNumber) || lastCustomerName;
    const incluirPlanos = await resolveIncluirPlanos(customerName);

    // `false` = el cliente NO quiere planos ⇒ el applet queda INERTE, cero UI.
    // Es lo correcto para 74 de los 81 clientes activos.
    if (incluirPlanos === false) {
      console.log(LOG, `"${customerName}" no pide planos; sin panel`);
      return true; // montaje "exitoso": la decisión fue no pintar nada
    }

    const cells = row.querySelectorAll('td, th');
    const tr = document.createElement('tr');
    tr.className = row.className;                    // hereda del vecino VIVO
    tr.setAttribute('data-sa-ps-drawings', '1');
    const tdLabel = document.createElement('td');
    const tdBody = document.createElement('td');
    if (cells[0]) tdLabel.className = cells[0].className;
    if (cells[1]) tdBody.className = cells[1].className;
    tdLabel.textContent = '📐 Planos';
    tr.appendChild(tdLabel);
    tr.appendChild(tdBody);
    row.parentElement.insertBefore(tr, row.nextSibling);

    // ⚠️ EL GATE MÁS IMPORTANTE DEL APPLET.
    //
    // Resolver los archivos cuesta DOS queries por número de parte. Una remisión
    // real de Fisher trae 88 NP ⇒ 176 peticiones en ráfaga. El `/graphql` de SH
    // se cuelga a las ~40 y el límite es POR SESIÓN: tumbaría también la pantalla
    // nativa del operador. Disparar eso en CADA correo de remisión —cuando 80 de
    // 81 clientes ni siquiera quieren planos— es castigar al ERP por nada.
    //
    // Así que sólo se carga automáticamente con un `true` CONFIRMADO. Con `null`
    // («no pude verificar») se ofrece un botón y decide el operador: se conserva
    // la salida de emergencia sin pagar el costo por defecto.
    // Sin partes no hay nada que resolver, y un panel mudo sería peor que un
    // aviso: el operador vería el recuadro vacío y asumiría «este cliente pide
    // planos y no hay ninguno», cuando lo cierto es «no pude leer la lista».
    if (!parts.length) {
      tdBody.innerHTML =
        `<span style="color:${AMBER}">No pude leer los números de parte de esta remisión, ` +
        'así que no busqué planos. Adjúntalos con “+ ADD” si hacen falta.</span>';
      console.warn(LOG, 'sin partes legibles en el modal; panel en modo aviso');
      return true;
    }

    if (incluirPlanos === true) {
      tdBody.textContent = 'Buscando planos…';
      loadFilesFor(parts, tdBody, incluirPlanos);    // async: pinta cuando llega
    } else {
      renderUnverified(tdBody, parts, customerName);
    }
    return true;
  }

  // Estado `null`: una sola línea discreta, sin cargar nada. El panel completo
  // en TODOS los correos sería ruido para 80 de 81 clientes — y un aviso que
  // casi siempre sobra es un aviso que el operador aprende a ignorar.
  function renderUnverified(container, parts, customerName) {
    const quien = customerName ? `«${escHtml(customerName)}»` : 'este cliente';
    container.innerHTML =
      `<span style="color:${AMBER}">No pude verificar si ${quien} pide planos.</span> ` +
      `<button type="button" data-sa-buscar="1" style="margin-left:6px;padding:4px 10px;cursor:pointer">` +
      `Buscar planos de ${parts.length} NP</button>`;
    const btn = container.querySelector('button[data-sa-buscar]');
    if (btn) {
      btn.addEventListener('click', () => {
        container.textContent = 'Buscando planos…';
        loadFilesFor(parts, container, null);
      });
    }
  }

  // Pinta el plan. Estados que NO se confunden entre sí:
  //   · archivos listados con su checkbox
  //   · ÁMBAR "sin plano": el cliente los pide y el NP no los tiene. Es el caso
  //     MAYORITARIO medido (77% de los NP de Fisher). Callarlo haría creer al
  //     operador que el cliente los recibió.
  //   · ÁMBAR "no pude verificar": no se resolvió el NP o la preferencia del
  //     cliente. NO es lo mismo que "no tiene".
  function renderPanel(container) {
    const plan = currentPlan;
    if (!plan) { container.textContent = 'No pude leer los números de parte.'; return; }
    const out = [];

    if (plan.incluirPlanos === null) {
      out.push(`<div style="padding:6px 8px;border-left:3px solid ${AMBER};color:${AMBER};margin-bottom:6px">` +
        'No pude verificar si este cliente pide planos. No marqué nada; puedes elegir a mano.</div>');
    }

    for (const g of plan.groups) {
      out.push(`<div style="margin:6px 0;font-weight:600">${escHtml(g.pnName)}</div>`);
      if (!g.files.length) {
        out.push(`<div style="margin-left:14px;color:${AMBER}">⚠ sin archivos cargados</div>`);
        continue;
      }
      for (const f of g.files) {
        const marcado = f.preselected && plan.incluirPlanos === true ? ' checked' : '';
        out.push(
          '<label style="display:block;margin-left:14px;cursor:pointer">' +
          `<input type="checkbox" data-sa-file="${escHtml(f.filename)}"${marcado}> ` +
          `${escHtml(f.displayName)} <span style="color:${DIM}">(${escHtml(f.kind)})</span>` +
          '</label>'
        );
      }
    }

    if (plan.pnsSinPlano.length) {
      out.push(
        `<div style="margin-top:10px;padding:8px;border-left:3px solid ${AMBER};color:${AMBER}">` +
        `Este cliente pide planos. <b>${plan.pnsSinPlano.length}</b> de <b>${plan.groups.length}</b> ` +
        `número(s) de parte no tienen ninguno: ${escHtml(plan.pnsSinPlano.map((p) => p.pnName).join(', '))}` +
        '</div>'
      );
    }
    if (plan.noResueltos && plan.noResueltos.length) {
      out.push(
        `<div style="margin-top:8px;padding:8px;border-left:3px solid ${AMBER};color:${AMBER}">` +
        `No pude verificar ${plan.noResueltos.length} número(s) de parte: ` +
        `${escHtml(plan.noResueltos.join(', '))}. El correo sale igual.</div>`
      );
    }

    out.push(
      '<div style="margin-top:10px">' +
      '<button type="button" data-sa-print="1" style="padding:6px 12px;cursor:pointer">' +
      '🖨️ Imprimir remisión + selección</button>' +
      `<span data-sa-count style="margin-left:10px;color:${DIM}"></span></div>`
    );

    container.innerHTML = out.join('');
    [].forEach.call(container.querySelectorAll('input[data-sa-file]'), (cb) => {
      cb.addEventListener('change', () => {
        onToggleFile(cb.getAttribute('data-sa-file'), cb.checked);
        updateCount(container);
      });
    });
    const printBtn = container.querySelector('button[data-sa-print]');
    if (printBtn) printBtn.addEventListener('click', () => onPrint(container));
    updateCount(container);
  }

  function findFileInPlan(filename) {
    for (const g of (currentPlan ? currentPlan.groups : [])) {
      const f = g.files.find((x) => x.filename === filename);
      if (f) return f;
    }
    return null;
  }

  function onToggleFile(filename, checked) {
    const f = findFileInPlan(filename);
    if (!f) return;
    if (checked) selected.set(filename, Object.assign({}, f, { url: FILE_URL(filename) }));
    else selected.delete(filename);
  }

  function updateCount(container) {
    const c = container.querySelector('[data-sa-count]');
    if (c) c.textContent = `${selected.size} seleccionado(s)`;
  }

  // ── Impresión ───────────────────────────────────────────────────────────────

  // El link al albarán ya vive en el modal ("Click to View Packing Slip #1746"),
  // así que se toma de ahí en vez de adivinar una ruta.
  function findPackingSlipPdfUrl(dlg) {
    const el = dlg && dlg.querySelector(
      'a[href*="/api/pdf/share/"], object[data*="/api/pdf/share/"], iframe[src*="/api/pdf/share/"]'
    );
    if (!el) return null;
    return el.getAttribute('href') || el.getAttribute('data') || el.getAttribute('src');
  }

  async function onPrint(container) {
    const btn = container.querySelector('button[data-sa-print]');
    const restore = () => { if (btn) { btn.disabled = false; btn.textContent = '🖨️ Imprimir remisión + selección'; } };
    if (btn) { btn.disabled = true; btn.textContent = '🖨️ Preparando…'; }
    const dlg = container.closest('.MuiDialog-paper, [role="dialog"]');
    try {
      const res = await window.PackingSlipPrint.printCombined({
        packingSlipPdfUrl: findPackingSlipPdfUrl(dlg),
        files: getSelectedFiles(),
      });
      if (!res.ok) {
        alert('No se pudo armar nada para imprimir: ni la remisión ni los archivos.');
      } else if (res.missing.length) {
        // Se REPORTA lo que no entró. Imprimir de menos en silencio es
        // exactamente el modo de falla que este applet existe para evitar.
        alert('Se mandó a imprimir, pero esto NO entró:\n' +
          res.missing.map((m) => `• ${m.name} (${m.reason})`).join('\n'));
      }
    } catch (e) {
      alert('Error al imprimir: ' + (e && e.message));
    } finally { restore(); }
  }

  // ── Interceptor ─────────────────────────────────────────────────────────────

  // Operaciones que dispara el modal al abrirse y que pueden traer al cliente.
  const CUSTOMER_HINT_OPS = ['EmailCustomerContactsByCustomerIds', 'GetPackingSlip', 'PreviousEmailConfiguration'];

  function patchFetch() {
    if (window.__saPsDrawingsFetchPatched) return;
    window.__saPsDrawingsFetchPatched = true;
    origFetch = window.fetch;

    window.fetch = function (...args) {
      const [url, opts] = args;

      // Escucha PASIVA para identificar al cliente. Va antes de las guardas del
      // envío porque debe correr aunque no haya nada seleccionado.
      if (typeof url === 'string' && url.indexOf('/graphql') >= 0
          && opts && typeof opts.body === 'string'
          && CUSTOMER_HINT_OPS.some((op) => opts.body.indexOf('"' + op + '"') >= 0)) {
        const p = origFetch.apply(this, args);
        p.then((resp) => {
          try {
            resp.clone().json().then((j) => {
              const n = Modal().findCustomerName(j && j.data, 0);
              if (n) { lastCustomerName = n; console.log(LOG, 'cliente identificado:', n); }
            }).catch(() => {});
          } catch (_) {}
        }).catch(() => {});
        return p;
      }
      // Guardas BARATAS primero. El payload de SendEmailChecked pesa ~11.8 KB
      // (medido) y lleva el HTML completo del correo: hacer trabajo síncrono
      // sobre él congela la pestaña. Nada de regex globales; un solo parse, y
      // sólo cuando ya sabemos que hay algo que adjuntar.
      if (!selected.size) return origFetch.apply(this, args);
      if (typeof url !== 'string' || url.indexOf('/graphql') < 0) return origFetch.apply(this, args);
      if (!opts || typeof opts.body !== 'string') return origFetch.apply(this, args);
      if (opts.body.indexOf('"operationName"') < 0) return origFetch.apply(this, args);

      let bodyObj;
      try { bodyObj = JSON.parse(opts.body); } catch (_) { return origFetch.apply(this, args); }
      const opName = bodyObj && bodyObj.operationName;
      if (!opName || SEND_OPS.indexOf(opName) < 0) return origFetch.apply(this, args);
      // Última red: si el envío trae customerId y no habíamos resuelto nada, al
      // menos queda en el log para diagnosticar por qué falló la identificación.
      if (!lastCustomerName && bodyObj.variables && bodyObj.variables.customerId != null) {
        console.log(LOG, 'customerId del envío (sin resolver antes):', bodyObj.variables.customerId);
      }

      try {
        const extra = Core().toAttachments(Array.from(selected.values()));
        if (extra.length) {
          bodyObj.variables = bodyObj.variables || {};
          bodyObj.variables.attachments = (bodyObj.variables.attachments || []).concat(extra);
          args[1] = Object.assign({}, opts, { body: JSON.stringify(bodyObj) });
          console.log(LOG, `${extra.length} plano(s) adjuntado(s) a ${opName}`);
        }
      } catch (e) {
        // A DIFERENCIA de cfdi-attacher, aquí NO se cancela el envío: una
        // factura sin CFDI es inválida, pero una remisión sin plano sigue
        // siendo una remisión.
        console.warn(LOG, 'no pude adjuntar los planos; el correo sale sin ellos:', e && e.message);
      }
      return origFetch.apply(this, args);
    };
  }

  // ── Observer ────────────────────────────────────────────────────────────────

  function setupObserver() {
    if (observerActive) return;
    observerActive = true;
    const obs = new MutationObserver(() => {
      const dlg = document.querySelector('.MuiDialog-paper, [role="dialog"]');
      // Al cerrarse el modal se limpia TODO, incluido el cliente identificado.
      // Si sobreviviera, el próximo modal decidiría con el dueño anterior — el
      // clásico nodo stale, sólo que en una variable: la mentira se refresca
      // sola y encima parece coherente.
      if (!dlg) { currentPlan = null; selected.clear(); lastCustomerName = null; return; }
      // El guard rechaza '1' Y 'pending': `mountPanel` es async, así que entre el
      // disparo del observer y su `.then()` caben varias mutaciones más. Mirar
      // sólo '1' dejaba montar el panel DOS veces (visto en producción, v0.1.0).
      const st = dlg.getAttribute('data-sa-ps-mounted');
      if (st === '1' || st === 'pending') return;
      if (!enabled) return;
      if (!Modal().isShippingEmailModal(readModalInfo(dlg))) return;
      dlg.setAttribute('data-sa-ps-mounted', 'pending');
      mountPanel(dlg).then((ok) => {
        dlg.setAttribute('data-sa-ps-mounted', ok ? '1' : '0');
      }).catch((e) => {
        console.warn(LOG, 'montaje falló:', e && e.message);
        dlg.setAttribute('data-sa-ps-mounted', '0');
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── API pública ─────────────────────────────────────────────────────────────

  function getSelectedFiles() { return Array.from(selected.values()); }
  function getPlan() { return currentPlan; }

  function init() {
    enabled = document.documentElement.dataset.saPsDrawingsEnabled !== 'false';
    patchFetch();
    setupObserver();   // el observer se monta SIEMPRE, aunque el applet esté apagado
    console.log(LOG, 'inicializado', enabled ? '(activo)' : '(apagado)');
  }

  return { init, getSelectedFiles, getPlan };
})();

if (typeof window !== 'undefined') {
  window.PackingSlipDrawings = PackingSlipDrawings;
  PackingSlipDrawings.init();
}
