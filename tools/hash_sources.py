#!/usr/bin/env python3
"""Extrae y unifica los persisted-query hashes de las 3 fuentes que consumen la
API de Steelhead con hashes propios:

  1. extension   → remote/config.json (la extensión SteelheadAutomator)
  2. reportes-sh → Reportes SH: PERSISTED_QUERIES en scripts/steelhead_client.py
  3. powertools  → SteelheadPowerTools: dicts de hashes en sync/*.py

El validador (validate-hashes.py) usa esto para checar TODAS las fuentes en una
sola corrida, no solo la extensión. Un hash que rota y solo lo usa Reportes SH o
PowerTools se detecta igual (incidente 2026-07-20: GenerateDuckDb rotó, la
extensión se actualizó pero Reportes SH quedó con el hash muerto).

Funciones PURAS (testeables sin red ni FS): extract_py_hashes / infer_kind /
build_validation_items. load_external_sources toca el FS pero degrada a {} si un
repo no existe (una máquina puede no tener los 3 repos).
"""
from __future__ import annotations

import re
from pathlib import Path

# Rutas de las fuentes externas (absolutas; los repos son hermanos).
REPORTES_SH_CLIENT = Path("/Users/oviazcan/Projects/Ecoplating/Reportes SH/scripts/steelhead_client.py")
POWERTOOLS_ROOT = Path("/Users/oviazcan/Projects/Ecoplating/SteelheadPowerTools")
PT_SYNC_FILES = ["sync/lowcode_sync.py", "sync/maintenance_plans_sync.py"]

# Prefijos que indican MUTATION (para inferir kind — solo cosmético en el reporte;
# el probe no distingue). El resto se asume query.
_MUTATION_PREFIXES = (
    "Create", "Update", "Delete", "Archive", "Unarchive", "Generate",
    "Save", "Add", "Remove", "Set", "Move", "Merge", "Send", "Regenerate",
)

# op -> hash de 64 hex dentro de un dict literal de Python. No captura hashes en
# comentarios (esos no van en la forma "clave": "hash").
_PAIR_RE = re.compile(r'["\']([A-Za-z0-9_]+)["\']\s*:\s*["\']([a-f0-9]{64})["\']')
# Bloque PERSISTED_QUERIES: dict[str, str] = { ... } (no-greedy hasta el cierre).
_PQ_BLOCK_RE = re.compile(r'PERSISTED_QUERIES\s*:\s*dict\[str,\s*str\]\s*=\s*\{(.*?)\n\}', re.S)


def extract_py_hashes(text: str) -> dict[str, str]:
    """op -> hash de los pares "clave": "64hex" presentes en `text`."""
    return dict(_PAIR_RE.findall(text))


def infer_kind(op: str) -> str:
    """Heurística query|mutation por prefijo del nombre de operación."""
    return "mutation" if op.startswith(_MUTATION_PREFIXES) else "query"


def load_external_sources(
    rsh_client: Path = REPORTES_SH_CLIENT,
    powertools_root: Path = POWERTOOLS_ROOT,
) -> dict[str, dict[str, str]]:
    """{source: {op: hash}} para las fuentes externas DISPONIBLES.

    Si un repo/archivo no existe, esa fuente se omite (no es fatal): una máquina
    puede tener solo un subconjunto de los repos.
    """
    out: dict[str, dict[str, str]] = {}
    if rsh_client.exists():
        m = _PQ_BLOCK_RE.search(rsh_client.read_text())
        if m:
            ops = extract_py_hashes(m.group(1))
            if ops:
                out["reportes-sh"] = ops
    pt: dict[str, str] = {}
    for rel in PT_SYNC_FILES:
        f = powertools_root / rel
        if f.exists():
            pt.update(extract_py_hashes(f.read_text()))
    if pt:
        out["powertools"] = pt
    return out


