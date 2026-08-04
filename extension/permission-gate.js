// Decide qué apps se ven en el menú del popup según los permisos del usuario.
//
// POR QUÉ EXISTE ESTE MÓDULO (2026-07-30): el icono de "Ajuste Masivo de Specs"
// desapareció del menú sin que nadie tocara su config — sus requiredPermissions
// llevaban ahí desde el primer commit. La causa estaba en cómo se representaba
// "no sé qué permisos tiene el usuario":
//
//   background.js  → Array.isArray(perms) ? perms : []      ← "no sé" se volvía "no tiene"
//   popup.js       → d.sa_user_permissions || null          ← [] es TRUTHY, pasa como lista real
//   filtro         → req.every(p => [].includes(p)) = false ← esconde la app, en silencio
//
// Un [] cacheado esconde TODA app con requiredPermissions y sobrevive a las recargas.
// La regla, entonces: AUSENTE ≠ VACÍO, y ante la duda se MUESTRA. El gate del menú es
// cosmético — el servidor valida cada mutación al ejecutarla — así que un falso "sí"
// solo cuesta un error visible al hacer clic, mientras que un falso "no" deja al
// operador sin herramienta y sin explicación. Misma lección que report-regen 0.3.2/0.3.4.
(function () {
  'use strict';

  // Normaliza la lista de permisos a "conocida" (array con al menos un elemento) o null.
  // Una lista vacía NO es conocimiento: es la forma que toma el dato cuando falla la
  // consulta, cuando el ERP cambia el nombre del campo, o cuando la sesión no lo expone.
  function knownPermissions(list) {
    if (!Array.isArray(list)) return null;
    const limpia = list.filter(p => typeof p === 'string' && p.length > 0);
    return limpia.length > 0 ? limpia : null;
  }

  // Permisos que exige una app, contando el override manual del popup.
  // El override gana incluso si es [] — ahí sí es una decisión explícita del usuario.
  function requiredFor(app, overrides) {
    const ov = overrides && Object.prototype.hasOwnProperty.call(overrides, app.id)
      ? overrides[app.id]
      : undefined;
    const req = ov !== undefined ? ov : app.requiredPermissions;
    return Array.isArray(req) ? req.filter(p => typeof p === 'string' && p.length > 0) : [];
  }

  function isAppVisible(app, userPermissions, overrides) {
    const req = requiredFor(app, overrides);
    if (req.length === 0) return true;              // no exige nada
    const perms = knownPermissions(userPermissions);
    if (!perms) return true;                        // no sabemos → se muestra (fail-open)
    return req.every(p => perms.includes(p));
  }

  function selectVisibleApps(apps, userPermissions, overrides) {
    if (!Array.isArray(apps)) return [];
    return apps.filter(a => a && isAppVisible(a, userPermissions, overrides));
  }

  const api = { knownPermissions, requiredFor, isAppVisible, selectVisibleApps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.SAPermissionGate = api;
})();
