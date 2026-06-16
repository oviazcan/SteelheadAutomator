# Applet: `proceso-calculator` — Calculadora de Procesos

**Versión actual:** 0.1.1 (DEPLOYADO a gh-pages, config 1.6.67 — fix: filtro de etiquetas de cliente)
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

## Sincronización inversa: SH → Excel (catalog-fetcher + RefrescarListas V13)

Desde 2026-06-15 (config `1.6.68`) la hoja `CAT_Procesos` de la plantilla **deja de ser
fuente de verdad local**: se reconstruye desde el artículo de inventario `900192` al
"Actualizar Catálogos". Así, las combinaciones que la Calculadora agrega en vivo
(`addOrUpdateEntry` → `customInputs.CatProcesos`) se propagan de vuelta al Excel.

**Flujo:**
```
Calculadora (proceso-calculator) ──escribe──▶ inventario 900192 (customInputs.CatProcesos)
                                                      │
                "Actualizar Catálogos" (catalog-fetcher.fetchCatProcesos)
                                                      │  GetInventoryItem {id:900192}
                                                      ▼
                 hoja "CAT_Procesos" en Catalogos_Steelhead_*.xlsx
                 (Linea | MetalBase | Etiqueta1..6 | Proceso)
                                                      │
                       RefrescarListas V13 (Module2.txt, CargarCatProcesosDesde)
                                                      ▼
                 ListObject Tabla1 (CAT_Procesos!A..G):
                   D=Linea, E=MetalBase, F=join(Etiqueta1..6," + "), G=Proceso
                   A/B/C (Grupo/Característica/Línea corta) = vacías
```

**Decisiones / hallazgos (validados sobre `Plantilla_CargaMasiva_v12.xlsm`):**
- Ninguna fórmula de la plantilla usa A/B/C. El cálculo del proceso (`Upload!U9:U508` y
  `CAT_Procesos!M2`) solo lee **D (Línea2), E (Metal Base), F (Etiquetas), G (Proceso)** —
  exactamente lo que SH guarda. Por eso A/B/C quedan vacías sin romper nada (decisión del
  usuario 2026-06-15: "dejarlas vacías").
- La 5ta/6ta etiqueta del catálogo (40 filas con 5, 3 con 6) son de **acabado real**
  (Lavado, Enmascarado, Cromo Duro, Horno, Desenmascarado, Fibrado), NO la "Planta
  Schneider" (esa vive en el Upload, columna T, y nunca entró al catálogo). Por eso F se
  reconstruye con TODAS las etiquetas no vacías (1..6).
- **Round-trip lossless**: simular `split(F," + ")`→`Etiqueta1..6`→`join(" + ")` reproduce
  F exacto en las 1580 filas; D/E/G se preservan; 0 overflow de 6 slots. (Asume que la
  siembra preservó el orden de F al hacer split — confirmar en la 1ª corrida en vivo
  comparando F antes/después.)
- `CAT_Procesos` es un **ListObject `Tabla1` (A1:G1581)**; `CargarCatProcesosDesde` lo
  **redimensiona** (`lo.Resize`) al nº de combinaciones y limpia residuo si encoge. Las
  fórmulas auxiliares I2:O2 viven **fuera** de la tabla → no se tocan.
- Aplica a **ambas plantillas** (moderna v12 + compatibilidad 2019): misma hoja y misma
  `Tabla1`. El VBA solo escribe datos A..G, no fórmulas.

**Pendiente de aplicación:** el VBA del `.xlsm` se edita en Excel (no con openpyxl). Editado
el fuente `vbas/Module2.txt` (Macro `RefrescarListas` V13 + `CargarCatProcesosDesde`); falta
que el usuario lo pegue en ambas plantillas y las regenere. El `catalog-fetcher.js` ya
deploya remoto (config `1.6.68`).

## DOM — selectores (AFINADOS modal + ficha)

| Campo | Modal | Ficha |
|---|---|---|
| **Default Process** | react-select: `input[role="combobox"]` en `[class*="-control"]`; valor en `[class*="singleValue"]`. `writeProcess()` = click → setter nativo + InputEvent → opciones → click. | igual |
| **Metal base** | `<select id="root_DatosAdicionalesNP_BaseMetal">` (RJSF nativo) → texto de la opción. | mismo `<select>` (con `disabled`, igual se lee `selectedIndex`). |
| **Línea** | react-select `singleValue` tras `<p>Línea:</p>` (forma larga). | `<p>` de texto plano hermano del label → `readSingleValueByLabel` captura texto plano. |
| **Etiquetas** | `[data-steelhead-component-id="CREATE_PART_NUMBER_DIALOG_LABELS"]` → chips por `svg[data-testid="CloseIcon"]` (parentElement). | chips de solo lectura `.css-1owv9dy` (sin CloseIcon) en el encabezado. |

Etiquetas: se filtran `nonFinishLabelNames` (SRG, SMY, "En desarrollo", …) + dedup.

**Fix v0.1.1 — etiquetas de cliente vs de acabado.** El fallback de la ficha usa el selector **global** `.css-1owv9dy`, que captura *cualquier* chip de la página — incluidas las **etiquetas de CLIENTE** ("Industrial", "Automotriz", "Activo"), que NO son de acabado del NP y confundían el matching. `nonFinishLabelNames` solo cubre labels administrativos, no las de cliente. **Solución (data-driven, sin adivinar DOM):** en `openModal`, tras cargar `live`, se filtran las etiquetas leídas contra el **catálogo oficial de acabado** (`live.etiquetas` = `AllLabels(forPartNumber:true)` − `nonFinishLabelNames`). Las de cliente NO son `forPartNumber:true`, así que caen fuera del set y se descartan (se loguea cuáles). Guardado: si el catálogo no cargó, no se filtra (degradado, no roto). El mismo discriminador que usa `bulk-upload` para validar labels de NP.

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
