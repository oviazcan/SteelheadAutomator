# `dual-source-recovery` — bitácora

Tool standalone (`tools/dual_source_recovery.py`) que cruza los xlsm
originales de bulk-upload contra el reporte oficial de Steelhead y emite un
xlsx v11 de recovery donde cada PN se identifica por **Id SH** (pivote directo).

## 1.0.5 — 2026-05-28 — Limpiar PARÁMETROS A..D (no emitir toggles V/F)

### Causa root (incidente 2026-05-28, post-mortem de la corrida del recovery)
La corrida de `recovery_dualsource_v104.csv` aplicó correctamente las
correcciones de Proceso/Metal base/specs, **pero** desarchivó masivamente
**10,842 PNs** sin que el CSV lo pidiera. La cadena de causa fue:

1. `Plantilla_Cotizaciones_v11.xlsm` trae las primeras ~500 filas de data con
   los 4 toggles PARÁMETROS pre-poblados: `A='F'` (Archivado=No), `B='V'`
   (Validación 1er recibo), `C='F'` (Forzar duplicar), `D='F'` (Archivar
   anterior).
2. `emit_v11_xlsx` (≤ v1.0.4) sólo escribía las llaves (Id SH/Cliente/PN) y
   los campos de `FIELD_RULES`; **no limpiaba col A..D**. Las primeras 351
   filas del v104.xlsm quedaron con `Archivado='F'` heredado del template
   (las demás filas — más allá de ~500 — quedaron vacías porque el template
   no las pre-llena).
3. `emit_v11_csv` propagó esas 351 "F" + 15,991 vacíos al CSV.
4. **bulk-upload v11** (`bulk-upload.js:5841-5848` STEP 8) interpreta tanto
   "F" como **vacío** del mismo modo: `if (!part.archivado && status ==
   'existing') pnsToUnarchive.push(...)`. Es decir, **cualquier fila** del
   CSV con un PN existing entró a la lista de desarchivar. La corrida marcó
   "16,342 desarchivar" en STEP 8 y completó 10,842 (los que efectivamente
   estaban archivados pre-run en SH).

