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


# Headers requeridos en el reporte SH (los que el script lee SIEMPRE)
REQUIRED_SH_HEADERS = (
    "Id SH", "Cliente", "Número de parte", "Descripción",
    "Metal base", "Etiqueta 1", "Etiqueta 2", "Etiqueta 3", "Etiqueta 4", "Etiqueta 5",
    "Proceso", "Spec 1", "Spec 2", "Notas adicionales", "QuoteIBMS",
)


def load_sh_report(path: str | Path) -> list[PartNumberRow]:
    """Lee el reporte oficial de SH (xlsx, hoja única, headers row 1)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb[wb.sheetnames[0]]
        headers = read_header_map(ws, header_row=1)

        for req in REQUIRED_SH_HEADERS:
            if req not in headers:
                raise ValueError(f"header esperado en reporte SH no encontrado: {req!r}")

        rows: list[PartNumberRow] = []
        for r_idx, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
            # skip filas completamente vacías
            if all(c is None or str(c).strip() == "" for c in row):
                continue
            raw = {h: row[i - 1] if i - 1 < len(row) else None for h, i in headers.items()}
            pn_row = _row_from_raw(source="sh_report", source_row=r_idx, raw=raw)
            # skip si no tiene id ni pn (row con ruido)
            if not pn_row.id_sh and not pn_row.pn:
                continue
            rows.append(pn_row)
        return rows
    finally:
        wb.close()


def _row_from_raw(source: str, source_row: int, raw: dict) -> PartNumberRow:
    """Construye un PartNumberRow desde un dict {header → valor}."""
    def s(key: str) -> str:
        v = raw.get(key)
        if v is None:
            return ""
        return str(v).strip()

    labels = [s(f"Etiqueta {i}") for i in range(1, 6)]
    return PartNumberRow(
        source=source,
        source_row=source_row,
        id_sh=s("Id SH"),
        cliente=s("Cliente"),
        pn=s("Número de parte"),
        descripcion=s("Descripción"),
        quote_ibms=s("QuoteIBMS"),
        est_ibms=s("EstIBMS"),
        notas=s("Notas adicionales"),
        metal_base=s("Metal base"),
        labels=labels,
        proceso=s("Proceso"),
        spec1=s("Spec 1"),
        spec1_um=s("Esp. Spec 1 (µm)"),
        spec2=s("Spec 2"),
        spec2_um=s("Esp. Spec 2 (µm)"),
        raw=raw,
    )


REQUIRED_XLSM_HEADERS = (
    "Cliente", "Número de parte", "Metal base", "Proceso",
    "Etiqueta 1", "Etiqueta 2", "Etiqueta 3", "Etiqueta 4", "Etiqueta 5",
    "Spec 1", "Spec 2", "Notas adicionales", "QuoteIBMS",
)


def load_xlsm_originals(sources: list[tuple[str | Path, str]]) -> list[PartNumberRow]:
    """Lee uno o más xlsm de bulk-upload (hoja 'Upload', headers row 7, datos row 9+).

    `sources` es lista de (path, source_label).
    """
    all_rows: list[PartNumberRow] = []
    for path, source_label in sources:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False)
        try:
            if "Upload" not in wb.sheetnames:
                raise ValueError(f"{path}: hoja 'Upload' no encontrada")
            ws = wb["Upload"]
            headers = read_header_map(ws, header_row=7)
            for req in REQUIRED_XLSM_HEADERS:
                if req not in headers:
                    raise ValueError(f"{path}: header esperado no encontrado: {req!r}")
            for r_idx, row in enumerate(ws.iter_rows(min_row=9, values_only=True), start=9):
                if all(c is None or str(c).strip() == "" for c in row):
                    continue
                raw = {h: row[i - 1] if i - 1 < len(row) else None for h, i in headers.items()}
                pn_row = _row_from_raw(source=source_label, source_row=r_idx, raw=raw)
                if not pn_row.pn:
                    continue
                all_rows.append(pn_row)
        finally:
            wb.close()
    return all_rows


def filter_round(rows: list[PartNumberRow]) -> list[PartNumberRow]:
    """Filtra rows que tienen la marca estructurada de 'esta ronda' en Notas adicionales."""
    return [r for r in rows if is_round_marker(r.notas)]


@dataclass
class MatchedPair:
    xlsm_row: PartNumberRow
    sh_row: PartNumberRow
    tier: str  # 'quoteIBMS' | 'composite_unique' | 'fingerprint'


@dataclass
class MatchResult:
    matched: list[MatchedPair] = field(default_factory=list)
    unmatched_xlsm: list[dict] = field(default_factory=list)
    unmatched_sh_in_round: list[dict] = field(default_factory=list)
    duplicate_quoteibms: list[dict] = field(default_factory=list)


def _key_composite(row: PartNumberRow) -> tuple[str, str]:
    return (row.cliente.strip().upper(), row.pn.strip().upper())


def match_xlsm_to_sh(xlsm_rows: list[PartNumberRow], sh_round: list[PartNumberRow]) -> MatchResult:
    # Index sh_round por QuoteIBMS y por (cliente, pn)
    by_quote: dict[str, list[PartNumberRow]] = defaultdict(list)
    by_key: dict[tuple[str, str], list[PartNumberRow]] = defaultdict(list)
    for sh in sh_round:
        if sh.quote_ibms:
            by_quote[sh.quote_ibms.strip().upper()].append(sh)
        by_key[_key_composite(sh)].append(sh)

    # Detectar duplicate_quoteibms buckets (≥2 candidatos)
    dup_qibms: list[dict] = []
    for q, cands in by_quote.items():
        if len(cands) >= 2:
            dup_qibms.append({
                "quoteIBMS": q,
                "candidates": [
                    {"idSH": c.id_sh, "pn": c.pn, "customer": c.cliente}
                    for c in cands
                ],
            })

    result = MatchResult(duplicate_quoteibms=dup_qibms)
    matched_sh_ids: set[str] = set()

    for x in xlsm_rows:
        # Tier 1: QuoteIBMS único
        if x.quote_ibms:
            q = x.quote_ibms.strip().upper()
            cands = by_quote.get(q, [])
            if len(cands) == 1:
                sh_match = cands[0]
                result.matched.append(MatchedPair(xlsm_row=x, sh_row=sh_match, tier="quoteIBMS"))
                matched_sh_ids.add(sh_match.id_sh)
                continue
            # 0 o ≥2 candidatos → cae a Tier 2 (ya registrado en dup_qibms si ≥2)

        # Tier 2: (cliente, pn) único
        key = _key_composite(x)
        cands = by_key.get(key, [])
        if len(cands) == 0:
            result.unmatched_xlsm.append({
                "pn": x.pn, "customer": x.cliente, "quoteIBMS": x.quote_ibms,
                "source": x.source, "source_row": x.source_row,
                "reason": "no_pn_in_sh_round",
            })
            continue
        if len(cands) == 1:
            result.matched.append(MatchedPair(xlsm_row=x, sh_row=cands[0], tier="composite_unique"))
            matched_sh_ids.add(cands[0].id_sh)
            continue

        # Tier 3: fingerprint
        x_fp = make_fingerprint(x.metal_base, x.labels)
        fp_matches = [c for c in cands if make_fingerprint(c.metal_base, c.labels) == x_fp]
        if len(fp_matches) == 1:
            result.matched.append(MatchedPair(xlsm_row=x, sh_row=fp_matches[0], tier="fingerprint"))
            matched_sh_ids.add(fp_matches[0].id_sh)
        else:
            result.unmatched_xlsm.append({
                "pn": x.pn, "customer": x.cliente, "quoteIBMS": x.quote_ibms,
                "source": x.source, "source_row": x.source_row,
                "reason": "ambiguous_fingerprint",
                "candidates": [{"idSH": c.id_sh, "fingerprint": make_fingerprint(c.metal_base, c.labels)} for c in cands],
            })

    # PNs en sh_round que no quedaron matcheados
    for sh in sh_round:
        if sh.id_sh not in matched_sh_ids:
            result.unmatched_sh_in_round.append({
                "idSH": sh.id_sh, "pn": sh.pn, "customer": sh.cliente,
                "notas": sh.notas[:200],
            })

    return result


def main(argv: list[str] | None = None) -> int:
    raise NotImplementedError("se implementa en Task 13")


if __name__ == "__main__":
    sys.exit(main())
