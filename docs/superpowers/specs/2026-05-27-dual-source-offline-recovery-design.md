# Dual-source offline recovery — diseño

**Fecha:** 2026-05-27
**Estado:** aprobado por usuario (diseño v3); falta plan de implementación.
**Contexto previo:** `docs/applets/audit-incomplete-pns.md` (en particular Fix LL del 2026-05-25), `docs/applets/bulk-upload.md` § 1.5.0 / 1.5.1 (v11: `Id SH` como pivote).

## Motivación

Tras varias rondas de `audit-incomplete-pns` + recarga vía bulk-upload con el CSV de recovery, todavía quedan PNs con etiquetas / proceso / specs / predictivos / racks vacíos en Steelhead. Dos sospechas concurrentes:

1. El auditor empareja la fila CSV original con un PN distinto del que se intentó cargar (caso bug Map colapsado de 2026-05-23 + caso QuoteIBMS duplicado en SCHNEIDER ELECTRIC MEXICO).
2. La carga masiva del recovery vuelve a fallar parcialmente (timeouts intermitentes, unique-constraints, etc.).

La hipótesis del usuario, que esta spec convierte en script: descargar el reporte oficial de Steelhead (xlsx de "Validación de Carga Masiva NP"), compararlo offline contra los xlsm originales, y emitir un único xlsx en formato v11 — donde cada fila identifica el PN por **`Id SH`** (pivote directo del servidor, no por `nombre + cliente`) y trae solo las columnas con campos faltantes. La extensión v11 (bulk-upload 1.5.1) ya soporta ese pivote, así que el output es carga-directa.

Ventaja sobre `audit-incomplete-pns`: 0 fetches a SH en vivo (vs ~24k `GetPartNumber`), no hay riesgo OOM en pestaña, el matching usa Id SH cuando ya está y solo cae a fingerprint para resolver duplicados, y produce un reporte JSON con los PNs sospechosos (match dudoso) y los que requieren intervención manual (duplicate QuoteIBMS, PN inexistente en SH).

## Inputs

Tres archivos en `~/Downloads/`, descritos por el usuario el 2026-05-27:

| Archivo | Rol |
|---|---|
| `BD Numeros de Parte Reloaded v23 valores base final SRG.xlsm` | xlsm original cargado a bulk-upload (universo SRG; ~12 193 filas en hoja `Upload`) |
| `BD Numeros de Parte Reloaded v23 valores base final clientes generales.xlsm` | xlsm original cargado a bulk-upload (universo Clientes Generales; ~5 773 filas en hoja `Upload`) |
| `ING. Validación de Carga Masiva NP 2026-05-27 (1).xlsx` | reporte oficial de Steelhead (hoja única `ING. Validación de Carga Masiva`; ~24 678 filas) |

**Estructura del xlsm original** (formato v10 base, layout idéntico al de la plantilla v10 con todas las hojas auxiliares):

- Hoja relevante: `Upload`. El script ignora `Claude Log`, `Ref`, `Estrategia`, `Listas`, `CAT_*` (catálogos / metadatos).
- Rows 1-6: metadatos del layout (Empresa, Nombre Cotización, Notas Externas / Internas, etc.) — el script no las usa para datos.
- Row 7: nombres de columnas (`Cliente`, `Número de parte`, `Descripción`, `Etiqueta 1-5`, `Proceso`, etc.).
- Row 8: subheaders (`V/F`, `Texto`, `#`, `$`, `Desp.`, `Calc.`, `Calc/#`) — el script los ignora.
- Row 9 en adelante: datos.

**Estructura del reporte SH**: headers en row 1, datos desde row 2. Columnas relevantes (numeradas como aparecen en el reporte 2026-05-27):

- E (5) `Id SH`, F (6) `Cliente`, G (7) `Número de parte`, H (8) `Descripción`
- P (16) `Línea`, Q (17) `Metal base`, R-V (18-22) `Etiqueta 1-5`, W (23) `Proceso`
- Specs en cols 36-39, racks en 42-45, dimensiones en 46-53, contable en 54-55, predictivos en 56-64
- 65 `Notas adicionales`, 66-67 `QuoteIBMS`/`EstIBMS`, 68-71 `Plano`/`Piezas por Carga`/`Cargas por Hora`/`Tiempo de Entrega`

Universo combinado xlsm: 17 966 PNs. Universo SH con `Notas adicionales` no vacías: 19 200. Diferencia esperable: ~1 200 PNs de cargas anteriores con notas en otro formato.