def build_validation_items(
    config_queries: dict[str, str],
    config_mutations: dict[str, str],
    external_sources: dict[str, dict[str, str]],
) -> list[dict]:
    """Entries ÚNICOS por (op, hash), con las fuentes que lo usan agregadas.

    entry = {"kind", "operation", "hash", "sources": [source, ...]}

    Dedup por (op, hash): si dos fuentes usan la MISMA op con el MISMO hash, se
    prueba UNA vez y se listan ambas fuentes. Si usan la misma op con hashes
    DISTINTOS (drift, p.ej. GenerateDuckDb desincronizado), se prueban AMBOS
    pares — cada hash importa por separado.
    """
    seen: dict[tuple[str, str], dict] = {}

    def add(kind: str, op: str, h: str, source: str) -> None:
        key = (op, h)
        if key in seen:
            if source not in seen[key]["sources"]:
                seen[key]["sources"].append(source)
        else:
            seen[key] = {"kind": kind, "operation": op, "hash": h, "sources": [source]}

    for op, h in config_queries.items():
        add("query", op, h, "extension")
    for op, h in config_mutations.items():
        add("mutation", op, h, "extension")
    for source, ops in external_sources.items():
        for op, h in ops.items():
            add(infer_kind(op), op, h, source)

    return list(seen.values())


# ── Auto-test (sin pytest: `python3 tools/hash_sources.py` corre estos asserts) ──
def _selftest() -> None:
    # extract_py_hashes: pares válidos, ignora líneas sin hash de 64 hex.
    txt = '''
    "AllReports": "1f83add2747f8e0949a47ea4b6f95a67f8e1948a07fad9a5cf543d1ab4b8c00c",
    "Corta": "abc",  # no 64 hex → ignorada
    # comentario "Falsa": "deadbeef..." no aplica
    "JobQuery": "86432972dfe6ea75c523515801993374044dc99e909778024904a02e9ef1b4e3",
    '''
    h = extract_py_hashes(txt)
    assert set(h) == {"AllReports", "JobQuery"}, h
    assert len(h["AllReports"]) == 64

    # infer_kind
    assert infer_kind("CreateReportConfig") == "mutation"
    assert infer_kind("GenerateDuckDb") == "mutation"
    assert infer_kind("GetPerspectiveDashboards") == "query"
    assert infer_kind("SearchSpecsForSelect") == "query"

    # build_validation_items: dedup + atribución + drift
    HA = "a" * 64
    HB = "b" * 64
    HC = "c" * 64
    items = build_validation_items(
        config_queries={"GetX": HA, "Shared": HB},
        config_mutations={"GenerateDuckDb": HC},
        external_sources={
            "reportes-sh": {"Shared": HB, "GenerateDuckDb": HC, "OnlyRsh": HA},
            "powertools": {"OnlyPt": HB},
        },
    )
    by = {(e["operation"], e["hash"]): e for e in items}
    # Shared: mismo hash en extension + reportes-sh → 1 entry, 2 sources.
    assert by[("Shared", HB)]["sources"] == ["extension", "reportes-sh"], by[("Shared", HB)]
    # GenerateDuckDb: mismo hash config + rsh → 1 entry, 2 sources (post-fix).
    assert set(by[("GenerateDuckDb", HC)]["sources"]) == {"extension", "reportes-sh"}
    # OnlyRsh / OnlyPt exclusivas.
    assert by[("OnlyRsh", HA)]["sources"] == ["reportes-sh"]
    assert by[("OnlyPt", HB)]["sources"] == ["powertools"]
    # kind inferido para externas.
    assert by[("OnlyRsh", HA)]["kind"] == "query"
    assert by[("GenerateDuckDb", HC)]["kind"] == "mutation"
    # Total entries: GetX, Shared, GenerateDuckDb, OnlyRsh, OnlyPt = 5.
    assert len(items) == 5, len(items)

    # Drift: misma op, hashes distintos → 2 entries (ambos se prueban).
    drift = build_validation_items(
        config_queries={},
        config_mutations={"GenerateDuckDb": HA},
        external_sources={"reportes-sh": {"GenerateDuckDb": HB}},
    )
    assert len(drift) == 2, drift

    print("hash_sources selftest OK")


if __name__ == "__main__":
    _selftest()
