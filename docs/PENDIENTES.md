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
- Línea base del trinquete: **56 huérfanas** (bajó de 58 el 2026-08-05 al cubrir las dos de specs) (queries 110/119, mutations 18/69).
  **El hueco son las mutations**: cada una necesita su centinela.

---

## 2. ✅ RESUELTO — applets invisibles para el repo

Los **7** quedaron con bitácora y fila en el índice: `report-liberator`, `inventory-reset`,
`po-reconciler`, `wo-deadline`, `invoice-default-tab`, `paros-linea`, `bill-autofill`
(más `cfdi-attacher`, que fue el que destapó el hueco).

**Quedan 4 sin ficha propia** (se mencionan en `CLAUDE.md` pero no tienen fila ni bitácora):
`auditor` · `po-comparator` · `invoice-listing-marker` · `portal-importer`.

## 3. ✅ RESUELTO — inventario del paquete de capacitación

`docs/training/inventario-applets.html`: **35 → 50 applets**, `~77 → ~96` archivos, fecha
`2026-05-26 → 2026-08-05`. Los 15 faltantes entraron en su sección temática, con descripción
en lenguaje de usuario y `—` donde no hay versión publicada (no se inventó ninguna).
**Publicado a `gh-pages` y verificado EN VIVO**, no solo commiteado — que es justamente la
lección del §4 de este documento aplicada a sí misma.

**Recordatorio vigente:** los tres documentos **transversales**
(`repos-y-mantenimiento.html`, `manual-arquitectura.html`, `catalogo-mantenimiento.html`) son
idénticos byte-a-byte en los tres paquetes: tocar uno obliga a republicar los tres.

## 4. Freno de masa: propuesta sin implementar

Medido sobre el histórico (log 2026-07-06 → 2026-08-05, **92 corridas**, 20 auto-deploys): el
máximo de rotados en una corrida que **sí** deployó fue **3**. El umbral de 6 nunca estorbó en
operación normal, y **la única vez que actuó bloqueó un deploy urgente** durante ~5 h con los
applets rotos en producción.

- Su comentario dice defender contra *"captura corrupta / cookie de otro dominio"*: **eso no
  aplica** — un hash de persisted query identifica el *texto* de la query, es **global al
  build**, no al tenant. Una sesión en el dominio equivocado capturaría los mismos hashes.
- **Lo que sí protege:** un bug del propio motor (si el interceptor asociara hashes a
  operaciones equivocadas, el síntoma sería *"rotaron 14 de golpe"*). Es un *circuit breaker*
  contra nosotros, no un detector de anomalías del ERP.
- **Propuesta:** condicionar el freno al **probe del `cfgHash`** en vez de al conteo —
  *viejo muerto* ⇒ corregir siempre (no deployar **garantiza** el daño); *viejo vivo* ⇒
  retener y avisar (rotación de futuro, protege del rollback de Steelhead).
- Mientras tanto existe `--mass-brake=N`, **flag manual** (el cron nunca lo pasa).

---

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
