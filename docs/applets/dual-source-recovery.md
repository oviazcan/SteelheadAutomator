# `dual-source-recovery` — bitácora

Tool standalone (`tools/dual_source_recovery.py`) que cruza los xlsm
originales de bulk-upload contra el reporte oficial de Steelhead y emite un
xlsx v11 de recovery donde cada PN se identifica por **Id SH** (pivote directo).

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
