# Pendientes abiertos — SteelheadAutomator

**Levantado:** 2026-08-05 · **Alcance:** lo detectado y *verificado* durante la sesión del
incidente de hashes del release `BB7C5204`. Cada renglón dice **cómo se comprobó**; lo que
viene de otra bitácora se cita como tal en vez de re-afirmarse.

> Criterio de esta lista: **nombrar la deuda donde se pueda medir.** Un pendiente sin
> evidencia ni forma de verificarlo no es un pendiente, es una intención.

---

## 1. Hashes sin ruta de regeneración

### 1.1 ✅ RESUELTO — familia de parámetros de spec (3 de 3)

Entidad `partNumberSpecParams` sobre el PN Centinela **#3770957**. Las tres en **un ciclo**,
todas captura-y-aborta, validadas end-to-end y deployadas (`v1.11.85`, `v1.11.86`):

| Op | Cómo se dispara |
|---|---|
| `SaveMultipleSpecFieldParams` | seleccionar param → `Edit Selected Params` → Save |
| `UpdatePartNumberSpecParam` | `Archive Parameter` → Confirm |
| `AddParamsToPartNumber` | `+` del **spec field** → `Add Parameter` → llenar parametrización → **Confirm** |

Incluye el **fallback**: si el PN aparece archivado, desarchiva → captura → **re-archiva**.
Trinquete 58 → 55. Idioma **medido, no supuesto**: `Show Spec`, `Archive Parameter` y
`Edit Spec Field Parameter` salen en **inglés** en una sesión con la UI en español (la misma
fila trae `Cambiar Nodo de Proceso` y `Copiar arriba`). SH no los traduce ⇒ el anclaje
mono-idioma es correcto ahí y sale de la lista de sospechosos.

### 1.2 ✅ RESUELTO — retirados 2 hashes muertos sin consumidor (`v1.11.87`)

`CreateInvoiceAndUpdatePartTransferAccounts` y `TempSpecFieldsAndOptions` alertaban como
urgentes en cada corrida sin romper nada. Su entrada documental sigue en
`config.knownOperations`; lo que se fue es el hash. Trinquete 55 → 53.

**Cómo se definió "nadie" (y por qué el primer intento estaba mal):** se midió sobre **4
fuentes** — applets, `extension/`, Reportes SH y PowerTools — **excluyendo**
`safari/extension/main-bundle.js` (ARTEFACTO que embebe el catálogo completo: hacía
aparecer las **199 ops como "usadas"**) y `dataLoader_v84.js` (standalone con su **propia**
tabla de hashes). De 199 ops, **14 sin uso real**; de esas, solo **2 estaban muertas**. Las
otras **12 están vivas y se dejaron intactas** — no alertan hoy.

> La lección: el primer "0 usos" salió de mirar dos directorios. Un inventario incompleto no
> produce una respuesta incompleta, produce una **respuesta con signo cambiado**.

### 1.3 Otras rutas declaradas pero sin guionizar
- **`partNumberRackType`** (`CreatePartNumberPerPerRackType`, `UpdatePartNumberPerPerRackType`):
  su propia nota dice *"PENDIENTE de correr headless: falta guionizar el DOM del diálogo"*.
- Línea base del trinquete: **53 huérfanas** — leída del código
  (`HUERFANAS_BASE = 53` en `tools/test/hash-regen-coverage.test.js:59`) y **re-medida en verde el
  2026-08-05** (`node --test tools/test/hash-regen-coverage.test.js` → 5/5). Este renglón decía
  **56** y contradecía al §1.2 de este mismo documento, que ya narraba el 55 → 53; el desglose que
  traía (`queries 110/119, mutations 18/69`) también era viejo — el vigente
  (**queries 115/122, mutations 29/75**) está en el índice de `CLAUDE.md`.
  **El hueco siguen siendo las mutations**: cada una necesita su centinela.

---

## 2. ✅ RESUELTO — applets invisibles para el repo

