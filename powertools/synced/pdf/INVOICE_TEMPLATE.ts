// ─────────────────────────────────────────────────────────────────────────────
// Power Tools de Steelhead — Hook de preparación de payload para la plantilla
// PDF de factura (PDFGeneratorAPI). Este hook NO genera el PDF; solo limpia y
// enriquece los datos que se pasan al template como `additionalPayload`.
//
// Convención: lo que regreses en `result.additionalPayload` queda disponible
// en la plantilla de PDFGeneratorAPI como objeto raíz (junto con `inputs`
// originales). Útil para precomputar joins, formateos y valores derivados que
// la plantilla no puede calcular por sí sola (Handlebars-like).
//
// Bloques actuales:
//   1) ZIP code: se extrae del `billToAddress.address` con regex, descartando
//      el ZIP-like que arranca el string (suele ser número de calle, no CP).
//   2) XML decodificado: el `XmlBase64File` del writeResult se decodifica con
//      atob y se reindenta para legibilidad (debug / leyenda).
//   3) Lotes y PackingSlip por línea de factura: join one-to-many entre
//      `partAccounts[]` y `invoiceLines[]` por `invoiceLineNumbers[].line`.
//      Expone tanto un array enriquecido como un map por lineNumber para
//      flexibilidad del template.
// ─────────────────────────────────────────────────────────────────────────────

