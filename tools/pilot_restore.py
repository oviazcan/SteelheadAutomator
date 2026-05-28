#!/usr/bin/env python3
"""Reconstruye xlsm de RESTAURACIÓN para PNs del piloto, con filas COMPLETAS del xlsm fuente.

Contexto:
  El piloto string-only (50 PNs vía pilot_select.py) emitió xlsm con SOLO las
  columnas de diffs. El applet bulk-upload v11 hace REPLACE de customInputs
  (no merge), entonces los campos no-incluidos (Metal Base, Quote IBMS,
  Est IBMS, Plano cuando no era corrección, Piezas/Carga, Cargas/Hora,
  Lead Time, Notas Adicionales) llegaron como `null` → SH los borró.

  Este script repara el daño: para los mismos 50 PNs piloto, genera un xlsm
  con TODAS las columnas pobladas desde el xlsm fuente (las 2 BD Reloaded).
  Al cargar este xlsm, el applet construye un customInputs COMPLETO y SH lo
  reemplaza con los valores correctos.

Uso típico:
  python3 tools/pilot_restore.py \
    --report-json ~/Downloads/dualsource_report_v102.json \
    --srg-xlsm "$HOME/Downloads/BD Numeros de Parte Reloaded v23 valores base final SRG.xlsm" \
    --cg-xlsm "$HOME/Downloads/BD Numeros de Parte Reloaded v23 valores base final clientes generales.xlsm" \
    --template remote/templates/Plantilla_Cotizaciones_v11.xlsm \
    --out-xlsx ~/Downloads/recovery_pilot_50_RESTORE.xlsm \
    --limit 50 --max-per-customer 8
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).parent))
from dual_source_recovery import load_xlsm_originals, read_header_map  # noqa: E402
from pilot_select import select  # noqa: E402


def emit_v11_xlsx_full_rows(
    template_path: str | Path,
    rows_with_idsh: list[tuple[str, "PartNumberRow", str]],  # (idSH, src_row, customer_for_label)
    out_path: str | Path,
) -> None:
    """Copia la plantilla v11 y escribe TODA la fila del xlsm fuente por header name.

    A diferencia de `emit_v11_xlsx`, no escribe diffs sino el row completo del
    xlsm fuente — preserva customInputs en SH durante MODIFY.
    """
    wb = openpyxl.load_workbook(template_path, keep_vba=True, data_only=False)
    try:
        if "Upload" not in wb.sheetnames:
            raise ValueError(f"template no tiene hoja 'Upload': {template_path}")
        ws = wb["Upload"]
        headers = read_header_map(ws, header_row=7)

        if "Id SH" not in headers:
            raise ValueError("template v11: header 'Id SH' no encontrado")

        # Metadata row 3
        ws.cell(row=3, column=8, value=f"Restore FULL ROWS {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")

        start_row = 9
        for offset, (idsh, src_row, customer) in enumerate(rows_with_idsh):
            r = start_row + offset
            # Id SH desde el report SH (el xlsm fuente no lo tiene)
            ws.cell(row=r, column=headers["Id SH"], value=idsh)
            # Cliente desde el JSON report (formato "NOMBRE — DIRECCIÓN" igual al SH report)
            if "Cliente" in headers:
                ws.cell(row=r, column=headers["Cliente"], value=customer)

            # Para cada header del template, escribir desde src_row.raw si existe.
            # Limpiar SIEMPRE las columnas que tocaremos (la plantilla pre-llena
            # algunos slots con '(seleccione)' o defaults visuales).
            for header, col in headers.items():
                if header in ("Id SH", "Cliente"):
                    continue
                value = src_row.raw.get(header)
                if value is None:
                    ws.cell(row=r, column=col).value = None
                    continue
                if isinstance(value, str):
                    s = value.strip()
                    ws.cell(row=r, column=col).value = s if s else None
                else:
                    ws.cell(row=r, column=col).value = value

        out_path = Path(out_path)
        wb.save(out_path)
    finally:
        wb.close()


def _resolve_xlsm_row(
    pn: str,
    customer: str,
    by_pn: dict[str, list],
) -> tuple:
    """Encuentra la fila xlsm fuente para (pn, customer). Retorna (row, None) o (None, motivo)."""
    candidates = by_pn.get(pn, [])
    if not candidates:
        return None, f"sin filas xlsm para pn={pn!r}"
    if len(candidates) == 1:
        return candidates[0], None
    # Múltiples: filtrar por cliente. El JSON tiene "NOMBRE — DIRECCIÓN".
    client_prefix = customer.split("—")[0].strip().upper()
    if not client_prefix:
        return candidates[0], None
    filtered = [c for c in candidates if (c.cliente or "").upper().startswith(client_prefix[:30])]
    if filtered:
        return filtered[0], None
    return candidates[0], f"customer={customer!r} no matchea exactamente; usando primera"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--report-json", required=True, type=Path)
    ap.add_argument("--srg-xlsm", required=True, type=Path)
    ap.add_argument("--cg-xlsm", required=True, type=Path)
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
    print(f"Selected {len(picked)} PNs (same selector as pilot_select)", file=sys.stderr)

    print("Loading source xlsm files...", file=sys.stderr)
    xlsm_rows = load_xlsm_originals([
        (args.srg_xlsm, "xlsm_srg"),
        (args.cg_xlsm, "xlsm_cg"),
    ])
    print(f"  Loaded {len(xlsm_rows)} xlsm rows", file=sys.stderr)

    by_pn: dict[str, list] = defaultdict(list)
    for r in xlsm_rows:
        if r.pn:
            by_pn[r.pn].append(r)

    rows_with_idsh: list[tuple[str, object, str]] = []
    warnings: list[str] = []
    for p in picked:
        src_row, warn = _resolve_xlsm_row(p["pn"], p["customer"], by_pn)
        if src_row is None:
            warnings.append(f"  SKIP pn={p['pn']!r} idSH={p['idSH']!r}: {warn}")
            continue
        if warn:
            warnings.append(f"  WARN pn={p['pn']!r} idSH={p['idSH']!r}: {warn}")
        rows_with_idsh.append((p["idSH"], src_row, p["customer"]))

    print(f"Resolved {len(rows_with_idsh)}/{len(picked)} source rows", file=sys.stderr)
    if warnings:
        print("\nResolution warnings:", file=sys.stderr)
        for w in warnings:
            print(w, file=sys.stderr)

    emit_v11_xlsx_full_rows(
        template_path=str(args.template),
        rows_with_idsh=rows_with_idsh,
        out_path=str(args.out_xlsx),
    )
    print(f"\nWrote {args.out_xlsx}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
