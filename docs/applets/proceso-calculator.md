# Applet: `proceso-calculator` — Calculadora de Procesos

**Versión actual:** 0.1.4 (en workbench — cache de metal/línea del modal vía observer: lee el ajustado aunque esté en otra pestaña desmontada). Vivo en gh-pages: 0.1.3.
**Archivo:** `remote/scripts/proceso-calculator.js`
**Global:** `window.ProcesosCalculator`

## Qué es

Replica la **"Calculadora de Procesos"** de la pestaña `CAT_Procesos` del `.xlsm` de carga masiva, **dentro del UI de Steelhead**, como herramienta inline durante la edición de un Número de Parte (NP).

Dado `(metal base, línea, etiquetas de acabado)` calcula el/los proceso(s) candidato(s) y los coloca en el combobox **"Default Process"**:
- **1 match** → lo coloca automáticamente.
- **2+ matches** → lista reducida; al elegir, lo coloca.
- **0 matches** → permite agregar la combinación al catálogo (compartida con todos al instante).

## Arquitectura

### Almacenamiento — artículo de inventario (DECIDIDO Y VALIDADO)
El catálogo vive en `customInputs.CatProcesos` (array) de un **artículo de inventario dedicado**:
- **Artículo id `900192`** — "Catálogo de Procesos (no archivar)"
- **Tipo de inventario id `3767`**
- **inputSchemaId `941`** (se lee dinámico vía `GetInventoryItemInputSchema`; 941 es fallback)

Persistente, compartido por todo el dominio, escribible con la sesión del operador en **una sola mutación**. Cada item:
```json
{ "Linea":"...", "MetalBase":"...", "Etiqueta1..Etiqueta6":"...", "Proceso":"..." }
```

**Operaciones (hashes en `config.json`):**
| Acción | Operación | Hash | Path / vars |
|---|---|---|---|
| Leer | `GetInventoryItem` | `38a52d1c…` | `{id:900192, usagesLimit:10, usagesOffset:0, purchaseOrderBomItemsOffset:0, purchaseOrderBomItemsLimit:10}` → `inventoryItemById.customInputs.CatProcesos` |
| Schema | `GetInventoryItemInputSchema` | `b0ebb55c…` | `{inventoryTypeId:3767}` → `latestInventoryItemInputSchemaForType.id` |
| Escribir | `UpdateInventoryItemInputs` | `e5eafcb7…` | `{itemId:900192, inputSchemaId:941, customInputs:{...ci, CatProcesos:[…]}}` (REPLACE, RMW) |

**Por qué NO otras opciones** (historial del diseño):
- gh-pages estático → no escribible por el operador.
- `customInputs` del dominio → lento (se carga en todos lados) + requiere admin.
- **operator input de nodo de proceso / work order → DESCARTADO**: no persiste, se resetea por orden de trabajo; los datos viven en parts-transfers (log infinito, frágil).
- OV centinela → viable pero hacky.
- **Artículo de inventario → ganador**: persistente, una mutación, lectura directa.

### Estado de la carga
**Semilla cargada (2026-06-12):** los **1,580** registros de `CAT_Procesos` (Plantilla_CargaMasiva_v12.xlsm) están cargados en el artículo 900192 (374 KB, persistido OK). 43 filas con 5 etiquetas, 3 con 6 — todas persisten (el servidor no valida estricto contra el schema de 4). Carga hecha con un script Python que reusa el cliente autenticado de Reportes SH (`client_from_env` + hashes registrados en `PERSISTED_QUERIES`).
- **Recarga futura** (cuando se optimice la base): regenerar el JSON desde el `.xlsm` y re-correr la mutación `UpdateInventoryItemInputs` (REEMPLAZA todo). Es un comando, cero trabajo manual.
- **Fuente de verdad a definir:** tras la siembra, lo natural es que el **artículo** tome el relevo (el applet agrega ahí). Si se recarga desde el Excel, se sobrescriben los agregados del applet.

### Disparador — ícono inline (autoInject)
autoInject (data-driven desde `config.apps[].autoInject`, sin tocar `background.js`). `MutationObserver` idempotente que ancla un ícono 🧮 junto al combobox "Default Process", en dos vistas:
- **Modal** "Edit Part Number → PROCESO Y SPECS" (`data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_DEFAULT_PROCESS"`).
- **Ficha** del NP "Process Setup".

