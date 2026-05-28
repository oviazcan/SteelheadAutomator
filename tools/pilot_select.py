#!/usr/bin/env python3
"""Filtra un reporte JSON de dual_source_recovery y emite un xlsx v11 reducido.

Uso típico (piloto string-only de 50 PNs):
  python3 tools/pilot_select.py \
    --report-json ~/Downloads/dualsource_report_<stamp>.json \
    --template remote/templates/Plantilla_Cotizaciones_v11.xlsm \
    --out-xlsx ~/Downloads/recovery_pilot_50.xlsm \
    --limit 50

Categoriza los campos en tres grupos:
  STRING_SAFE      campos string/categóricos confiables (Línea, Departamento,
                   Proceso, _labels_, Spec 1, Spec 2, Plano, Grupo, Rack...)
  NUM_PREDICTIVE   numéricos predictivos sospechosos de ruido IEEE 754
                   (CMK, Estaño, Plata, Antitarnish, Zinc, Níquel, Cobre,
                   Epóx*, KGM, LM)
  DIMENSIONAL      Longitud/Ancho/Alto/Diám.* (m), Esp. Spec * (µm), Piezas...

Por defecto solo deja PNs cuyos `diffs` estén EXCLUSIVAMENTE en STRING_SAFE.
Esto es seguro para piloto inicial: ni ruido IEEE 754 ni dimensionales
discutibles. El piloto valida el flujo end-to-end sin cargar correcciones
discutibles.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

# Reusamos emit_v11_xlsx del tool principal
sys.path.insert(0, str(Path(__file__).parent))
from dual_source_recovery import emit_v11_xlsx  # noqa: E402


STRING_SAFE = {
    "Línea",
    "Departamento",
    "Proceso",
    "_labels_",
    "Spec 1",
    "Spec 2",
    "Plano",
    "Grupo",
    "Rack Flybar o Barril (Carga)",
}

NUM_PREDICTIVE = {
    "CMK (cm²/pza)",
    "Estaño (kg/pza)",
    "Plata (kg/pza)",
    "Antitarnish (L/pza)",
    "Zinc (kg/pza)",
    "Níquel (kg/pza)",
    "Cobre (kg/pza)",
    "Epóx. MT (lb/pza)",
    "Epóx. BT (lb/pza)",
    "Epóx. MTR (lb/pza)",
    "KGM (kg/pza)",
    "LM (m/pza)",
}


def select(
    corrections: list[dict],
    *,
    limit: int,
    max_per_customer: int,
) -> list[dict]:
    """Selecciona PNs con diffs SOLO en STRING_SAFE, balanceado por cliente."""
    eligible = []
    for c in corrections:
        diff_fields = {d["field"] for d in c["diffs"]}
        if not diff_fields:
            continue
        if diff_fields - STRING_SAFE:
            continue
        eligible.append(c)

    # Ordenar por cantidad de diffs desc (más correcciones por PN cargado)
    eligible.sort(key=lambda c: -len(c["diffs"]))

    picked: list[dict] = []
    per_customer: dict[str, int] = defaultdict(int)
    for c in eligible:
        if len(picked) >= limit:
            break
        if per_customer[c["customer"]] >= max_per_customer:
            continue
        picked.append(c)
        per_customer[c["customer"]] += 1
    return picked


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--report-json", required=True, type=Path)
    ap.add_argument("--template", required=True, type=Path)
    ap.add_argument("--out-xlsx", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--max-per-customer", type=int, default=8)
    args = ap.parse_args(argv)

    report = json.loads(args.report_json.read_text(encoding="utf-8"))
    corrections = report["corrections"]
    print(f"Loaded {len(corrections)} corrections from {args.report_json}", file=sys.stderr)

    picked = select(
        corrections,
        limit=args.limit,
        max_per_customer=args.max_per_customer,
    )
    print(f"Selected {len(picked)} PNs (limit={args.limit}, max/cliente={args.max_per_customer})", file=sys.stderr)

    # Breakdown por cliente
    per_cust: dict[str, int] = defaultdict(int)
    fields_hit: dict[str, int] = defaultdict(int)
    for c in picked:
        per_cust[c["customer"][:50]] += 1
        for d in c["diffs"]:
            fields_hit[d["field"]] += 1
    print("\nBy customer:", file=sys.stderr)
    for k, n in sorted(per_cust.items(), key=lambda x: -x[1]):
        print(f"  {n:>3}  {k}", file=sys.stderr)
    print("\nFields touched:", file=sys.stderr)
    for k, n in sorted(fields_hit.items(), key=lambda x: -x[1]):
        print(f"  {n:>4}  {k}", file=sys.stderr)

    emit_v11_xlsx(
        template_path=str(args.template),
        corrections=picked,
        out_path=str(args.out_xlsx),
    )
    print(f"\nWrote {args.out_xlsx}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