Los **7** quedaron con bitácora y fila en el índice: `report-liberator`, `inventory-reset`,
`po-reconciler`, `wo-deadline`, `invoice-default-tab`, `paros-linea`, `bill-autofill`
(más `cfdi-attacher`, que fue el que destapó el hueco).

**✅ Los 4 restantes también quedaron documentados** (2026-08-05): `auditor`,
`po-comparator`, `invoice-listing-marker`, `portal-importer`.

**Cobertura hoy: 45/45 apps del `config.json` con fila en el índice y bitácora.** Los dos
que la auditoría automática marca como faltantes son falsos positivos conocidos:
`carga-masiva` es el `id` de la app cuyo applet se documenta como **`bulk-upload`**, y
`process-canon` es un **helper compartido**, no un applet (su documentación vive en
[`processes-architecture.md`](processes-architecture.md)).

## 3. ✅ RESUELTO — inventario del paquete de capacitación

`docs/training/inventario-applets.html`: **35 → 50 applets**, `~77 → ~96` archivos, fecha
`2026-05-26 → 2026-08-05`. Los 15 faltantes entraron en su sección temática, con descripción
en lenguaje de usuario y `—` donde no hay versión publicada (no se inventó ninguna).
**Publicado a `gh-pages` y verificado EN VIVO**, no solo commiteado — que es justamente la
lección del §4 de este documento aplicada a sí misma.

**Recordatorio vigente:** los tres documentos **transversales**
(`repos-y-mantenimiento.html`, `manual-arquitectura.html`, `catalogo-mantenimiento.html`) son
idénticos byte-a-byte en los tres paquetes: tocar uno obliga a republicar los tres.

## 4. ✅ IMPLEMENTADO — el freno de masa ya no cuenta, pregunta

Condicionado al `probeVerdicts` que el motor **ya calculaba y no usaba para esto**:

| `cfgHash` según el probe | Qué hace |
|---|---|
| **muerto** (`stale`) | **deploya siempre** — el applet ya está roto; retener garantiza el daño |
| vivo (`vigente`) | cuenta para el freno: rotación *de futuro*, no urge y protege del rollback |
| `auth` / `unknown` / sin probe | cuenta para el freno (**fail-safe**: "no sé" no habilita deploy masivo) |

Dejó de ser todo-o-nada: al frenar **retiene las de futuro y deploya igual las muertas**.
El correo dice qué retuvo, por qué no urge y el comando exacto para liberarlo
(`--mass-brake=N`). 6 pruebas + 2 trinquetes de cableado, verificados **por mutación**.

## 5. Deuda de anclaje y de cobertura (de bitácoras previas)

| Pendiente | Fuente |
|---|---|
| **24 sitios en 9 archivos** anclados a clases `css-<hash>` (fallan en silencio cuando alguien mueve un padding) | `docs/architecture/steelhead-ui-anchoring.md` |
| **25 anclajes mono-idioma en 12 applets**; el hardening está **bloqueado por evidencia** (regla dura: no adivinar la traducción) | `docs/architecture/bilingual-anchoring-debt.md` |
| `SendIcon` **sin forma medida** en el catálogo — hoy lo sostiene el `aria-label` bilingüe (afecta a `cfdi-attacher`) | `docs/applets/cfdi-attacher.md` |
| `cfdi-attacher` **sin test**: candidatos a extraer son `cacheInvoiceData` y la selección de `idsToProcess` desde `linkInfo` | ídem |
| Memory-hardening: **2 applets NO-ADOPTADO** (`portal-importer`, `po-comparator`), 5 PARCIAL | `docs/applets/memory-hardening-audit.md` |

---

## 6. Riesgos operativos vivos (no son deuda de código)

- **Titularidad:** de 10 dependencias externas, **5 están a nombre del consultor** (repos,
  GitHub Pages, el workflow del vigía, la cuenta Apple del bundle iPad, y la Mac que corre los
  3 procesos de `launchd` con rutas `/Users/oviazcan/…`). Los avisos automáticos llegan al
  consultor, no a Ecoplating.
- **`escalation` y `weekly_snapshot` NO emiten latido** — esos sí se detienen en silencio. Solo
  el `hash-autopilot` tiene watchdog externo.