const getPdfCustomization = (inputs: Inputs, helpers: Helpers): LowCodeResult => {
  const result: LowCodeResult = {};

  // Helper de reindentación XML. Se queda fuera del try porque no depende del
  // input y para que el cierre léxico no atrape variables del bloque try.
  // Nota: la variable interna `result` en el .map() *sombrea* al `result` del
  // hook arriba — funciona porque el .map() retorna y nunca asigna al de afuera,
  // pero si algún día se refactoriza hay que renombrarla para evitar confusión.
  function formatXml(xml: string): string {
    let indent = 0;
    return xml
      .replace(/>\s*</g, "><")
      .replace(/(<[^/][^>]*>)/g, "\n" + "$1")
      .replace(/(<\/[^>]+>)/g, "$1\n")
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        if (line.match(/^<\//)) indent--;
        const result = "  ".repeat(Math.max(0, indent)) + line.trim();
        if (line.match(/^<[^/]/) && !line.match(/\/>/)) indent++;
        return result;
      })
      .join("\n");
  }

  try {
    // ── 1️⃣ ZIP CODE desde Bill To ──────────────────────────────────────────
    // Solo usamos la dirección de facturación (no Ship To / Drop Ship).
    const rawAddress = inputs?.billToAddress?.address || "";

    // Captura cualquier secuencia ZIP-like (5 dígitos o ZIP+4 estilo US).
    // En direcciones MX esto también pega códigos postales de 5 dígitos.
    const zipMatches = rawAddress.match(/\b\d{5}(?:-\d{4})?\b/g) || [];

    // Heurística: si la dirección arranca con "12345 Some Street...", ese
    // primer "12345" es número exterior, no CP. Lo descartamos.
    const filteredZips = zipMatches.filter((zip) => {
      return !rawAddress.startsWith(zip);
    });

    // Si quedan 2+, asumimos que el segundo es el CP real (el primero suele
    // ser parte de calle interna o suite). Si queda 1, ese es. Si no hay, null.
    const zipCode =
      filteredZips.length > 1
        ? filteredZips[1]
        : filteredZips.length === 1
          ? filteredZips[0]
          : null;

    // ── 2️⃣ XML CFDI decodificado ──────────────────────────────────────────
    // El writeResult del paso previo trae el XML del CFDI en Base64. Lo
    // decodificamos y reindentamos para que el template pueda mostrar un
    // bloque legible (o se use para diagnóstico).
    const xmlBase64 = inputs?.createWriteResult?.data?.result?.writeResult?.XmlBase64File ?? null;
    let xmlDecodificado: string | null = null;

    if (xmlBase64 && typeof xmlBase64 === "string") {
      try {
        xmlDecodificado = formatXml(atob(xmlBase64));
      } catch {
        // atob falla si el string no es Base64 válido. No es crítico — el PDF
        // se puede generar sin la sección XML; solo avisamos.
        helpers.addErrorMessage({
          severity: "warning",
          message: "No se pudo decodificar el campo XML (Base64 inválido)",
        });
      }
    }

    // ── 3️⃣ JOIN partAccounts ↔ invoiceLines por lineNumber ───────────────
    // Problema: el template necesita mostrar, dentro de la tabla de
    // invoiceLines, los lotes (`receivedBatches[].name`) y su PackingSlip
    // (`receivedBatches[].customInputs.DatosRecibo.PackingSlip`) que están
    // en otro array (partAccounts) a nivel raíz.
    //
    // Llave de unión:
    //   partAccounts[].invoiceLineNumbers[].line  ==  invoiceLines[].invoiceLine.lineNumber
    //
    // Cardinalidad:
    //   - 1 invoiceLine ↔ N partAccounts  (varios lotes por línea de factura)
    //   - 1 partAccount ↔ N invoiceLineNumbers  (mismo PA repartido en varias
    //     líneas; raro pero el shape lo permite, así que iteramos)
    //   - 1 partAccount ↔ N receivedBatches  (lotes físicos recibidos)
    //
    // Estrategia: construir un Map<lineNumber, Lote[]> dedupado por id de
    // batch, y exponer dos formas para flexibilidad del template:
    //   a) `lotesPorLinea`: objeto plano keyed por lineNumber (string) —
    //      útil si el template hace lookup desde el loop original de
    //      invoiceLines (`{{lotesPorLinea.[lineNumber]}}`).
    //   b) `invoiceLinesConLotes`: array ya enriquecido, listo para iterar
    //      directo en la plantilla sin lookup adicional.

    type LoteResumen = {
      batchId: number;
      name: string | null;
      packingSlip: string | number | null;
      descriptionMarkdown: string | null;
    };

    const lotesPorLineaMap = new Map<number, LoteResumen[]>();
    // Paralelo a lotesPorLineaMap pero a nivel partAccount, para acceder a
    // workOrder.idInDomain (que vive en el PA, no en el batch).
    const paPorLineaMap = new Map<number, typeof inputs.partAccounts>();

    for (const pa of inputs.partAccounts ?? []) {
      const lineNumbers = (pa.invoiceLineNumbers ?? [])
        .map((iln) => iln?.line)
        .filter((n): n is number => typeof n === "number");

      if (lineNumbers.length === 0) continue;

      for (const ln of lineNumbers) {
        if (!paPorLineaMap.has(ln)) paPorLineaMap.set(ln, [] as any);
        (paPorLineaMap.get(ln) as any).push(pa);
      }

      for (const batch of pa.receivedBatches ?? []) {
        if (!batch) continue;
        const resumen: LoteResumen = {
          batchId: batch.id,
          name: batch.name ?? null,
          packingSlip:
            (batch.customInputs as any)?.DatosRecibo?.PackingSlip ?? null,
          descriptionMarkdown: batch.descriptionMarkdown ?? null,
        };

        for (const ln of lineNumbers) {
          if (!lotesPorLineaMap.has(ln)) lotesPorLineaMap.set(ln, []);
          const arr = lotesPorLineaMap.get(ln)!;
          // Dedup por batchId: si el mismo lote llega vía dos partAccounts
          // distintos para la misma línea, no lo repetimos.
          if (!arr.some((l) => l.batchId === resumen.batchId)) {
            arr.push(resumen);
          }
        }
      }
    }

    // Forma (a): objeto plano para lookup por lineNumber desde el template.
    const lotesPorLinea: Record<string, LoteResumen[]> = {};
    for (const [ln, lotes] of lotesPorLineaMap.entries()) {
      lotesPorLinea[String(ln)] = lotes;
    }

    // Helper: arma string combinado "nameLote (PS PackingSlip), ..." manteniendo
    // cada lote pegado a su PS. Si un lote no tiene PS, se muestra solo el
    // nombre (sin el sufijo entre paréntesis). Si `name === packingSlip` (caso
    // común en Steelhead donde el lote se nombra igual al PS de origen),
    // tampoco repetimos: solo el nombre.
    function formatLotesConPs(lotes: LoteResumen[]): string {
      return lotes
        .map((l) => {
          const name = l.name ?? "—";
          const ps =
            l.packingSlip != null && l.packingSlip !== ""
              ? String(l.packingSlip)
              : null;
          return ps && ps !== name ? `${name} (PS ${ps})` : name;
        })
        .join(", ");
    }

    // ── Flags DatosFactura (vienen del customer del Bill To) ──────────────
    // Replican los flags del expression language del template para decidir
    // qué bloques se muestran en la descripción enriquecida.
    type DatosFactura = {
      MostrarNP: boolean;
      MostrarAcabado: boolean;
      MostrarProducto: boolean;
      MostrarRemision: boolean;
      MostrarPO: boolean;
      MostrarLineaPO: boolean;
      MostrarOV: boolean;
      MostrarOT: boolean;
      MostrarLote: boolean;
      MostrarPS: boolean;
      MultiplicadorLineaOC: number;
    };

    const dfRawAny = (inputs?.billToAddress?.customer?.customInputs as any)
      ?.DatosFactura;
    // Distinguir "no configurado" (null/undefined/objeto vacío) de "todos los
    // flags en false" (válido — el cliente decidió ocultar todo a propósito).
    const datosFacturaPresente =
      dfRawAny != null &&
      typeof dfRawAny === "object" &&
      Object.keys(dfRawAny).length > 0;

    const dfRaw = dfRawAny ?? {};
    const flags: DatosFactura = {
      MostrarNP: !!dfRaw.MostrarNP,
      MostrarAcabado: !!dfRaw.MostrarAcabado,
      MostrarProducto: !!dfRaw.MostrarProducto,
      MostrarRemision: !!dfRaw.MostrarRemision,
      MostrarPO: !!dfRaw.MostrarPO,
      MostrarLineaPO: !!dfRaw.MostrarLineaPO,
      MostrarOV: !!dfRaw.MostrarOV,
      MostrarOT: !!dfRaw.MostrarOT,
      MostrarLote: !!dfRaw.MostrarLote,
      MostrarPS: !!dfRaw.MostrarPS,
      MultiplicadorLineaOC: Number(dfRaw.MultiplicadorLineaOC) || 1,
    };

    const customerName = inputs?.billToAddress?.customer?.name ?? "";
    const isSchneider = customerName.substring(0, 3) === "SCH";

    // Sugerencia para que el template decida si renderiza la tabla
    // consolidada en lugar de la tabla por línea. NO se usa como gating
    // en el TS (siempre exponemos ambas formas); el template hace el switch.
    // Tolerante a "Gómez"/"Gomez" (con/sin tilde) en case-insensitive.
    const customerNameLower = customerName.toLowerCase();
    const shipToLower = (
      inputs?.shipToAddress?.address ?? ""
    ).toLowerCase();
    const isSchneiderRojoGomez =
      customerNameLower.includes("schneider") &&
      (shipToLower.includes("rojo gómez") || shipToLower.includes("rojo gomez"));

    // Mensaje fallback cuando el cliente no tiene DatosFactura configurado.
    // Se inyecta como `descripcionHtml` en TODAS las líneas y también como
    // campo suelto en additionalPayload por si el template prefiere ponerlo
    // en el header del PDF en lugar de en cada fila.
    const datosFacturaMissingMsg = !datosFacturaPresente
      ? `<span style="color:red;"><b>Favor de configurar DatosFactura del Cliente ${
          customerName || "(sin nombre)"
        } en SH</b></span>`
      : null;

    if (!datosFacturaPresente) {
      helpers.addErrorMessage({
        severity: "warning",
        message: `Cliente "${
          customerName || "(sin nombre)"
        }" no tiene DatosFactura configurado en customInputs; descripciones enriquecidas usan mensaje de fallback.`,
      });
    }

    // Helper: descripción HTML enriquecida por línea de factura. Traduce
    // tu expression del template de PDFGeneratorAPI a TS. Ver doc en
    // `docs/applets/powertools-facturacion-pdf.md` (bloque "Descripción HTML").
    function buildDescripcionHtml(
      il: (typeof inputs.invoiceLines)[number],
      lotesDeLinea: LoteResumen[],
      pasDeLinea: any[]
    ): string {
      const line = il?.invoiceLine;
      if (!line) return "";

      // Si el cliente no tiene DatosFactura configurado, reemplazar cada
      // descripción por el mensaje de fallback (se ve en cada fila del PDF
      // para que el operador lo cache obvio).
      if (datosFacturaMissingMsg) return datosFacturaMissingMsg;

      // Top-level: si el invoice tiene total negativo (notas de crédito),
      // usar la descripción cruda y saltarse todo el enriquecimiento.
      if ((inputs.totalPriceUSD ?? 0) < 0) {
        return line.description ?? "";
      }

      const items = line.invoiceLineItems ?? [];
      const item0 = items[0];

      const partes: string[] = [];

      // Helper de fusión PO/Lote/PS (espejo de tools/pdf_description_fusion.mjs).
      const fusionarPoLotePs = (po: string | null, loteNames: string[], psVals: string[]) => {
        const noFusion = { fusionado: false, label: '', valor: '', psRestantes: psVals }
        if (!po || loteNames.length === 0) return noFusion
        if (!loteNames.every((n) => n === po)) return noFusion
        const prefijo = po + ' '
        const psCoincide =
          psVals.length > 0 && psVals.every((ps) => ps === po || ps.startsWith(prefijo))
        if (psCoincide) {
          const sufijos = [
            ...new Set(psVals.map((ps) => (ps === po ? '' : ps.slice(prefijo.length))).filter(Boolean)),
          ]
          const valor = sufijos.length > 0 ? `${po} ${sufijos.join(', ')}` : po
          return { fusionado: true, label: 'PO/Lote/PS', valor, psRestantes: [] as string[] }
        }
        return { fusionado: true, label: 'PO/Lote', valor: po, psRestantes: psVals }
      }

      const poName = item0?.salesOrderLineItem?.salesOrder?.name ?? null
      const loteNamesLinea = lotesDeLinea
        .map((l) => l.name)
        .filter((n): n is string => !!n)
      const psValsLinea = lotesDeLinea
        .map((l) => (l.packingSlip != null && l.packingSlip !== '' ? String(l.packingSlip) : null))
        .filter((p): p is string => !!p)
      const fusion =
        flags.MostrarPO && flags.MostrarLote
          ? fusionarPoLotePs(poName, loteNamesLinea, flags.MostrarPS ? psValsLinea : [])
          : { fusionado: false, label: '', valor: '', psRestantes: psValsLinea }

      // ── Bloque 1: Producto ────────────────────────────────────────────
      if (flags.MostrarProducto) {
        const productName =
          item0?.product?.name ??
          item0?.salesOrderLineItem?.product?.name ??
          null;
        if (productName) {
          partes.push(`<b>Producto: </b>${productName}<br>`);
        }
      }

      // ── Bloque 2: Remisión (PS de embarque) ───────────────────────────
      // Itera TODOS los referencedPartAccounts de TODOS los lineItems y
      // saca packingSlip.idInDomain. Dedupea para no repetir el mismo PS.
      if (flags.MostrarRemision) {
        const psIds = new Set<string>();
        for (const it of items) {
          for (const rpa of it?.referencedPartAccounts ?? []) {
            const id = rpa?.packingSlip?.idInDomain;
            if (id != null) psIds.add(String(id));
          }
        }
        if (psIds.size > 0) {
          partes.push(
            `<b>Remisión: </b>${Array.from(psIds).join(", ")}<br>`
          );
        }
      }

      // ── Bloque 3: OC (OV) — o fusión PO/Lote/PS ──────────────────────
      if (fusion.fusionado) {
        const so = item0?.salesOrderLineItem?.salesOrder
        const lineaPO = flags.MostrarLineaPO
          ? `-${Number(line.salesOrderLineNumber ?? 0) * flags.MultiplicadorLineaOC}`
          : ''
        const ov = flags.MostrarOV ? ` (${so?.idInDomain ?? ''})` : ''
        const isPending = /pen/i.test(poName ?? '') || poName === '.'
        const cuerpo = `<b>${fusion.label}: </b>${fusion.valor}${lineaPO}${ov}`
        partes.push(
          isPending
            ? `<span style="color:red; font-size:14pt;">${cuerpo}</span><br>`
            : `${cuerpo}<br>`
        )
      } else if (flags.MostrarPO) {
        const so = item0?.salesOrderLineItem?.salesOrder;
        const soName = so?.name ?? null;
        if (soName) {
          const isPending = /pen/i.test(soName) || soName === ".";
          const lineaPO = flags.MostrarLineaPO
            ? `-${Number(line.salesOrderLineNumber ?? 0) *
                flags.MultiplicadorLineaOC}`
            : "";
          const ov = flags.MostrarOV
            ? ` (${so?.idInDomain ?? ""})`
            : "";

          if (isPending) {
            partes.push(
              `<span style="color:red; font-size:14pt;"><b> OC (OV): ${soName}${lineaPO}${
                flags.MostrarOV ? ov + "</b>" : "</b>"
              }</span><br>`
            );
          } else {
            partes.push(`<b> OC (OV): </b>${soName}${lineaPO}${ov}<br>`);
          }
        }
      }

      // ── Bloque 4: Orden de Trabajo ────────────────────────────────────
      // Por línea (no global). Si varios PAs apuntan a esta línea con
      // distintas OTs, las unimos con coma; dedup por idInDomain.
      if (flags.MostrarOT) {
        const otIds = new Set<string>();
        for (const pa of pasDeLinea) {
          const id = pa?.workOrder?.idInDomain;
          if (id != null) otIds.add(String(id));
        }
        if (otIds.size > 0) {
          partes.push(
            `<b>Orden de Trabajo: </b>${Array.from(otIds).join(", ")}<br>`
          );
        }
      }

      // ── Bloque 5: Lote + PS ───────────────────────────────────────────
      // Por línea, usando el join. Sin parsear "Batch: X" del description.
      // Sufijo Schneider (VM/VE) según el primer lote.
      const fusionConsumioLote = fusion.fusionado
      const psParaMostrar = fusion.fusionado ? fusion.psRestantes : psValsLinea
      if (flags.MostrarLote && lotesDeLinea.length > 0 && !fusionConsumioLote) {
        const nombresLote = lotesDeLinea
          .map((l) => l.name)
          .filter((n): n is string => !!n);

        if (nombresLote.length > 0) {
          let bloque = `<b>Lote: </b>${nombresLote.join(", ")}`;

          // descriptionMarkdown del batch (si hay), igual que el template.
          const descs = lotesDeLinea
            .map((l) => l.descriptionMarkdown)
            .filter((d): d is string => !!d);
          if (descs.length > 0) bloque += ` ${descs.join(", ")}`;

          if (flags.MostrarPS) {
            // Solo agregamos sección PS si hay al menos un PS distinto del
            // nombre del lote (regla "PS===Lote → no repetir").
            // Caso NO fusionado: comportamiento original per-lote (cada PS se
            // compara contra el name de SU propio lote — "PS===Lote → no repetir").
            const psDistintos = Array.from(
              new Set(
                lotesDeLinea
                  .filter(
                    (l) =>
                      l.packingSlip != null &&
                      l.packingSlip !== "" &&
                      String(l.packingSlip) !== (l.name ?? "")
                  )
                  .map((l) => String(l.packingSlip))
              )
            );
            if (psDistintos.length > 0) {
              bloque += ` <b>PS: </b>${psDistintos.join(", ")}`;
            }

            // Sufijo Schneider: VM si el primer lote empieza con "RG-M",
            // VE en cualquier otro caso. Solo para clientes "SCH*".
            if (isSchneider) {
              const primerLoteName = lotesDeLinea[0]?.name ?? "";
              const sufijo =
                primerLoteName.substring(0, 4) === "RG-M" ? "VM" : "VE";
              bloque += ` ${sufijo}`;
            }
          }

          partes.push(bloque);
        }
      } else if (fusionConsumioLote && psParaMostrar.length > 0) {
        partes.push(`<b>PS: </b>${Array.from(new Set(psParaMostrar)).join(', ')}`)
      } else if (!flags.MostrarLote) {
        // Si Mostrar Lote está apagado: fallback al description original
        // (replica el `else` del expression).
        partes.push(line.description ?? "");
      }

      return partes.join("");
    }

    // Helper: HTML del nombre/descripción del NP por línea. Traduce el
    // expression del template que mezcla `name + description + partAccounts::
    // partNumber::description + Acabado (labels)`.
    // - Aterriza `partAccounts.partNumber.*` por línea (no global como el
    //   expression original) usando `paPorLineaMap`.
    // - Dedupea PNs y labels por id (varios PAs por línea suelen apuntar al
    //   mismo PN; sin dedup se duplicaría la descripción).
    // - `partNumber.labels` no está en el typedef de Inputs pero existe en
    //   runtime, por eso el cast a `any`.
    function buildNpHtml(
      il: (typeof inputs.invoiceLines)[number],
      pasDeLinea: any[]
    ): string {
      const line = il?.invoiceLine;
      if (!line) return "";

      const name = line.name ?? "";

      // Si el name viene vacío, no hay nada útil que mostrar — disparamos el
      // mensaje rojo pidiendo configurar al cliente (en cualquier caso, no
      // solo cuando falta DatosFactura). Cubre datos rotos / huérfanos.
      if (!name.trim()) {
        return `<span style="color:red;"><b>Favor de configurar Cliente ${
          customerName || "(sin nombre)"
        } en SH</b></span>`;
      }

      // Fallback cuando el cliente NO tiene DatosFactura: muestra al menos
      // el name del invoice line en negrita para que la celda no quede vacía.
      // (El aviso completo "Favor de configurar DatosFactura..." ya sale en
      // descripcionHtml, así que aquí basta con el name.)
      if (!datosFacturaPresente) {
        return `<b>${name}</b>`;
      }

      // Si el cliente tiene DatosFactura pero decidió apagar MostrarNP
      // intencionalmente → celda vacía (respeta la decisión).
      if (!flags.MostrarNP) return "";

      // Descripciones de PartNumber por línea, dedupeadas por id de PN.
      const pnDescs: string[] = [];
      const seenPnIds = new Set<number>();
      for (const pa of pasDeLinea) {
        const pn = pa?.partNumber;
        if (!pn || seenPnIds.has(pn.id)) continue;
        seenPnIds.add(pn.id);
        if (pn.description) pnDescs.push(pn.description);
      }
      const pnDescStr = pnDescs.join(" ");

      // Labels (Acabado) por línea, dedup por id (fallback a name si no hay).
      const labelNames: string[] = [];
      const seenLabels = new Set<string>();
      for (const pa of pasDeLinea) {
        const pn = pa?.partNumber as any;
        for (const lbl of pn?.labels ?? []) {
          const key = String(lbl?.id ?? lbl?.name ?? "");
          if (!key || seenLabels.has(key)) continue;
          seenLabels.add(key);
          if (lbl?.name) labelNames.push(lbl.name);
        }
      }
      const acabadoStr =
        !flags.MostrarAcabado || labelNames.length === 0
          ? ""
          : `<br><b>Acabado: </b>${labelNames.join(", ")}`;

      return (
        `<b>${name}</b><br>` +
        `${line.description ?? ""} ${pnDescStr}` +
        acabadoStr
      );
    }

    // Forma (b): array enriquecido. Conserva todos los campos originales de
    // `invoiceLine` y agrega:
    //   - `lotes`: array de {batchId, name, packingSlip, descriptionMarkdown}
    //   - `lotesConPsStr`: string "nameLote (PS PS), ..." (omite "(PS X)" si
    //      name===PS o si no hay PS)
    //   - `descripcionHtml`: HTML enriquecido replicando el expression del
    //      template (Producto / Remisión / OC(OV) / OT / Lote+PS).
    //   - `npHtml`: HTML del nombre/descripción del NP (con Acabado opcional).
    const invoiceLinesConLotes = (inputs.invoiceLines ?? []).map((il) => {
      const ln = il?.invoiceLine?.lineNumber ?? null;
      const lotes = ln != null ? lotesPorLineaMap.get(ln) ?? [] : [];
      const pasDeLinea: any[] =
        ln != null ? (paPorLineaMap.get(ln) as any) ?? [] : [];
      return {
        ...il.invoiceLine,
        lotes,
        lotesConPsStr: formatLotesConPs(lotes),
        descripcionHtml: buildDescripcionHtml(il, lotes, pasDeLinea),
        npHtml: buildNpHtml(il, pasDeLinea),
      };
    });

    // ── 4️⃣ Tabla consolidada por Producto (caso Schneider Rojo Gómez) ────
    // Agrupa las líneas por (productName, rateUnits) para clientes que
    // facturan "por producto" en lugar de "por NP". Cada grupo trae una
    // sub-tabla de NPs (los partAccounts que contribuyeron) con conversión
    // de piezas → unidad del producto cuando el PN tiene la conversión.
    //
    // Se expone SIEMPRE, en paralelo a invoiceLinesConLotes. El template
    // decide qué tabla renderizar usando el flag `isSchneiderRojoGomez`
    // (o cualquier otra condición que quiera).

    type SubrowNp = {
      partAccountId: number;
      partNumberId: number | null;
      partNumberName: string | null;
      partNumberDescription: string | null;
      cantidadPiezas: number;
      cantidadEnUnidadProducto: number | null; // null si no hay conversión al rateUnits del grupo
      unidadProducto: string;
      lotes: LoteResumen[];
      lotesNombresStr: string;
      packingSlipsStr: string;
      acabados: string[];
    };

    type LineaConsolidada = {
      productName: string;
      unidadProducto: string;
      cantidadTotal: number;       // suma de invoiceLineItem.quantity (fuente fiable)
      cantidadTotalPiezas: number; // suma de maxInvoicedPartCount de los PAs únicos
      subtotalTotal: number;       // suma de invoiceLineItem.subtotal
      rate: number | null;         // promedio ponderado por cantidad
      npCount: number;
      nps: SubrowNp[];
    };

    // Index PA por id para poder dedupear cuando un mismo PA aparezca vía
    // distintas líneas dentro del mismo grupo (no contar dos veces las piezas).
    type GrupoAcc = {
      productName: string;
      unidadProducto: string;
      cantidadTotal: number;
      subtotalTotal: number;
      // suma ponderada de (rate × quantity) para promedio ponderado al cierre.
      rateWeightedSum: number;
      lineNumbers: Set<number>;
    };
    const gruposMap = new Map<string, GrupoAcc>(); // key = `${productName}||${rateUnits}`

    for (const il of inputs.invoiceLines ?? []) {
      const ln = il?.invoiceLine?.lineNumber;
      if (ln == null) continue;
      for (const item of il.invoiceLine?.invoiceLineItems ?? []) {
        const productName =
          item?.product?.name ??
          item?.salesOrderLineItem?.product?.name ??
          null;
        const rateUnits = item?.rateUnits ?? null;
        if (!productName || !rateUnits) continue; // sin producto o sin unidad no agrupable

        const key = `${productName}||${rateUnits}`;
        if (!gruposMap.has(key)) {
          gruposMap.set(key, {
            productName,
            unidadProducto: rateUnits,
            cantidadTotal: 0,
            subtotalTotal: 0,
            rateWeightedSum: 0,
            lineNumbers: new Set(),
          });
        }
        const g = gruposMap.get(key)!;
        const qty = Number(item?.quantity ?? 0);
        const sub = Number(item?.subtotal ?? 0);
        const r = Number(item?.rate ?? 0);
        g.cantidadTotal += qty;
        g.subtotalTotal += sub;
        g.rateWeightedSum += r * qty;
        g.lineNumbers.add(ln);
      }
    }

    // Helper: factor de conversión de piezas a `unidadTarget` para un PN.
    // unitConversions[].factor = unidades target POR pieza (1 PZ = factor target).
    // Por convención (ver ordendeventa.ts), match exacto del unit.name.
    function factorPiezasA(
      pn: any,
      unidadTarget: string
    ): number | null {
      for (const uc of pn?.unitConversions ?? []) {
        if (uc?.unit?.name === unidadTarget) {
          const f = Number(uc.factor);
          if (!isNaN(f) && f !== 0) return f;
        }
      }
      return null;
    }

    const lineasConsolidadasPorProducto: LineaConsolidada[] = [];

    for (const g of gruposMap.values()) {
      // PAs asociados al grupo: los que apuntan a alguna lineNumber del grupo.
      const pasDelGrupo: any[] = [];
      const seenPaIds = new Set<number>();
      for (const ln of g.lineNumbers) {
        for (const pa of (paPorLineaMap.get(ln) as any) ?? []) {
          if (pa?.id != null && !seenPaIds.has(pa.id)) {
            seenPaIds.add(pa.id);
            pasDelGrupo.push(pa);
          }
        }
      }

      // Subrows: una por PA del grupo.
      const nps: SubrowNp[] = pasDelGrupo.map((pa) => {
        const pn = pa?.partNumber;
        const piezas = Number(pa?.maxInvoicedPartCount ?? 0);
        const factor = pn ? factorPiezasA(pn, g.unidadProducto) : null;
        const cantidadEnUnidad =
          factor != null ? Math.round(piezas * factor * 10000) / 10000 : null;

        // Lotes / PS de este PA (sin filtrar por línea; aquí es agregado
        // por producto). Reusa la misma extracción que el join principal.
        const lotesPa: LoteResumen[] = [];
        const seenBatchIds = new Set<number>();
        for (const batch of pa?.receivedBatches ?? []) {
          if (!batch || seenBatchIds.has(batch.id)) continue;
          seenBatchIds.add(batch.id);
          lotesPa.push({
            batchId: batch.id,
            name: batch.name ?? null,
            packingSlip:
              (batch.customInputs as any)?.DatosRecibo?.PackingSlip ?? null,
            descriptionMarkdown: batch.descriptionMarkdown ?? null,
          });
        }

        // Acabados (labels) del PN. Sin tipo en el typedef → cast a any.
        const acabados: string[] = [];
        const seenLbl = new Set<string>();
        for (const lbl of (pn as any)?.labels ?? []) {
          const key = String(lbl?.id ?? lbl?.name ?? "");
          if (!key || seenLbl.has(key)) continue;
          seenLbl.add(key);
          if (lbl?.name) acabados.push(lbl.name);
        }

        return {
          partAccountId: pa?.id ?? 0,
          partNumberId: pn?.id ?? null,
          partNumberName: pn?.name ?? null,
          partNumberDescription: pn?.description ?? null,
          cantidadPiezas: piezas,
          cantidadEnUnidadProducto: cantidadEnUnidad,
          unidadProducto: g.unidadProducto,
          lotes: lotesPa,
          lotesNombresStr: formatLotesConPs(lotesPa),
          packingSlipsStr: Array.from(
            new Set(
              lotesPa
                .map((l) => l.packingSlip)
                .filter((p) => p != null && p !== "")
                .map((p) => String(p))
            )
          ).join(", "),
          acabados,
        };
      });

      const cantidadTotalPiezas = nps.reduce(
        (acc, n) => acc + (n.cantidadPiezas || 0),
        0
      );
      const rateAvg =
        g.cantidadTotal > 0
          ? Math.round((g.rateWeightedSum / g.cantidadTotal) * 10000) / 10000
          : null;

      lineasConsolidadasPorProducto.push({
        productName: g.productName,
        unidadProducto: g.unidadProducto,
        cantidadTotal: Math.round(g.cantidadTotal * 10000) / 10000,
        cantidadTotalPiezas,
        subtotalTotal: Math.round(g.subtotalTotal * 100) / 100,
        rate: rateAvg,
        npCount: nps.length,
        nps,
      });
    }

    // ── 5️⃣ Payload final hacia el template ───────────────────────────────
    result.additionalPayload = {
      zipCode,
      xmlDecodificado,
      lotesPorLinea,
      invoiceLinesConLotes,
      // Tabla consolidada y flag de sugerencia (no es gating — el template
      // decide). Ambas tablas siempre se exponen en paralelo.
      lineasConsolidadasPorProducto,
      isSchneiderRojoGomez,
      // Flags útiles para que el template decida si renderiza un banner en
      // el header en lugar de (o además de) mostrar el mensaje en cada fila.
      datosFacturaConfigurado: datosFacturaPresente,
      datosFacturaMensajeFaltante: datosFacturaMissingMsg, // null si está OK
    };

    helpers.log(`Extracted zip code: ${zipCode} from Bill To address: ${rawAddress}`);
    helpers.log(`XML (primeros 100 chars): ${xmlDecodificado?.slice(0, 100)}`);
    helpers.log(
      `Lotes asignados a ${lotesPorLineaMap.size} líneas de factura ` +
        `(de ${inputs.invoiceLines?.length ?? 0} totales).`
    );
    helpers.log(
      `Tabla consolidada: ${lineasConsolidadasPorProducto.length} grupos por (producto, unidad). isSchneiderRojoGomez=${isSchneiderRojoGomez}.`
    );
  } catch (error) {
    helpers.addErrorMessage({
      severity: "error",
      message: `Error preparando payload PDF: ${String(error)}`,
    });
  }

  return result;
};


