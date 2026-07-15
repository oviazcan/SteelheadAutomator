# Decisión de arquitectura — Candado de surtido en iPad: Safari Web Extension vs PWA

> **Fecha:** 2026-06-29 · **Estado:** DECIDIDO (Ruta A) · **POC Fase 1 VALIDADA en vivo 2026-06-30** — `world:"MAIN"` funciona en Safari iPad y el bloqueo de una pieza no programada quedó confirmado (NO se necesitó plan B)
> **Decisión:** Portar `surtido-guard` a iPad como **Safari Web Extension** (solo el candado), no como PWA.
> Generado con un análisis multi-agente (10 agentes: mapeo del repo → 4 dimensiones → síntesis → red-team).

## Contexto
Se pide replicar el **bloqueo preventivo** de `surtido-guard` (impedir mover piezas no programadas en
"Preparando Surtido en Almacén") en **iPad, 10+ dispositivos**. Chrome iOS no soporta extensiones; el factor
de decisión declarado por el dueño es la **mantenibilidad/handoff** (el autor principal no estará 100% a futuro).
Dos rutas evaluadas:
- **Ruta A — Safari Web Extension:** portar la extensión (el candado sigue siendo un *interceptor sobre la
  pantalla nativa de Steelhead*).
- **Ruta C — PWA propia:** una app nuestra que *reemplaza* la pantalla de surtido y hace el movimiento vía API.

## 1. Decisión (TL;DR)
**Ruta A — Safari Web Extension, solo el candado.** La Ruta C tiene dos bloqueadores que pueden tumbarla
antes de escribir código: **CORS probablemente cerrado** en `app.gosteelhead.com/graphql` para orígenes
externos, y **auth per-operador sin camino documentado** (el refresh token rota en cada uso → no sirve para
10 operadores concurrentes; requeriría un backend proxy = nuevo conocimiento tribal, justo lo que se quiere
evitar). La Ruta A reutiliza **~100% del JS del candado** (autocontenido: solo parchea `window.fetch`), tiene
camino técnico claro, y su mayor costo operativo (recompilar en Xcode por cada fix) está acotado por un
hallazgo clave: el candado es **inmune a la rotación de hashes de Apollo** (intercepta por `operationName`,
no por hash) — el dolor de mantenimiento más frecuente del proyecto **no lo afecta**.

## 2. El insight clave: candado ≠ reemplazo del flujo
- **Ruta A es un interceptor.** El operador sigue usando la pantalla nativa de Steelhead; el candado solo
  parcha `fetch` y bloquea la mutación `CreateManyPartsTransfersChecked` si la pieza no está programada.
  Invisible cuando no interviene. Cero curva de adopción.
- **Ruta C es una pantalla de reemplazo.** Tendría que replicar listado del workboard, estado de
  programación, modal de mover, paginación, refresh, errores — y depender de CORS abierto o un backend proxy.
  Multiplica el alcance ×5-10 y crea *drift*: cada cambio del surtido en Steelhead puede desincronizar la PWA
  sin aviso. **Confundir "candado" con "reemplazo de flujo" es lo que infla a la Ruta C en el papel.**

## 3. Tabla comparativa (cifras corregidas tras red-team)
| Dimensión | Ruta A — Safari Ext | Ruta C — PWA |
|---|---|---|
| Costo año 0 (dinero) | $99 (Apple Developer) | $0 |
| Costo año 0 (dev) | 32-54 h | 92-184 h *(si CORS y auth se resuelven)* |
| Recurrente anual (dinero) | $99 + $240-480 opc. (MDM) | $70-320 hosting (+ proxy si aplica) |
| Recurrente anual (dev) | 4-16 h/año (inmune a hashes) | 17-59 h/año (hashes + drift de UI) |
| Mantenimiento/mes estable | 5-8 h | 8-12 h (sin proxy) / 15-20 h (con proxy) |
| Tiempo a fix en prod | 1-3 h (build + TestFlight) | minutos (git push) |
| Exposición a rotación de hashes | **Ninguna** (por `operationName`) | Alta (queries activas) |
| Bloqueadores pre-inversión | Ninguno técnico ($99) | CORS + OAuth client externo (depende de Steelhead) |
| Stack para el sucesor | JS + Xcode (nuevo) + distribución iOS | JS + hosting estático (familiar) |
| Instalación en iPads | App (TestFlight 1-click / MDM silencioso) | URL en Safari (sin instalación) |
| Riesgo de colapso pre-prod | Bajo (camino mapeado) | Alto (2 incógnitas externas) |

> Nota: el "57 commits / 16 rotaciones en junio" del borrador estaba inflado (incluía 27 corridas
> automáticas de launchd con exit 0). Las rotaciones que **requirieron fix humano fueron ~10 en junio**
> (~2.5/semana). El argumento de fondo se mantiene: la Ruta A no las sufre; la Ruta C sí.

