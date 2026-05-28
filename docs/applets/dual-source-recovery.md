# `dual-source-recovery` — bitácora

Tool standalone (`tools/dual_source_recovery.py`) que cruza los xlsm
originales de bulk-upload contra el reporte oficial de Steelhead y emite un
xlsx v11 de recovery donde cada PN se identifica por **Id SH** (pivote directo).

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