type LowCodeResult = {
  additionalPayload?: any;
};

interface Inputs {
  idInDomain: number | null;
  invoiceTerms: {
    days: number | null;
    discountDays: number | null;
    discountPercent: number | null;
    terms: string;
  };
  paymentLinkUrl: string | null;
  createdAt: string;
  totalPriceUSD: number;
  notes: string;
  location: {
    id: number;
    path: string;
  } | null;
  logoUrl: string | null;
  timezone: string;
  invoicedAt: string;
  invoicedAtAsDate: string;
  dueAt: string;
  dueAtAsDate: string;
  paid: boolean;
  customInputs: {
    [x: string]: any;
  } | null;
  salesTax: {
    id: number;
    name: string | null;
    taxRates: {
      id: number;
      name: string | null;
      percent: number | null;
      salesTaxUSD: number;
    }[];
  } | null;
  salesTaxUSD: number | null;
  customerContact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    isInvoiceContact: boolean | null;
  } | null;
  domain: {
    name: string | null;
    address: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    logoUrl?: (string | undefined) | null;
  } | null;
  billToAddress: {
    address: string | null;
    description: string | null;
    customer: {
      id: number | null;
      name: string | null;
      avatarUrl: string | null;
      shortName: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
    } | null;
  };
  shipToAddress: {
    address: string | null;
  };
  dropShipToAddress: {
    address: string | null;
    customer: {
      id: number | null;
      name: string | null;
      avatarUrl: string | null;
      shortName: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
    } | null;
  };
  completedPartsTransfers: {
    partNumber: {
      id: number;
      name: string;
    } | null;
    partCount: number | null;
    fromPartGroup: {
      id: number;
      name: string;
    } | null;
    fromLocation: {
      id: number;
      path: string;
    } | null;
  }[] | null;
  shipVia: string | null;
  shipDate: string | null;
  shipDateAsDate: string | null;
  partAccounts: {
    id: number;
    invoiceLineNumbers: {
      line: number;
    }[];
    maxInvoicedPartCount: number;
    partNumber: {
      id: number;
      name: string | null;
      description: string | null;
      customerFacingNotes: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      unitConversions: {
        unit: {
          id: number;
          name: string;
        };
        factor: number;
      }[];
    } | null;
    partGroup: {
      id: number;
      name: string | null;
    } | null;
    qualityHold: {
      id: number;
      descriptionMarkdown: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      markForScrap: boolean | null;
    } | null;
    packingSlip: {
      idInDomain: number | null;
      createdAt: string | null;
      shipVia: string | null;
      shipMethod: string | null;
      trackingNumber: string | null;
      shipToAddress: string | null;
      signedAt: string | null;
    } | null;
    billOfLading: {
      idInDomain: number | null;
      createdAt: string | null;
      signedAt: string | null;
      carrier: {
        id: number | null;
        name: string | null;
      };
    } | null;
    currentRecipeNode: {
      treatment: {
        id: number;
        name: string | null;
      } | null;
    } | null;
    invoiceDescriptionTreatments: {
      treatment: {
        id: number;
        name: string | null;
        treatmentGroup: {
          id: number;
          name: string | null;
        } | null;
      } | null;
      process: {
        id: number | null;
        name: string | null;
      } | null;
    }[];
    workOrder: {
      idInDomain: number | null;
      createdAt: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      recipe: {
        name: string | null;
      } | null;
      salesOrder: {
        idInDomain: number | null;
        name: string | null;
      } | null;
    } | null;
    certReports: {
      id: number;
      idInDomain: number | null;
    }[] | null;
    receivedBatches: {
      id: number;
      name: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      descriptionMarkdown: string | null;
      partNumberOnBatch: {
        id: number;
        name: string | null;
      } | null;
    }[];
  }[];
  invoiceLines: {
    invoiceLine: {
      sumAssociatedParts: number | null;
      rate: number | null;
      quantity: number | null;
      unit: string | null;
      id: number;
      name: string | null;
      description: string | null;
      totalPrice: number | null;
      lineNumber: number | null;
      salesOrderLineNumber: string | null;
      salesOrderName: string | null;
      salesOrderIdInDomain: number | null;
      invoiceLineItems: {
        id: number;
        quantity: number | null;
        rate: number | null;
        rateUnits: string | null;
        subtotal: number | null;
        description: string | null;
        product: {
          id: number;
          name: string | null;
          productGroup: {
            id: number;
            name: string | null;
          } | null;
        } | null;
        referencedPartAccounts: {
          id: number;
          packingSlip: {
            idInDomain: number | null;
          } | null;
          billOfLading: {
            idInDomain: number | null;
          } | null;
        }[];
        salesOrderLineItem: {
          description: string | null;
          product: {
            name: string;
          } | null;
          salesOrder: {
            idInDomain: number | null;
            name: string | null;
            customInputs: {
              [x: string]: any;
            } | null;
            files: {
              url: string | null;
            }[];
          } | null;
          pricecents: number | null;
          priceByPriceId: {
            name: string | null;
            type: string | null;
            valueUnits: string | null;
            rateUnits: string | null;
          } | null;
          lineTaxesUSD: number | null;
          salesOrderLineItemPartTransforms: {
            id: number;
            salesOrderPartTransform: {
              id: number;
              count: number | null;
              partNumberWorkOrders: ({
                id: number;
                partNumber: {
                  id: number;
                  name: string | null;
                  descriptionMarkdown: string | null;
                  certificationComment: string | null;
                  customerFacingNotes: string | null;
                  customInputs: {
                    [x: string]: any;
                  } | null;
                } | null;
                secondaryLabel: {
                  id: number;
                  name: string | null;
                } | null;
                workOrder: {
                  id: number;
                  idInDomain: number | null;
                  name: string | null;
                  recipe: {
                    id: number | null;
                    name: string | null;
                    description: string | null;
                    process: {
                      id: number | null;
                      name: string | null;
                      description: string | null;
                    } | null;
                  } | null;
                } | null;
                treatments: {
                  treatment: {
                    name: string;
                    inventoryItems: {
                      id: number;
                      name: string;
                      customInputs: {
                        [x: string]: any;
                      } | null;
                      descriptionMarkdown: string | null;
                      inventoryItemVendors: {
                        vendorItemName: string | null;
                      }[] | null;
                    }[];
                  } | null;
                  process: {
                    id: number | null;
                    name: string;
                  } | null;
                  isOverride: boolean;
                }[];
                invoiceDescriptionTreatments: {
                  treatment: {
                    id: number;
                    name: string | null;
                    treatmentGroup: {
                      id: number;
                      name: string | null;
                    } | null;
                  } | null;
                  process: {
                    id: number | null;
                    name: string | null;
                  } | null;
                }[];
                descriptionMarkdown: string | null;
              } | null)[];
            } | null;
          }[];
        } | null;
      }[];
    };
  }[];
  workOrderItems: {
    description: string | null;
    workOrder: {
      idInDomain: number | null;
      name: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      salesOrder: {
        idInDomain: number | null;
        name: string | null;
      } | null;
    } | null;
    receivedBatches: {
      id: number;
      name: string | null;
      customInputs: {
        [x: string]: any;
      } | null;
      descriptionMarkdown: string | null;
      partNumberOnBatch: {
        id: number;
        name: string | null;
      } | null;
    }[];
  }[];
  createWriteResult: {
    data: {
      result: {
        writeResult: {
          XmlBase64File: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
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
