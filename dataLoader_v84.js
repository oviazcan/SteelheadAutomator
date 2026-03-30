// dataLoader_v84.js — Steelhead Data Loader v8.4 (Fase 1: modo COTIZACIÓN)
// Layout CSV v8.3: 61 cols (A-BI), header key-value + data rows
// Fix: SaveManyPNP no acepta newPartNumber; PNs nuevos se crean primero via SavePartNumber

(async () => {
  const VER = '8.4';
  const LOG = `[DL${VER}]`;
  const _log = [];
  const log = (m) => { const s = `${LOG} ${m}`; console.log(s); _log.push(s); };
  const warn = (m) => { const s = `${LOG} WARN: ${m}`; console.warn(s); _log.push(s); };
  const err = (m) => { const s = `${LOG} ERROR: ${m}`; console.error(s); _log.push(s); throw new Error(m); };

  // ═══════════════════════════════════════════
  // 1. CONSTANTS
  // ═══════════════════════════════════════════

  const DOMAIN = {
    id: 344, inputSchemaId_PN: 3456, inputSchemaId_Quote: 659,
    stagesRevisionId: 306, geometryGenericaId: 831, unitMTR: 3971,
    unitIds: { KGM:3969, LBR:3972, FTK:4797, CMK:4907, FOT:5148, LM:5150, LO:5348 },
    conversions: { KGM_TO_LBR:2.20462, CMK_TO_FTK:1/929.0304, LM_TO_FOT:3.28084 },
    geomDims: { LENGTH:1284, WIDTH:1011, HEIGHT:1012, OUTER_DIAM:1013, INNER_DIAM:1014 },
    empresas: {
      ECO:'ECO030618BR4 - ECOPLATING SA DE CV, Primero de Mayo 1803, Zona Industrial Toluca, Santa Ana Tlapaltitlán Toluca, Estado de México 50071 México',
      PRO:'PRO800417TDA - PROQUIPA SA DE CV, Primero de Mayo 1801, Zona Industrial Toluca, Santa Ana Tlapaltitlán Toluca, Estado de México 50071 México',
    },
    defaultQuoteCI: {
      Comentarios:{CargosFletes:true,CotizacionSujetaPruebas:true,ReferirNumeroCotizacion:true,ModificacionRequiereRecotizar:true},
      DatosAdicionales:{Divisa:'USD',Decimales:'2',EmpresaEmisora:'',MostrarProceso:false,MostrarTotales:true},
      Autorizacion:{}, CondicionesComerciales:{},
    },
    validacionProcessNodeId: 231176,
  };

  const H = {
    CreateQuote:'ee313e1243e786915d564eee8b005f0a0c2d39525b76467ece84b6debaa3d129',
    UpdateQuote:'765fc26af87241f0f614a51fe3583e10d2f1765dafb1426402f69dcc79e33a8e',
    SaveQuoteLines:'b227e2f5a5b40021383077e58ab311169da2d5438d566bfe389fd7642e4d1937',
    CreateQuoteStageChange:'85c945f12f3367a132607ab1ae22d1e3a8a43d78b836c564840d4251f66e4797',
    SaveManyPNP_Quote:'af7b81567691854da4b9bbdf473b2732d89e3e6224ba52cbfb3d13dbfa93841b',
    SaveManyPNP_PN:'bd2db06e8e0b0a66cb65ada5b5433d9c5abe981b4aee4b39b86be4bba077cd05',
    SavePartNumber:'31a6c7d99c525979acea562cc892fa0968b439f10c79341f4de8748cc4a6cce9',
    SavePartNumberRackTypes:'087af4e8b489edc1c6ade599da96f368fc3a764f2f16093feae9c57ee81cb363',
    SetPNPricesDefault:'9f89b40ef7d5754e8e94a94b028ce4c54c3cbf53a102098fd4d3cbec28c9e293',
    UpdatePartNumber:'af584fa8ebb7487fc84de18fa3a5e360e99699a3280185fe98b840c157bbf2c7',
    GetQuote_v8:'15db7a9b0325c45c181d7be61e223d1dbede8179433a25db36ebc9699097acb6',
    GetQuote_v71:'083046b3bca84f1bc8039145b40bdb10625194735ff18ce0c3815d83600ecd99',
    GetQuoteRelatedData:'04cc75ea43a2860a31e3f5043bb00e83d4c67a8b49b1d86c59cf65b72583f480',
    AllLabels:'2b16b142d01daddf7cf4b29efc7754161a414afdd22630daa6494d894aa3073c',
    SearchSpecsForSelect:'8e7723b3a4cf3e7b692999e45d20b7299952253089c7bf146d36ff2872507e2b',
    TempSpecFieldsAndOptions:'c881d971a4c9fcd3849129e27fcc21546ad8eca732f6248ea523c3fbd89502ea',
    AllRackTypes:'7d601c396bb27a5534424582bcc9e44262781414cbb3e60c09413922775eaef3',
    SearchUnits:'b0750f8a59b649944906b1a6275bfbe562b3eb79836292807f760b3b5b425428',
    SearchProducts:'b835021eff4113acd5529f63fa742a9b70373c62a5d9cb39f4203fe2bbba9f8a',
    SearchUsers:'6a422f35513d85386355f874c14cfb5d80ab38f46210e54c4d3a56ba764ddaa3',
    CustomerSearchByName:'c06fb4c3b770a89c02d00ac51b92be6e1efe98bf5f6f5caccfe753f0570e6f02',
    AllProcesses:'b66651f7c159e7fdef35d67fe27048ea68f1f206531a31256fc8663f52707092',
    SearchPartNumbers:'63ba50ed71fbf40476f1844b841351766eefbb147613b51b33919b4f4b2d4d91',
    PNCreatableSelect:'723dbb599905cf895d306707fc01ed232486ad8190b1cf2649166f57b137d83f',
    PNGroupSelect:'da00a1e356e8a3d1e1020fd64c0b6b26f989650a2d4177fb5485629b11ef7e4c',
    CreatePNGroup:'81edc50920e0ab37d470720a29160d74c6856aea6498b02543707dedfc405202',
    SearchInvoiceTerms:'26f2915bfe50e633829a1d85f58ff6578a31c2e22901094d2a92a9a71e222dca',
    CustomerFinancial:'7ea934f4e057c922f5ea1fbf832fd5b301a34784efc563e964abe4467689d1b9',
  };

  const DIVISA_SCHEMA = {type:"object",title:"",required:["DatosPrecio"],properties:{DatosPrecio:{type:"object",title:"Datos del Precio",required:["Divisa"],properties:{Divisa:{enum:["USD","MXN"],type:"string",title:"Divisa",enumNames:["USD - Dolar americano","MXN - Peso mexicano"]}},dependencies:{}}},dependencies:{}};
  const DIVISA_UI = {"ui:order":["DatosPrecio"],DatosPrecio:{"ui:order":["Divisa"],Divisa:{"ui:title":"Divisa"}}};

  const PREDICTIVE_MATERIALS = [
    { col: 51, inventoryItemId: 364506, name: 'Plata Fina' },
    { col: 52, inventoryItemId: 397490, name: 'Estaño Puro' },
    { col: 53, inventoryItemId: 412305, name: 'Níquel Metálico' },
    { col: 54, inventoryItemId: 412805, name: 'Zinc Metálico' },
    { col: 55, inventoryItemId: 412479, name: 'Placa de Cobre Electrolítico' },
    { col: 56, inventoryItemId: 412723, name: 'Sterlingshield S (Antitarnish)' },
    { col: 57, inventoryItemId: 702767, name: 'Epoxy MT' },
    { col: 58, inventoryItemId: 702769, name: 'Epoxica BT' },
    { col: 59, inventoryItemId: 702768, name: 'Epoxica MT Red' },
  ];

  const PRICE_UNIT_MAP = { PZA:null, KGM:3969, CMK:4907, FTK:4797, LM:5150, LBR:3972, LO:5348 };

  // ═══════════════════════════════════════════
  // 2. UTILITIES
  // ═══════════════════════════════════════════

  const numVal = (v) => typeof v === 'object' && v?.float !== undefined ? (v.float ?? 0) : (v ?? 0);
  const toBool = (v) => { const s = (v||'').toString().trim().toUpperCase(); return s==='SI'||s==='SÍ'||s==='YES'||s==='1'||s==='TRUE'; };
  const isoDate = (d) => { const dt = new Date(); dt.setDate(dt.getDate()+d); return dt.toISOString(); };
  const g = (row, i) => (row[i]||'').trim();
  const gn = (row, i) => { const v = parseFloat(g(row,i)); return isNaN(v)?null:v; };

  function parseCSV(t) {
    const rows=[]; let i=0;
    while(i<t.length){const row=[];while(i<t.length){if(t[i]==='"'){i++;let v='';while(i<t.length){if(t[i]==='"'){if(t[i+1]==='"'){v+='"';i+=2}else{i++;break}}else{v+=t[i];i++}}row.push(v)}else{let v='';while(i<t.length&&t[i]!==','&&t[i]!=='\r'&&t[i]!=='\n'){v+=t[i];i++}row.push(v)}if(t[i]===','){i++;continue}else break}if(t[i]==='\r')i++;if(t[i]==='\n')i++;rows.push(row)}return rows;
  }
  function pickFile(){return new Promise(res=>{const inp=document.createElement('input');inp.type='file';inp.accept='.csv';inp.onchange=()=>{const f=inp.files[0];if(!f){res(null);return}const r=new FileReader();r.onload=()=>res(r.result);r.readAsText(f,'UTF-8')};inp.click()})}

  // ═══════════════════════════════════════════
  // 3. GRAPHQL
  // ═══════════════════════════════════════════

  async function gql(op, hash, vars) {
    const r = await fetch('/graphql',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({operationName:op,variables:vars,extensions:{clientLibrary:{name:"@apollo/client",version:"4.0.8"},persistedQuery:{version:1,sha256Hash:hash}}})});
    if(!r.ok) err(`GraphQL ${r.status}: ${await r.text()}`);
    const json = await r.json();
    if(json.errors&&!json.data) err(`GraphQL errors (${op}): ${JSON.stringify(json.errors).substring(0,300)}`);
    if(json.errors) warn(`GraphQL warnings (${op}): ${json.errors.map(e=>e.message).join('; ')}`);
    return json.data;
  }
  async function gqlFallback(op, hashA, hashB, vars) {
    try { const data = await gql(op, hashA, vars); log(`  ${op}: hash A OK`); return {data,usedHash:'A'}; }
    catch(e) { warn(`${op}: hash A fallo, intentando B...`); const data = await gql(op, hashB, vars); log(`  ${op}: hash B OK`); return {data,usedHash:'B'}; }
  }

  // ═══════════════════════════════════════════
  // 4. CSV PARSER v8.2 — 59 cols
  // ═══════════════════════════════════════════

  const HEADER_KEYS = {
    'modo':'modo',
    'nombre cotizacion':'quoteName','nombre cotización':'quoteName',
    'cliente':'customer',
    'etiquetas cliente':'customerLabels',
    'customer idindomain':'customerIdInDomain',
    'proceso (default)':'processName',
    'id proceso (default)':'processId',
    'divisa (precios linea)':'divisaLinea','divisa (precios línea)':'divisaLinea',
    'empresa emisora':'empresaEmisora',
    'divisa cotizacion':'divisaCotizacion','divisa cotización':'divisaCotizacion',
    'notas externas':'notasExternas',
    'notas internas':'notasInternas',
    'asignado':'asignado',
    'valida hasta (dias)':'validaDias','válida hasta (días)':'validaDias',
  };

  function parseV82(rows) {
    const header = {};
    const parts = [];
    for (const row of rows) {
      const colA = (row[0]||'').trim();
      const keyNorm = colA.replace(/:$/,'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const keyAcc = colA.replace(/:$/,'').trim().toLowerCase();
      const hk = HEADER_KEYS[keyAcc] || HEADER_KEYS[keyNorm];
      if (hk) { header[hk] = (row[2]||'').trim(); continue; }

      // v8.2: PN is in col E (index 4), qty in col H (index 7)
      const pn = g(row, 4);
      const qty = gn(row, 7);
      if (!pn || qty === null) continue;

      // PARÁMETROS (0-3)
      const archivado = toBool(g(row, 0));
      const validacion1er = toBool(g(row, 1));
      const forzarDuplicado = toBool(g(row, 2));
      const archivarAnterior = toBool(g(row, 3));

      // IDENTIFICACIÓN (4-11)
      const pnAlterno = g(row, 5);
      const pnGroup = g(row, 6);
      const precio = gn(row, 8);
      const unidadPrecio = g(row, 9).toUpperCase();
      const precioDefault = toBool(g(row, 10));
      const descripcion = g(row, 11);

      // ACABADOS (12-16)
      const metalBase = g(row, 12);
      const labels = [g(row,13), g(row,14), g(row,15), g(row,16)].filter(Boolean);

      // PROCESO (17-18)
      const procesoOverride = g(row, 17);
      const processIdOverride = gn(row, 18);

      // PRODUCTOS (19-30, 3×4)
      const products = [];
      for (const b of [19, 23, 27]) {
        const nm = g(row, b);
        if (nm) products.push({name:nm, price:gn(row,b+1)||0, qty:gn(row,b+2)||1, unit:g(row,b+3)});
      }

      // SPECS (31-34: spec1, esp1, spec2, esp2)
      const specs = [];
      for (const [specIdx, espIdx] of [[31,32],[33,34]]) {
        const raw = g(row, specIdx);
        if (!raw) continue;
        if (raw.includes(' | ')) { const s=raw.indexOf(' | '); specs.push({name:raw.substring(0,s).trim(),param:raw.substring(s+3).trim()}); }
        else specs.push({name:raw,param:''});
      }

      // CONV UNIDADES (35-38)
      const unitConv = { kgm:gn(row,35), cmk:gn(row,36), lm:gn(row,37), minPzasLote:gn(row,38) };

      // RACKS (39-42)
      const racks = [];
      if (g(row,39)) racks.push({name:g(row,39), ppr:gn(row,40)});
      if (g(row,41)) racks.push({name:g(row,41), ppr:gn(row,42)});

      // DIMENSIONES (43-47)
      const dims = { length:gn(row,43), width:gn(row,44), height:gn(row,45), outerDiam:gn(row,46), innerDiam:gn(row,47) };

      // ASIGNACIÓN CONTABLE (48-50)
      const codigoSAT = g(row, 50);

      // PREDICTIVE USAGE (49-57)
      const predictiveUsage = [];
      for (const mat of PREDICTIVE_MATERIALS) {
        const val = gn(row, mat.col);
        if (val !== null && val > 0) predictiveUsage.push({inventoryItemId:mat.inventoryItemId, usagePerPart:String(val), name:mat.name});
      }

      parts.push({
        pn, qty, precio, descripcion, procesoOverride, processIdOverride,
        labels, products, specs, unitConv, racks, dims,
        metalBase, pnAlterno, codigoSAT, pnGroup,
        archivado, precioDefault, forzarDuplicado, archivarAnterior,
        unidadPrecio, predictiveUsage, validacion1er,
      });
    }
    return { header, parts };
  }

  // ═══════════════════════════════════════════
  // 5. MODAL UI (same as v8.0, compact)
  // ═══════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('dl8-styles')) return;
    const s = document.createElement('style'); s.id = 'dl8-styles';
    s.textContent = `.dl8-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.dl8-modal{background:#1e293b;color:#e2e8f0;border-radius:12px;padding:28px 32px;max-width:720px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,0.5)}.dl8-modal h2{font-size:20px;margin:0 0 4px;color:#38bdf8}.dl8-modal h3{font-size:14px;margin:16px 0 6px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}.dl8-modal .dl8-sub{color:#64748b;font-size:13px;margin-bottom:16px}.dl8-modal table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}.dl8-modal th{text-align:left;padding:4px 8px;color:#94a3b8;border-bottom:1px solid #334155;font-weight:500}.dl8-modal td{padding:4px 8px;border-bottom:1px solid #1e293b}.dl8-new{color:#4ade80}.dl8-exist{color:#facc15}.dl8-dup{color:#f97316}.dl8-err{color:#f87171}.dl8-btnrow{display:flex;gap:12px;margin-top:20px;justify-content:flex-end}.dl8-btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity 0.2s}.dl8-btn:hover{opacity:0.85}.dl8-btn-cancel{background:#475569;color:#e2e8f0}.dl8-btn-exec{background:#2563eb;color:white}.dl8-btn-close{background:#475569;color:#e2e8f0}.dl8-btn-copy{background:#0d9488;color:white}.dl8-progress{font-size:13px;color:#94a3b8;margin-top:8px;white-space:pre-wrap;line-height:1.6}.dl8-bar{height:4px;background:#334155;border-radius:2px;margin:8px 0;overflow:hidden}.dl8-bar-fill{height:100%;background:#2563eb;transition:width 0.3s;width:0%}.dl8-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}.dl8-stat{background:#0f172a;padding:8px 12px;border-radius:6px;font-size:13px}.dl8-stat b{color:#38bdf8}`;
    document.head.appendChild(s);
  }
  function createOverlay(){const ov=document.createElement('div');ov.className='dl8-overlay';const md=document.createElement('div');md.className='dl8-modal';ov.appendChild(md);document.body.appendChild(ov);return{overlay:ov,modal:md}}
  function removeOverlay(ov){if(ov?.parentNode)ov.parentNode.removeChild(ov)}

  function showPreview(header,parts,pnStatus,info){
    return new Promise(resolve=>{
      injectStyles();const{overlay,modal}=createOverlay();
      const nc=pnStatus.filter(s=>s.status==='new').length, ec=pnStatus.filter(s=>s.status==='existing').length, dc=pnStatus.filter(s=>s.status==='forceDup').length;
      let pnR='';for(const s of pnStatus){const cls=s.status==='new'?'dl8-new':s.status==='existing'?'dl8-exist':'dl8-dup';const lbl=s.status==='new'?'NUEVO':s.status==='existing'?`EXISTE (${s.existingId})`:`DUPLICAR (viejo:${s.existingId})`;pnR+=`<tr><td>${s.pn}</td><td class="${cls}">${lbl}</td><td>${s.qty}</td><td>${s.precio??'-'}</td></tr>`}
      modal.innerHTML=`<h2>Data Loader v${VER} - Preview</h2><p class="dl8-sub">Modo: ${header.modo||'COTIZACIÓN+NP'}</p><div class="dl8-stats"><div class="dl8-stat"><b>Cotización:</b> ${header.quoteName||'?'}</div><div class="dl8-stat"><b>Cliente:</b> ${info.customerName||'?'}</div><div class="dl8-stat"><b>Asignado:</b> ${info.assigneeName||'(auto)'}</div><div class="dl8-stat"><b>Proceso:</b> ${info.processName||'?'}</div><div class="dl8-stat"><b>Divisa:</b> ${header.divisaLinea||'USD'}</div><div class="dl8-stat"><b>Empresa:</b> ${header.empresaEmisora||'ECO'}</div></div><h3>Part Numbers (${parts.length}): ${nc} nuevos, ${ec} existentes, ${dc} forzar dup</h3><div style="max-height:200px;overflow-y:auto"><table><tr><th>PN</th><th>Status</th><th>Qty</th><th>Precio</th></tr>${pnR}</table></div><div class="dl8-btnrow"><button class="dl8-btn dl8-btn-cancel" id="dl8-cancel">CANCELAR</button><button class="dl8-btn dl8-btn-exec" id="dl8-exec">EJECUTAR (${parts.length} PNs)</button></div>`;
      document.getElementById('dl8-cancel').onclick=()=>{removeOverlay(overlay);resolve(false)};
      document.getElementById('dl8-exec').onclick=()=>{removeOverlay(overlay);resolve(true)};
    });
  }
  function showProgress(msg){let ov=document.getElementById('dl8-progress-overlay');if(!ov){injectStyles();ov=document.createElement('div');ov.className='dl8-overlay';ov.id='dl8-progress-overlay';ov.innerHTML=`<div class="dl8-modal"><h2>Ejecutando...</h2><div class="dl8-bar"><div class="dl8-bar-fill" id="dl8-bar"></div></div><div class="dl8-progress" id="dl8-progress-text"></div></div>`;document.body.appendChild(ov)}const el=document.getElementById('dl8-progress-text');if(el)el.textContent+=msg+'\n'}
  function setProgressBar(p){const b=document.getElementById('dl8-bar');if(b)b.style.width=p+'%'}
  function showResult(stats,quoteUrl,errors){
    const po=document.getElementById('dl8-progress-overlay');if(po)removeOverlay(po);injectStyles();const{overlay,modal}=createOverlay();
    const errH=errors.length?`<h3 class="dl8-err">Errores (${errors.length})</h3><div style="max-height:150px;overflow-y:auto;font-size:12px;color:#f87171;white-space:pre-wrap">${errors.join('\n')}</div>`:'';
    modal.innerHTML=`<h2>${errors.length?'Completado con errores':'Completado OK'}</h2><div class="dl8-stats"><div class="dl8-stat"><b>Quote:</b> ${stats.quoteName} (#${stats.quoteIdInDomain})</div><div class="dl8-stat"><b>PNs creados:</b> ${stats.pnsCreated}</div><div class="dl8-stat"><b>PNs existentes:</b> ${stats.pnsExisting}</div><div class="dl8-stat"><b>Duplicados:</b> ${stats.pnsDuplicated}</div><div class="dl8-stat"><b>Products:</b> ${stats.productsSet}</div><div class="dl8-stat"><b>Labels:</b> ${stats.labelsSet}</div><div class="dl8-stat"><b>Specs:</b> ${stats.specsSet}</div><div class="dl8-stat"><b>UnitConv:</b> ${stats.unitConvSet}</div><div class="dl8-stat"><b>Racks:</b> ${stats.racksSet}</div><div class="dl8-stat"><b>CI:</b> ${stats.ciSet}</div><div class="dl8-stat"><b>Dims:</b> ${stats.dimsSet}</div><div class="dl8-stat"><b>PredUsage:</b> ${stats.predictiveSet}</div><div class="dl8-stat"><b>Default Price:</b> ${stats.defaultPriceSet}</div><div class="dl8-stat"><b>Archivados:</b> ${stats.archived}</div><div class="dl8-stat"><b>Ant.archivados:</b> ${stats.oldArchived}</div><div class="dl8-stat"><b>Valid.1erRecibo:</b> ${stats.validacionSet}</div></div>${errH}<div class="dl8-btnrow"><button class="dl8-btn dl8-btn-copy" id="dl8-copy-log">COPIAR LOG</button>${quoteUrl?`<a href="${quoteUrl}" class="dl8-btn dl8-btn-exec" style="text-decoration:none" target="_blank">ABRIR COTIZACIÓN</a>`:''}<button class="dl8-btn dl8-btn-close" id="dl8-close">CERRAR</button></div>`;
    document.getElementById('dl8-close').onclick=()=>removeOverlay(overlay);
    document.getElementById('dl8-copy-log').onclick=()=>{navigator.clipboard.writeText(_log.join('\n')).then(()=>alert('Log copiado.')).catch(()=>{const w=window.open('','_blank');w.document.write('<pre>'+_log.join('\n')+'</pre>')})};
  }

  // ═══════════════════════════════════════════
  // 6. HELPERS
  // ═══════════════════════════════════════════

  let unitNodes = [];
  const resolveUnitId = (abbr) => { if(!abbr)return null; const u=abbr.toUpperCase().trim(); const m=unitNodes.find(x=>x.name.toUpperCase().startsWith(u+' ')||x.name.toUpperCase()===u); if(m)return m.id; const f=unitNodes.find(x=>x.name.toUpperCase().includes(u)); if(f)return f.id; warn(`Unit "${abbr}" no encontrada.`);return null; };

  function buildDimensions(dims) {
    const out=[];const map=[['length',DOMAIN.geomDims.LENGTH],['width',DOMAIN.geomDims.WIDTH],['height',DOMAIN.geomDims.HEIGHT],['outerDiam',DOMAIN.geomDims.OUTER_DIAM],['innerDiam',DOMAIN.geomDims.INNER_DIAM]];
    for(const[key,id]of map){if(dims[key]!==null&&dims[key]!==undefined)out.push({geometryTypeDimensionTypeId:id,unitId:DOMAIN.unitMTR,dimensionValue:dims[key]})}return out;
  }

  function mergeCustomInputs(existing, part) {
    const ci = existing ? JSON.parse(JSON.stringify(existing)) : {};
    if (part.codigoSAT) { if(!ci.DatosFacturacion)ci.DatosFacturacion={}; ci.DatosFacturacion.CodigoSAT=part.codigoSAT; }
    if (part.metalBase||part.pnAlterno) {
      if(!ci.DatosAdicionalesNP)ci.DatosAdicionalesNP={};
      if(part.metalBase)ci.DatosAdicionalesNP.BaseMetal=part.metalBase;
      if(part.pnAlterno)ci.DatosAdicionalesNP.NumeroParteAlterno=part.pnAlterno.split(',').map(s=>s.trim()).filter(Boolean);
    }
    return Object.keys(ci).length>0?ci:null;
  }

  async function checkPNExistence(parts, customerId) {
    const uniq=[...new Set(parts.map(p=>p.pn.toUpperCase()))];const existMap=new Map();
    log(`Buscando ${uniq.length} PNs...`);
    for(const name of uniq){
      try{const d=await gql('SearchPartNumbers',H.SearchPartNumbers,{searchQuery:name,first:20,offset:0,orderBy:['ID_DESC']});
        const nodes=d?.searchPartNumbers?.nodes||d?.pagedData?.nodes||[];
        // SearchPartNumbers does NOT return customerId — match by exact name + not archived only
        // Results are ordered ID_DESC so first match = most recent
        const match=nodes.find(n=>n.name?.toUpperCase()===name&&!n.archivedAt);
        if(match){existMap.set(name,{id:match.id});log(`  "${name}" -> EXISTE id:${match.id}`)}
        else log(`  "${name}" -> NUEVO (${nodes.length} resultados, ninguno coincide exacto+activo)`)
      }catch(e){warn(`Busqueda "${name}": ${String(e).substring(0,120)}`)}
    }
    return parts.map(p=>{
      const key=p.pn.toUpperCase();const ex=existMap.get(key);
      if(!ex)return{pn:p.pn,status:'new',existingId:null,qty:p.qty,precio:p.precio};
      if(p.forzarDuplicado)return{pn:p.pn,status:'forceDup',existingId:ex.id,qty:p.qty,precio:p.precio};
      return{pn:p.pn,status:'existing',existingId:ex.id,qty:p.qty,precio:p.precio};
    });
  }

  // ═══════════════════════════════════════════
  // 7. MAIN
  // ═══════════════════════════════════════════

  try {
    log(`Data Loader v${VER} - iniciando...`);
    const csvText = await pickFile(); if(!csvText){log('Cancelado.');return}
    const csvClean = csvText.replace(/^\uFEFF/, ''); // strip BOM
    const {header,parts} = parseV82(parseCSV(csvClean));
    log(`CSV: ${parts.length} partes, header: ${Object.keys(header).join(', ')}`);
    if(!parts.length) err('No se encontraron filas de datos.');

    const modo = (header.modo||'').toUpperCase();
    if(modo.includes('SOLO')) err('Modo SOLO_PN no soportado en Fase 1. Usa COTIZACIÓN+NP.');
    const quoteName = header.quoteName;
    if(!quoteName) err('Falta "Nombre Cotización" en header.');
    log(`Modo: COTIZACIÓN+NP - "${quoteName}"`);

    // Resolve customer
    const customerRaw=header.customer||'';const customerName=customerRaw.split(/\s*[\u2014\u2013]\s*|\s+[-]\s+/)[0].trim();
    if(!customerName)err('Falta Cliente.');
    const custData=await gql('CustomerSearchByName',H.CustomerSearchByName,{nameLike:`%${customerName}%`,orderBy:['NAME_ASC']});
    const custNodes=custData?.searchCustomers?.nodes||custData?.pagedData?.nodes||custData?.allCustomers?.nodes||[];
    const customer=custNodes.find(c=>c.name?.toUpperCase().includes(customerName.toUpperCase()));
    if(!customer)err(`Cliente "${customerName}" no encontrado.`);
    const customerId=customer.id;log(`  Cliente: ${customer.name} (${customerId})`);

    // Related data
    const relData=await gql('GetQuoteRelatedData',H.GetQuoteRelatedData,{customerId});
    const custAddr=relData?.customerById?.customerAddressesByCustomerId?.nodes||[];
    const custCont=relData?.customerById?.customerContactsByCustomerId?.nodes||[];
    const customerAddressId=custAddr[0]?.id||null;const customerContactId=custCont[0]?.id||null;
    let invoiceTermsId=null;
    try{const fin=await gql('CustomerFinancialByCustomerId',H.CustomerFinancial,{id:customerId});invoiceTermsId=fin?.customerById?.invoiceTermsId||null}catch(e){warn(`CustomerFinancial: ${String(e).substring(0,80)}`)}
    if(!invoiceTermsId){try{const t=await gql('SearchInvoiceTerms',H.SearchInvoiceTerms,{termsLike:'%%'});const tn=t?.allInvoiceTerms?.nodes||t?.pagedData?.nodes||t?.searchInvoiceTerms?.nodes||[];if(tn.length)invoiceTermsId=tn[0].id}catch(e){warn(`SearchInvoiceTerms: ${String(e).substring(0,80)}`)}}
    log(`  Addr:${customerAddressId} Cont:${customerContactId} Terms:${invoiceTermsId}`);

    // Assignee
    let assigneeId=null,assigneeName='';
    if(header.asignado){const ud=await gql('SearchUsers',H.SearchUsers,{searchQuery:header.asignado,first:50});const un=ud?.searchUsers?.nodes||ud?.pagedData?.nodes||[];const u=un.find(u=>(u.name||u.fullName||'').toUpperCase().includes(header.asignado.toUpperCase()));if(u){assigneeId=u.id;assigneeName=u.name||u.fullName||''}else warn(`Asignado "${header.asignado}" no encontrado.`)}
    log(`  Asignado: ${assigneeName||'(ninguno)'}`);

    // Process
    let defaultProcessId=null,defaultProcessName='';
    if(header.processId){defaultProcessId=parseInt(header.processId);defaultProcessName=`id:${defaultProcessId}`}
    else if(header.processName){const pd=await gql('AllProcesses',H.AllProcesses,{includeArchived:'NO',processNodeTypes:['PROCESS'],searchQuery:`%${header.processName}%`,first:50});const pn2=pd?.allProcessNodes?.nodes||pd?.pagedData?.nodes||[];const pr=pn2.find(p=>p.name?.toUpperCase().includes(header.processName.toUpperCase()));if(pr){defaultProcessId=pr.id;defaultProcessName=pr.name}}
    log(`  Proceso: ${defaultProcessName} (${defaultProcessId})`);

    // Catalogs
    log('Cargando catálogos...');
    const[labelsD,specsD,racksD,unitsD,productsD,groupsD]=await Promise.all([
      gql('AllLabels',H.AllLabels,{condition:{forPartNumber:true}}),
      gql('SearchSpecsForSelect',H.SearchSpecsForSelect,{like:'%%',locationIds:[],alreadySelectedSpecs:[],orderBy:['NAME_ASC']}),
      gql('AllRackTypes',H.AllRackTypes,{}),
      gql('SearchUnits',H.SearchUnits,{}),
      gql('SearchProducts',H.SearchProducts,{searchQuery:'%%',first:200}),
      gql('PartNumberGroupSelect',H.PNGroupSelect,{partNumberGroupLike:'%%'}).catch(()=>gql('PartNumberGroupSelect',H.PNGroupSelect,{})).catch(()=>null),
    ]);
    const labelByName=new Map();for(const l of(labelsD?.allLabels?.nodes||[]))labelByName.set(l.name,l.id);
    const specByName=new Map();for(const s of(specsD?.searchSpecs?.nodes||[]))specByName.set(s.name,s);
    const rackTypeByName=new Map();for(const rt of(racksD?.pagedData?.nodes||racksD?.allRackTypes?.nodes||[]))rackTypeByName.set(rt.name,rt);
    unitNodes=unitsD?.pagedData?.nodes||unitsD?.searchUnits?.nodes||[];
    const productByName=new Map();for(const p of(productsD?.searchProducts?.nodes||productsD?.pagedData?.nodes||[]))productByName.set(p.name,p);
    const groupByName=new Map();
    if(groupsD){const gn=groupsD?.allPartNumberGroups?.nodes||groupsD?.pagedData?.nodes||groupsD?.partNumberGroups?.nodes||[];for(const g of gn)groupByName.set(g.name,g.id)}
    log(`  ${labelByName.size} labels, ${specByName.size} specs, ${rackTypeByName.size} racks, ${unitNodes.length} units, ${productByName.size} products, ${groupByName.size} groups`);

    // Group resolver (busca o crea)
    async function resolveGroupId(name){
      if(!name)return null;const n=name.trim();if(!n)return null;
      const existing=groupByName.get(n);if(existing)return existing;
      try{const res=await gql('CreatePartNumberGroup',H.CreatePNGroup,{input:{name:n}});
        const id=res?.createPartNumberGroup?.partNumberGroup?.id;if(id){groupByName.set(n,id);log(`  Grupo "${n}" creado id:${id}`);return id}
      }catch(e){warn(`Crear grupo "${n}": ${String(e).substring(0,100)}`)}
      return null;
    }

    // Spec fields cache
    const uniqueSpecs=new Set();for(const p of parts)for(const s of p.specs)uniqueSpecs.add(s.name);
    const sfCache=new Map();
    for(const sn of uniqueSpecs){const si=specByName.get(sn);if(!si){warn(`Spec "${sn}" no encontrada.`);continue}if(!sfCache.has(si.id)){const d=await gql('TempSpecFieldsAndOptions',H.TempSpecFieldsAndOptions,{specId:si.id});const sd=d?.specById;if(sd){sfCache.set(si.id,sd);log(`  Spec "${sn}": ${sd.specFieldSpecsBySpecId?.nodes?.length||0} campos`)}}}

    // PN existence
    const pnStatus = await checkPNExistence(parts, customerId);

    // Preview
    const proceed = await showPreview(header,parts,pnStatus,{customerName:customer.name,assigneeName,processName:defaultProcessName});
    if(!proceed){log('Cancelado.');return}

    // ═══════════════════════════════════════════
    // EXECUTION
    // ═══════════════════════════════════════════
    const errors=[];
    const stats={quoteName,quoteIdInDomain:0,pnsCreated:0,pnsExisting:0,pnsDuplicated:0,productsSet:0,labelsSet:0,specsSet:0,unitConvSet:0,racksSet:0,ciSet:0,dimsSet:0,defaultPriceSet:0,archived:0,oldArchived:0,predictiveSet:0,validacionSet:0};

    showProgress('Iniciando...');

    // STEP 1: CreateQuote
    showProgress('Paso 1/9: Creando cotización...'); setProgressBar(5);
    const divisaLinea=(header.divisaLinea||'USD').toUpperCase();
    const divisaCot=(header.divisaCotizacion||divisaLinea).toUpperCase();
    const empresaKey=(header.empresaEmisora||'ECO').toUpperCase();
    const empresaStr=DOMAIN.empresas[empresaKey]||DOMAIN.empresas.ECO;
    const validDays=parseInt(header.validaDias)||30;
    const quoteCI=JSON.parse(JSON.stringify(DOMAIN.defaultQuoteCI));
    quoteCI.DatosAdicionales.Divisa=divisaCot;quoteCI.DatosAdicionales.EmpresaEmisora=empresaStr;
    const createResult=await gql('CreateQuote',H.CreateQuote,{name:quoteName,assigneeId,customerId,validUntil:isoDate(validDays),followUpDate:isoDate(3),customerAddressId,customerContactId,stagesRevisionId:DOMAIN.stagesRevisionId,lowCodeEnabled:false,autoGenerateLines:false,lowCodeId:null,customInputs:quoteCI,inputSchemaId:DOMAIN.inputSchemaId_Quote,invoiceTermsId,orderDueAt:null,shipToAddressId:customerAddressId});
    const quoteId=createResult?.createQuote?.quote?.id;const quoteIdInDomain=createResult?.createQuote?.quote?.idInDomain;
    if(!quoteId)err('CreateQuote no devolvió id.');stats.quoteIdInDomain=quoteIdInDomain;
    log(`  Quote #${quoteIdInDomain} (id:${quoteId})`);showProgress(`  -> Quote #${quoteIdInDomain} creada`);

    // STEP 2a: Create new PNs via SavePartNumber (minimal)
    showProgress('Paso 2/9: Creando PNs nuevos...'); setProgressBar(10);
    const newPnIds=new Map();
    const newOrDupParts=[];
    for(let i=0;i<parts.length;i++){const status=pnStatus[i];if(status.status!=='existing')newOrDupParts.push({part:parts[i],status,idx:i})}
    for(let j=0;j<newOrDupParts.length;j++){const{part,status}=newOrDupParts[j];
      setProgressBar(10+Math.round((j/Math.max(newOrDupParts.length,1))*5));
      const processId=part.processIdOverride||defaultProcessId;
      const groupId=await resolveGroupId(part.pnGroup);
      const minInput={id:null,name:part.pn,customerId,defaultProcessNodeId:processId,
        inputSchemaId:DOMAIN.inputSchemaId_PN,customInputs:{},
        geometryTypeId:null,userFileName:null,inventoryItemInput:null,
        glAccountId:null,taxCodeId:null,certPdfTemplateId:null,
        isOneOff:false,isTemplatePartNumber:false,isCoupon:false,partNumberGroupId:groupId,
        descriptionMarkdown:'',customerFacingNotes:'',
        labelIds:[],ownerIds:[],defaults:[],optInOuts:[],
        inventoryPredictedUsages:[],specsToApply:[],paramsToApply:[],
        partNumberDimensions:[],partNumberLocations:[],dimensionCustomValueIds:[],
        partNumberSpecsToArchive:[],partNumberSpecsToUnarchive:[],
        partNumberSpecFieldParamsToArchive:[],partNumberSpecFieldParamsToUnarchive:[],
        partNumberSpecClassificationsToUpdate:[],
        partNumberSpecFieldParamUpdates:[],specFieldParamUpdates:[]};
      try{const res=await gql('SavePartNumber',H.SavePartNumber,{input:[minInput]});
        const created=(res?.savePartNumbers||[])[0];if(!created?.id)throw new Error('No id returned');
        newPnIds.set(part.pn.toUpperCase(),created.id);
        if(status.status==='forceDup')stats.pnsDuplicated++;else stats.pnsCreated++;
        log(`  "${part.pn}" -> creado id:${created.id}`)
      }catch(e){errors.push(`Crear PN "${part.pn}": ${String(e).substring(0,150)}`)}
    }
    showProgress(`  -> ${newPnIds.size} PNs creados`);

    // STEP 2b: SaveManyPartNumberPrices (ahora todos con partNumberId)
    showProgress('Paso 2/9: Vinculando precios...'); setProgressBar(15);
    const pnpItems=[];let lineNum=0;
    for(let i=0;i<parts.length;i++){const part=parts[i];const status=pnStatus[i];lineNum++;
      const processId=part.processIdOverride||defaultProcessId;
      let partNumberId;
      if(status.status==='existing'){partNumberId=status.existingId;stats.pnsExisting++}
      else{partNumberId=newPnIds.get(part.pn.toUpperCase());if(!partNumberId){errors.push(`PN "${part.pn}" no fue creado, omitido de quote.`);continue}}
      const entry={partNumberId,processId,customInputs:{DatosPrecio:{Divisa:divisaLinea}},inputSchema:DIVISA_SCHEMA,uiSchema:DIVISA_UI,
        partNumberPriceLineItems:[{title:'',price:part.precio||0,productId:null,quoteInventoryItemId:null}],
        usePartNumberDescription:true,treatmentSelections:[],priceBuilders:[],informationalPriceDisplayItems:[],priceTiers:[],
        unitId:(part.unidadPrecio&&PRICE_UNIT_MAP[part.unidadPrecio]!==undefined)?PRICE_UNIT_MAP[part.unidadPrecio]:null,
        partNumberCustomInputs:null,
        quotePartNumberPrice:{savedQuotePartNumberPriceId:null,quoteId,quantityPerParent:part.qty,lineNumber:lineNum}};
      pnpItems.push(entry);
    }
    let usedPNPHash='';
    for(let i=0;i<pnpItems.length;i+=20){const batch=pnpItems.slice(i,i+20);
      const{data,usedHash}=await gqlFallback('SaveManyPartNumberPrices',H.SaveManyPNP_Quote,H.SaveManyPNP_PN,{input:{quoteId,autoGenerateQuoteLines:true,partNumberPrices:batch,partNumberPriceIdsToDelete:[],quotePartNumberPriceLineNumberOnlyUpdates:[]}});
      usedPNPHash=usedHash;showProgress(`  -> Batch ${Math.floor(i/20)+1}: ${batch.length} PNs (hash ${usedHash})`);
    }
    log(`  SaveManyPNP: ${pnpItems.length} (hash: ${usedPNPHash})`);

    // STEP 3: Re-read quote
    showProgress('Paso 3/9: Leyendo cotización...'); setProgressBar(30);
    const{data:qData}=await gqlFallback('GetQuote',H.GetQuote_v8,H.GetQuote_v71,{idInDomain:quoteIdInDomain,revisionNumber:1});
    const quote=qData?.quoteByIdInDomainAndRevisionNumber||qData?.quoteByIdInDomain;
    if(!quote)err(`No se pudo leer quote #${quoteIdInDomain}.`);
    const qpnpNodes=quote.quotePartNumberPricesByQuoteId?.nodes||[];const qlNodes=quote.quoteLinesByQuoteId?.nodes||[];
    const qlByQpnpId=new Map();for(const ql of qlNodes)if(ql.autoGeneratedFromQuotePartNumberPriceId)qlByQpnpId.set(ql.autoGeneratedFromQuotePartNumberPriceId,ql);
    const pnLookup=new Map();
    for(const qpnp of qpnpNodes){const pnp=qpnp.partNumberPriceByPartNumberPriceId;if(!pnp)continue;const pn=pnp.partNumberByPartNumberId;if(!pn?.name)continue;pnLookup.set(pn.name.toUpperCase(),{qpnp,pnp,pn,ql:qlByQpnpId.get(qpnp.id)||null})}
    log(`  ${pnLookup.size} PNs en quote`);
    const allProdNodes=quote.allProducts?.nodes||qData.allProducts?.nodes||[];if(allProdNodes.length)for(const p of allProdNodes)productByName.set(p.name,p);

    // STEP 4: SaveQuoteLines (products)
    showProgress('Paso 4/9: Products en líneas...'); setProgressBar(40);
    let prodAdded=0;
    for(const part of parts){if(!part.products.length)continue;
      const entry=pnLookup.get(part.pn.toUpperCase());if(!entry){errors.push(`PN "${part.pn}" no en quote.`);continue}
      const ql=entry.ql;if(!ql){errors.push(`QuoteLine no encontrada para "${part.pn}".`);continue}
      const existing=ql.quoteLineItemsByQuoteLineId?.nodes||[];const idsToDelete=existing.map(ei=>ei.id).filter(Boolean);
      const items=[];
      for(let idx=0;idx<part.products.length;idx++){const np=part.products[idx];const pr=productByName.get(np.name);if(!pr){errors.push(`Product "${np.name}" no en catálogo.`);continue}
        items.push({savedQuoteLineItemId:null,title:np.name,price:np.price,quantity:np.qty,productId:pr.id,displayOrder:idx,description:'',dimensionCustomValueIds:[],quotePartNumberPriceIds:[entry.qpnp.id],unitId:resolveUnitId(np.unit)});prodAdded++}
      if(!items.length)continue;
      try{await gql('SaveQuoteLines',H.SaveQuoteLines,{input:{quoteId,quoteLines:[{savedQuoteLineId:ql.id,lineNumber:ql.lineNumber,title:ql.title,description:ql.description||'',autoGeneratedFromQuotePartNumberPriceId:ql.autoGeneratedFromQuotePartNumberPriceId,quoteLineItems:items}],quoteLinesToDelete:[],quoteLineItemsToDelete:idsToDelete,quoteLineNumberUpdates:[]}})}
      catch(e){errors.push(`SaveQuoteLines "${part.pn}": ${String(e).substring(0,100)}`)}
    }
    stats.productsSet=prodAdded;showProgress(`  -> ${prodAdded} products`);

    // STEP 5: UpdateQuote (notes)
    showProgress('Paso 5/9: Notas...'); setProgressBar(50);
    try{if(header.notasExternas)await gql('UpdateQuote',H.UpdateQuote,{id:quoteId,notesMarkdown:header.notasExternas});
      if(header.notasInternas)await gql('UpdateQuote',H.UpdateQuote,{id:quoteId,internalNotesMarkdown:header.notasInternas})}catch(e){errors.push(`UpdateQuote: ${String(e).substring(0,100)}`)}

    // STEP 6: SavePartNumber (enrich)
    showProgress('Paso 6/9: Enriqueciendo PNs...'); setProgressBar(55);
    let okSP=0,retrySP=0;
    for(let i=0;i<parts.length;i++){const part=parts[i];const entry=pnLookup.get(part.pn.toUpperCase());if(!entry)continue;const pn=entry.pn;
      setProgressBar(55+Math.round((i/parts.length)*20));
      const labelIds=part.labels.map(n=>labelByName.get(n)).filter(Boolean);if(labelIds.length)stats.labelsSet+=labelIds.length;
      // Specs
      const specsToApply=[];
      for(const cs of part.specs){const si=specByName.get(cs.name);if(!si){errors.push(`Spec "${cs.name}" no encontrada.`);continue}const sd=sfCache.get(si.id);if(!sd)continue;
        const dS=[],gS=[];for(const sf of(sd.specFieldSpecsBySpecId?.nodes||[])){const params=sf.defaultValues?.nodes||[];if(!params.length)continue;const fn=sf.specFieldBySpecFieldId?.name||'';const isEsp=fn.toLowerCase().includes('espesor');
          let pid;if(params.length===1)pid=params[0].id;else if(isEsp&&cs.param){const m=params.find(p=>p.name===cs.param);pid=m?m.id:(errors.push(`"${cs.name}" "${fn}": "${cs.param}" no encontrado.`),params[0].id)}else pid=params[0].id;
          if(!pid)continue;const sel={defaultParamId:pid,processNodeId:pn.defaultProcessNodeId||defaultProcessId||null,processNodeOccurrence:(pn.defaultProcessNodeId||defaultProcessId)?1:null,locationId:null,geometryTypeSpecFieldId:null};
          if(sf.isGeneric)gS.push(sel);else dS.push(sel)}
        specsToApply.push({specId:si.id,classificationSetId:null,classificationIds:[],defaultSelections:dS,genericSelections:gS});stats.specsSet++}
      // UnitConv
      const ucs=[];const u=part.unitConv;
      if(u.kgm!==null){ucs.push({unitId:DOMAIN.unitIds.KGM,factor:u.kgm});ucs.push({unitId:DOMAIN.unitIds.LBR,factor:u.kgm*DOMAIN.conversions.KGM_TO_LBR})}
      if(u.cmk!==null){ucs.push({unitId:DOMAIN.unitIds.CMK,factor:u.cmk});ucs.push({unitId:DOMAIN.unitIds.FTK,factor:u.cmk*DOMAIN.conversions.CMK_TO_FTK})}
      if(u.lm!==null){ucs.push({unitId:DOMAIN.unitIds.LM,factor:u.lm});ucs.push({unitId:DOMAIN.unitIds.FOT,factor:u.lm*DOMAIN.conversions.LM_TO_FOT})}
      if(u.minPzasLote!==null&&u.minPzasLote>0)ucs.push({unitId:DOMAIN.unitIds.LO,factor:1/u.minPzasLote});
      if(ucs.length)stats.unitConvSet++;
      // CI
      const mergedCI=mergeCustomInputs(pn.customInputs,part);if(part.codigoSAT||part.metalBase||part.pnAlterno)stats.ciSet++;
      // Dims
      const dims=buildDimensions(part.dims);const hasDims=dims.length>0;if(hasDims)stats.dimsSet++;
      // Predictive
      if(part.predictiveUsage.length)stats.predictiveSet++;
      // OptIn Validación 1er recibo
      const optInOuts=[];
      if(part.validacion1er){optInOuts.push({processNodeId:DOMAIN.validacionProcessNodeId,processNodeOccurrence:1,cancelOthers:false});stats.validacionSet++}
      const pnGroupId=part.pnGroup?(await resolveGroupId(part.pnGroup)):pn.partNumberGroupId||null;
      const pnProcessId=part.processIdOverride||pn.defaultProcessNodeId||defaultProcessId;
      const pnInput={id:pn.id,name:pn.name,customerId:pn.customerId||customerId,defaultProcessNodeId:pnProcessId,
        descriptionMarkdown:part.descripcion||pn.descriptionMarkdown||'',customerFacingNotes:pn.customerFacingNotes||'',
        customInputs:mergedCI||pn.customInputs||{},inputSchemaId:DOMAIN.inputSchemaId_PN,labelIds,
        partNumberGroupId:pnGroupId,
        geometryTypeId:hasDims?DOMAIN.geometryGenericaId:(pn.geometryTypeId||null),
        inventoryItemInput:ucs.length?{materialId:null,purchasable:false,sourceMaterialConversionType:null,providedMaterialConversionType:null,defaultLeadTime:null,unitConversions:ucs,inventoryItemVendors:[]}:null,
        inventoryPredictedUsages:part.predictiveUsage.map(pu=>({inventoryItemId:pu.inventoryItemId,usagePerPart:pu.usagePerPart,lowCodeId:null})),
        specsToApply,isCoupon:false,isOneOff:false,isTemplatePartNumber:false,optInOuts,ownerIds:[],defaults:[],dimensionCustomValueIds:[],
        paramsToApply:[],partNumberDimensions:dims,partNumberLocations:[],
        partNumberSpecClassificationsToUpdate:[],partNumberSpecFieldParamUpdates:[],partNumberSpecFieldParamsToArchive:[],partNumberSpecFieldParamsToUnarchive:[],
        partNumberSpecsToArchive:[],partNumberSpecsToUnarchive:[],specFieldParamUpdates:[],glAccountId:null,taxCodeId:null,certPdfTemplateId:null,userFileName:null};
      try{await gql('SavePartNumber',H.SavePartNumber,{input:[pnInput]});okSP++}
      catch(e){if(String(e).includes('unique_constraint')||String(e).includes('exclusion constraint')){try{await gql('SavePartNumber',H.SavePartNumber,{input:[{...pnInput,specsToApply:[]}]});retrySP++;log(`  -> ${pnInput.name}: retry sin specs OK`)}catch(e2){errors.push(`${pnInput.name}: retry fallo: ${String(e2).substring(0,120)}`)}}else errors.push(`SavePartNumber "${pnInput.name}": ${String(e).substring(0,120)}`)}
    }
    log(`  SavePartNumber: ${okSP} OK, ${retrySP} retry`);showProgress(`  -> ${okSP} OK, ${retrySP} retry`);

    // STEP 7: RackTypes
    showProgress('Paso 7/9: Racks...'); setProgressBar(78);
    const rackIn=[];
    for(const part of parts){if(!part.racks.length)continue;const entry=pnLookup.get(part.pn.toUpperCase());if(!entry)continue;
      for(const rk of part.racks){const rt=rackTypeByName.get(rk.name);if(!rt){errors.push(`RackType "${rk.name}" no encontrado.`);continue}if(rk.ppr===null)continue;
        rackIn.push({rackTypeId:rt.id,partNumberId:entry.pn.id,partsPerRack:rk.ppr})}}
    if(rackIn.length)for(let i=0;i<rackIn.length;i+=50)await gql('SavePartNumberRackTypes',H.SavePartNumberRackTypes,{input:{partNumberRackTypes:rackIn.slice(i,i+50),partNumberRackTypeIdsToDelete:[]}});
    stats.racksSet=rackIn.length;log(`  Racks: ${rackIn.length}`);

    // STEP 8: Default Price + Archive
    showProgress('Paso 8/9: Default price + archivado...'); setProgressBar(85);
    const priceIdsForDefault=[],pnsToArchive=[],oldPnsToArchive=[];
    for(let i=0;i<parts.length;i++){const part=parts[i];const status=pnStatus[i];const entry=pnLookup.get(part.pn.toUpperCase());if(!entry)continue;
      if(part.precioDefault){const pnpId=entry.pnp?.id;if(pnpId)priceIdsForDefault.push(pnpId)}
      if(part.archivado)pnsToArchive.push({id:entry.pn.id,name:part.pn});
      if(status.status==='forceDup'&&part.archivarAnterior&&status.existingId)oldPnsToArchive.push({id:status.existingId,name:part.pn+' (ant)'});
    }
    if(priceIdsForDefault.length){try{await gql('SetPartNumberPricesAsDefaultPrice',H.SetPNPricesDefault,{partNumberPriceIds:priceIdsForDefault});stats.defaultPriceSet=priceIdsForDefault.length}catch(e){errors.push(`SetDefaultPrice: ${String(e).substring(0,120)}`)}}
    for(const p of pnsToArchive){try{await gql('UpdatePartNumber',H.UpdatePartNumber,{id:p.id,archivedAt:new Date().toISOString()});stats.archived++}catch(e){errors.push(`Archivar "${p.name}": ${String(e).substring(0,100)}`)}}
    for(const p of oldPnsToArchive){try{await gql('UpdatePartNumber',H.UpdatePartNumber,{id:p.id,archivedAt:new Date().toISOString()});stats.oldArchived++}catch(e){errors.push(`ArchAnt "${p.name}": ${String(e).substring(0,100)}`)}}

    // STEP 9: Done
    showProgress('Paso 9/9: Completado.'); setProgressBar(100);
    const quoteUrl=`/Domains/${window.location.pathname.match(/\/Domains\/(\d+)/)?.[1]||DOMAIN.id}/Quotes/${quoteIdInDomain}`;
    log(`\n=== RESULTADO ===`);log(`Quote: "${quoteName}" #${quoteIdInDomain}`);
    log(`PNs: ${stats.pnsCreated} nuevos, ${stats.pnsExisting} existentes, ${stats.pnsDuplicated} dup`);
    if(errors.length)log(`ERRORES: ${errors.length}\n${errors.join('\n')}`);
    await new Promise(r=>setTimeout(r,500));
    showResult(stats,quoteUrl,errors);
  } catch(e) {
    console.error(`${LOG} FATAL:`,e);
    const po=document.getElementById('dl8-progress-overlay');if(po)removeOverlay(po);
    showResult({quoteName:'???',quoteIdInDomain:0,pnsCreated:0,pnsExisting:0,pnsDuplicated:0,productsSet:0,labelsSet:0,specsSet:0,unitConvSet:0,racksSet:0,ciSet:0,dimsSet:0,defaultPriceSet:0,archived:0,oldArchived:0,predictiveSet:0,validacionSet:0},null,[`FATAL: ${e.message}`]);
  }
})();