## Discriminador de "esta ronda"

El usuario marca cada PN que sube en la ronda con un patrón estructurado en `Notas adicionales` que tiene esta forma típica:

```
F1: <Label1> | F2: <Label2> | SPECS: <spec> | DEPT: <num> | METAL: <metal> | PROC: <process> | LSPEC1: <num> | USPEC1: <num>
```

Variantes:

- `MPO:` reemplaza a `F1/F2/F3` en algunos PNs (~2-4k filas).
- `SPECIALREQ:` puede aparecer al final.
- Orden de tokens estable salvo casos puntuales.

**Heurística del filtro (`is_round_marker`)**: cumple al menos 3 de estos tokens en la cadena, separados por ` | `: `F1:`, `F2:`, `F3:`, `MPO:`, `SPECS:`, `DEPT:`, `METAL:`, `PROC:`, `LSPEC1:`, `USPEC1:`.

Las filas SH que no cumplen el filtro son **cargas anteriores** y quedan fuera de scope (no se tocan).

## Pipeline

```
1. load_xlsm_originals(srg, cg)        → xlsm_rows[] (universo "lo que se quiso cargar")
2. load_sh_report(report)              → sh_rows[] (universo SH)
3. filter_round(sh_rows)               → sh_round[] (PNs marcados como "esta ronda")
4. match(xlsm_rows, sh_round)          → matched[], unmatched_xlsm[], unmatched_sh_in_round[], duplicate_quoteibms[]
5. for each matched:
     validate_notas_adicionales       → ok | suspicious
     if ok: compute_field_diffs       → corrections[] (con id SH + deltas)
6. emit_v11_xlsx(corrections, plantilla v11)
7. emit_json_report(corrections, suspicious_matches, unmatched_xlsm, unmatched_sh_in_round, duplicate_quoteibms)
```

### Mapping de columnas — usar nombres, no posiciones

Cada uno de los 3 archivos tiene su propio orden de columnas: el xlsm original sigue layout v10, el reporte SH tiene su propio orden cercano a v11, y la plantilla v11 reordenó campos (`Línea` se movió, `Tipo de Geometría` se agregó). Por eso el script construye el mapping `{header_name → col_index}` por archivo a partir de su fila de headers (row 7 para xlsm, row 1 para reporte SH, row 7 para template v11) — **NUNCA hard-codear posiciones**. Si un header esperado no se encuentra, el script aborta con error explícito.

Lista canónica de campos a leer / escribir (nombres de header tal cual aparecen en el reporte SH, con `\n` removido):

```
Cliente, Número de parte, Descripción, PN alterno, Grupo,
Cantidad, Precio, Unidad precio, Divisa, Precio default,
Línea, Metal base, Etiqueta 1, Etiqueta 2, Etiqueta 3, Etiqueta 4, Etiqueta 5, Proceso,
Producto 1, Precio P1, Cant P1, Unidad P1,
Producto 2, Precio P2, Cant P2, Unidad P2,
Producto 3, Precio P3, Cant P3, Unidad P3,
Spec 1, Esp. Spec 1 (µm), Spec 2, Esp. Spec 2 (µm),
KGM (kg/pza), CMK (cm²/pza), LM (m/pza), Mín Pzas Lote,
Rack Flybar o Barril (Carga), Pzas/Rack Línea, Rack Específico, Pzas/Rack Sec.,
Tipo de Geometría, Longitud (m), Ancho (m), Alto (m), Diám.Ext (m), Diám.Int (m),
Departamento, Código SAT,
Plata (kg/pza), Estaño (kg/pza), Níquel (kg/pza), Zinc (kg/pza), Cobre (kg/pza),
Antitarnish (L/pza), Epóx. MT (lb/pza), Epóx. BT (lb/pza), Epóx. MTR (lb/pza),
Notas adicionales, QuoteIBMS, EstIBMS, Plano,
Piezas por Carga, Cargas por Hora, Tiempo de Entrega,
Id SH
```

**Campos esperados pero opcionales** (faltan en xlsm v10): `Línea` (en v10 está en col 51 dentro de "ASIGNACIÓN CONTABLE"), `Tipo de Geometría` (no existe en v10). El script los lee si están y los ignora si no — los maneja como vacíos en el lado xlsm si el header no se encuentra.

### Paso 4 — matching tiers

**Universo de candidatos**: `sh_round` (PNs que pasaron el filtro de Notas adicionales). El matching NO cae a `sh_rows` completo — si un PN no tiene la marca en su nota, queda fuera por diseño.

