// ===============================================================
// importFile FINAL — Plantilla v7.1
// ===============================================================
// Crea Quote Lines con: Part Number, proceso, descripción.
// Products, Divisa, Labels, Specs, UnitConv, RackTypes → bookmarklet.
//
// Parser: no depende de "Parts List" ni de skipRows.
// Detecta header keys por nombre (col A) y data rows por contenido
// (col A numérico + col B no vacío). Todo lo demás se ignora.
// Compatible con v6 (inglés) y v7.1 (español, 32 cols)...
// ===============================================================

const normalize = (s: any) =>
  String(s ?? "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");

const toNumber = (v: any) => {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  let cleaned = s.replace(/ /g, "");
  const hasDot = cleaned.includes(".");
  const hasComma = cleaned.includes(",");
  if (hasComma && !hasDot) cleaned = cleaned.replace(/,/g, ".");
  if (hasComma && hasDot) cleaned = cleaned.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

const makeUuid = () =>
  `lc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function CSVtoArray(text: string): string[] | null {
  var re_valid =
    /^\s*(?:'[^'\\]*(?:\\[\S\s][^'\\]*)*'|"[^"\\]*(?:(?:"")?[^"\\]*)*"|[^,'"\s\\]*(?:\s+[^,'"\s\\]+)*)\s*(?:,\s*(?:'[^'\\]*(?:\\[\S\s][^'\\]*)*'|"[^"\\]*(?:(?:"")?[^"\\]*)*"|[^,'"\s\\]*(?:\s+[^,'"\s\\]+)*)\s*)*$/;
  var re_value =
    /(?!\s*$)\s*(?:'([^'\\]*(?:\\[\S\s][^'\\]*)*)'|"((?:[^"\\]|\\.|"")*)"|([^,'"\s\\]*(?:\s+[^,'"\s\\]+)*))\s*(?:,|$)/g;
  if (!re_valid.test(text)) return null;
  var a: string[] = [];
  text.replace(re_value, function (m0, m1, m2, m3) {
    if (m1 !== undefined) a.push(m1.replace(/\\'/g, "'"));
    else if (m2 !== undefined) a.push(m2.replace(/\\"/g, '"').replace(/""/g, '"'));
    else if (m3 !== undefined) a.push(m3);
    return "";
  });
  if (/,\s*$/.test(text)) a.push("");
  return a;
}

const importFile = (inputs: any, helpers: any): any => {
  const quote: any[] = [];

  try {
    const fileContents = inputs.fileContents ?? "";
    // Fix UTF-8 bytes leídos como Latin-1 por Steelhead
    let fixedContents = fileContents;
    if (fileContents.includes("\u00C3")) {
      let out = "";
      for (let i = 0; i < fileContents.length; i++) {
        const c = fileContents.charCodeAt(i);
        if (c === 0xC3 && i + 1 < fileContents.length) {
          const n = fileContents.charCodeAt(i + 1);
          if (n >= 0x80 && n <= 0xBF) { out += String.fromCharCode(((c & 0x1F) << 6) | (n & 0x3F)); i++; continue; }
        }
        if (c === 0xC2 && i + 1 < fileContents.length) {
          const n = fileContents.charCodeAt(i + 1);
          if (n >= 0x80 && n <= 0xBF) { out += String.fromCharCode(n); i++; continue; }
        }
        if (c === 0xC5 && i + 1 < fileContents.length) {
          const n = fileContents.charCodeAt(i + 1);
          if (n >= 0x80 && n <= 0xBF) { out += String.fromCharCode(((c & 0x1F) << 6) | (n & 0x3F)); i++; continue; }
        }
        out += fileContents.charAt(i);
      }
      fixedContents = out;
      helpers.log("[encoding] UTF-8→Latin-1 fix aplicado");
    }
    const fileLines = fixedContents.split(/\r?\n/);

    let quoteName = (inputs.fileName ?? "").replace(/\.[^.]+$/, "");
    let customerName = "";
    let customerIdInDomainDirect: number | null = null;
    let defaultProcessName = "";
    let defaultProcessId: number | null = null;

    interface PartData {
      qty: number; name: string; description: string;
      price: number; processNameLine: string; processIdLine: number | null;
    }

    const parts: PartData[] = [];

    const KEY_MAP: Record<string, string> = {
      "quote name:": "quoteName",
      "nombre cotización:": "quoteName",
      "nombre cotizacion:": "quoteName",
      "customer:": "customer",
      "cliente:": "customer",
      "customer idindomain:": "customerId",
      "process (default):": "processName",
      "proceso (default):": "processName",
      "process id (default):": "processId",
      "id proceso (default):": "processId",
    };

    for (const line of fileLines) {
      let normalizedLine = line;
      const semi = (line.match(/;/g) || []).length;
      const comma = (line.match(/,/g) || []).length;
      if (semi > comma) normalizedLine = line.replace(/;/g, ",");
      const rawEntries = CSVtoArray(normalizedLine);
      if (!rawEntries) continue;
      const entries: string[] = rawEntries;

      const col0 = (entries[0] ?? "").trim();
      const col1 = (entries[1] ?? "").trim();

      // ── TRY HEADER KEY ──
      const key = col0.toLowerCase();
      const valC = (entries[2] ?? "").trim();
      const valB = (entries[1] ?? "").trim();
      const val = valC || valB;

      const mapped = KEY_MAP[key];
      if (mapped === "quoteName" && val) { quoteName = val; continue; }
      if (mapped === "customer" && val) { customerName = val; continue; }
      if (mapped === "customerId") { const n = toNumber(val); customerIdInDomainDirect = n || null; continue; }
      if (mapped === "processName" && val) { defaultProcessName = val; continue; }
      if (mapped === "processId") { const n = toNumber(val); defaultProcessId = n || null; continue; }

      // ── TRY DATA ROW ──
      if (col0 !== "" && col1 !== "" && !isNaN(Number(col0))) {
        parts.push({
          qty: toNumber(entries[0]),
          name: col1,
          description: (entries[3] ?? "").trim(),
          price: toNumber(entries[2]),
          processNameLine: (entries[4] ?? "").trim(),
          processIdLine: toNumber(entries[5]) || null,
        });
      }
    }

    if (parts.length === 0) {
      throw Error("No se encontraron partes válidas en el CSV.");
    }

    // ── CUSTOMER ──
    const customers = inputs.additionalData?.customerIds ?? [];
    let customerObj: any = null;

    const customerCleanName = customerName.includes("\u2014")
      ? customerName.split("\u2014")[0].trim()
      : customerName.includes(" — ")
        ? customerName.split(" — ")[0].trim()
        : customerName;

    if (customerIdInDomainDirect) {
      customerObj = customers.find((c: any) =>
        Number(c.idInDomain) === customerIdInDomainDirect);
    }
    if (!customerObj && customerCleanName) {
      customerObj = customers.find((c: any) =>
        normalize(c.name) === normalize(customerCleanName));
    }
    if (!customerObj) {
      const sample = customers.slice(0, 20)
        .map((c: any) => `${c.idInDomain}:${c.name}`).join(" | ");
      throw Error(
        `Customer no encontrado. IdInDomain="${customerIdInDomainDirect ?? ""}" ` +
        `Name="${customerCleanName}". Primeros 20: ${sample}`
      );
    }
    const customerId = customerObj.id;

    // ── PROCESS DEFAULT ──
    const processes = inputs.additionalData?.processes ?? [];
    let defaultProcess: any = null;
    if (defaultProcessId)
      defaultProcess = processes.find((p: any) =>
        Number(p.id) === Number(defaultProcessId)) ?? null;
    if (!defaultProcess && defaultProcessName)
      defaultProcess = processes.find((p: any) =>
        normalize(p.name) === normalize(defaultProcessName)) ?? null;

    // ── EXISTING PART NUMBERS ──
    const existingPartNumbers = inputs.additionalData?.partNumbers ?? [];
    const existingNames = new Set(
      existingPartNumbers.map((pn: any) => normalize(pn.name))
    );

    // ── BUILD PART LINES ──
    const partLines: any[] = parts.map((part, i) => {
      let lineProcess: any = null;
      if (part.processIdLine)
        lineProcess = processes.find((p: any) =>
          Number(p.id) === Number(part.processIdLine)) ?? null;
      if (!lineProcess && part.processNameLine)
        lineProcess = processes.find((p: any) =>
          normalize(p.name) === normalize(part.processNameLine)) ?? null;
      if (!lineProcess && defaultProcess)
        lineProcess = defaultProcess;

      let needsUuid = false;
      if (existingPartNumbers.length > 0 && lineProcess) {
        const normName = normalize(part.name);
        const matches = existingPartNumbers.filter((pn: any) =>
          normalize(pn.name) === normName &&
          (Number(pn.customerId) === Number(customerId) || !pn.customerId));
        if (matches.length > 0 && !matches.some((pn: any) =>
          Number(pn.defaultProcessNodeId) === Number(lineProcess.id)))
          needsUuid = true;
      }

      return {
        microQuantity: part.qty * 1e6,
        name: part.name,
        description: part.description,
        lineNumber: i + 1,
        priceMicrodollars: part.price * 1e6,
        ...(lineProcess
          ? { processId: lineProcess.id }
          : { usePartNumberProcessDefaults: true }),
        newPartNumber: {
          name: part.name,
          customerId,
          descriptionMarkdown: part.description || null,
          ...(lineProcess ? { defaultProcessNodeId: lineProcess.id } : {}),
          ...(needsUuid ? { uuid: makeUuid() } : {}),
        },
      };
    });

    // ── STATS & LOG ──
    const newParts = partLines.filter((l: any) => !existingNames.has(normalize(l.name)));
    const existingParts = partLines.filter((l: any) => existingNames.has(normalize(l.name)));
    const withProcess = partLines.filter((l: any) => l.processId).length;

    quote.push({ name: quoteName, customerId, partLines });

    helpers.log(
      `[importFile v7.1] Quote "${quoteName}" → ${partLines.length} líneas, ` +
      `${withProcess} con proceso. ` +
      `${newParts.length} NUEVOS, ${existingParts.length} EXISTENTES.`
    );
    if (newParts.length > 0) {
      helpers.log(`  ── Nuevos (${newParts.length}) ──`);
      for (const pl of newParts.slice(0, 20))
        helpers.log(`    + ${pl.name} $${(pl.priceMicrodollars / 1e6).toFixed(2)}`);
      if (newParts.length > 20) helpers.log(`    ... y ${newParts.length - 20} más`);
    }
    if (existingParts.length > 0) {
      helpers.log(`  ── Existentes (${existingParts.length}) ──`);
      for (const pl of existingParts.slice(0, 20))
        helpers.log(`    ✓ ${pl.name} $${(pl.priceMicrodollars / 1e6).toFixed(2)}`);
      if (existingParts.length > 20) helpers.log(`    ... y ${existingParts.length - 20} más`);
    }
  } catch (err) {
    helpers.log(err);
    console.log(err);
  }

  return quote;
};