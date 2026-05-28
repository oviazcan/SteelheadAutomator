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

### Validaciones pendientes
- [ ] Pre-flight de cobertura xlsm→sh_round con datos reales 2026-05-27 (debe estar ≥ 90%).
- [ ] Spot-check de 5 PNs random en UI de SH (verificar que campos `sh: ""` están realmente vacíos).
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