Por cada fila xlsm:

1. **Tier 1 — QuoteIBMS**: si la fila xlsm tiene `QuoteIBMS` no vacío y existe **exactamente 1** PN en `sh_round` con ese `QuoteIBMS` (case-insensitive, trim), match resuelto vía `quoteIBMS`. Si hay 0 → cae a Tier 2. Si hay ≥2 → registrar bucket en `duplicate_quoteibms[]` y caer a Tier 2 (el script no elige cuál de los duplicados es).
2. **Tier 2 — `(cliente, nombre)` exacto**: agrupar `sh_round` por `(cliente.strip().upper(), nombre.strip().upper())`. Si la fila xlsm tiene exactamente 1 candidato → match resuelto vía `composite_unique`.
3. **Tier 3 — fingerprint** (si Tier 2 devuelve ≥2 candidatos): construir fingerprint del xlsm como `metalBase.upper() + "|" + sorted_labels.join(",")` con los labels normalizados (upper + strip). Para cada candidato SH, construir el mismo fingerprint. Si exactamente 1 candidato coincide → match vía `fingerprint`. Si 0 o ≥2 → unresolved, registrar en `unmatched_xlsm[]` con razón `ambiguous_fingerprint`.

PNs en `sh_round` que no fueron matcheados por ninguna fila xlsm quedan en `unmatched_sh_in_round[]` (universo de "el reporte SH tiene la marca pero no hay xlsm que lo respalde"). Útil para auditoría manual.

### Paso 5 — validador único (Notas adicionales)

Después del match, comparar literal normalizado:

```python
def norm(s: str | None) -> str:
    if not s: return ""
    return re.sub(r"\s+", " ", s.strip().lower())

both_have = norm(xlsm.notas) != "" and norm(sh.notas) != ""
notas_match = norm(xlsm.notas) == norm(sh.notas)

if both_have and not notas_match:
    suspicious_matches.append({pn, customer, idSH, xlsm_notas, sh_notas, tier_used})
    # NO escribir nada para este PN
elif sh.notas == "" and xlsm.notas != "":
    # PN se creó parcial (notas no se cargaron); match probablemente correcto
    proceder_a_compute_diffs()
elif both vacías o match exacto:
    proceder_a_compute_diffs()
```

**Importante**: `Notas adicionales` NO se escribe nunca al output v11. Solo es validador. Decisión del usuario el 2026-05-27.

### Paso 5b — reglas mixtas (compute_field_diffs)

**Convención de escritura v10/v11 (de la plantilla, row 2)**: `Vacío ó (seleccione) = no tocar.  Guión (-) = borrar dato.`

Por lo tanto en el output:

- `""` (celda vacía) significa "no tocar" — bulk-upload deja el campo de SH como está.
- `"-"` significa "borrar el valor de SH".
- Cualquier otro valor significa "sobreescribir SH con este valor".

**Para el xlsm de input se aplica la misma convención**: si el xlsm trae `""` en una columna, el operador original quiso "no tocar" — el script no debe inferir "borrar" desde una celda vacía del xlsm. Solo si el xlsm trae `"-"` explícito y la columna es de tipo *sobreescribir*, el script propaga el `"-"` al output.

Para cada match validado, generar deltas según esta tabla, en orden de columna v11 (F-71):