### Inputs — leídos del DOM (no GraphQL)
El NP está en edición y aún no persiste; se leen del DOM (Material/metal, Línea, chips de etiquetas) para pre-poblar inputs editables. Dropdowns poblados en vivo desde catálogos oficiales (`AllProcesses`, `AllLabels` menos `nonFinishLabelNames`, `GetDimension(349)`, `BaseMetal.enum`).

### Matching
Exacto en metal + línea + **CONJUNTO** de etiquetas (sin orden, `Etiqueta1..6`), normalizado (trim + lowercase + strip acentos). **17+5 tests pasan.**

## DOM — selectores (AFINADOS modal + ficha)

| Campo | Modal | Ficha |
|---|---|---|
| **Default Process** | react-select: `input[role="combobox"]` en `[class*="-control"]`; valor en `[class*="singleValue"]`. `writeProcess()` = click → setter nativo + InputEvent → opciones → click. | igual |
| **Metal base** | `<select id="root_DatosAdicionalesNP_BaseMetal">` (RJSF nativo) → texto de la opción. | mismo `<select>` (con `disabled`, igual se lee `selectedIndex`). |
| **Línea** | react-select `singleValue` tras `<p>Línea:</p>` (forma larga), **acotado al diálogo `MuiDialogContent`** (ver fix v0.1.3). | `<p>` de texto plano hermano del label → `readSingleValueByLabel` captura texto plano. |
| **Etiquetas** | `[data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_LABELS"]` → chips por `svg[data-testid="CloseIcon"]` (parentElement). | chips `.css-1owv9dy` **dentro de `MuiPaper-elevation0`** (superficie del NP), NO los de la card del cliente (`MuiPaper-elevation1`). |

Etiquetas: se filtran `nonFinishLabelNames` (SRG, SMY, "NP desconocido", "En desarrollo", …) + dedup. "NP desconocido" NO debe aparecer (decisión del usuario: no es acabado).

**Fix v0.1.1 (FALLIDO) — allowlist por nombre.** Intento: filtrar las etiquetas leídas contra el catálogo oficial `AllLabels(forPartNumber:true)`. **No sirvió:** `Industrial` está asociada solo a Cliente en la UI pero IGUAL aparecía en el set `forPartNumber:true` (o existe una etiqueta de NP homónima), así que el filtro por **nombre** no la quitaba; y de fondo el chip se leía del bloque "Customer:". Lección: el discriminador correcto es DOM, no nombre.

**Fix v0.1.2 — scoping por elevación de MuiPaper (verificado en DOM).** Las etiquetas del **NP** cuelgan de la superficie primaria plana `MuiPaper-elevation0`; las del **CLIENTE** (renglón "Customer:") viven en una tarjeta elevada `MuiPaper-elevation1`. En la ficha solo se aceptan chips `.css-1owv9dy` cuyo `closest('.MuiPaper-root')` sea `MuiPaper-elevation0`. `closest` funciona aunque la card del cliente esté anidada (devuelve el paper más cercano = elevation1 → excluido). **Degradación segura:** si nada matchea elevation0, no entra ninguna etiqueta (mejor "sin etiquetas" que colar las de cliente). Se eliminó la allowlist por nombre (arriesgaba falsos negativos). El modal no cambia: su input `CREATE_PART_NUMBER_DIALOG_LABELS` ya es del NP. **Cadena DOM verificada (2026-06-15):** NP `Estaño Mate` → `.css-1owv9dy` … `MuiPaper-elevation0.css-10sik0g`; cliente `Activo`/`Industrial` → `.css-1owv9dy` … `MuiPaper-elevation1.css-1qkmlp`.

**Fix v0.1.3 — Línea del modal leía el valor GUARDADO, no el ajustado (verificado en DOM).** En el modal "Edit Part Number", la **ficha sigue montada DETRÁS** y aparece *antes* en el DOM; su `Línea:` es texto plano con el valor guardado. `readSingleValueByLabel(LINEA_LABEL_RE)` corría con scope = `document`, encontraba primero el de la ficha y devolvía el valor viejo, ignorando el react-select del modal con el valor ajustado-no-guardado. **Fix:** `readInputs` calcula el `modalRoot` (`[data-steelhead-component-id^="CREATE_PART_NUMBER_DIALOG"]`→`closest('[class*="MuiDialog"], [role="dialog"]')` = `MuiDialogContent-root`) y acota **metal+línea** a ese root; en la ficha (sin modal) `modalRoot=null` → lectura global como antes. La Línea del modal vive en `CREATE_PART_NUMBER_DIALOG_ACCOUNTING_DIMENSIONS`. **Verificado (2026-06-15):** sin scope → `#0 ficha T201-LI…(viejo)`; con scope → `#1 modal T111-LI…(ajustado)`. (Metal ya leía bien por el `<select id>` editable, pero se acotó por consistencia ante IDs duplicados ficha/modal.)

