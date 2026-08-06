# Pendientes abiertos — SteelheadAutomator

**Levantado:** 2026-08-05 · **Alcance:** lo detectado y *verificado* durante la sesión del
incidente de hashes del release `BB7C5204`. Cada renglón dice **cómo se comprobó**; lo que
viene de otra bitácora se cita como tal en vez de re-afirmarse.

> Criterio de esta lista: **nombrar la deuda donde se pueda medir.** Un pendiente sin
> evidencia ni forma de verificarlo no es un pendiente, es una intención.

---

## 1. Hashes sin ruta de regeneración

### 1.1 Mutations de specs — 2 de 3 RESUELTAS (2026-08-05)

**Resueltas y deployadas** (`v1.11.85`), con ruta de regeneración real en la entidad
`partNumberSpecParams` sobre el PN Centinela **#3770957**:

| Op | Hash nuevo | Cómo se dispara |
|---|---|---|
| `SaveMultipleSpecFieldParams` | `150956c4…` | seleccionar param → `Edit Selected Params` → Save |
| `UpdatePartNumberSpecParam` | `ba17174b…` | `aria-label="Archive Parameter"` → Confirm |

Un solo ciclo captura las dos (validado end-to-end con `--only`). Ambas por
**captura-y-aborta** ⇒ cero persistencia. Incluye el **fallback** pedido: si el PN aparece
archivado, el ciclo lo desarchiva, captura y **re-archiva en el `restore`**.

> **El sink corrigió dos suposiciones** — las dos parecían obvias y las dos eran falsas:
> el **lápiz individual** (`Edit Spec Field Parameter`) NO dispara `UpdatePartNumberSpecParam`
> sino el **mismo** `SaveMultipleSpecFieldParams` (Steelhead unificó los caminos), y
> **"Add Spec"** dispara `ApplySpecsToPartNumber`, no `AddParamsToPartNumber`.

**Sigue pendiente: `AddParamsToPartNumber`** (applets `bulk-upload`, `spec-migrator`,
`wo-spec-params`). No sale de ninguno de los flujos probados de la ficha del PN. Vive en
`_paraPendiente`, que el trinquete **no** cuenta — para no fingir cobertura. Pista para
retomarlo: los comentarios de `bulk-upload.js` la describen aplicando al PN un parámetro
recién creado en la *definición de la spec*, así que el flujo probablemente nace en la
pantalla de la **Spec**, no en la del PN.

⚠️ **Deuda bilingüe nueva:** los `aria-label` de esa tabla vienen **mezclados** — usamos
`"Show Spec"` y `"Archive Parameter"` (inglés) mientras la misma fila trae `"Cambiar Nodo de
Proceso"` y `"Copiar arriba"` (español). Si Steelhead traduce los nuestros, **el ciclo se
apaga en silencio**. No se inventa la traducción (regla dura del repo).

### 1.2 Dos hashes muertos que no usa ningún applet — decisión pendiente
| Op | Evidencia |
|---|---|
| `TempSpecFieldsAndOptions` | **0 usos** en `remote/scripts/` y `extension/`. Solo vive en `dataLoader_v84.js` (ancestro del bulk-upload) y en docs. `docs/api/hash-fase-b-guion-navegacion.html` ya la clasifica como *"Marginal (ningún applet la usa)"* |
| `CreateInvoiceAndUpdatePartTransferAccounts` | **0 usos** en código. El config la atribuye a `invoice-autofill`, pero su propia descripción dice *"no se intercepta outbound en v1; DOM-fill garantiza valores"*: el applet llena por DOM y nunca la llama |

Ambas tienen el hash **muerto** y generan una alerta **urgente en cada corrida** sin romper
nada: **cry-wolf puro**. No hay que regenerarlas — hay que **sacarlas del radar** (borrar el
hash y conservar la entrada documental). Es decisión del operador, por eso siguen ahí.

### 1.3 Otras rutas declaradas pero sin guionizar
- **`partNumberRackType`** (`CreatePartNumberPerPerRackType`, `UpdatePartNumberPerPerRackType`):
  su propia nota dice *"PENDIENTE de correr headless: falta guionizar el DOM del diálogo"*.
- Línea base del trinquete: **56 huérfanas** (bajó de 58 el 2026-08-05 al cubrir las dos de specs) (queries 110/119, mutations 18/69).
  **El hueco son las mutations**: cada una necesita su centinela.

---

## 2. Applets invisibles para el repo

`cfdi-attacher` estaba vivo en producción **sin figurar en el índice de `CLAUDE.md` ni tener
bitácora**; salió a la luz solo al rastrear qué rompía la rotación de `InvoiceByIdInDomain`.
Ya quedó documentado — pero **no era un caso aislado**.

De **45 apps** registradas en `config.json`, **7 siguen sin índice ni bitácora**:

`report-liberator` · `inventory-reset` · `po-reconciler` · `wo-deadline` ·
`invoice-default-tab` · `paros-linea` · `bill-autofill`

> **Por qué importa más de lo que parece:** un applet indocumentado no es solo un hueco de
> documentación — **es un applet cuya rotura nadie sabe atribuir.** Cuando su hash rote, el
> correo del autopilot dirá un nombre de operación que no le consta a nadie.

---

## 3. Paquete de capacitación: el inventario va 2 meses atrás

`docs/training/inventario-applets.html` se presenta como **"documento vivo"** y declara
**"35 Applets y herramientas documentados"**. Sus entradas están fechadas **2026-05-26**.

**Medido hoy contra `config.json`: faltan 15 applets** (verificado también por búsqueda de
texto: ninguno aparece con otro nombre).

`bill-autofill` · `cfdi-attacher` · `inventory-reset` · `invoice-default-tab` ·
`invoice-listing-marker` · `packing-slip-drawings` · `paros-linea` · `po-comparator` ·
`po-listing-filters` · `po-reconciler` · `portal-importer` · `report-liberator` ·
`wo-deadline` · `wo-listing-columns` · `wo-schedule-button`

Varios de ellos **sí están** en el índice de `CLAUDE.md` (`packing-slip-drawings`,
`wo-listing-columns`, `wo-schedule-button`, `po-listing-filters`), o sea que el desfase es del
**paquete del cliente**, no del repo. Es el documento que Ecoplating lee: un inventario que se
anuncia vivo y va dos meses atrás **enseña a desconfiar de todo el paquete**.

**Al actualizarlo, recordar:** los tres documentos **transversales**
(`repos-y-mantenimiento.html`, `manual-arquitectura.html`, `catalogo-mantenimiento.html`) son
idénticos byte-a-byte en los **tres** paquetes (`training/`, `reportes-sh/`, `powertools/`):
tocar uno obliga a re-copiar y republicar los tres.

---

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