| Col v11 | Campo | Acción | Lógica |
|---|---|---|---|
| F | Cliente | nunca | llave; redundancia visual en output |
| G | Número de parte | nunca | llave; redundancia visual en output |
| H | Descripción | conservador | escribir xlsm.value solo si `norm(sh.value) == ""` y `xlsm.value not in {"", "-"}` |
| I | PN alterno | conservador | id. |
| J | Grupo | conservador | id. |
| K | Cantidad | nunca | sensible comercialmente |
| L | Precio | nunca | id. |
| M | Unidad precio | nunca | id. |
| N | Divisa | nunca | id. |
| O | Precio default | nunca | id. |
| P | Línea | conservador | id. a Descripción |
| Q | Metal base | conservador | id. |
| R-V | Etiqueta 1-5 | **sobreescribir** | Comparar como sets normalizados (`upper().strip()`). `xlsm_labels = {l1,l2,l3,l4,l5} \ {""}`, `sh_labels = idem`. Si `xlsm_labels == sh_labels` → no escribir. Si difieren → escribir las cols R-V con los labels del xlsm en posiciones 1..k del xlsm y dejar **vacías** las posiciones que sobran. **CAVEAT a verificar en implementación**: el comportamiento de bulk-upload v11 ante `[A, B, C, "", ""]` cuando SH tiene 5 etiquetas (A, B, C, X, Y) no está documentado — puede interpretarlo como "agregar A,B,C y dejar X,Y" o como "solo A,B,C son válidas". Si el comportamiento es lo primero y queremos borrar X,Y, hay que escribir `-` explícito en las cols 4 y 5. Decisión por defecto: escribir solo las etiquetas que SH no tenga (subset que falta) → no borrar las extras. Si las extras son problemáticas, flaggear en JSON report como `extra_labels_in_sh` para revisión manual. |
| W | Proceso | **sobreescribir** | si `norm(sh.proceso) != norm(xlsm.proceso)` y `xlsm.proceso not in {"", "-"}` → escribir xlsm. Si `xlsm.proceso == "-"` → escribir `-`. Si SH vacío y xlsm tiene proceso → escribir. |
| X-Y-Z-AA | Producto 1 + Precio/Cant/Unidad | nunca | parte de cotización |
| AB-AC-AD-AE | Producto 2 + Precio/Cant/Unidad | nunca | id. |
| AF-AG-AH-AI | Producto 3 + Precio/Cant/Unidad | nunca | id. |
| AJ | Spec 1 | **sobreescribir** | si difieren → escribir xlsm. `""` en xlsm no provoca borrado. |
| AK | Esp. Spec 1 (µm) | sobreescribir | comparar numérico con tolerancia `1e-6` |
| AL | Spec 2 | **sobreescribir** | id. a Spec 1 |
| AM | Esp. Spec 2 (µm) | sobreescribir | id. a Esp. Spec 1 |
| AN | KGM (kg/pza) | sobreescribir | si difieren numéricamente (tol `1e-6`) → escribir xlsm |
| AO | CMK (cm²/pza) | sobreescribir | id. |
| AP | LM (m/pza) | sobreescribir | id. |
| AQ | Mín Pzas Lote | conservador | – |
| AR | Rack Flybar o Barril (Carga) | conservador | – |
| AS | Pzas/Rack Línea | conservador | – |
| AT | Rack Específico | conservador | – |
| AU | Pzas/Rack Sec. | conservador | – |
| AV | Tipo de Geometría | conservador | – |
| AW-AX-AY-AZ-col53 | Longitud / Ancho / Alto / Diám.Ext / Diám.Int | conservador | tol `1e-6` para el comparador |
| col54 | Departamento | conservador | – |
| col55 | Código SAT | conservador | – |
| col56-col64 | Predictivos (Plata, Estaño, Níquel, Zinc, Cobre, Antitarnish, Epóx MT, Epóx BT, Epóx MTR) | **sobreescribir** | si difieren numéricamente (tol `1e-6`) → escribir xlsm. Si SH tiene predictive y xlsm no (vacío) → **no escribir** (la convención dice vacío en xlsm = no tocar). Si xlsm tiene `-` explícito → propagar `-`. |
| col65 | Notas adicionales | **NUNCA** | validador del match, no campo del recovery |
| col66 | QuoteIBMS | sobreescribir | identificador IBMS |
| col67 | EstIBMS | sobreescribir | id. |
| col68 | Plano | sobreescribir | custom input IBMS |
| col69 | Piezas por Carga | sobreescribir | id. (numérico, tol `1e-6`) |
| col70 | Cargas por Hora | sobreescribir | id. |
| col71 | Tiempo de Entrega | sobreescribir | id. |

**Resumen de la lógica**:

- `xlsm == "" ` en columna conservadora o sobreescribir → no escribir nunca en el output.
- `xlsm == "-"` en columna sobreescribir → propagar `"-"` (borrar) si SH tiene valor.
- `xlsm != ""` en columna conservadora → escribir solo si SH vacío.
- `xlsm != ""` en columna sobreescribir → escribir si difiere de SH.
- columna *nunca* → no escribir nunca.

**Output por PN**: una fila en el xlsx v11 con:

- col E (`Id SH`) = pivote (obligatorio)
- col F (Cliente) = referencia visual (no se usa para escritura)
- col G (Número de parte) = referencia visual
- col H (Descripción) = solo si vamos a escribir descripción; vacío si no
- demás columnas: valor (`= sobreescribir o agregar`), `-` (`= borrar`), o vacío (`= no tocar`).