**Fix v0.1.4 — metal/línea viven en otra pestaña DESMONTADA (cache vía observer).** v0.1.3 acotó la lectura al diálogo, pero metal/línea están en la pestaña **DATOS GENERALES**; cuando la calc abre desde **PROCESO Y SPECS** esos campos están **desmontados** (verificado: solo existe 1 metal/1 línea en el doc, y son los de la FICHA, fuera del diálogo) → leía vacío. **No hay forma de leer el ajustado por DOM en esa pestaña.** Solución: el `MutationObserver` (que ya corre) llama `captureModalInputs()` síncrono en cada mutación; mientras estás en DATOS GENERALES (montado) lee metal (`#root_DatosAdicionalesNP_BaseMetal`, con listener `change` para captar antes de desmontar) y línea (react-select dentro de `CREATE_PART_NUMBER_DIALOG_ACCOUNTING_DIMENSIONS`) y los guarda en `_modalCache`. Al abrir la calc, `readInputs` usa `_modalCache` (el ajustado) → diálogo montado → ficha (guardado), en ese orden. `_modalCache` se resetea al cerrar el modal. Pendiente: etiquetas podrían tener el mismo patrón (hoy caen a ficha elevation0 y funcionan; cachear si se reporta).

El ícono 🧮 se ancla junto al combobox (idempotente por `dataset.saPcIcon`).

### Mapeo de datos clave
- **Línea = columna `Línea2`** del Excel (forma larga "T204-LI … (16.1)"), NO `Línea` ("Línea 16.1"). El UI muestra la larga (= dimensión oficial `GetDimension 349`: 27/29 coinciden; 2 raras quedan fuera: `T400-CE08 Barnizado`, `T500-CE04 Ensamble de Kits`). Catálogo recargado con `Línea2`.
- **inputSchemaId = 942** (tras agregar Etiqueta5/6 al schema), leído dinámico del item.

## Estado de implementación
- ✅ `matchEngine` (normStr, sameSet, findMatches, buildEntry) — tests pasan.
- ✅ `catalogStore` → artículo de inventario (RMW), cache por sesión.
- ✅ `liveCatalogs` (4 catálogos oficiales).
- ✅ `modal` UI (inputs editables, cálculo, resultado, agregar).
- ✅ `iconInjector` + `init` autoInject idempotente; combobox afinado.
- ✅ Hashes en `config.json`; semilla cargada (1,580, con `Línea2`).
- ✅ DOM adapter de inputs (Metal/Línea/etiquetas) afinado para modal + ficha.
- ⏳ Deploy (entrada `apps[]` + bump `version` + sync gh-pages) + prueba en vivo.
- ⚠️ autoInject: al deployar, el ícono 🧮 aparece para TODOS los usuarios de la extensión al editar un PN. Es defensivo (si algo falla, error en el modal, no rompe la edición). Considerar probar antes de exponer (toggle `procesoCalculatorEnabled`).

## Registro y deploy
Entrada a agregar en `config.json` `apps[]` (con bump `version`):
```json
{ "id":"proceso-calculator", "name":"Calculadora de Procesos",
  "subtitle":"Sugiere Default Process al editar un NP", "icon":"🧮",
  "category":"Números de Parte", "autoInject":true,
  "scripts":["scripts/steelhead-api.js","scripts/proceso-calculator.js"],
  "requiredPermissions":[] }
```
autoInject data-driven → **deploy 100% remoto** (script + config), sin republicar el `.zip`. Toggle: storage `procesoCalculatorEnabled` (default true).

## Plan de validación (tras wrappers + deploy)
En ambas vistas, editando un NP: ícono 🧮 aparece; 0 match → agregar → re-resuelve; 1 match → escribe combobox → Guardar NP persiste; 2+ → lista → click escribe. Edición manual re-calcula.

## Pendientes derivados
- CRUD completo (editar/eliminar) desde el modal — `deleteEntry` existe en el store, falta UI.
- Confirmar permisos: operador no-admin escribiendo `UpdateInventoryItemInputs`.
- Nombre exacto del proceso en el combobox (corto vs largo) para que `writeProcess` matchee.
- Mapeo de "Línea": el catálogo tiene `Línea` (Línea 4.0) y `Línea2` (T101-LI…); el applet usa `Línea`. Confirmar contra lo que muestra el UI del NP.