## 4. Riesgos a gestionar (del red-team — el veredicto confirma Ruta A, con estas correcciones)
1. **[CRÍTICO] Inmunidad a hashes es PARCIAL — fail-safe silencioso.** El *enforcement* (bloqueo de
   `CreateManyPartsTransfersChecked`) es inmune a hashes. Pero el **mapa de programadas** se construye
   parseando la respuesta de `GetRelatedScheduleData` (`buildScheduledAccountSet`). Si Steelhead cambia ese
   *schema de respuesta*, el parser devuelve un `Set` vacío **sin excepción** → por diseño fail-safe el candado
   **deja de bloquear sin avisar**. El operador no ve error. → **Pendiente: telemetría/alerta cuando el set de
   programadas sale vacío en un board de surtido** (señal de que el shape cambió). Aplica a Chrome y a iPad.
2. **[PRE-PROD] Distribución sin MDM duele.** Builds TestFlight expiran a 90 días; sin MDM, cada uno de los
   10 operadores debe reinstalar → en la práctica 2-4 quedan en versión expirada y el candado "desaparece"
   sin que sepan por qué. Decidir MDM **antes** de producción, no después. Ver Opción D (§6).
3. **[HANDOFF] Curva de Xcode para el sucesor: 3-5 días** (no 1-2): firma, certificados y provisioning
   profiles son crípticos para alguien JS-only. → **Pendiente: `docs/deploy-safari.md` con capturas** de los
   pasos de Xcode/firma, no solo comandos.
4. **[HANDOFF] Divergencia `remote/` ↔ `safari/extension/`.** Un sucesor podría actualizar el candado para
   Chrome y olvidar re-sincronizar Safari. → **Mitigado**: `tools/deploy.sh` ahora emite un warning si los
   `.js` de `safari/extension/` difieren de `remote/scripts/` (commit de esta fecha). `safari/sync-scripts.sh`
   es paso obligatorio antes de cada rebuild.
5. **[PROCEDIMIENTO] El test de CORS no funciona en iPad solo** (no hay DevTools en iPadOS). Correrlo desde
   Safari de una Mac contra el endpoint, o vía Web Inspector remoto (iPad por USB). Solo relevante si se
   reconsidera la Ruta C.

## 5. Plan por fases (corregido: el POC YA existe)
- **Fase 0 — hoy (5 min):** confirmar la versión de iPadOS de los iPads. Si ≥17, `world:"MAIN"` directo; si
  <17, usar el **plan B** ya incluido (`manifest.fallback.json` + `sg-inject.js`).
- **Fase 1 — ✓ VALIDADA (2026-06-30):** se generó el proyecto con el converter, se firmó con Apple ID gratis y
  se instaló en un iPad. `world:"MAIN"` intercepta `fetch` en Safari/iPadOS, el login OAuth funcionó y el
  bloqueo de una pieza no programada quedó confirmado. **Pendiente menor:** validar el caso de una pieza
  PROGRAMADA (que no se bloquee) cuando haya una en el board.
- **Fase 2 — si el POC pasa:** cuenta Apple Developer ($99), decidir toggle (§7), decidir distribución (§6),
  agendar la telemetría del fail-safe (riesgo #1), escribir `docs/deploy-safari.md`.

## 6. Decisión de distribución (10+ iPads)
- **TestFlight:** 1-click por iPad, sin App Store Review (internal testing ≤100), pero expira a 90 días y sin
  MDM genera reinstalaciones manuales por operador.
- **MDM (Jamf Now/Mosyle, ~$2-4/disp/mes):** push silencioso, sin expiración percibida. Recomendado para 10+.
- **Opción D (híbrida, para validación inicial):** con la planta físicamente accesible, un técnico hace
  sideload directo (`Product → Run`) en los 10 iPads cada 90 días (~15 min total). Más simple que gestionar 10
  cuentas TestFlight durante los primeros 2-3 meses, antes de comprometer MDM.

## 7. Decisiones abiertas (requieren input del dueño)
- **¿El MVP de iPad arranca con toggle o default-ON permanente?** El POC actual es **default-ON sin toggle**
  (el bloqueo es lo crítico a validar). Agregar toggle en Safari ≠ trivial: requiere `popup.html`/`popup.js`
  + un background con messaging (la UX del popup en Safari es distinta a Chrome: `Aa` → gestionar extensiones).
  Suma ~1-2 días. **Recomendación:** validar el POC default-ON primero; decidir el toggle después.
- **Distribución:** TestFlight vs MDM vs Opción D (ver §6).

## Anexos / trazabilidad
- Análisis crudo completo (mapeo del repo, 4 dimensiones, síntesis, red-team) generado por el workflow
  `ipad-surtido-guard-analysis` (10 agentes). Resumen ejecutivo y red-team integrados arriba.
- POC: `safari/` (README con pasos de Xcode) · candado fuente: `remote/scripts/surtido-guard*.js` ·
  bitácora del applet: `docs/applets/surtido-guard.md`.