Si para un PN matchado y validado **no hay ningún campo a corregir**, el PN se omite del xlsx (no genera una fila vacía con solo Id SH).

### Paso 6 — emit_v11_xlsx

- Cargar `remote/templates/Plantilla_Cotizaciones_v11.xlsm` como template base (con sus 8 rows de header intactas).
- Llenar metadatos row 3 (Nombre Cotización/Layout, etc.) con un valor explicativo: `"Recovery dual-source 2026-05-27"`.
- Insertar 1 fila por correction a partir de row 9.
- Guardar como `recovery_dualsource_<timestamp>.xlsm` en el cwd o ruta indicada por `--out-xlsx`.

**Nota técnica**: para no romper VBA / macros del .xlsm, mejor abrir el template con `openpyxl` con `keep_vba=True`. Si openpyxl no preserva macros 100%, fallback: emitir `.xlsx` plano (la extensión sigue parseando v11 como xlsx — los macros no son requeridos para bulk-upload).

### Paso 7 — emit_json_report

Estructura:

```json
{
  "generated_at": "2026-05-27T...",
  "inputs": { "srg_xlsm": "...", "cg_xlsm": "...", "sh_report": "..." },
  "counts": {
    "xlsm_rows_total": 17966,
    "sh_rows_total": 24678,
    "sh_rows_in_round": 17800,
    "matched": 17500,
    "suspicious_matches": 80,
    "unmatched_xlsm": 386,
    "unmatched_sh_in_round": 300,
    "duplicate_quoteibms_buckets": 22,
    "corrections_emitted": 1450
  },
  "field_correction_counts": {
    "etiquetas": 320,
    "proceso": 180,
    "specs": 95,
    "predictivos": 612,
    "...": "..."
  },
  "corrections": [ { "idSH": 2300153, "customer": "...", "pn": "...", "tier": "quoteIBMS", "diffs": [{"field": "Proceso", "xlsm": "...", "sh": ""}, ...] } ],
  "suspicious_matches": [ { "idSH": ..., "tier": "composite_unique", "notas_xlsm": "...", "notas_sh": "..." } ],
  "unmatched_xlsm": [ { "pn": "...", "customer": "...", "quoteIBMS": "...", "reason": "no_pn_in_sh_round" | "ambiguous_fingerprint" | "duplicate_quoteibms" } ],
  "unmatched_sh_in_round": [ { "idSH": ..., "pn": "...", "customer": "...", "notas": "..." } ],
  "duplicate_quoteibms": [ { "quoteIBMS": "...", "candidates": [ { "idSH": ..., "pn": "...", "customer": "..." }, ... ] } ]
}
```

## Entregables

1. **`tools/dual-source-recovery.py`** — script Python 3.10+ con CLI:
   ```
   python3 tools/dual-source-recovery.py \
     --srg-xlsm  "/Users/.../SRG.xlsm" \
     --cg-xlsm   "/Users/.../clientes generales.xlsm" \
     --sh-report "/Users/.../ING. Validación de Carga Masiva NP 2026-05-27 (1).xlsx" \
     --template  "remote/templates/Plantilla_Cotizaciones_v11.xlsm" \
     --out-xlsx  "recovery_dualsource_2026-05-27T22-30-00.xlsm" \
     --report-json "dualsource_report_2026-05-27T22-30-00.json"
   ```
   - Dependencias: `openpyxl` (instalable con `pip3 install openpyxl`). Sin otras dependencias externas.
   - CLI v1: 2 paths fijos (`--srg-xlsm` / `--cg-xlsm`). Extensible a `--xlsm path*` en versión futura si se necesita.
   - Idempotente: 2 corridas con mismos inputs → mismos outputs (orden estable de filas en el xlsx por `(cliente, pn)`; sin timestamps internos en el JSON salvo el campo `generated_at`).
   - Logs en stderr; resumen final por categoría (corrections, suspicious, unmatched, duplicates) en stdout.

2. **`docs/applets/dual-source-recovery.md`** — bitácora del nuevo tool (formato igual a `audit-incomplete-pns.md`): lecciones, validaciones, pendientes derivados.

3. **Entry nueva en `CLAUDE.md`** índice de applets:
   `| dual-source-recovery (tools/, no extensión) | 1.0.0 | docs/applets/dual-source-recovery.md |`

## Plan de validación

Antes de cargar el xlsx de output:

1. **Pre-flight de filtro**: el script imprime cuántas filas SH pasaron el filtro `is_round_marker` vs cuántas xlsm hay. Si la cobertura xlsm→sh-round es < 90% (es decir, > 10% de xlsm rows no encuentran su PN marcado), abortar y revisar el regex.
2. **Spot-check manual**: tomar 5 PNs random de `corrections[]`, abrir cada uno en la UI de Steelhead (URL `/part-numbers/<idSH>`), verificar que los campos que el JSON lista como `sh: ""` están efectivamente vacíos en la UI, y que el valor del xlsm corresponde al PN.
3. **Conteo sanity**: `corrections_emitted` debe ser razonablemente menor o igual a `audit-incomplete-pns` última corrida (el offline encuentra los mismos huecos, salvo casos legítimos donde el audit falla por homónimos).
4. **Carga piloto**: tomar las primeras 50 filas del output, cargar en bulk-upload v11 con `Id SH` como pivote, verificar 5 PNs en UI post-carga (los campos faltantes ahora deben aparecer).

## Edge cases conocidos

- **PN en xlsm pero no en sh_round**: el PN nunca se creó en SH, o se creó sin la marca de notas. Va a `unmatched_xlsm[].reason="no_pn_in_sh_round"`. Acción manual: carga completa (no recovery).
- **PN en sh_round pero no en xlsm**: la marca quedó en SH pero no hay xlsm que lo respalde. Va a `unmatched_sh_in_round[]`. Acción manual: revisar si es un PN huérfano o si pertenece a otra ronda.
- **Duplicate QuoteIBMS**: 2+ PNs en SH comparten QuoteIBMS no vacío. Va a `duplicate_quoteibms[]`. Acción manual: DELETE en SH del PN incorrecto antes de re-correr el script.
- **Sospechoso por Notas**: el match resolvió por Tier 1/2/3 pero las notas SH difieren del xlsm. Va a `suspicious_matches[]`. Acción manual: revisar si es match correcto + nota editada manualmente (raro), o match incorrecto. Si es lo segundo, el PN nunca cargó las notas → buscar el PN correcto por composite/fingerprint a mano.
- **Predictivo numérico con decimales distintos por formato xlsm**: comparar con tolerancia `1e-6` (no por string).
- **Etiquetas con orden distinto entre xlsm y SH**: comparar como `set`, no como lista ordenada.
- **`-` en xlsm como valor a borrar**: si el xlsm tiene `-` en una columna conservadora, **no propagar al output** (asume que el usuario ya lo decidió y el comportamiento del recovery es solo llenar huecos). Si está en una columna sobreescribir y el campo en SH tiene valor → propagar `-` al output (borrar).
- **Notas adicionales con caracteres especiales (`µ`, `_x000D_`, etc.)**: `norm()` colapsa whitespace pero preserva caracteres. Verificar que `µm` no genere falsos sospechosos.

## Out of scope

- No corregir cotizaciones (Productos 1–3, precios). Si una cotización está mal, se atiende fuera de este flujo.
- No detectar PNs duplicados por `(cliente, nombre)` sin QuoteIBMS distinto (eso es trabajo de `audit-incomplete-pns` standalone dup-scan).
- No automatizar la carga del xlsx de output. El usuario corre la extensión manualmente.
- No tocar la rama `gh-pages` ni `remote/`. Este tool vive solo en `tools/` (local).

## Riesgos

- **El filtro `is_round_marker` puede excluir un PN legítimo** de esta ronda si la nota se cortó / quedó con formato distinto. Mitigación: pre-flight de cobertura (paso 1 del plan de validación) lo detecta y permite ajustar el regex.
- **Match Tier 3 (fingerprint) puede equivocarse** si dos PNs distintos comparten metalBase + labels exactos (común en SCHNEIDER). Mitigación: el validador de Notas adicionales atrapa ~todos esos casos como suspicious. Riesgo residual: ambos PNs comparten también notas → el script los daría como match resuelto y podría escribir en el PN equivocado. Probabilidad estimada: < 0.1% (notas con DEPT + SPECS + PROC son altamente discriminantes).
- **Predictivos con unidades diferentes**: el xlsm usa kg/pza, lb/pza, L/pza según el material. Verificar que el reporte SH preserva la unidad (cols 56-64 incluyen unidad en el header).
- **Carga del output con bulk-upload v11** todavía no se ha estresado con un xlsx 100% por Id SH. Validar piloto antes de carga masiva.

## Decisiones pendientes (none)

Diseño aprobado por usuario el 2026-05-27. Listo para writing-plans.
