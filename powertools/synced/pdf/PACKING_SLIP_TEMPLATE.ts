const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = { additionalPayload: {} };

  const ps = inputs.packingSlip;
  if (!ps || !Array.isArray(ps.items)) return result;

  // ──────────────────────────────────────────────────────────────
  // Config
  // ──────────────────────────────────────────────────────────────
  // El "PS" del cliente vive ANIDADO en el batch como
  // customInputs.DatosRecibo.PackingSlip (confirmado en scans 2026-05;
  // el mismo objeto DatosRecibo trae PesoCliente y numeroContenedores).
  // Fallbacks por si el schema cambia: PackingSlip plano, o key /^(ps|packingslip)$/i.
  const readPS = (ci: { [x: string]: any } | null | undefined): any => {
    if (!ci) return null;
    const dr = ci.DatosRecibo;
    if (dr && dr.PackingSlip != null && dr.PackingSlip !== "") return dr.PackingSlip;
    if (ci.PackingSlip != null && ci.PackingSlip !== "") return ci.PackingSlip;
    const hit = Object.keys(ci).find(k => /^(ps|packingslip)$/i.test(String(k).trim()));
    return (hit && ci[hit] !== "") ? ci[hit] : null;
  };

  // Fecha de embarque: ideal la que se coloca en el packing slip
  // (shippingDate); fallback shippedAt. NOTA: el Input NO expone un
  // createdAt del packing slip, así que el fallback disponible es shippedAt.
  const shippingDate = ps.shippingDate != null ? ps.shippingDate
    : (ps.shippedAt != null ? ps.shippedAt : null);
  const shippingDateSource = ps.shippingDate != null ? "shippingDate"
    : (ps.shippedAt != null ? "shippedAt" : null);

  // Empacador = usuario actual que genera el PDF/etiqueta. Es constante para
  // todo el embarque (no depende del contenedor), así que se calcula una vez.
  const packedBy = (inputs.currentUser && inputs.currentUser.name != null)
    ? inputs.currentUser.name : null;

  // Fecha de embarque ya formateada (d/m/Y H:i, 24 h) en la zona horaria del
  // Input. Se entrega lista para que la plantilla imprima `{shippingDateFmt}`
  // directo, SIN la función date() de Twig (que truena con "array given" al
  // recibir el binding del label). Constante para todo el embarque.
  const fmtDate = (iso: string | null, tz: string | null): string => {
    if (iso == null || iso === "") return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      const parts = new Intl.DateTimeFormat("es-MX", {
        timeZone: (tz != null && tz !== "") ? tz : "America/Mexico_City",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d);
      const get = (t: string): string => {
        const p = parts.find(x => x.type === t);
        return p ? p.value : "";
      };
      const hh = get("hour") === "24" ? "00" : get("hour"); // ICU a veces da 24
      return `${get("day")}/${get("month")}/${get("year")} ${hh}:${get("minute")}`;
    } catch (e) {
      // Fallback sin zona horaria: reformatea la parte de fecha/hora del ISO.
      const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : "";
    }
  };
  const shippingDateFmt = fmtDate(shippingDate, inputs.timezone);

  // ── Unidad de peso: DOS ejes independientes ───────────────────────────────
  //   • DESTINO (display): la unidad que el cliente quiere ver en la etiqueta.
  //     Wieland captura en libras (customInput UnidadMedidaPeso=true, criterio
  //     recursivo igual que weight-quick-entry.js) → "LB"; el resto "KG".
  //   • ORIGEN (source): la unidad REAL en que Steelhead entrega `item.weight`.
  //     ¡NO siempre es KG! El input la trae explícita en `item.unit` /
  //     `packingSlip.unit` (id 3972 = LBR/libras, 3969 = KGM/kilos). Asumir kg
  //     a ciegas DUPLICABA el peso de clientes LB cuando el dato ya venía en lb
  //     (bug remisión #1090, 2026-06-06).
  // La lógica pura (unitIsLb/convertWeight) es ESPEJO de
  // tools/packing_slip_weight.mjs (+ tests node:test). Mantener idénticas.
  const KG_TO_LB = 2.2046226218;
  const LBR_UNIT_ID = 3972;
  const isLbCustomer = (obj: any): boolean => {
    if (!obj || typeof obj !== "object") return false;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const k = String(key).toLowerCase();
      const val = obj[key];
      if (k.indexOf("lbs") >= 0 || k === "unidadmedidapeso" ||
          (k.indexOf("usar") >= 0 && k.indexOf("lb") >= 0)) {
        if (val === true || val === "true") return true;
      }
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (isLbCustomer(val)) return true;
      }
    }
    return false;
  };
  // ¿La unidad de ORIGEN que entrega Steelhead es libras? id 3972 autoritativo;
  // nombre ("LBR Libra") de respaldo. Default KG (false).
  const unitIsLb = (unit: any): boolean => {
    if (!unit || typeof unit !== "object") return false;
    if (unit.id != null && Number(unit.id) === LBR_UNIT_ID) return true;
    const n = unit.name != null ? String(unit.name).toLowerCase() : "";
    return n.indexOf("lbr") >= 0 || n.indexOf("libra") >= 0 || n.indexOf("lb") >= 0;
  };
  const customerCI = (ps.customer && ps.customer.customInputs) ? ps.customer.customInputs : null;
  const displayInLb = isLbCustomer(customerCI);
  const weightUnit = displayInLb ? "LB" : "KG";
  // Unidad de origen a nivel embarque (el PS trae una sola `unit`); se prioriza
  // la del item dentro del map por si difiriera.
  const psUnitIsLb = unitIsLb(ps.unit);
  // Convierte un peso desde su unidad de ORIGEN (sourceIsLb) a la de DESTINO
  // (displayInLb) y redondea a 2 decimales (el reparto proporcional por grupo
  // genera decimales largos).
  const convertWeight = (v: number | null, sourceIsLb: boolean): number | null => {
    if (v == null) return null;
    let out: number;
    if (displayInLb) {
      out = sourceIsLb ? v : v * KG_TO_LB;
    } else {
      out = sourceIsLb ? v / KG_TO_LB : v;
    }
    return Math.round(out * 100) / 100;
  };

  // ──────────────────────────────────────────────────────────────
  // Paso 1: aplanar a filas de etiqueta (item × partTransferAccount × batch).
  // Cada `item` del packing slip es un contenedor/bulto físico.
  // ──────────────────────────────────────────────────────────────
  const rows: any[] = [];
  ps.items.forEach(item => {
    (item.partsTransferAccounts || []).forEach((part: any) => {
      const pn = part.partNumber;
      if (!pn || pn.id == null) return;
      const batches = (part.receivedBatches && part.receivedBatches.length)
        ? part.receivedBatches
        : [null];
      batches.forEach((batch: any) => {
        rows.push({ item, part, pn, batch });
      });
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Paso 2: "Contenedor x de y" — agrupar por PN + batch, contar
  // contenedores (items) distintos y ordenar por item.index.
  // Se preserva la mutación item.containerIndex que la plantilla de
  // remisión ya leía (compatibilidad hacia atrás).
  // ──────────────────────────────────────────────────────────────
  const groups: Record<string, any[]> = {};
  rows.forEach(r => {
    const batchKey = (r.batch && r.batch.id != null) ? r.batch.id : "nobatch";
    const key = `${r.pn.id}-${batchKey}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  Object.keys(groups).forEach(key => {
    const group = groups[key];
    group.sort((a, b) => (a.item.index || 0) - (b.item.index || 0));
    const total = group.length;
    group.forEach((r, idx) => {
      r.containerNum = idx + 1;
      r.containerTotal = total;
      (r.item as any).containerIndex = `${idx + 1}/${total}`;
    });
  });

  // Etiquetas (filas) por item — para repartir la TARA igual entre los grupos
  // del mismo item (el empaque/tara no escala con las piezas).
  const itemRowCount: Record<string, number> = {};
  rows.forEach(r => {
    const iid = (r.item && r.item.id != null) ? String(r.item.id) : "noitem";
    itemRowCount[iid] = (itemRowCount[iid] || 0) + 1;
  });

  // ──────────────────────────────────────────────────────────────
  // Paso 3: construir las etiquetas + diagnóstico.
  // ──────────────────────────────────────────────────────────────
  let missingPS = 0, missingName = 0, missingWeight = 0, multiPart = 0, missingSO = 0;

  const labels = rows.map(r => {
    const item = r.item, part = r.part, pn = r.pn, batch = r.batch;
    const weight = item.weight || null;

    // Peso por grupo: el Input solo trae `item.weight` (TOTAL del item); con
    // grupos de partes hay N PTAs en 1 item y Steelhead no expone peso por grupo
    // (partGroup.containerWeight = null). Reparto:
    //   • NETO  → proporcional a las piezas del grupo (PN uniforme).
    //   • TARA  → IGUAL entre los grupos del item (el empaque no escala con piezas).
    //   • BRUTO → neto (proporcional) + tara (igual).
    // Para contenedores físicos (1 PTA por item) wFrac=1 e itemGroups=1 → íntegro.
    // La suma de los grupos del item reconstituye el total (gross = net + tare).
    const itemPieces = (item.partCount != null && item.partCount > 0) ? item.partCount : null;
    const wFrac = (itemPieces != null && part.partCount != null) ? part.partCount / itemPieces : 1;
    const itemGroups = itemRowCount[(item.id != null) ? String(item.id) : "noitem"] || 1;
    // Unidad de ORIGEN del peso de ESTE item (item.unit) → fallback al PS.
    // El peso reparte EN su unidad de origen; convertWeight lo lleva al destino.
    const sourceIsLb = unitIsLb(item.unit) || psUnitIsLb;
    const netSrc = (weight && weight.net != null) ? weight.net * wFrac : null;
    const tareSrc = (weight && weight.tare != null) ? weight.tare / itemGroups : null;
    const grossSrc = (netSrc != null && tareSrc != null)
      ? netSrc + tareSrc
      : ((weight && weight.gross != null) ? weight.gross * wFrac : null);

    // Nombre del contenedor: contenarización (rack) o agrupación de
    // partes (partGroup). El usuario confirmó que pueden usarse ambos,
    // así que se prioriza rack y se cae a partGroup.
    const rackName = (part.rack && part.rack.name) ? part.rack.name : null;
    const groupName = (part.partGroup && part.partGroup.name) ? part.partGroup.name : null;
    const containerName = rackName != null ? rackName : (groupName != null ? groupName : null);
    const containerNameSource = rackName != null ? "rack"
      : (groupName != null ? "partGroup" : null);

    // Unidad declarada en partGroup (aplica al peso del contenedor/tara).
    // El item.weight viene numérico sin unidad explícita en el Input.
    const containerWeightUnit = (part.partGroup && part.partGroup.containerWeightUnit && part.partGroup.containerWeightUnit.name)
      ? part.partGroup.containerWeightUnit.name : null;

    const psValue = readPS(batch ? batch.customInputs : null);

    // Orden de venta (received_order = OV en Steelhead) de la OT de esta parte.
    const receivedOrder = (part.workOrder && part.workOrder.receivedOrder)
      ? part.workOrder.receivedOrder : null;
    const salesOrder = (receivedOrder && receivedOrder.name != null) ? receivedOrder.name : null;
    const salesOrderId = (receivedOrder && receivedOrder.idInDomain != null) ? receivedOrder.idInDomain : null;

    // Diagnóstico
    if (psValue == null) missingPS++;
    if (containerName == null) missingName++;
    if (!weight || (weight.gross == null && weight.net == null)) missingWeight++;
    if ((item.partsTransferAccounts || []).length > 1) multiPart++;
    if (salesOrder == null && salesOrderId == null) missingSO++;

    const label: any = {
      // — Etiqueta base (8 campos) —
      partNumber: pn.name != null ? pn.name : null,
      description: pn.descriptionMarkdown != null ? pn.descriptionMarkdown : null,
      // Piezas de ESTA etiqueta = del PTA/grupo (part.partCount), NO del item:
      // con grupos de partes hay 1 item con N PTAs y item.partCount es el TOTAL
      // (mostraba el 100% en cada etiqueta). part.partCount es por grupo/contenedor.
      piecesPerContainer: part.partCount != null ? part.partCount
        : (item.partCount != null ? item.partCount : null),
      ps: psValue,
      batchName: (batch && batch.name != null) ? batch.name : null,
      workOrder: (part.workOrder && part.workOrder.name != null) ? part.workOrder.name : null,
      workOrderId: (part.workOrder && part.workOrder.idInDomain != null) ? part.workOrder.idInDomain : null,
      // — Orden de venta (received_order) de la OT de esta parte —
      salesOrder,
      salesOrderId,
      // — Empacador: usuario actual que genera la remisión/etiqueta —
      packedBy,
      shippingDate,
      shippingDateSource,
      shippingDateFmt,
      containerIndex: `${r.containerNum}/${r.containerTotal}`,
      containerNum: r.containerNum,
      containerTotal: r.containerTotal,

      // — Etiqueta 2 (extras): peso bruto/neto + nombre de contenedor —
      grossWeight: convertWeight(grossSrc, sourceIsLb),
      netWeight: convertWeight(netSrc, sourceIsLb),
      tareWeight: convertWeight(tareSrc, sourceIsLb),
      weightUnit,
      containerWeightUnit,
      containerName,
      containerNameSource,
    };
    // Toda rama debe EXISTIR en el árbol de PDFGeneratorAPI aunque el dato
    // falte en todas las etiquetas de la muestra (ej. nombre de contenedor
    // antes de contenarizar): null/undefined → "" para que el campo siempre
    // tenga un nodo colocable en la plantilla.
    Object.keys(label).forEach(k => { if (label[k] == null) label[k] = ""; });
    return label;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CUERPO de la remisión → additionalPayload.bodyRows[] (una fila por PN
  // consolidado: Cantidad Recibida · Descripción · Referencias (con rojo de OV
  // pendiente) · Cantidad Embarcada). Re-apuntar la tabla del template a este
  // array (cada celda renderiza su *Html). Aditivo: no toca labels[].
  //
  // ESPEJO INLINE de tools/packing_slip_body.mjs (40 tests node:test) — debe
  // quedar IDÉNTICO. Self-contenido y ES2017-safe (NADA de `?.` ni `??`).
  // ──────────────────────────────────────────────────────────────────────────
  const buildBodyRows = (bInputs: any): any[] => {
    const KG_TO_LB = 2.2046226218;
    const LBR_UNIT = 3972;
    const KGM_UNIT = 3969;
    const unitIsLb = (unit: any): boolean => {
      if (!unit || typeof unit !== "object") return false;
      if (unit.id != null && Number(unit.id) === LBR_UNIT) return true;
      const n = unit.name != null ? String(unit.name).toLowerCase() : "";
      return n.indexOf("lbr") >= 0 || n.indexOf("libra") >= 0 || n.indexOf("lb") >= 0;
    };
    const convertWeight = (a: any): number | null => {
      const value = a.value, sourceIsLb = a.sourceIsLb, displayInLb = a.displayInLb;
      if (value == null) return null;
      let out: number;
      if (displayInLb) { out = sourceIsLb ? value : value * KG_TO_LB; }
      else { out = sourceIsLb ? value / KG_TO_LB : value; }
      return Math.round(out * 100) / 100;
    };
    const escapeHtml = (s: any): string => {
      if (s == null) return "";
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    const mdToHtml = (s: any): string => {
      if (s == null) return "";
      let out = escapeHtml(s);
      out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      out = out.replace(/(^|[\s(>])_([^_\s][^_]*?)_(?=[\s).,;:<]|$)/g, "$1<i>$2</i>");
      out = out.replace(/\n/g, "<br>");
      return out;
    };
    const isPendingName = (name: any): boolean => {
      if (name == null) return false;
      const t = String(name).trim();
      return /pen/i.test(t) || t === ".";
    };
    const pluralContenedor = (n: any): string => (Number(n) === 1 ? "contenedor" : "contenedores");
    const formatInt = (n: any): string => {
      const v = n == null || isNaN(Number(n)) ? 0 : Math.round(Number(n));
      return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    };
    const format2 = (n: any): string => {
      const v = n == null || isNaN(Number(n)) ? 0 : Number(n);
      const fixed = (Math.round(v * 100) / 100).toFixed(2);
      const neg = fixed.charAt(0) === "-";
      const abs = neg ? fixed.slice(1) : fixed;
      const dot = abs.indexOf(".");
      const intPart = abs.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return (neg ? "-" : "") + intPart + abs.slice(dot);
    };
    const findWeightConversion = (convs: any): any => {
      if (!Array.isArray(convs)) return null;
      for (let i = 0; i < convs.length; i++) {
        const c = convs[i];
        if (c == null || c.unit == null || c.factor == null || c.factor <= 0) continue;
        const id = Number(c.unit.id);
        const n = c.unit.name != null ? String(c.unit.name).toLowerCase() : "";
        const isLbr = id === LBR_UNIT || n.indexOf("lbr") >= 0 || n.indexOf("libra") >= 0;
        const isKgm = id === KGM_UNIT || n.indexOf("kgm") >= 0 || n.indexOf("kilo") >= 0 || n.indexOf("kg") >= 0;
        if (isLbr) return { factor: c.factor, sourceIsLb: true };
        if (isKgm) return { factor: c.factor, sourceIsLb: false };
      }
      return null;
    };
    const sumContenedores = (uniqueBatches: any): any => {
      let total = 0; let has = false;
      uniqueBatches.forEach((b: any) => {
        const ci = b.customInputs;
        if (ci == null) return;
        const dr = ci.DatosRecibo;
        if (dr == null) return;
        const nn = dr.numeroContenedores;
        if (nn == null || isNaN(Number(nn))) return;
        total += Number(nn); has = true;
      });
      return has && total >= 1 ? total : null;
    };
    const isLbCustomer = (obj: any): boolean => {
      if (!obj || typeof obj !== "object") return false;
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i]).toLowerCase();
        const val = obj[keys[i]];
        if (k.indexOf("lbs") >= 0 || k === "unidadmedidapeso" || (k.indexOf("usar") >= 0 && k.indexOf("lb") >= 0)) {
          if (val === true || val === "true") return true;
        }
        if (val && typeof val === "object" && !Array.isArray(val)) {
          if (isLbCustomer(val)) return true;
        }
      }
      return false;
    };
    const collectUniqueBatches = (entries: any): any[] => {
      const out: any[] = []; const seen: any = {};
      entries.forEach((e: any) => {
        const batches = e.pta.receivedBatches != null ? e.pta.receivedBatches : [];
        batches.forEach((b: any) => {
          if (b == null) return;
          if (b.id != null) { if (seen[b.id]) return; seen[b.id] = true; }
          out.push(b);
        });
      });
      return out;
    };
    const sumInitialAmounts = (uniqueBatches: any): any => {
      let sum = 0; let has = false;
      uniqueBatches.forEach((b: any) => {
        const accs = b.inventoryAccountsByInventoryBatchId != null ? b.inventoryAccountsByInventoryBatchId : null;
        if (accs == null) return;
        accs.forEach((a: any) => {
          if (a == null || a.initialAmount == null) return;
          has = true; sum += Number(a.initialAmount);
        });
      });
      return { has: has, sum: sum };
    };
    const computeRecibida = (entries: any, uniqueBatches: any): number => {
      const init = sumInitialAmounts(uniqueBatches);
      if (init.has) return init.sum;
      const byWo: any = {};
      entries.forEach((e: any) => {
        const wo = e.pta.workOrder;
        const woKey = wo != null && wo.idInDomain != null ? "wo-" + wo.idInDomain : "pta-" + e.pta.id;
        const pnwo = e.pta.partNumberWorkOrder;
        if (pnwo != null && pnwo.billablePartCount != null) byWo[woKey] = pnwo.billablePartCount;
      });
      let total = 0;
      Object.keys(byWo).forEach((k) => { total += byWo[k]; });
      return total;
    };
    const computeEmbarcada = (entries: any): number => {
      let total = 0;
      entries.forEach((e: any) => { if (e.pta.partCount != null) total += e.pta.partCount; });
      return total;
    };
    const buildCantidadRecibidaHtml = (recibida: any, pn: any, uniqueBatches: any, ctx: any): string => {
      const parts: string[] = [];
      const conv = findWeightConversion(pn.unitConversions);
      if (conv != null) {
        const peso = convertWeight({ value: recibida * conv.factor, sourceIsLb: conv.sourceIsLb, displayInLb: ctx.displayInLb });
        if (peso != null) parts.push("(" + format2(peso) + (ctx.displayInLb ? " LBS)" : " KGM)"));
      }
      const cont = sumContenedores(uniqueBatches);
      if (cont != null) parts.push(formatInt(cont) + " " + pluralContenedor(cont));
      const small = parts.length > 0 ? "<br><small>" + parts.join("<br>") + "</small>" : "";
      return formatInt(recibida) + " PZA" + small;
    };
    const collectLabels = (entries: any): string[] => {
      const out: string[] = []; const seen: any = {};
      entries.forEach((e: any) => {
        const labels2 = e.pta.partNumber != null ? e.pta.partNumber.labels : null;
        if (!Array.isArray(labels2)) return;
        labels2.forEach((l: any) => {
          if (l == null || l.name == null) return;
          const key = l.id != null ? "id-" + l.id : "n-" + l.name;
          if (seen[key]) return; seen[key] = true; out.push(l.name);
        });
      });
      return out;
    };
    const collectSpecParams = (entries: any): any[] => {
      const out: any[] = []; const seen: any = {};
      entries.forEach((e: any) => {
        const sps = e.pta.partNumber != null ? e.pta.partNumber.specFieldParameters : null;
        if (!Array.isArray(sps)) return;
        sps.forEach((sp: any) => {
          if (sp == null) return;
          if (sp.id != null) { if (seen[sp.id]) return; seen[sp.id] = true; }
          out.push(sp);
        });
      });
      return out;
    };
    const isExternalSpec = (sp: any): boolean => {
      const sf = sp.specField;
      const spec = sf != null ? sf.spec : null;
      return spec != null && spec.type != null && String(spec.type).toUpperCase() === "EXTERNAL";
    };
    const buildDescripcionHtml = (pn: any, entries: any): string => {
      let html = "<b>" + escapeHtml(pn.name != null ? pn.name : "") + "</b>";
      const desc = mdToHtml(pn.descriptionMarkdown);
      if (desc !== "") html += " " + desc;
      const grupo = pn.partNumberGroup != null && pn.partNumberGroup.name != null ? pn.partNumberGroup.name : "";
      if (grupo !== "") html += " " + escapeHtml(grupo);
      const labels2 = collectLabels(entries);
      if (labels2.length > 0) html += "<br><b>Acabados: </b>" + labels2.map(escapeHtml).join(", ");
      const specs = collectSpecParams(entries);
      const specNames: string[] = []; const seenSpec: any = {};
      specs.forEach((sp: any) => {
        if (!isExternalSpec(sp)) return;
        const name = sp.specField.spec.name;
        if (name == null) return;
        const key = String(name).trim().toLowerCase();
        if (seenSpec[key]) return; seenSpec[key] = true; specNames.push(name);
      });
      if (specNames.length > 0) html += "<br><b>Especificación: </b>" + specNames.map((n: any) => escapeHtml(n) + ": ").join(", ");
      const egItems: string[] = []; const seenEg: any = {};
      specs.forEach((sp: any) => {
        if (!isExternalSpec(sp)) return;
        const fname = sp.specField.name != null ? String(sp.specField.name) : "";
        if (fname.indexOf("Espesor") < 0 && fname.indexOf("Grano") < 0) return;
        const value = sp.name != null ? sp.name : "";
        const text = escapeHtml(fname) + " (" + escapeHtml(value) + ")";
        const key = text.toLowerCase();
        if (seenEg[key]) return; seenEg[key] = true; egItems.push(text);
      });
      if (egItems.length > 0) html += "<br>" + egItems.join(", <br>");
      return html;
    };
    const readPS = (ci: any): any => {
      if (ci == null) return null;
      const dr = ci.DatosRecibo;
      if (dr != null && dr.PackingSlip != null && dr.PackingSlip !== "") return dr.PackingSlip;
      if (ci.PackingSlip != null && ci.PackingSlip !== "") return ci.PackingSlip;
      const keys = Object.keys(ci);
      for (let i = 0; i < keys.length; i++) {
        if (/^(ps|packingslip)$/i.test(String(keys[i]).trim())) {
          if (ci[keys[i]] !== "") return ci[keys[i]];
        }
      }
      return null;
    };
    const buildOcOv = (entries: any): any => {
      const ovs: string[] = []; const seen: any = {}; let anyPending = false;
      entries.forEach((e: any) => {
        const wo = e.pta.workOrder;
        const ro = wo != null ? wo.receivedOrder : null;
        if (ro == null) return;
        const key = ro.idInDomain != null ? "id-" + ro.idInDomain : (ro.name != null ? "n-" + ro.name : null);
        if (key == null || seen[key]) return;
        seen[key] = true;
        const name = ro.name != null ? ro.name : "";
        const id = ro.idInDomain != null ? ro.idInDomain : "";
        let disp;
        if (name !== "" && id !== "") disp = escapeHtml(name) + " (" + id + ")";
        else if (name !== "") disp = escapeHtml(name);
        else if (id !== "") disp = "#" + id;
        else return;
        ovs.push(disp);
        if (isPendingName(ro.name)) anyPending = true;
      });
      if (ovs.length === 0) return null;
      const inner = "<b>OC (OV): </b>" + ovs.join(", ");
      const html = anyPending ? '<span style="color:red; font-size:14pt;">' + inner + "</span>" : inner;
      return { html: html, anyPending: anyPending };
    };
    const buildOt = (entries: any): any => {
      const ots: any[] = []; const seen: any = {};
      entries.forEach((e: any) => {
        const wo = e.pta.workOrder;
        if (wo == null || wo.idInDomain == null || seen[wo.idInDomain]) return;
        seen[wo.idInDomain] = true; ots.push({ id: wo.idInDomain, name: wo.name });
      });
      if (ots.length === 0) return null;
      if (ots.length === 1) {
        const o = ots[0];
        const suf = o.name != null && String(o.name).trim() !== "" ? " - " + escapeHtml(o.name) : "";
        return "<b>OT: </b>" + o.id + suf;
      }
      return "<b>OT: </b>" + ots.map((o: any) => String(o.id)).join(", ");
    };
    const buildLote = (uniqueBatches: any): any => {
      const names: string[] = []; const seen: any = {};
      uniqueBatches.forEach((b: any) => {
        if (b.name == null || seen[String(b.name)]) return;
        seen[String(b.name)] = true; names.push(b.name);
      });
      if (names.length === 0) return null;
      return "<b>Lote: </b>" + names.map(escapeHtml).join(", ");
    };
    const buildPsCliente = (uniqueBatches: any, isSchneider: any): any => {
      const items: string[] = []; const seen: any = {};
      uniqueBatches.forEach((b: any) => {
        const ps = readPS(b.customInputs);
        if (ps == null || ps === "") return;
        let suf = "";
        if (isSchneider) {
          const bn = b.name != null ? String(b.name).trim() : "";
          suf = " " + (bn.substring(0, 4) === "RG-M" ? "VM" : "VE");
        }
        const text = escapeHtml(String(ps)) + suf;
        if (seen[text]) return; seen[text] = true; items.push(text);
      });
      if (items.length === 0) return null;
      return "<b>PS Cliente: </b>" + items.join(", ");
    };
    const buildCotizacion = (entries: any): any => {
      const ids: any[] = []; const seen: any = {};
      entries.forEach((e: any) => {
        const q = e.pta.quote;
        if (q == null || q.quoteId == null || seen[q.quoteId]) return;
        seen[q.quoteId] = true; ids.push(q.quoteId);
      });
      if (ids.length === 0) return null;
      return "<b>Cotización: </b>" + ids.join(", ");
    };
    const buildReferenciasHtml = (entries: any, uniqueBatches: any, ctx: any): any => {
      const lines: string[] = []; let anyPending = false;
      const oc = buildOcOv(entries);
      if (oc != null) { lines.push(oc.html); anyPending = oc.anyPending; }
      const ot = buildOt(entries); if (ot != null) lines.push(ot);
      const lote = buildLote(uniqueBatches); if (lote != null) lines.push(lote);
      const ps = buildPsCliente(uniqueBatches, ctx.isSchneider); if (ps != null) lines.push(ps);
      const cot = buildCotizacion(entries); if (cot != null) lines.push(cot);
      return { html: lines.join("<br>"), anyPending: anyPending };
    };
    const collectUniqueItems = (entries: any): any[] => {
      const out: any[] = []; const seen = new Set();
      entries.forEach((e: any) => {
        if (seen.has(e.item)) return; seen.add(e.item); out.push(e.item);
      });
      return out;
    };
    const sumContenedoresEmbarcados = (uniqueItems: any): number => {
      let total = 0;
      uniqueItems.forEach((it: any) => {
        let n = 1;
        if (it.comment != null) {
          const tok = String(it.comment).trim().split(/\s+/)[0];
          const parsed = parseInt(tok, 10);
          if (!isNaN(parsed)) n = parsed;
        }
        total += n;
      });
      return total;
    };
    const computeNetWeight = (entries: any, ctx: any): any => {
      let total = 0; let hasAny = false;
      entries.forEach((e: any) => {
        const item = e.item;
        const w = item.weight;
        if (w == null || w.net == null) return;
        const ipc = item.partCount != null && item.partCount > 0 ? item.partCount : null;
        const wFrac = ipc != null && e.pta.partCount != null ? e.pta.partCount / ipc : 1;
        const sourceIsLb = unitIsLb(item.unit) || ctx.psUnitIsLb;
        const conv = convertWeight({ value: w.net * wFrac, sourceIsLb: sourceIsLb, displayInLb: ctx.displayInLb });
        if (conv != null) { total += conv; hasAny = true; }
      });
      return hasAny ? total : null;
    };
    const buildCantidadEmbarcadaHtml = (embarcada: any, recibida: any, entries: any, uniqueItems: any, ctx: any): string => {
      const small: string[] = [];
      const net = computeNetWeight(entries, ctx);
      if (net != null) small.push("(" + format2(net) + (ctx.displayInLb ? " LBS)" : " KGM)"));
      else small.push("Sin peso");
      const cont = sumContenedoresEmbarcados(uniqueItems);
      small.push(formatInt(cont) + " " + pluralContenedor(cont));
      let estatus: string;
      if (embarcada === recibida) estatus = "<b>Estatus: </b>Completa";
      else if (embarcada < recibida) estatus = "<b>Estatus: </b>Parcial<br><b>Balance: </b>" + formatInt(recibida - embarcada) + " PZA";
      else estatus = "<b>Estatus: </b>Excedente<br><b>Balance: </b>+" + formatInt(embarcada - recibida) + " PZA";
      small.push(estatus);
      return formatInt(embarcada) + " PZA<br><small>" + small.join("<br>") + "</small>";
    };
    const buildRowInner = (g: any, ctx: any): any => {
      const pn = g.pn;
      const entries = g.entries;
      const uniqueBatches = collectUniqueBatches(entries);
      const uniqueItems = collectUniqueItems(entries);
      const recibida = computeRecibida(entries, uniqueBatches);
      const embarcada = computeEmbarcada(entries);
      const refs = buildReferenciasHtml(entries, uniqueBatches, ctx);
      const row: any = {
        pnId: g.pnId,
        partNumber: pn.name != null ? pn.name : "",
        cantidadRecibidaHtml: buildCantidadRecibidaHtml(recibida, pn, uniqueBatches, ctx),
        descripcionHtml: buildDescripcionHtml(pn, entries),
        referenciasHtml: refs.html,
        cantidadEmbarcadaHtml: buildCantidadEmbarcadaHtml(embarcada, recibida, entries, uniqueItems, ctx),
        anyPending: refs.anyPending ? "1" : "0",
        _placeholder: "",
      };
      Object.keys(row).forEach((k) => { if (row[k] == null) row[k] = ""; });
      return row;
    };
    const placeholderRow = (): any => ({
      pnId: 0, partNumber: "", cantidadRecibidaHtml: "", descripcionHtml: "",
      referenciasHtml: "", cantidadEmbarcadaHtml: "", anyPending: "0", _placeholder: "1",
    });

    const bPs = bInputs != null ? bInputs.packingSlip : null;
    if (!bPs || !Array.isArray(bPs.items)) return [];
    const bCustomerCI = bPs.customer != null && bPs.customer.customInputs != null ? bPs.customer.customInputs : null;
    const bDisplayInLb = isLbCustomer(bCustomerCI);
    const bWeightUnit = bDisplayInLb ? "LB" : "KG";
    const bPsUnitIsLb = unitIsLb(bPs.unit);
    const bCustomerName = bPs.customer != null && bPs.customer.name != null ? bPs.customer.name : "";
    const bIsSchneider = bCustomerName.substring(0, 3) === "SCH";
    const bCtx = { displayInLb: bDisplayInLb, weightUnit: bWeightUnit, psUnitIsLb: bPsUnitIsLb, isSchneider: bIsSchneider };

    const bGroups = new Map<any, any>();
    bPs.items.forEach((item: any) => {
      const ptas = item.partsTransferAccounts != null ? item.partsTransferAccounts : [];
      ptas.forEach((pta: any) => {
        const pn = pta.partNumber;
        if (pn == null || pn.id == null) return;
        let g = bGroups.get(pn.id);
        if (g == null) { g = { pnId: pn.id, pn: pn, entries: [] }; bGroups.set(pn.id, g); }
        g.entries.push({ item: item, pta: pta });
      });
    });
    const bRows: any[] = [];
    bGroups.forEach((g) => { bRows.push(buildRowInner(g, bCtx)); });
    if (bRows.length === 0) return [placeholderRow()];
    return bRows;
  };

  let bodyRows: any[] = [];
  try {
    bodyRows = buildBodyRows(inputs);
  } catch (e) {
    helpers.addErrorMessage({
      severity: "error",
      message: "Error armando el cuerpo de la remisión (bodyRows): " + String(e),
    });
  }

  result.additionalPayload = {
    labels,
    bodyRows,
    totalLabels: labels.length,
    shippingDate: shippingDate != null ? shippingDate : "",
    shippingDateSource: shippingDateSource != null ? shippingDateSource : "",
    shippingDateFmt,
    packedBy: packedBy != null ? packedBy : "",
    weightUnit,
  };

  helpers.log(
    `🏷️ ${labels.length} etiqueta(s) · peso en ${weightUnit}` +
    (packedBy != null ? ` · empacador: ${packedBy}` : ` · sin empacador`) + `. ` +
    `Sin PS: ${missingPS} · sin nombre contenedor: ${missingName} · ` +
    `sin peso: ${missingWeight} · sin OV: ${missingSO} · items multi-parte: ${multiPart}.`
  );

  if (missingSO > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: `⚠️ ${missingSO} etiqueta(s) sin orden de venta (la OT no trae receivedOrder).`,
    });
  }

  if (missingPS > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: `⚠️ ${missingPS} etiqueta(s) sin customInput "PS" en el batch — revisa la key (PS_KEYS) o captura el dato.`,
    });
  }
  if (missingName > 0) {
    helpers.addErrorMessage({
      severity: "warning",
      message: `⚠️ ${missingName} etiqueta(s) sin nombre de contenedor (ni rack ni partGroup).`,
    });
  }
  if (multiPart > 0) {
    helpers.addErrorMessage({
      severity: "info",
      message: `ℹ️ ${multiPart} contenedor(es) con más de una parte: el peso se reparte proporcional a las piezas (Steelhead no expone peso por parte/grupo).`,
    });
  }

  return result;
};

type LowCodeResult = {
  additionalPayload?: any;
};

interface Inputs {
  origin: string;
  signUrl: string;
  timezone: string;
  packingSlip: {
    idInDomain: number;
    shipVia: string | null;
    shippingDate: string | null;
    trackingNumber: string | null;
    signatureReceivedB64: string | null;
    signatureReceivedPrintedName: string | null;
    signatureReceivedSignedAt: string | null;
    signingKey: string;
    shippedAt: string;
    customerContact: {
      name: string | null;
      phone: string | null;
      email: string | null;
      address: string | null;
      isInvoiceContact: boolean | null;
      isShippingContact: boolean | null;
    } | null;
    customer: {
      domainId: number;
      idInDomain: number | null;
      name: string | null;
      shortName: string | null;
      avatarUrl: string | null;
    } & {
      defaultTerms: string | null;
      phoneNumber: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
    };
    domain: {
      id: number;
      logoUrl: string | null;
      name: string | null;
      address: string | null;
      contactPhone: string | null;
      contactEmail: string | null;
    };
    billToAddress: string;
    shipToAddress: string;
    shipToAddressDescription: string | null;
    dropShipToAddress: {
      customerName: string | null;
      address: string | null;
    };
    customInputs: {
      [x: string]: any;
    } | null;
    unit: {
      id: number;
      name: string;
    } | null;
    totalWeight: {
      gross: number;
      net: number;
    } | null;
    items: {
      id: number;
      index: number;
      partCount: number;
      comment: string | null;
      weight: {
        gross: number;
        tare: number;
        net: number;
      } | null;
      unit: {
        id: number;
        name: string;
      } | null;
      partsTransferAccounts: {
        id: number;
        partCount: number;
        partNumber: {
          id: number | null;
          name: string | null;
          descriptionMarkdown: string | null;
          customerFacingNotes: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
          treatments: {
            treatment: {
              name: string;
              treatmentGroup: {
                id: number;
                name: string;
              } | null;
              inventoryItems: {
                id: number;
                name: string;
                customInputs: {
                  [x: string]: any;
                } | null;
                descriptionMarkdown: string | null;
              }[];
            } | null;
            process: {
              name: string;
              id: number | null;
            } | null;
          }[];
          unitConversions: {
            unit: {
              id: number;
              name: string;
            };
            factor: number;
          }[];
          partNumberGroup: {
            id: number;
            name: string | null;
          } | null;
          specFieldParameters: {
            id: number | null;
            name: string | null;
            minimumValue: number | null;
            maximumValue: number | null;
            targetValue: number | null;
            samplingRate: number | null;
            sampleCount: number | null;
            sampleSet: {
              id: number;
              name: string;
              sampleRanges: {
                id: number;
                minBatchCount: number;
                maxBatchCount: number | null;
                sampleCount: number | null;
                samplingRate: number | null;
              }[];
            } | null;
            specField: {
              id: number | null;
              name: string | null;
              spec: {
                id: number | null;
                revisionNumber: number;
                name: string | null;
                revisionName: string | null;
                externalDescription: string | null;
                type: string | null;
                customInputs: {
                  [x: string]: any;
                } | null;
              } | null;
            } | null;
          }[] | null;
        };
        location: {
          id: number;
          path: string;
        } | null;
        materialConversion: {
          id: number;
          assembly: {
            id: number;
            idInDomain: number | null;
            castComponents: {
              id: number;
              idInDomain: number | null;
            }[];
          } | null;
        } | null;
        rack?: ({
          name?: (string | null) | undefined;
          id?: (number | undefined) | null;
          rackType: {
            isContainer?: (boolean | undefined) | null;
            name?: (string | undefined) | null;
          };
        } | undefined) | null;
        partGroup: ({
          id: number | null;
          name: string | null;
          labels: {
            name: string | null;
            color: string | null;
          }[];
          containerWeight: number | null;
          containerWeightUnit: {
            id: number | null;
            name: string | null;
            mustBeInteger: boolean | null;
          } | null;
        } | null) | null;
        workOrder: {
          idInDomain: number | null;
          name: string | null;
          recipeName: string | null;
          recipe: {
            name: string | null;
            description: string | null;
          };
          deadline: string | null;
          labels: {
            name: string | null;
            color: string | null;
          }[];
          customInputs: {
            [x: string]: any;
          } | null;
          receivedOrder: {
            idInDomain: number | null;
            name: string | null;
            createdAt: string | null;
            customInputs: {
              [x: string]: any;
            } | null;
            invoiceTerms: {
              id: number;
              terms: string;
            } | null;
            receivedOrderLines: {
              id: number;
              name: string | null;
              receivedOrderLineItems: {
                id: number;
                price: number | null;
                quantity: number | null;
                unit: {
                  id: number;
                  name: string;
                } | null;
                receivedOrderLineItemPartTransforms: {
                  receivedOrderPartTransform: {
                    id: number;
                    partNumber: {
                      id: number;
                      name: string;
                    };
                    count: number | null;
                  } | null;
                }[];
              }[];
            }[];
          };
          treatments: {
            treatment: {
              name: string;
              isOverride: boolean;
            } | null;
            process: {
              name: string;
            } | null;
          }[];
          treatmentDisplays: {
            treatment: {
              name: string;
              isOverride: boolean;
            } | null;
            process: {
              name: string;
            } | null;
          }[];
        };
        qualityHold: {
          id: number;
          descriptionMarkdown: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
          markForScrap: boolean | null;
        } | null;
        returnMerchandiseAuthorization: {
          id: number;
          name: string | null;
          idInDomain: number | null;
          customInputs: {
            [x: string]: any;
          } | null;
        } | null;
        nonConformanceReport: {
          id: number;
          name: string | null;
          idInDomain: number | null;
          customInputs: {
            [x: string]: any;
          } | null;
        } | null;
        partNumberWorkOrder: {
          partGroup: {
            id: number;
            name: string;
          } | null;
          billablePartCount: number;
          completedPartCount: number;
          shippedPartCount: number;
          shippedFinalizedPartCount: number;
          descriptionMarkdown: string | null;
        } | null;
        quote: {
          quoteId: number | null;
          partNumbers: {
            partNumber: {
              id: number;
              name: string;
              description: string | null;
              partNumberGroup: {
                id: number;
                name: string | null;
              } | null;
            } | null;
            description: string | null;
          }[];
        };
        receivedBatches: {
          id: number;
          name: string | null;
          descriptionMarkdown: string | null;
          customInputs: {
            [x: string]: any;
          } | null;
          partNumberOnBatch: {
            id: number;
            name: string;
          } | null;
          // Opcional: cantidad inicial del lote (COALESCE primario de Cantidad
          // Recibida). HOY Steelhead NO lo expone para packing slip → llega
          // undefined y el hook cae a billablePartCount. Si se agrega al data
          // query del PDF, el hook lo usa automáticamente. Ver spec 2026-06-10.
          inventoryAccountsByInventoryBatchId?: {
            initialAmount: number | null;
            partNumber: { id: number | null } | null;
          }[];
        }[];
      }[];
    }[];
    images: {
      url: string;
    }[];
    receivedOrdersIncluded: {
      idInDomain: number;
      name: string | null;
      workOrders: {
        idInDomain: number;
        name: string | null;
      }[];
    }[];
  };
  currentUser: {
    id: number;
    name: string | null;
    avatarUrl: string | null;
  } & {
    signatureBase64: string;
  };
}

type Severity = 'warning' | 'error' | 'info' | 'success'
type ErrorMessage = string | { severity: Severity, message: string }

interface Helpers {
  log: (message: any) => void
  addErrorMessage: (message: ErrorMessage) => void
  addInformationalPrice: (value: { title: string, note?: string, price: number, category?: string }) => void
  addQuotePartPricingTier: (value: { title: string, quantity: number, price: number }) => void
  parseCSV: (value: string) => { data: any[][], errors: [], meta: any }
}