El bug del v11 template/bulk-upload (tratar "Archivado vacío" como "F
explícito") es real y debería arreglarse por separado, pero la mitigación
inmediata es del lado del recovery: **no emitir nunca esos 4 toggles en modo
diff**. El recovery no quiere instruir archivado/validación/dup — sólo
corregir Proceso/Metal base/etc.

### Cambios
- `emit_v11_xlsx`: resolver columnas de PARÁMETROS por header (`Archivado`,
  `Validación\n1er recibo`, `Forzar\nduplicar`, `Archivar\nanterior`, con
  fallback sin `\n` por si algún extractor normaliza) y limpiarlas a `None`
  en cada data row, igual que ya se hace con Etq 1-5 y Metal base.
- Fail-fast: si algún header no se resuelve, levanta `ValueError`.
- 1 test nuevo: `test_clears_parametros_cols_a_to_d_when_no_diff` — corrida
  E2E que crea una correction con un único diff de Proceso y valida que
  col 1..4 de la fila emitida quedan en blanco.
- 81/81 tests passing (80 previos + 1 nuevo).

### Notas operativas
- El `v104.csv` ya subido **NO se regenera** — los 16,342 desarchivados ya
  están aplicados; la mitigación es por DevTools selectivo (re-archivar
  según col `Archivado=V` de los XMLs originales).
- Para la próxima corrida (si hay otra), regenerar el recovery con v1.0.5
  para garantizar que el CSV no traiga toggles.
- Pendiente independiente: ¿debe `bulk-upload v11` distinguir "Archivado
  vacío" (no tocar) de "Archivado=F" (desarchivar)? Hoy los trata igual.
  Cambiarlo requiere bump de schema y migración del template.

## 1.0.4 — 2026-05-28 — Emisión nativa de CSV (`--out-csv`)

### Motivación
Bulk-upload v11 come CSV. El usuario no quería el paso intermedio "abrir xlsm
en Excel → Save As CSV" para cada recovery; quería que el script emitiera CSV
directo. Además ya teníamos el conversor ad-hoc `/tmp/v104_to_csv.py` que
funcionaba — sólo había que portarlo al script.

### Cambios
- `emit_v11_csv(xlsm_path, out_csv_path) -> {rows_written, data_rows}`: toma
  el xlsm ya emitido por `emit_v11_xlsx` y lo serializa a CSV.
  - utf-8, `,` separador, `"` quote, CRLF line terminator (idéntico al export
    "Save As CSV" de Excel — formato que bulk-upload espera).
  - Conserva filas 1-8 de metadata/headers; `parseRows()` de bulk-upload las
    salta sola por strings reservados (`PARÁMETROS`, `Archivado`, `V/F`,
    `Texto`, `Número de parte`).
  - Defensa en profundidad: re-limpia `(seleccione)` / `(seleccione o escriba)`
    a `''` (emit_v11_xlsx ya los limpia en Etq 1-5 y Metal base; este chequeo
    cubre cualquier columna futura).
  - Trunca trailing empties de cada fila para no escribir 70 comas vacías.
  - Floats integrales se escriben sin `.0` (importante para QuoteIBMS y otros
    IDs enteros camuflados como `float`).
- `_cell_to_csv(value)`: helper puro, sin estado, testeable independientemente.
- CLI: nuevo flag opcional `--out-csv PATH`. Si se pasa, el script emite CSV
  además del xlsm en la misma corrida.
- 1 test nuevo en `TestEmitV11Xlsx`:
  - `test_emit_v11_csv_writes_data_and_skips_placeholders`: corrida E2E
    (xlsx → csv) con una correction que tiene `Metal base` + `Proceso`, valida
    que la fila CSV en col 16/22 trae los valores correctos y que ningún
    placeholder se filtró en ninguna columna.
- 80/80 tests passing (79 previos + 1 nuevo).

### Uso
```bash
python3 tools/dual_source_recovery.py \
    --srg-xlsm SRG.xlsm \
    --cg-xlsm  CG.xlsm \
    --sh-report report.xlsx \
    --template remote/templates/Plantilla_Cotizaciones_v11.xlsm \
    --out-xlsx recovery.xlsm \
    --out-csv  recovery.csv \
    --report-json report.json
```

### Plan de validación
1. Re-run completo con `--out-csv` → comparar byte-a-byte el CSV emitido contra
   el output de `/tmp/v104_to_csv.py` sobre el mismo xlsm: deben ser idénticos.
2. Cargar el CSV directo en bulk-upload 1.5.7+ → verificar parse sin errores y
   data_rows reportadas coinciden con `corrections_emitted` del report JSON.
3. Confirmar que las filas 1-8 de metadata no rompen `parseRows()` (ya lo
   manejan, pero verificar en run real con 16k filas).

### Pendientes derivados
- [ ] Considerar flag opcional `--csv-only` (no emitir xlsm si solo se necesita
  CSV) — para corridas muy grandes el xlsm es ~1.3MB y el csv ~3.7MB, no es
  problema ahorrar el xlsm pero sería más rápido y consume menos disco.
- [ ] Validar que el CSV abre limpio en Excel también (algunos users prefieren
  inspeccionarlo antes de cargar) — caracteres con tildes en UTF-8 sin BOM
  pueden mostrarse mojibake en Excel for Windows; considerar BOM opcional.

---

## 1.0.3 — 2026-05-28 — Metal base ACTION_OVERWRITE + limpiar `(seleccione o escriba)`

### Motivación
Al abrir `recovery_dualsource_v103.xlsm` (output de 1.0.2 sobre el run completo
de 16,491 corrections) en Excel, la columna `Proceso` mostraba **149 celdas
con "Combinación no existente"**. El usuario reportó: *"ya habíamos dejado 0
combinaciones no existentes"* en sus BD, así que el CNE no podía venir del dato.

Investigación reveló el flujo real:

1. Las dos BD xlsm (SRG + Generales) tienen CERO CNE en sus filas de datos
   (`Upload!A9:end`). El único string "Combinación no existente" vive en
   `Upload!U3` y `Upload!W3` como **token marcador** que usa la fórmula LAMBDA
   del template para decidir qué mostrar cuando la tripleta
   `(Metal base, Etiquetas, Línea)` no resuelve contra `CAT_Procesos`.
2. v103.xlsm tampoco tenía CNE como valor estático en `Proceso` — la columna
   son strings simples (sin fórmulas; verificado scaneo).
3. **Los 149 CNE se calculan en tiempo de apertura de Excel** por la fórmula
   LAMBDA + VBA del template. Cuando `Metal base = '(seleccione o escriba)'`,
   la fórmula no resuelve la tripleta → output = token CNE.
4. Diff v103 vs BD (matcher PN+cliente tokens) mostró que **351 filas** tenían
   `Metal base = '(seleccione o escriba)'` literal. Esas 351 son superset de
   los 149 CNE — el resto (~202) la fórmula sí resolvió de otra forma o no
   se evaluó (e.g., labels también vacías).

Root cause: la regla `FIELD_RULES["Metal base"] = ACTION_CONSERVATIVE` sólo
emitía un diff cuando SH tenía Metal base vacío. Cuando SH ya tenía valor
(la mayoría), recovery dejaba la celda intacta → el template pre-llena con
`(seleccione o escriba)` → openpyxl no la sobreescribe → la fórmula CNE
dispara al abrir. Mismo patrón que el Bug B de las etiquetas en 1.0.2, pero
en otra columna y con otra regla.

### Cambios
- `FIELD_RULES`: `Metal base` cambia de `ACTION_CONSERVATIVE` a
  `ACTION_OVERWRITE`. Justificación documentada inline: **BD es la fuente de
  verdad para Metal base** (el usuario valida manualmente las dos BD; si SH
  trae un Metal base distinto al de BD, gana BD). Esta decisión es coherente
  con el resto de campos críticos (`Proceso`, `Spec 1`, `Spec 2`, KGM, CMK, LM,
  componentes de baño) que ya eran OVERWRITE.
- `emit_v11_xlsx`: resuelve `metal_base_col = headers.get("Metal base")` y
  limpia esa celda con `value = None` SIEMPRE, antes del loop de diffs —
  análogo al patrón de etiquetas. Si el diff tiene Metal base, se vuelve a
  llenar con el valor BD; si no, queda en `None` y la fórmula del template
  recibirá string vacío en vez del placeholder.
- Tests pendientes a agregar en `TestEmitV11Xlsx`:
  - `test_clears_metal_base_placeholder_when_no_diff`: correction sin diff de
    Metal base, columna Q debe quedar limpia (no `(seleccione o escriba)`).
  - `test_writes_metal_base_when_diff_present`: correction con diff
    `{field:"Metal base", xlsm:"Cobre", action:"overwrite"}` → columna Q debe
    quedar en `"Cobre"`.

### Hot-fix retroactivo v103 → v104
Mientras este parche se valida con un re-run completo, se generó v104 in-place
con `/tmp/patch_v103_to_v104.py`:
- Carga ambas BD por (QuoteIBMS) y (PN, tokens cliente).
- Recorre v103 fila a fila; para cada fila con `Metal base` placeholder, busca
  primero por QuoteIBMS (matcher de tier-1 idéntico al script); si no, fallback
  por PN + token overlap del cliente.
- Resultado del run: 351/351 placeholders resueltos vía tier-2 (PN+tokens) —
  tier-1 hit 0 porque las 351 filas en v103 no traían QuoteIBMS poblado en la
  columna correspondiente (efecto del mismo bug de template intermedio).
- v104 preserva VBA (`keep_vba=True`). Plan: el usuario abre v104 en Excel y
  cuenta CNE → debería bajar de 149 a 0 (o cerca, si quedan filas con labels
  faltantes).

### Plan de validación
1. Re-run completo con script v1.0.3: `recovery_dualsource_v104_full.xlsm`.
2. Abrir en Excel, contar CNE en columna `Proceso` → esperado 0.
3. Comparar field_correction_counts vs 1.0.2: `Metal base` debe pasar de
   skip-cuando-SH-no-vacío a contar diffs reales cuando BD != SH.
4. Cargar por bulk-upload 1.5.7+ → verificar logs sin warnings de Metal base.
5. Spot-check 5 PNs post-carga: Metal base en SH = valor de BD.

### Pendientes derivados
- [ ] Agregar 2 tests nuevos en `TestEmitV11Xlsx` (Metal base preservación y
  limpieza).
- [ ] Considerar mover Línea y Departamento a ACTION_OVERWRITE también — son
  campos donde BD debería ganar y mismo patrón de template default podría
  estar latente.
- [ ] Hash visual rápido en el output del script: contar celdas con
  `(seleccione*)` literal después de save y warning si > 0.

---

## 1.0.2 — 2026-05-28 — Preservar casing de etiquetas + limpiar `(seleccione)`

### Motivación
Piloto string-only (50 PNs) cargado vía bulk-upload 1.5.3 falló en TODAS las
etiquetas. Log del applet:
```
[SA] WARN: ⚠️ 20 etiqueta(s) en el CSV no existen en el catálogo de Steelhead:
    NÍQUEL SULFAMATO, PLATA, ESTAÑO, BRIGHT DIP, ZINC, ...
[SA] ERRORES: 50
```

Investigación reveló dos bugs separados en el tool:

**Bug A — Casing destruido**: `_norm_labels()` aplicaba `.upper()` sobre cada
etiqueta. El xlsm fuente las tiene en **Title Case** (`Plata`, `Estaño`, `Zinc`,
`Cromato Claro Azul (Iridiscente)`, `Lavado de Bimetales`, `Tratamiento Térmico`)
y el catálogo de Steelhead (`AllLabels`) también está en Title Case. El applet
hace `labelByName.has(name)` **case-sensitive** → `labelByName.has("PLATA")`
retorna `false` aunque exista `"Plata"`. Resultado: 20 etiquetas únicas
rechazadas en los 50 PNs.

**Bug B — `(seleccione)` residual**: la plantilla v11 viene con `'(seleccione)'`
literal en todas las celdas de `Etiqueta 1-5` (placeholder visual). Mi código
hacía `ws.cell(row=r, column=col, value=lab if lab else None)`, pero cuando
`lab == ""` y el slot intermedio queda en `None`, **openpyxl no sobreescribe en
ese caso** y `(seleccione)` persiste. Caso concreto observado: PN `48000-004-01`
con `xlsm_labels = ['Lavado de Bimetales', 'Tratamiento Térmico', 'Estaño', '', 'STX']`
quedó con pos 4 = `'(seleccione)'` (literal cargado al applet).

### Cambios
- `_norm_labels()` ya NO aplica `.upper()`. Solo strip por slot, preserva
  casing original. Docstring actualizado explicando por qué.
- `_label_set()` ahora aplica `.upper()` internamente para comparación
  case-insensitive (la responsabilidad se movió de `_norm_labels`).
- `emit_v11_xlsx()` limpia las 5 columnas de etiqueta SIEMPRE antes de
  escribir (línea por línea): `ws.cell(row=r, column=col).value = None`.
  Luego escribe solo los slots con valor real.
- 3 tests nuevos en `TestEmitV11Xlsx`:
  - `test_preserves_label_casing`: input `'Plata'` → output `'Plata'` (no `'PLATA'`).
  - `test_clears_seleccione_placeholder_in_empty_slots`: caso con hueco
    intermedio (`['A', 'B', 'C', '', 'STX']`), pos 4 debe quedar vacía.
  - `test_clears_label_cells_when_correction_has_no_labels_diff`: correction
    sin `_labels_` diff, las 5 columnas deben quedar limpias.
- 77/77 tests passing.

### Regeneración piloto
Counts del reporte 1.0.2 idénticos a 1.0.1 (16,491 corrections, 12 suspicious)
— el cambio es de *output*, no de *decisión*. Inspección del nuevo
`recovery_pilot_50_v102.xlsm`:
- r9: `['Lavado de Bimetales', 'Tratamiento Térmico', 'Estaño', None, 'STX']` ✓
- r10: `['Plata', None, None, None, None]` ✓
- r16: `['Zinc', 'Cromato Claro Azul (Iridiscente)', None, None, None]` ✓

### Plan de validación
1. Recargar nuevamente `~/Downloads/recovery_pilot_50_v102.xlsm` con
   bulk-upload 1.5.3 ya deployado.
2. Verificar log: `⚠️ N etiqueta(s) en el CSV no existen` → debe bajar de 20 a 0
   (o cerca, si quedan típos legítimos).
3. Verificar log: `ERRORES: 50 → 0` (o cerca).
4. Verificar panel: 50 MODIFY directos, 0 decisiones pendientes (regresión
   anti-1.5.3).
5. Spot-check 3 PNs post-carga en SH → etiquetas deben quedar aplicadas.

### Pendientes derivados (heredados, no urgentes)
- [ ] Tolerancia relativa por campo en numéricos predictivos (1.0.3?).
- [ ] Normalizar `DEPT: N.0` → `DEPT: N` en `_notas_canon` para bajar de 12
  suspicious a 1.

---

## 1.0.1 — 2026-05-28 — Validador de notas realista + reporte sin truncamiento

### Motivación
El smoke 1.0.0 reportó 11,263 `suspicious_matches`. Auditoría posterior mostró
que el 99.7% eran **ruido técnico**, no discrepancias semánticas:
- 87.3% `_x000D_\n` artifact de Excel multilínea que SH no preserva.
- 9.8% truncamiento por longitud distinto del campo Notas adicionales (la nota
  es la misma, solo cortada en distinto punto).
- 2.5% **artefacto del propio reporte**: `emit_json_report` truncaba
  `notas_xlsm`/`notas_sh` a 300 chars, lo que hacía que el análisis posterior
  pensara que faltaban claves (`LSPEC1`, `USPEC1`, etc.) cuando solo estaban
  más allá del cap. El validador interno sí usaba notas completas; era un bug
  de evidencia, no de decisión.

### Cambios
- `_notas_canon()` nueva helper: aplica `norm()` + quita `_x000D_` (regex case-insensitive).
- `validate_notas()` ahora marca `suspicious` solo si tras `_notas_canon` los
  dos strings difieren **y** ninguno es prefijo del otro.
- `emit_json_report` ya no trunca a 300 chars; ahora corta a 2000 (suficiente
  para preservar la estructura completa de `F1..F5 | MPO | SPECS | DEPT | METAL
  | PROC | LSPEC* | USPEC* | SPECIALREQ`).
- 3 tests nuevos en `TestValidateNotas`: `test_x000d_artifact_returns_ok`,
  `test_prefix_truncation_returns_ok`, `test_genuine_difference_after_canon_returns_suspicious`. 74/74 passing.

### Smoke run 2026-05-28
Mismos inputs que 1.0.0.

| Métrica | 1.0.0 | 1.0.1 | Δ |
|---|---:|---:|---:|
| `suspicious_matches` | 11,263 | **12** | −99.9% |
| `corrections_emitted` | 5,868 | **16,491** | +181% |

El salto en `corrections_emitted` es esperado: los ~10,600 matches que antes
caían en `suspicious` (y por tanto no aportaban diffs) ahora pasan el
validador y aportan sus correcciones reales. Es decir, **el validador previo
estaba bloqueando ~10k correcciones legítimas**.

### Los 12 suspicious restantes
- **1 genuino**: `PN=80247-667-01` (SCHNEIDER MEX) — SH tiene `F2: DESHIDROGENADO`
  que el xlsm no incluye. Revisar a mano antes de carga masiva.
- **11 ruido nuevo**: el campo `DEPT` viene como entero en el xlsm (`DEPT: 10`,
  `DEPT: 14`) pero SH lo persiste como float string (`DEPT: 10.0`, `DEPT: 14.0`).
  Las notas son funcionalmente iguales pero rompen el prefijo. Pendiente
  derivado: normalizar tokens numéricos en `_notas_canon`
  (`\d+\.0(?=\s|\||$)` → `\d+`), o aceptar como ruido tolerable.

### Pendientes derivados (nuevos)
- [ ] Normalizar `DEPT: N.0 ` → `DEPT: N ` en `_notas_canon` para bajar de 12 a 1.
- [ ] Decidir si los 16,491 corrections necesitan re-pasar por la tolerancia
  relativa por campo (pendiente heredado de 1.0.0) antes de carga masiva.
  Probable que la tasa de ruido IEEE 754 en numéricos haya crecido proporcionalmente.

---

## 1.0.0 — 2026-05-27 — Implementación inicial

### Diseño
Ver `docs/superpowers/specs/2026-05-27-dual-source-offline-recovery-design.md`.

### Componentes principales
- `norm()` — normalización de strings (lower + strip + colapsar whitespace).
- `is_round_marker()` — filtra Notas adicionales con ≥3 tokens estructurados.
- `make_fingerprint()` — `metalBase + sorted_labels`, compatible con `audit-incomplete-pns` fase 5.4b.
- `load_sh_report()`, `load_xlsm_originals()` — readers (headers por nombre, no posición).
- `match_xlsm_to_sh()` — 3 tiers (QuoteIBMS / composite_unique / fingerprint).
- `validate_notas()` — único validador del match.
- `compute_field_diffs()` — reglas mixtas por campo (NEVER / CONSERVATIVE / OVERWRITE).
- `emit_v11_xlsx()` — copia template v11 y rellena desde row 9.
- `emit_json_report()` — auditoría JSON con corrections, suspicious, unmatched, duplicates.

### Smoke run real — 2026-05-27
Inputs:
- `BD Numeros de Parte Reloaded v23 valores base final SRG.xlsm` (5.1 MB)
- `BD Numeros de Parte Reloaded v23 valores base final clientes generales.xlsm` (2.8 MB)
- `ING. Validación de Carga Masiva NP 2026-05-27 (1).xlsx` (44 MB)
- `remote/templates/Plantilla_Cotizaciones_v11.xlsm`

Outputs:
- `~/Downloads/recovery_dualsource_2026-05-27T23-33-57.xlsm` (5,868 filas)
- `~/Downloads/dualsource_report_2026-05-27T23-33-57.json`

Counts:
- `xlsm_rows_total: 17,964`
- `sh_rows_total: 24,677`
- `sh_rows_in_round: 18,266` (>90% cobertura, sin WARN)
- `matched: 17,858` (99.4% del universo xlsm)
- `unmatched_xlsm: 106`
- `unmatched_sh_in_round: 408`
- `duplicate_quoteibms_buckets: 71`
- `suspicious_matches: 11,263` (notas distintas entre xlsm y SH)
- `corrections_emitted: 5,868`

Field corrections top:
- `Estaño (kg/pza)`: 3,089
- `CMK (cm²/pza)`: 2,978
- `Línea` / `_labels_` / `Departamento`: 1,251 cada uno
- `Proceso`: 1,240
- `Antitarnish (L/pza)`: 622
- `Plata (kg/pza)`: 439

Observación importante: muchas correcciones numéricas (`CMK`, `Estaño`, `Antitarnish`) son ruido de precisión IEEE 754 entre Excel y la representación interna de SH (e.g., `5240.31` xlsm vs `5240.31005859375` sh — diff `~5.86e-3`, por encima de `NUMERIC_TOLERANCE = 1e-5`). Ver pendiente abajo sobre tolerancia relativa por campo.

### Validaciones pendientes
- [x] Pre-flight de cobertura xlsm→sh_round con datos reales 2026-05-27 (102%, sin WARN).
- [x] Spot-check de 5 PNs random — correcciones legítimas: `sh=''` en Proceso/Línea/Departamento de cargas parciales SCHNEIDER.
- [ ] Sanity de conteos vs `audit-incomplete-pns` última corrida (debe ser ≤).
- [ ] Carga piloto de 50 PNs y verificación post-carga.

### Caveats
- Comportamiento de bulk-upload v11 ante etiquetas parciales (`[A, B, C, "", ""]` vs SH con 5) no probado. Decisión por defecto: solo agregar las etiquetas que faltan; flaggear las que sobran en SH en `field_correction_counts._labels_extras`.
- El validador de Notas solo flaggea suspicious cuando AMBOS lados tienen notas distintas. Si SH no tiene notas y xlsm sí (carga parcial conocida), el match se considera válido.
- `Notas adicionales` NUNCA se escribe al output (es solo validador).

### Pendientes derivados
- [ ] Resume en disco para corridas largas (no parece necesario por ahora; <2 min sobre 20k PNs offline).
- [ ] Soporte multi-archivo `--xlsm path1 --xlsm path2 ...` para rondas con >2 fuentes.
- [ ] Métrica de divergencia por campo en stdout (top campos con más correcciones) para diagnóstico rápido.
- [ ] Tolerancia relativa por campo para descartar ruido IEEE 754 (e.g., `Estaño (kg/pza)` está reportando ~3k correcciones donde la diferencia real es < 0.5% del valor). Opciones: (a) tolerancia relativa `abs(a-b) / max(abs(a),abs(b)) < 0.01`; (b) redondear ambos lados a la precisión de la columna; (c) tolerancia por unidad (kg vs cm² vs L).
