#!/usr/bin/env python3
"""Dual-source offline recovery.

Cruza los xlsm originales de bulk-upload contra el reporte oficial de
Steelhead y emite un xlsx v11 con las correcciones por Id SH.

Uso:
    python3 tools/dual_source_recovery.py \\
        --srg-xlsm SRG.xlsm \\
        --cg-xlsm  CG.xlsm \\
        --sh-report report.xlsx \\
        --template remote/templates/Plantilla_Cotizaciones_v11.xlsm \\
        --out-xlsx recovery.xlsm \\
        --report-json report.json

Spec: docs/superpowers/specs/2026-05-27-dual-source-offline-recovery-design.md
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable

import openpyxl


def norm(value) -> str:
    """Normaliza una celda para comparación: cast a str, lower, strip, colapsa whitespace."""
    if value is None or value == "":
        return ""
    s = str(value)
    return re.sub(r"\s+", " ", s.strip().lower())


ROUND_MARKER_TOKENS = (
    "F1:", "F2:", "F3:", "F4:", "F5:",
    "MPO:", "SPECS:", "DEPT:", "METAL:", "PROC:",
    "LSPEC1:", "USPEC1:", "LSPEC2:", "USPEC2:",
    "SPECIALREQ:",
)


def is_round_marker(notas) -> bool:
    """True si las Notas adicionales contienen al menos 3 tokens estructurados
    de esta ronda, separados por ` | `."""
    if not notas:
        return False
    text = str(notas).upper()
    # contar tokens (case-insensitive)
    count = sum(1 for tok in ROUND_MARKER_TOKENS if tok in text)
    if count < 3:
        return False
    # exigir separador ` | ` al menos una vez (descarta freeform que tenga colons)
    return " | " in text


def make_fingerprint(metal_base: str | None, labels: Iterable[str | None]) -> str:
    """Fingerprint estable para discriminar PNs con mismo (cliente, nombre).

    Usa metalBase + labels normalizados y ordenados. Mismo formato que usa
    `audit-incomplete-pns.js` fase 5.4b para que los resultados sean comparables.
    """
    metal = (str(metal_base) if metal_base else "").strip().upper()
    labels_clean = sorted({
        str(l).strip().upper() for l in labels if l is not None and str(l).strip() != ""
    })
    return f"{metal}|{','.join(labels_clean)}"


def read_header_map(ws, header_row: int) -> dict[str, int]:
    """Devuelve {header_name → col_index (1-based)} leyendo la fila indicada.

    Normaliza headers: reemplaza '\\n' por espacio y colapsa whitespaces.
    """
    headers: dict[str, int] = {}
    for row in ws.iter_rows(min_row=header_row, max_row=header_row, values_only=True):
        for idx, val in enumerate(row, start=1):
            if val is None or str(val).strip() == "":
                continue
            key = re.sub(r"\s+", " ", str(val).replace("\n", " ").strip())
            headers[key] = idx
        break
    return headers


@dataclass
class PartNumberRow:
    """Una fila de PN normalizada — fuente puede ser xlsm o reporte SH."""
    source: str  # 'xlsm_srg' | 'xlsm_cg' | 'sh_report'
    source_row: int  # fila 1-based del archivo origen (debug)
    id_sh: str  # vacío en xlsm; numérico-string en SH report
    cliente: str
    pn: str
    descripcion: str
    quote_ibms: str
    est_ibms: str
    notas: str
    metal_base: str
    labels: list[str]  # 5 elementos, "" para vacíos
    proceso: str
    spec1: str
    spec1_um: str
    spec2: str
    spec2_um: str
    # campos numéricos / sobreescribir
    raw: dict[str, object] = field(default_factory=dict)  # acceso por header_name → valor crudo

    def get(self, header: str):
        return self.raw.get(header)


def main(argv: list[str] | None = None) -> int:
    raise NotImplementedError("se implementa en Task 13")


if __name__ == "__main__":
    sys.exit(main())