- **Concurrencia de sesiones:** el cron del autopilot y una sesión manual pueden escribir
  `remote/config.json` a la vez (pasó hoy, sin choque por tocar ops distintas). Antes de correr
  el autopilot a mano: `ps aux | grep hash-autopilot`.

---

## 7. `create-order-autofill` — el disparo automático en la lista de OVs (2026-08-05)

**Sin causa raíz.** La extracción del cliente quedó arreglada (v0.1.4/v0.1.5, `1.11.90`) y el
autofill funciona **cuando se invoca**: log del propio applet
`autofill | razon=OK | divisa=OK | consolidar=OK` con SCHNEIDER (#1). Pero en
`/Domains/<id>/SalesOrders` **no arrancó solo**: sólo corrió al llamar `scanForModal()` a mano.

**Medido, con el modal abierto y el cliente ya elegido:** cero entradas de `modal detectado` en
consola (con `sa_debug` activo, mientras `report-regen` **sí** logueaba), y una mutación directa
sobre `document.body` tampoco lo despertó.

Descartado con evidencia — **no volver a probarlo**:
- No lo introdujeron los fixes: `git diff v1.11.87 v1.11.89 -- create-order-autofill.js` no toca
  ni una línea de `init`/`checkUrl`/`setupObserver`/`scanForModal`/observer.
- No es el debounce posponiéndose por ráfaga: 17 mutaciones con **11 gaps > 350 ms** (máx **2049 ms**).
- No es el gate de URL (`matches=true` en el log de init), ni el latch de habilitación, ni permisos
  (`autoInject` no los consulta), ni una excepción no capturada (consola limpia).

**~~Sospecha: el observer no se monta~~ — REFUTADA POR MEDICIÓN (2026-08-05, misma noche).**
Se sospechaba que `setupObserver()` pone `observerActive = true` **antes** de
`obs.observe(document.body, …)` y que un fallo de montaje quedaba congelado. **Es falso.** Se
parcheó `MutationObserver.prototype.observe` **antes** de que el applet se inyectara —abriendo
primero `/Domains/<id>/WorkOrders`, donde el gate NO lo carga (confirmado: no está en
`__saLoadedApps.ids`), y llegando a la lista de OVs **navegando por la SPA**, que es el camino
real del operador— y el registro quedó capturado:

```
target: document.body   opts: {"childList":true,"subtree":true}
stack:  at setupObserver (<anonymous>:297:14) | at Object.init (<anonymous>:51:11)
```

**El observer SÍ se monta.** La causa de que no se vieran logs de `modal detectado` es otra y
**sigue sin identificar** — no vale la pena volver a probar el montaje.

⚠️ **La segunda tanda de medición también se contaminó**: el `/graphql` volvió a colgarse (el
combo de Cliente abría con **cero opciones** y al final **el modal ya ni abría**). El límite es
**por sesión** y no se recupera recargando. **Cualquier intento futuro empieza con sesión de
navegador limpia, y el diagnóstico se hace con el mínimo de peticiones posible.**

**Siguiente hipótesis a probar (no probada aún):** que la extensión del operador esté sirviendo
**código/config cacheado** — `applet-gate.js` cachea el código verificado por versión y
`loadConfig()` tiene TTL. Si su máquina no bajó `1.11.91`, ninguno de los tres fixes le llegó y el
síntoma se ve idéntico a un bug del applet. Se verifica con el snippet que imprime
`tools/check-deploy.sh` (compara `cfg.version` remoto contra el que corre la extensión).

⚠️ **Al retomar, sesión LIMPIA.** El diagnóstico acumuló ~50 peticiones al `/graphql` y
probablemente lo dejó degradado (el límite es **por sesión** y no se recupera recargando), además
de congelar una pestaña al re-evaluar el script remoto con `new Function`. **Las mediciones de
timing del final de esa sesión no son confiables.**

Nota: en el flujo de **Recibo** el síntoma «no sale el banner» resultó ser otra cosa (el cliente
vive en el wizard padre) y **ya está corregido** en v0.1.5 — no confundir los dos casos.
