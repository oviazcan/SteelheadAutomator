// SpecShared — catálogo de Specs + helpers reutilizables para applets
// de SpecParam (spec-params-bulk, futuros). Read-only sobre el dominio.
// Depende de: window.SteelheadAPI (init de config)

const SpecShared = (() => {
  'use strict';

  const api = () => window.SteelheadAPI;

  // ── Constantes ──────────────────────────────────────────
  // MP = Materia Prima. Dos señales: label exacto "MP" o nombre que arranca con "IMP".
  const MP_LABEL_NAME = 'MP';
  const IMP_PREFIX_REGEX = /^IMP/i;

  // Tamaño de página (config override en steelhead.domain.specParamsBulk.page.first)
  function getPageSize() {
    return api().getDomain()?.specParamsBulk?.page?.first || 400;
  }

  // ── Cache lazy ──────────────────────────────────────────
  // Una corrida de catálogo por sesión. Llave: idInDomain (el "número de spec" del UI).
  // Valor: el row más reciente NO archivado de AllSpecs.
  let _specsByIdInDomain = null;        // Map<number, Spec>
  let _specsById = null;                 // Map<number, Spec>  (id interno, no idInDomain)
  let _loadPromise = null;               // dedup concurrent loads

  // ── Loaders ─────────────────────────────────────────────

  // Pagina AllSpecs offset/first hasta agotar totalCount.
  // type ∈ {'INTERNAL', 'EXTERNAL', undefined}. Steelhead acepta searchQuery: "".
  // NOTE: AllSpecs no acepta filtro de type server-side; filtramos en cliente.
  async function loadAllSpecsRaw() {
    const pageSize = getPageSize();
    const all = [];
    let offset = 0;
    let totalCount = null;
    let iter = 0;

    while (true) {
      iter++;
      if (iter > 200) throw new Error('loadAllSpecsRaw: cap de iteraciones, abortando');
      const data = await api().query('AllSpecs', {
        includeArchived: 'NO',
        orderBy: ['ID_IN_DOMAIN_DESC'],
        offset,
        first: pageSize,
        searchQuery: ''
      });
      const paged = data?.pagedData;
      if (!paged) break;
      if (totalCount == null) totalCount = paged.totalCount || 0;
      const nodes = paged.nodes || [];
      all.push(...nodes);
      offset += nodes.length;
      if (!nodes.length || offset >= totalCount) break;
    }
    return all;
  }

  // Construye el catálogo: agrupa por idInDomain y se queda con la revisión activa
  // más reciente (mayor revisionNumber, archivedAt == null).
  async function loadSpecCatalog() {
    if (_specsByIdInDomain) return _specsByIdInDomain;
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      const rows = await loadAllSpecsRaw();
      const byIdInDomain = new Map();
      for (const r of rows) {
        if (!r || r.archivedAt) continue;
        const prev = byIdInDomain.get(r.idInDomain);
        if (!prev || (r.revisionNumber || 0) > (prev.revisionNumber || 0)) {
          byIdInDomain.set(r.idInDomain, r);
        }
      }
      const byId = new Map();
      for (const v of byIdInDomain.values()) byId.set(v.id, v);
      _specsByIdInDomain = byIdInDomain;
      _specsById = byId;
      return byIdInDomain;
    })();
    try {
      return await _loadPromise;
    } finally {
      _loadPromise = null;
    }
  }

  function getSpecCatalog() {
    if (!_specsByIdInDomain) throw new Error('SpecShared: catálogo no cargado. Llama loadSpecCatalog() primero.');
    return _specsByIdInDomain;
  }

  function getSpecByIdInDomain(idInDomain) {
    if (!_specsByIdInDomain) return null;
    return _specsByIdInDomain.get(idInDomain) || null;
  }

  function getSpecById(id) {
    if (!_specsById) return null;
    return _specsById.get(id) || null;
  }

  function invalidateCache() {
    _specsByIdInDomain = null;
    _specsById = null;
    _loadPromise = null;
  }

  // ── Identificación ──────────────────────────────────────

  // Una spec es MP si: tiene label `MP` exacto, O su name comienza con `IMP` (case-insensitive).
  function isMPSpec(spec) {
    if (!spec) return false;
    const name = String(spec.name || '');
    if (IMP_PREFIX_REGEX.test(name)) return true;
    const labels = spec.specLabelsBySpecId?.nodes || [];
    for (const lbl of labels) {
      const ln = lbl?.labelByLabelId?.name;
      if (ln === MP_LABEL_NAME) return true;
    }
    return false;
  }

  function getLabelsList(spec) {
    const labels = spec?.specLabelsBySpecId?.nodes || [];
    return labels.map(l => l?.labelByLabelId?.name).filter(Boolean);
  }

  // ── Detalle ─────────────────────────────────────────────

  // GetSpec por idInDomain + revision. Devuelve el árbol completo de specFields + defaultValues.
  // Atención: el shape NO incluye failingRequiresResolution, isDefault, derivedFromId, ni
  // specFieldParamDropdownId. Para esos campos hay que llamar GetSpecFieldParamToEdit por param.
  async function getSpecDetail(idInDomain, revisionNumber) {
    const data = await api().query('GetSpec', { idInDomain, revision: revisionNumber });
    return data?.specByIdInDomainAndRevisionNumber || null;
  }

  // GetSpecFieldParamToEdit por specFieldParamId + specFieldId.
  // Devuelve el shape completo del SpecParam, incluyendo failingRequiresResolution, isDefault,
  // derivedFromId, specFieldParamDropdownId, unitId, sampleSetId, classificationSetId, processNodes, etc.
  async function getSpecFieldParamToEdit(specFieldParamId, specFieldId) {
    const data = await api().query('GetSpecFieldParamToEdit', { specFieldParamId, specFieldId });
    return data?.specFieldParamById || null;
  }

  // ── Helpers de normalización ────────────────────────────

  // Aplana el árbol de una spec a filas de SpecParam (uno por defaultValue).
  // Cada fila lleva: contexto del spec, del field, y el snapshot del param desde GetSpec.
  // Los campos faltantes (failingRequiresResolution, isDefault, derivedFromId,
  // specFieldParamDropdownId) se rellenan con null para que el consumer los enriquezca
  // con GetSpecFieldParamToEdit en una segunda pasada.
  function flattenSpecToParams(specDetail) {
    const out = [];
    if (!specDetail) return out;
    const specContext = {
      specType: specDetail.type,
      specId: specDetail.id,
      specIdInDomain: specDetail.idInDomain,
      specName: specDetail.name,
      specRevision: specDetail.revisionNumber,
      labels: getLabelsList(specDetail).join('; '),
      esMP: isMPSpec(specDetail) ? 'TRUE' : 'FALSE'
    };
    const fieldNodes = specDetail.specFieldSpecsBySpecId?.nodes || [];
    for (const fs of fieldNodes) {
      if (!fs || fs.archivedAt) continue;
      const field = fs.specFieldBySpecFieldId || {};
      const fieldContext = {
        specFieldSpecId: fs.id,
        fieldId: field.id,
        fieldName: field.name || '',
        fieldType: field.type || ''
      };
      const params = fs.defaultValues?.nodes || [];
      for (const p of params) {
        if (!p) continue;
        out.push({
          ...specContext,
          ...fieldContext,
          paramId: p.id,
          paramName: p.name || '',
          descriptionMarkdown: p.descriptionMarkdown || '',
          minimumValue: numOrNull(p.minimumValue),
          maximumValue: numOrNull(p.maximumValue),
          targetValue: numOrNull(p.targetValue),
          sampleCount: numOrNull(p.sampleCount),
          samplingRate: numOrNull(p.samplingRate),
          samplingIntervalMinutes: numOrNull(p.samplingIntervalMinutes),
          sensorValidDurationMinutes: numOrNull(p.sensorValidDurationMinutes),
          sensorWarningThresholdMinutes: numOrNull(p.sensorWarningThresholdMinutes),
          inputRequired: !!p.inputRequired,
          inputRequested: !!p.inputRequested,
          mustBePassing: !!p.mustBePassing,
          requestDocument: !!p.requestDocument,
          oneAtATime: !!p.oneAtATime,
          drivesCoupons: !!p.drivesCoupons,
          // Faltantes de GetSpec — se enriquecen con GetSpecFieldParamToEdit
          failingRequiresResolution: null,
          isDefault: null,
          derivedFromId: null,
          specFieldParamDropdownId: null,
          unitId: p.unitByUnitId?.id ?? null,
          sampleSetId: p.sampleSetBySampleSetId?.id ?? null,
          classificationSetId: p.classificationSetByClassificationSetId?.id ?? null
        });
      }
    }
    return out;
  }

  // Toma el shape completo de GetSpecFieldParamToEdit y mergea los campos
  // faltantes en una fila ya flatten-eada.
  function enrichRowFromEditShape(row, editShape) {
    if (!row || !editShape) return row;
    row.failingRequiresResolution = !!editShape.failingRequiresResolution;
    row.isDefault = !!editShape.isDefault;
    row.derivedFromId = editShape.specFieldParamByDerivedFromId?.id ?? null;
    row.specFieldParamDropdownId = editShape.specFieldParamDropdownBySpecFieldParamDropdownId?.id ?? null;
    row.unitId = editShape.unitByUnitId?.id ?? null;
    row.sampleSetId = editShape.sampleSetBySampleSetId?.id ?? null;
    row.classificationSetId = editShape.classificationSetByClassificationSetId?.id ?? null;
    row.specFieldSpecId = editShape.specFieldSpecBySpecFieldSpecId?.nodeId
      ? row.specFieldSpecId
      : row.specFieldSpecId; // ya viene del flatten
    return row;
  }

  // Construye el shape de input que acepta SaveMultipleSpecFieldParams.input.specFieldParams[].
  // currentRow: la fila plana (snapshot actual) con specFieldSpecId, derivedFromId, etc.
  // updates: el subset de campos a sobreescribir (vienen de columnas _NUEVO del XLSX).
  // Si un campo de updates es undefined o '' (vacío) → conserva el valor de currentRow.
  function paramToInputShape(currentRow, updates) {
    const pickNum = (k) => {
      const v = updates && (k in updates) ? updates[k] : undefined;
      if (v === undefined || v === '' || v === null) return currentRow[k] ?? null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const pickStr = (k) => {
      const v = updates && (k in updates) ? updates[k] : undefined;
      if (v === undefined) return currentRow[k] ?? '';
      return v == null ? '' : String(v);
    };
    const pickBool = (k) => {
      const v = updates && (k in updates) ? updates[k] : undefined;
      if (v === undefined || v === '' || v === null) return !!currentRow[k];
      return toBool(v);
    };
    return {
      id: Number(currentRow.paramId),
      isDefault: !!currentRow.isDefault,
      specFieldSpecId: Number(currentRow.specFieldSpecId),
      derivedFromId: currentRow.derivedFromId ?? null,
      descriptionMarkdown: pickStr('descriptionMarkdown'),
      inputRequired: pickBool('inputRequired'),
      inputRequested: pickBool('inputRequested'),
      mustBePassing: pickBool('mustBePassing'),
      failingRequiresResolution: pickBool('failingRequiresResolution'),
      requestDocument: pickBool('requestDocument'),
      minimumValue: pickNum('minimumValue'),
      maximumValue: pickNum('maximumValue'),
      targetValue: pickNum('targetValue'),
      samplingRate: pickNum('samplingRate'),
      sampleCount: pickNum('sampleCount'),
      sampleSetId: currentRow.sampleSetId ?? null,
      samplingIntervalMinutes: pickNum('samplingIntervalMinutes'),
      specFieldParamDropdownId: currentRow.specFieldParamDropdownId ?? null,
      oneAtATime: pickBool('oneAtATime'),
      name: pickStr('paramName'),
      unitId: currentRow.unitId ?? null,
      sensorValidDurationMinutes: pickNum('sensorValidDurationMinutes'),
      sensorWarningThresholdMinutes: pickNum('sensorWarningThresholdMinutes'),
      processNodes: [],
      defaults: [],
      optInOuts: [],
      updateDerivedFroms: true,
      operation: null,
      drivesCoupons: pickBool('drivesCoupons'),
      classificationIds: []
    };
  }

  // ── Utilidades pequeñas ─────────────────────────────────
  function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'sí' || s === 'si' || s === 'verdadero';
  }

  return {
    // constantes
    MP_LABEL_NAME, IMP_PREFIX_REGEX,
    // loaders
    loadSpecCatalog, getSpecCatalog, getSpecByIdInDomain, getSpecById, invalidateCache,
    // identificación
    isMPSpec, getLabelsList,
    // detalle
    getSpecDetail, getSpecFieldParamToEdit,
    // normalización
    flattenSpecToParams, enrichRowFromEditShape, paramToInputShape,
    // utils
    numOrNull, toBool
  };
})();

if (typeof window !== 'undefined') window.SpecShared = SpecShared;
