# Dual-Source Offline Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar `tools/dual_source_recovery.py`, un script Python offline que cruza los xlsm originales contra el reporte oficial de Steelhead y emite un xlsx v11 de recovery donde cada PN se identifica por `Id SH`.

**Architecture:** Un único script Python con CLI (argparse) + un test file (pytest) al lado. Sin paquetes ni venv. Pipeline funcional puro hasta el paso de emisión (xlsx) — testing facilitado. Lee headers por **nombre** (no por posición) para sobrevivir a diferencias de layout entre xlsm v10, reporte SH y plantilla v11.

**Tech Stack:** Python 3.10+, openpyxl 3.1+, pytest 8.4+ (ya instalados). Sin nuevas dependencias.

**Spec:** [`docs/superpowers/specs/2026-05-27-dual-source-offline-recovery-design.md`](../specs/2026-05-27-dual-source-offline-recovery-design.md).

---

## File structure

| Archivo | Responsabilidad |
|---|---|
| `tools/dual_source_recovery.py` | Script principal. Contiene: constantes (FIELD_RULES, ROUND_MARKER_TOKENS), funciones puras (`norm`, `is_round_marker`, `make_fingerprint`, `compute_field_diffs`), I/O (`load_xlsm_originals`, `load_sh_report`), matching (`match_xlsm_to_sh`), validador (`validate_notas`), emitters (`emit_v11_xlsx`, `emit_json_report`), CLI (`main`). |
| `tools/test_dual_source_recovery.py` | Tests pytest. Cada función pura tiene su test; matching e I/O usan xlsm sintéticos en `tmp_path`. |
| `docs/applets/dual-source-recovery.md` | Bitácora del tool (formato como `audit-incomplete-pns.md`). |
| `CLAUDE.md` | Agregar entry en tabla "Índice de applets". |

**Convención de import en tests:** los tests importan del script con `from tools.dual_source_recovery import …`. Para que funcione, los tests se corren desde la raíz del repo (`pytest tools/test_dual_source_recovery.py`). El script debe tener `if __name__ == "__main__": main()` y todas las funciones a nivel módulo (sin `if __name__` envolviendo helpers).

---

## Task 1: Setup inicial — script vacío + test file + smoke

**Files:**
- Create: `tools/dual_source_recovery.py`
- Create: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Crear script con shebang y docstring**

```python
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


def main(argv: list[str] | None = None) -> int:
    raise NotImplementedError("se implementa en Task 13")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Crear test file con smoke test**

```python
"""Tests for tools/dual_source_recovery.py."""

from __future__ import annotations

import pytest

from tools.dual_source_recovery import main


def test_module_imports():
    """El módulo debe importarse sin errores."""
    from tools import dual_source_recovery as m
    assert callable(m.main)
```

- [ ] **Step 3: Asegurar que el módulo es importable como `tools.dual_source_recovery`**

`tools/` no tiene `__init__.py` actualmente. Verificar:

```bash
ls tools/__init__.py 2>&1
```

Si no existe, crearlo vacío:

```bash
touch tools/__init__.py
```

- [ ] **Step 4: Correr smoke test**

```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
pytest tools/test_dual_source_recovery.py::test_module_imports -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py tools/__init__.py
git commit -m "feat(dual-source): scaffold script + tests"
```

---

## Task 2: `norm()` — normalización de strings

**Files:**
- Modify: `tools/dual_source_recovery.py` (agregar función)
- Modify: `tools/test_dual_source_recovery.py` (tests)

- [ ] **Step 1: Escribir tests**

Agregar a `tools/test_dual_source_recovery.py`:

```python
from tools.dual_source_recovery import norm


class TestNorm:
    def test_empty_returns_empty(self):
        assert norm("") == ""
        assert norm(None) == ""

    def test_strips_whitespace(self):
        assert norm("  hola  ") == "hola"

    def test_lowercases(self):
        assert norm("HOLA") == "hola"

    def test_collapses_internal_whitespace(self):
        assert norm("a   b\t\nc") == "a b c"

    def test_preserves_special_chars(self):
        assert norm("PLATA 2µm") == "plata 2µm"

    def test_handles_newlines(self):
        assert norm("line1\nline2") == "line1 line2"

    def test_non_string_to_empty(self):
        assert norm(123) == "123"  # cast a string primero
        assert norm(0) == "0"
```

- [ ] **Step 2: Correr tests para verificar que fallan**

```bash
pytest tools/test_dual_source_recovery.py::TestNorm -v
```

Expected: FAIL (cannot import name `norm`).

- [ ] **Step 3: Implementar `norm`**

Agregar a `tools/dual_source_recovery.py`:

```python
def norm(value) -> str:
    """Normaliza una celda para comparación: cast a str, lower, strip, colapsa whitespace."""
    if value is None or value == "":
        return ""
    s = str(value)
    return re.sub(r"\s+", " ", s.strip().lower())
```

- [ ] **Step 4: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestNorm -v
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): norm() para comparación de strings"
```

---

## Task 3: `is_round_marker()` — filtro de Notas adicionales

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Escribir tests**

```python
from tools.dual_source_recovery import is_round_marker, ROUND_MARKER_TOKENS


class TestIsRoundMarker:
    def test_empty_returns_false(self):
        assert is_round_marker("") is False
        assert is_round_marker(None) is False

    def test_pattern_with_5_tokens(self):
        notas = "F1: PLATA | F2: ANTITARNISH | SPECS: PLATA COLGADO | DEPT: 16.3 | METAL: COBRE | PROC: PLATA SELECTIVA"
        assert is_round_marker(notas) is True

    def test_pattern_with_mpo(self):
        notas = "F1: Decapado | F2: ESTAÑO | MPO: DECAPADO ESTAÑADO"
        assert is_round_marker(notas) is True  # F1, F2, MPO = 3 tokens

    def test_only_2_tokens_returns_false(self):
        notas = "F1: PLATA | F2: ANTITARNISH"
        assert is_round_marker(notas) is False  # menos de 3

    def test_no_pipe_separator_returns_false(self):
        notas = "F1 PLATA SPECS COBRE DEPT 16.3"
        assert is_round_marker(notas) is False

    def test_freeform_text_returns_false(self):
        assert is_round_marker("EMPAQUE CON PAPEL SILVER SAVER") is False
        assert is_round_marker("Plata Flash Conector") is False

    def test_case_insensitive_tokens(self):
        # los tokens son case-sensitive en SH (F1:, no f1:), pero la robustez no estorba
        notas = "f1: plata | specs: plata | dept: 16 | metal: cobre"
        assert is_round_marker(notas) is True

    def test_tokens_constant_exists(self):
        assert "F1:" in ROUND_MARKER_TOKENS
        assert "MPO:" in ROUND_MARKER_TOKENS
        assert "SPECS:" in ROUND_MARKER_TOKENS
```

- [ ] **Step 2: Correr tests para verificar fallo**

```bash
pytest tools/test_dual_source_recovery.py::TestIsRoundMarker -v
```

Expected: FAIL.

- [ ] **Step 3: Implementar `is_round_marker` y `ROUND_MARKER_TOKENS`**

```python
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
```

- [ ] **Step 4: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestIsRoundMarker -v
```

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): is_round_marker() + tokens canónicos"
```

---

## Task 4: `make_fingerprint()` — composite para discriminar duplicados

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Escribir tests**

```python
from tools.dual_source_recovery import make_fingerprint


class TestMakeFingerprint:
    def test_basic(self):
        fp = make_fingerprint(metal_base="COBRE", labels=["PLATA", "ANTITARNISH"])
        assert fp == "COBRE|ANTITARNISH,PLATA"  # labels sorted

    def test_normalizes_case_and_spaces(self):
        fp1 = make_fingerprint(metal_base="cobre", labels=[" PLATA ", "antitarnish"])
        fp2 = make_fingerprint(metal_base="COBRE", labels=["ANTITARNISH", "PLATA"])
        assert fp1 == fp2

    def test_drops_empty_labels(self):
        fp = make_fingerprint(metal_base="COBRE", labels=["PLATA", "", None, "ANTITARNISH"])
        assert fp == "COBRE|ANTITARNISH,PLATA"

    def test_no_labels(self):
        fp = make_fingerprint(metal_base="ACERO", labels=[])
        assert fp == "ACERO|"

    def test_no_metal(self):
        fp = make_fingerprint(metal_base="", labels=["PLATA"])
        assert fp == "|PLATA"
```

- [ ] **Step 2: Correr tests para verificar fallo**

```bash
pytest tools/test_dual_source_recovery.py::TestMakeFingerprint -v
```

Expected: FAIL.

- [ ] **Step 3: Implementar `make_fingerprint`**

```python
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
```

- [ ] **Step 4: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestMakeFingerprint -v
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): make_fingerprint() compatible con audit-incomplete-pns"
```

---

## Task 5: Estructura de datos `PartNumberRow` + `read_header_map()`

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Escribir tests para `read_header_map`**

```python
from tools.dual_source_recovery import read_header_map


class TestReadHeaderMap:
    def test_maps_headers_to_indices(self, tmp_path):
        # crear xlsx sintético con headers en row 1
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Test"
        ws["A1"] = "Cliente"
        ws["B1"] = "Número de parte"
        ws["C1"] = "Etiqueta 1"
        path = tmp_path / "test.xlsx"
        wb.save(path)

        wb2 = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws2 = wb2["Test"]
        m = read_header_map(ws2, header_row=1)
        assert m == {"Cliente": 1, "Número de parte": 2, "Etiqueta 1": 3}

    def test_normalizes_newlines_in_headers(self, tmp_path):
        # headers como "Validación\n1er recibo" → keys deben coincidir con "Validación 1er recibo"
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws["A1"] = "Validación\n1er recibo"
        ws["B1"] = "Esp. Spec 1\n(µm)"
        path = tmp_path / "test.xlsx"
        wb.save(path)

        wb2 = openpyxl.load_workbook(path, read_only=True, data_only=True)
        m = read_header_map(wb2.active, header_row=1)
        # \n se reemplaza por espacio + se colapsan whitespaces
        assert m == {"Validación 1er recibo": 1, "Esp. Spec 1 (µm)": 2}

    def test_skips_empty_columns(self, tmp_path):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws["A1"] = "Cliente"
        ws["C1"] = "Proceso"  # B1 vacío
        path = tmp_path / "test.xlsx"
        wb.save(path)

        wb2 = openpyxl.load_workbook(path, read_only=True, data_only=True)
        m = read_header_map(wb2.active, header_row=1)
        assert m == {"Cliente": 1, "Proceso": 3}

    def test_header_row_param(self, tmp_path):
        # xlsm originals: headers en row 7
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws["A7"] = "Cliente"
        ws["B7"] = "Proceso"
        path = tmp_path / "test.xlsx"
        wb.save(path)

        wb2 = openpyxl.load_workbook(path, read_only=True, data_only=True)
        m = read_header_map(wb2.active, header_row=7)
        assert m == {"Cliente": 1, "Proceso": 2}
```

- [ ] **Step 2: Correr tests para verificar fallo**

```bash
pytest tools/test_dual_source_recovery.py::TestReadHeaderMap -v
```

Expected: FAIL.

- [ ] **Step 3: Implementar `read_header_map`**

```python
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
```

- [ ] **Step 4: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestReadHeaderMap -v
```

Expected: PASS (4 tests).

- [ ] **Step 5: Definir `PartNumberRow` dataclass**

Agregar a `tools/dual_source_recovery.py`:

```python
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
```

Sin tests independientes para el dataclass (es transporte).

- [ ] **Step 6: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): read_header_map() + PartNumberRow dataclass"
```

---

## Task 6: `load_sh_report()` — leer reporte de Steelhead

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Helper para crear xlsx sintético en tests**

Agregar a `tools/test_dual_source_recovery.py`:

```python
def _make_sh_report(tmp_path, rows):
    """Crea un xlsx tipo 'reporte SH' con headers en row 1 y rows desde row 2.
    `rows` es lista de dicts {header → value}.
    """
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "ING. Validación de Carga Masiva"
    headers = [
        "Archivado", "Validación\n1er recibo", "Forzar\nduplicar", "Archivar\nanterior",
        "Id SH", "Cliente", "Número de\nparte", "Descripción", "PN alterno", "Grupo",
        "Cantidad", "Precio", "Unidad\nprecio", "Divisa", "Precio\ndefault",
        "Línea", "Metal base",
        "Etiqueta 1", "Etiqueta 2", "Etiqueta 3", "Etiqueta 4", "Etiqueta 5",
        "Proceso",
        "Producto 1", "Precio P1", "Cant P1", "Unidad P1",
        "Producto 2", "Precio P2", "Cant P2", "Unidad P2",
        "Producto 3", "Precio P3", "Cant P3", "Unidad P3",
        "Spec 1", "Esp. Spec 1\n(µm)", "Spec 2", "Esp. Spec 2\n(µm)",
        "KGM\n(kg/pza)", "CMK\n(cm²/pza)", "LM\n(m/pza)", "Mín Pzas\nLote",
        "Rack Flybar o Barril (Carga)", "Pzas/Rack\nLínea", "Rack Específico", "Pzas/Rack\nSec.",
        "Tipo de Geometría", "Longitud\n(m)", "Ancho\n(m)", "Alto\n(m)", "Diám.Ext\n(m)", "Diám.Int\n(m)",
        "Departamento", "Código SAT",
        "Plata\n(kg/pza)", "Estaño\n(kg/pza)", "Níquel\n(kg/pza)", "Zinc\n(kg/pza)", "Cobre\n(kg/pza)",
        "Antitarnish\n(L/pza)", "Epóx. MT\n(lb/pza)", "Epóx. BT\n(lb/pza)", "Epóx. MTR\n(lb/pza)",
        "Notas adicionales", "QuoteIBMS", "EstIBMS", "Plano",
        "Piezas por Carga", "Cargas por Hora", "Tiempo de Entrega",
    ]
    for i, h in enumerate(headers, start=1):
        ws.cell(row=1, column=i, value=h)
    # normalizar cada dict de row contra los headers limpios (sin \n)
    import re as _re
    clean = {_re.sub(r"\s+", " ", h.replace("\n", " ").strip()): i for i, h in enumerate(headers, start=1)}
    for r_idx, row_dict in enumerate(rows, start=2):
        for key, val in row_dict.items():
            col = clean.get(key)
            if col:
                ws.cell(row=r_idx, column=col, value=val)
    path = tmp_path / "sh_report.xlsx"
    wb.save(path)
    return path
```

- [ ] **Step 2: Tests para `load_sh_report`**

```python
from tools.dual_source_recovery import load_sh_report


class TestLoadShReport:
    def test_loads_basic_row(self, tmp_path):
        path = _make_sh_report(tmp_path, [
            {"Id SH": 12345, "Cliente": "SCHNEIDER", "Número de parte": "ABC-001",
             "Descripción": "TEST", "Metal base": "COBRE",
             "Etiqueta 1": "PLATA", "Etiqueta 2": "ANTITARNISH",
             "Proceso": "PLATA SELECTIVA",
             "Notas adicionales": "F1: PLATA | F2: ANTITARNISH | SPECS: PLATA | DEPT: 16 | METAL: COBRE | PROC: PLATA",
             "QuoteIBMS": "Q-001"},
        ])
        rows = load_sh_report(path)
        assert len(rows) == 1
        r = rows[0]
        assert r.id_sh == "12345"
        assert r.cliente == "SCHNEIDER"
        assert r.pn == "ABC-001"
        assert r.metal_base == "COBRE"
        assert r.labels == ["PLATA", "ANTITARNISH", "", "", ""]
        assert r.proceso == "PLATA SELECTIVA"
        assert r.quote_ibms == "Q-001"
        assert r.source == "sh_report"
        assert r.source_row == 2

    def test_skips_completely_empty_rows(self, tmp_path):
        path = _make_sh_report(tmp_path, [
            {"Id SH": 1, "Cliente": "X", "Número de parte": "A"},
            {},  # empty row
            {"Id SH": 2, "Cliente": "Y", "Número de parte": "B"},
        ])
        rows = load_sh_report(path)
        assert len(rows) == 2
        assert {r.pn for r in rows} == {"A", "B"}

    def test_raw_dict_includes_all_headers(self, tmp_path):
        path = _make_sh_report(tmp_path, [
            {"Id SH": 1, "Cliente": "X", "Número de parte": "A",
             "Plata (kg/pza)": 0.5, "Notas adicionales": "F1: X | F2: Y | SPECS: Z"},
        ])
        rows = load_sh_report(path)
        assert rows[0].raw["Plata (kg/pza)"] == 0.5
        assert rows[0].raw["Notas adicionales"] == "F1: X | F2: Y | SPECS: Z"

    def test_aborts_if_required_header_missing(self, tmp_path):
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "ING. Validación de Carga Masiva"
        ws["A1"] = "Cliente"  # falta Id SH, Número de parte, etc.
        path = tmp_path / "bad.xlsx"
        wb.save(path)

        with pytest.raises(ValueError, match="header esperado"):
            load_sh_report(path)
```

- [ ] **Step 3: Correr tests (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestLoadShReport -v
```

Expected: FAIL.

- [ ] **Step 4: Implementar `load_sh_report`**

```python
# Headers requeridos en el reporte SH (los que el script lee SIEMPRE)
REQUIRED_SH_HEADERS = (
    "Id SH", "Cliente", "Número de parte", "Descripción",
    "Metal base", "Etiqueta 1", "Etiqueta 2", "Etiqueta 3", "Etiqueta 4", "Etiqueta 5",
    "Proceso", "Spec 1", "Spec 2", "Notas adicionales", "QuoteIBMS",
)


def load_sh_report(path: str | Path) -> list[PartNumberRow]:
    """Lee el reporte oficial de SH (xlsx, hoja única, headers row 1)."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
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
```

- [ ] **Step 5: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestLoadShReport -v
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): load_sh_report() + PartNumberRow factory"
```

---

## Task 7: `load_xlsm_originals()` — leer xlsm de bulk-upload

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Helper para crear xlsm sintético**

Agregar a `tools/test_dual_source_recovery.py`:

```python
def _make_xlsm(tmp_path, name, rows):
    """Crea un xlsm tipo 'BD Numeros de Parte' con headers en row 7 + datos desde row 9.

    `rows` es lista de dicts {header → value}.
    """
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Upload"
    # Row 7 headers (subset suficiente para tests)
    headers = [
        "Archivado", "Validación\n1er recibo", "Forzar\nduplicar", "Archivar\nanterior",
        "Cliente", "Número de\nparte", "Descripción", "PN alterno", "Grupo",
        "Cantidad", "Precio", "Unidad\nprecio", "Divisa", "Precio\ndefault",
        "Metal base",
        "Etiqueta 1", "Etiqueta 2", "Etiqueta 3", "Etiqueta 4", "Etiqueta 5",
        "Proceso",
        "Producto 1", "Precio P1", "Cant P1", "Unidad P1",
        "Producto 2", "Precio P2", "Cant P2", "Unidad P2",
        "Producto 3", "Precio P3", "Cant P3", "Unidad P3",
        "Spec 1", "Esp. Spec 1\n(µm)", "Spec 2", "Esp. Spec 2\n(µm)",
        "KGM\n(kg/pza)", "CMK\n(cm²/pza)", "LM\n(m/pza)", "Mín Pzas\nLote",
        "Rack Flybar o Barril (Carga)", "Pzas/Rack\nLínea", "Rack Específico", "Pzas/Rack\nSec.",
        "Longitud\n(m)", "Ancho\n(m)", "Alto\n(m)", "Diám.Ext\n(m)", "Diám.Int\n(m)",
        "Línea", "Departamento", "Código SAT",
        "Plata\n(kg/pza)", "Estaño\n(kg/pza)", "Níquel\n(kg/pza)", "Zinc\n(kg/pza)", "Cobre\n(kg/pza)",
        "Antitarnish\n(L/pza)", "Epóx. MT\n(lb/pza)", "Epóx. BT\n(lb/pza)", "Epóx. MTR\n(lb/pza)",
        "Notas adicionales", "QuoteIBMS", "EstIBMS", "Plano",
        "Piezas por Carga", "Cargas por Hora", "Tiempo de Entrega",
    ]
    for i, h in enumerate(headers, start=1):
        ws.cell(row=7, column=i, value=h)
    # row 8 subheaders (V/F, Texto, etc.) — el script los ignora
    ws.cell(row=8, column=1, value="V/F")
    import re as _re
    clean = {_re.sub(r"\s+", " ", h.replace("\n", " ").strip()): i for i, h in enumerate(headers, start=1)}
    for r_idx, row_dict in enumerate(rows, start=9):
        for key, val in row_dict.items():
            col = clean.get(key)
            if col:
                ws.cell(row=r_idx, column=col, value=val)
    path = tmp_path / name
    wb.save(path)
    return path
```

- [ ] **Step 2: Tests**

```python
from tools.dual_source_recovery import load_xlsm_originals


class TestLoadXlsmOriginals:
    def test_loads_basic_row(self, tmp_path):
        path = _make_xlsm(tmp_path, "test.xlsm", [
            {"Cliente": "SCHNEIDER", "Número de parte": "ABC-001",
             "Metal base": "COBRE", "Etiqueta 1": "PLATA",
             "Proceso": "PLATA SELECTIVA",
             "Notas adicionales": "F1: PLATA | SPECS: PLATA | DEPT: 16 | METAL: COBRE | PROC: PLATA",
             "QuoteIBMS": "Q-001"},
        ])
        rows = load_xlsm_originals([(path, "xlsm_test")])
        assert len(rows) == 1
        r = rows[0]
        assert r.cliente == "SCHNEIDER"
        assert r.pn == "ABC-001"
        assert r.metal_base == "COBRE"
        assert r.labels[0] == "PLATA"
        assert r.proceso == "PLATA SELECTIVA"
        assert r.quote_ibms == "Q-001"
        assert r.source == "xlsm_test"
        assert r.id_sh == ""  # xlsm no tiene Id SH

    def test_multiple_files_concatenates(self, tmp_path):
        p1 = _make_xlsm(tmp_path, "a.xlsm", [
            {"Cliente": "C1", "Número de parte": "PN1"},
        ])
        p2 = _make_xlsm(tmp_path, "b.xlsm", [
            {"Cliente": "C2", "Número de parte": "PN2"},
            {"Cliente": "C3", "Número de parte": "PN3"},
        ])
        rows = load_xlsm_originals([(p1, "xlsm_srg"), (p2, "xlsm_cg")])
        assert len(rows) == 3
        assert [r.source for r in rows].count("xlsm_srg") == 1
        assert [r.source for r in rows].count("xlsm_cg") == 2

    def test_skips_rows_without_pn(self, tmp_path):
        path = _make_xlsm(tmp_path, "test.xlsm", [
            {"Cliente": "C1", "Número de parte": "PN1"},
            {"Cliente": "C2"},  # no PN
            {},  # vacío
        ])
        rows = load_xlsm_originals([(path, "xlsm_test")])
        assert len(rows) == 1
```

- [ ] **Step 3: Correr tests (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestLoadXlsmOriginals -v
```

Expected: FAIL.

- [ ] **Step 4: Implementar `load_xlsm_originals`**

```python
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
    return all_rows
```

- [ ] **Step 5: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestLoadXlsmOriginals -v
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): load_xlsm_originals() multi-source"
```

---

## Task 8: `filter_round()` — aplicar `is_round_marker` al universo SH

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Tests**

```python
from tools.dual_source_recovery import filter_round


class TestFilterRound:
    def test_filters_by_marker(self, tmp_path):
        from tools.dual_source_recovery import load_sh_report
        path = _make_sh_report(tmp_path, [
            {"Id SH": 1, "Cliente": "C", "Número de parte": "A",
             "Notas adicionales": "F1: X | F2: Y | SPECS: Z | DEPT: 1 | METAL: M"},
            {"Id SH": 2, "Cliente": "C", "Número de parte": "B",
             "Notas adicionales": "EMPAQUE CON PAPEL SILVER SAVER"},
            {"Id SH": 3, "Cliente": "C", "Número de parte": "C",
             "Notas adicionales": ""},
        ])
        rows = load_sh_report(path)
        filtered = filter_round(rows)
        assert len(filtered) == 1
        assert filtered[0].id_sh == "1"
```

- [ ] **Step 2: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestFilterRound -v
```

- [ ] **Step 3: Implementar**

```python
def filter_round(rows: list[PartNumberRow]) -> list[PartNumberRow]:
    """Filtra rows que tienen la marca estructurada de 'esta ronda' en Notas adicionales."""
    return [r for r in rows if is_round_marker(r.notas)]
```

- [ ] **Step 4: Correr**

```bash
pytest tools/test_dual_source_recovery.py::TestFilterRound -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): filter_round() aplica is_round_marker al universo SH"
```

---

## Task 9: `match_xlsm_to_sh()` — los 3 tiers de matching

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Definir `MatchResult` dataclass + tests**

Agregar al test:

```python
from tools.dual_source_recovery import match_xlsm_to_sh, MatchResult


def _mk_row(source="sh_report", id_sh="", cliente="C", pn="P", quote_ibms="",
            metal_base="", labels=None, notas=""):
    return PartNumberRow(
        source=source, source_row=2, id_sh=id_sh, cliente=cliente, pn=pn,
        descripcion="", quote_ibms=quote_ibms, est_ibms="", notas=notas,
        metal_base=metal_base, labels=labels or ["", "", "", "", ""],
        proceso="", spec1="", spec1_um="", spec2="", spec2_um="", raw={},
    )


class TestMatchXlsmToSh:
    def test_tier1_quoteibms(self):
        xlsm = [_mk_row(source="xlsm", quote_ibms="Q-001", cliente="C1", pn="A")]
        sh = [_mk_row(id_sh="100", quote_ibms="Q-001", cliente="C1", pn="A")]
        result = match_xlsm_to_sh(xlsm, sh)
        assert len(result.matched) == 1
        assert result.matched[0].tier == "quoteIBMS"
        assert result.matched[0].sh_row.id_sh == "100"
        assert result.unmatched_xlsm == []
        assert result.duplicate_quoteibms == []

    def test_tier1_duplicate_quoteibms_falls_to_tier2(self):
        xlsm = [_mk_row(source="xlsm", quote_ibms="Q-001", cliente="C1", pn="A")]
        sh = [
            _mk_row(id_sh="100", quote_ibms="Q-001", cliente="C1", pn="A"),
            _mk_row(id_sh="200", quote_ibms="Q-001", cliente="C2", pn="B"),
        ]
        result = match_xlsm_to_sh(xlsm, sh)
        # 2 candidatos por QuoteIBMS → duplicate bucket + cae a tier 2
        assert len(result.duplicate_quoteibms) == 1
        assert result.duplicate_quoteibms[0]["quoteIBMS"] == "Q-001"
        # tier 2 resuelve por (C1, A) único → match con id_sh=100
        assert len(result.matched) == 1
        assert result.matched[0].tier == "composite_unique"
        assert result.matched[0].sh_row.id_sh == "100"

    def test_tier2_composite_unique(self):
        xlsm = [_mk_row(source="xlsm", cliente="C1", pn="A")]
        sh = [_mk_row(id_sh="100", cliente="C1", pn="A")]
        result = match_xlsm_to_sh(xlsm, sh)
        assert len(result.matched) == 1
        assert result.matched[0].tier == "composite_unique"

    def test_tier3_fingerprint(self):
        xlsm = [_mk_row(source="xlsm", cliente="C1", pn="A",
                        metal_base="COBRE", labels=["PLATA", "", "", "", ""])]
        sh = [
            _mk_row(id_sh="100", cliente="C1", pn="A",
                    metal_base="COBRE", labels=["PLATA", "", "", "", ""]),
            _mk_row(id_sh="200", cliente="C1", pn="A",
                    metal_base="ACERO", labels=["ZINC", "", "", "", ""]),
        ]
        result = match_xlsm_to_sh(xlsm, sh)
        assert len(result.matched) == 1
        assert result.matched[0].tier == "fingerprint"
        assert result.matched[0].sh_row.id_sh == "100"

    def test_unmatched_no_pn_in_sh_round(self):
        xlsm = [_mk_row(source="xlsm", cliente="C1", pn="A")]
        sh = [_mk_row(id_sh="100", cliente="OTHER", pn="OTHER")]
        result = match_xlsm_to_sh(xlsm, sh)
        assert result.matched == []
        assert len(result.unmatched_xlsm) == 1
        assert result.unmatched_xlsm[0]["reason"] == "no_pn_in_sh_round"

    def test_unmatched_ambiguous_fingerprint(self):
        # 2 candidatos con MISMO metal+labels → fingerprint no discrimina
        xlsm = [_mk_row(source="xlsm", cliente="C1", pn="A",
                        metal_base="COBRE", labels=["PLATA", "", "", "", ""])]
        sh = [
            _mk_row(id_sh="100", cliente="C1", pn="A",
                    metal_base="COBRE", labels=["PLATA", "", "", "", ""]),
            _mk_row(id_sh="200", cliente="C1", pn="A",
                    metal_base="COBRE", labels=["PLATA", "", "", "", ""]),
        ]
        result = match_xlsm_to_sh(xlsm, sh)
        assert result.matched == []
        assert len(result.unmatched_xlsm) == 1
        assert result.unmatched_xlsm[0]["reason"] == "ambiguous_fingerprint"

    def test_unmatched_sh_in_round(self):
        xlsm = [_mk_row(source="xlsm", cliente="C1", pn="A")]
        sh = [
            _mk_row(id_sh="100", cliente="C1", pn="A"),
            _mk_row(id_sh="200", cliente="C2", pn="B"),  # no match en xlsm
        ]
        result = match_xlsm_to_sh(xlsm, sh)
        assert len(result.unmatched_sh_in_round) == 1
        assert result.unmatched_sh_in_round[0]["idSH"] == "200"
```

- [ ] **Step 2: Correr tests (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestMatchXlsmToSh -v
```

- [ ] **Step 3: Implementar matching**

Agregar a `tools/dual_source_recovery.py`:

```python
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
```

- [ ] **Step 4: Correr tests**

```bash
pytest tools/test_dual_source_recovery.py::TestMatchXlsmToSh -v
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): match_xlsm_to_sh() con 3 tiers"
```

---

## Task 10: `validate_notas()` — validador de Notas adicionales

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Tests**

```python
from tools.dual_source_recovery import validate_notas


class TestValidateNotas:
    def test_both_empty_returns_ok(self):
        x = _mk_row(notas="")
        s = _mk_row(notas="")
        assert validate_notas(x, s) == "ok"

    def test_both_equal_returns_ok(self):
        x = _mk_row(notas="F1: PLATA | SPECS: PLATA | DEPT: 16")
        s = _mk_row(notas="F1: PLATA | SPECS: PLATA | DEPT: 16")
        assert validate_notas(x, s) == "ok"

    def test_normalizes_whitespace(self):
        x = _mk_row(notas="F1: PLATA  |  SPECS: PLATA")
        s = _mk_row(notas="f1:    plata | specs: plata")
        assert validate_notas(x, s) == "ok"

    def test_sh_empty_xlsm_full_returns_ok(self):
        # carga parcial: el PN se creó sin notas pero el match es válido
        x = _mk_row(notas="F1: PLATA | SPECS: PLATA")
        s = _mk_row(notas="")
        assert validate_notas(x, s) == "ok"

    def test_both_full_but_different_returns_suspicious(self):
        x = _mk_row(notas="F1: PLATA | SPECS: PLATA | DEPT: 16")
        s = _mk_row(notas="F1: ZINC | SPECS: ZINC | DEPT: 7")
        assert validate_notas(x, s) == "suspicious"

    def test_xlsm_empty_sh_full_returns_ok(self):
        # xlsm sin notas: no podemos validar, confiar en el tier
        x = _mk_row(notas="")
        s = _mk_row(notas="F1: PLATA | SPECS: PLATA")
        assert validate_notas(x, s) == "ok"
```

- [ ] **Step 2: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestValidateNotas -v
```

- [ ] **Step 3: Implementar**

```python
def validate_notas(xlsm_row: PartNumberRow, sh_row: PartNumberRow) -> str:
    """Validador único del match.

    Retorna 'ok' o 'suspicious'.
    'suspicious' SOLO si ambos lados tienen notas no vacías y difieren.
    """
    nx = norm(xlsm_row.notas)
    ns = norm(sh_row.notas)
    if nx and ns and nx != ns:
        return "suspicious"
    return "ok"
```

- [ ] **Step 4: Correr**

```bash
pytest tools/test_dual_source_recovery.py::TestValidateNotas -v
```

Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): validate_notas() único validador del match"
```

---

## Task 11: Tabla `FIELD_RULES` + helper `compare_values`

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Definir tabla de reglas**

Agregar a `tools/dual_source_recovery.py`:

```python
# Acciones permitidas por columna
ACTION_NEVER = "never"
ACTION_CONSERVATIVE = "conservative"  # escribir solo si SH vacío
ACTION_OVERWRITE = "overwrite"        # escribir si difiere

# Tipos de comparación
TYPE_STRING = "string"
TYPE_NUMBER = "number"
TYPE_LABEL_SET = "label_set"  # cols 1-5 como set

FIELD_RULES: list[dict] = [
    # (header_name, action, type)
    {"header": "Descripción",                 "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "PN alterno",                  "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Grupo",                       "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Línea",                       "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Metal base",                  "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "_labels_",                    "action": ACTION_OVERWRITE,    "type": TYPE_LABEL_SET},  # especial: cols 1-5
    {"header": "Proceso",                     "action": ACTION_OVERWRITE,    "type": TYPE_STRING},
    {"header": "Spec 1",                      "action": ACTION_OVERWRITE,    "type": TYPE_STRING},
    {"header": "Esp. Spec 1 (µm)",            "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Spec 2",                      "action": ACTION_OVERWRITE,    "type": TYPE_STRING},
    {"header": "Esp. Spec 2 (µm)",            "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "KGM (kg/pza)",                "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "CMK (cm²/pza)",               "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "LM (m/pza)",                  "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Mín Pzas Lote",               "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Rack Flybar o Barril (Carga)","action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Pzas/Rack Línea",             "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Rack Específico",             "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Pzas/Rack Sec.",              "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Tipo de Geometría",           "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Longitud (m)",                "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Ancho (m)",                   "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Alto (m)",                    "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Diám.Ext (m)",                "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Diám.Int (m)",                "action": ACTION_CONSERVATIVE, "type": TYPE_NUMBER},
    {"header": "Departamento",                "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Código SAT",                  "action": ACTION_CONSERVATIVE, "type": TYPE_STRING},
    {"header": "Plata (kg/pza)",              "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Estaño (kg/pza)",             "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Níquel (kg/pza)",             "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Zinc (kg/pza)",               "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Cobre (kg/pza)",              "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Antitarnish (L/pza)",         "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Epóx. MT (lb/pza)",           "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Epóx. BT (lb/pza)",           "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Epóx. MTR (lb/pza)",          "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "QuoteIBMS",                   "action": ACTION_OVERWRITE,    "type": TYPE_STRING},
    {"header": "EstIBMS",                     "action": ACTION_OVERWRITE,    "type": TYPE_STRING},
    {"header": "Plano",                       "action": ACTION_OVERWRITE,    "type": TYPE_STRING},
    {"header": "Piezas por Carga",            "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Cargas por Hora",             "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    {"header": "Tiempo de Entrega",           "action": ACTION_OVERWRITE,    "type": TYPE_NUMBER},
    # Notas adicionales: NUNCA se escribe (es validador)
    # Cliente, Número de parte: NUNCA (llaves; van como referencia visual fuera de FIELD_RULES)
    # Cantidad, Precio, Unidad precio, Divisa, Precio default, Productos 1-3: NUNCA (sensibles)
]

NUMERIC_TOLERANCE = 1e-6
```

- [ ] **Step 2: Tests para `compare_values`**

```python
from tools.dual_source_recovery import compare_values, TYPE_STRING, TYPE_NUMBER


class TestCompareValues:
    def test_strings_equal_normalized(self):
        assert compare_values("PLATA", "plata", TYPE_STRING) is True
        assert compare_values("  PLATA  ", "plata", TYPE_STRING) is True

    def test_strings_different(self):
        assert compare_values("PLATA", "ZINC", TYPE_STRING) is False

    def test_numbers_within_tolerance(self):
        assert compare_values(0.500001, 0.5, TYPE_NUMBER) is True
        assert compare_values("0.5", 0.5, TYPE_NUMBER) is True

    def test_numbers_different(self):
        assert compare_values(0.5, 0.6, TYPE_NUMBER) is False

    def test_one_empty(self):
        assert compare_values("", "PLATA", TYPE_STRING) is False
        assert compare_values("PLATA", "", TYPE_STRING) is False
        assert compare_values("", "", TYPE_STRING) is True

    def test_number_empty_vs_zero(self):
        # vacío != 0 (cuidado con falsos positivos)
        assert compare_values("", 0, TYPE_NUMBER) is False

    def test_number_invalid_string_falls_to_string_compare(self):
        # si no parsea, comparar como string
        assert compare_values("N/A", "n/a", TYPE_NUMBER) is True
```

- [ ] **Step 3: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestCompareValues -v
```

- [ ] **Step 4: Implementar `compare_values`**

```python
def _to_float_or_none(v) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def compare_values(xlsm_val, sh_val, type_: str) -> bool:
    """True si son equivalentes según el tipo."""
    if type_ == TYPE_NUMBER:
        fx = _to_float_or_none(xlsm_val)
        fs = _to_float_or_none(sh_val)
        if fx is None and fs is None:
            return norm(xlsm_val) == norm(sh_val)
        if fx is None or fs is None:
            # uno vacío, otro número → distintos (incluso si el número es 0)
            return False
        return abs(fx - fs) < NUMERIC_TOLERANCE
    # string
    return norm(xlsm_val) == norm(sh_val)
```

- [ ] **Step 5: Correr**

```bash
pytest tools/test_dual_source_recovery.py::TestCompareValues -v
```

Expected: PASS (7).

- [ ] **Step 6: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): FIELD_RULES + compare_values"
```

---

## Task 12: `compute_field_diffs()` — generar deltas por PN

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Tests**

```python
from tools.dual_source_recovery import compute_field_diffs


class TestComputeFieldDiffs:
    def _pair(self, xlsm_raw, sh_raw, xlsm_labels=None, sh_labels=None):
        x = _mk_row(source="xlsm", labels=xlsm_labels or ["", "", "", "", ""])
        s = _mk_row(id_sh="100", labels=sh_labels or ["", "", "", "", ""])
        x.raw = xlsm_raw
        s.raw = sh_raw
        return x, s

    def test_overwrite_when_different(self):
        x, s = self._pair({"Proceso": "PLATA"}, {"Proceso": "ZINC"})
        x.proceso = "PLATA"
        s.proceso = "ZINC"
        diffs = compute_field_diffs(x, s)
        assert {"field": "Proceso", "xlsm": "PLATA", "sh": "ZINC", "action": "overwrite"} in diffs

    def test_overwrite_when_sh_empty(self):
        x, s = self._pair({"Proceso": "PLATA"}, {"Proceso": ""})
        x.proceso = "PLATA"
        diffs = compute_field_diffs(x, s)
        assert any(d["field"] == "Proceso" for d in diffs)

    def test_no_diff_when_equal(self):
        x, s = self._pair({"Proceso": "PLATA"}, {"Proceso": "plata"})
        x.proceso = "PLATA"
        s.proceso = "plata"
        diffs = compute_field_diffs(x, s)
        assert all(d["field"] != "Proceso" for d in diffs)

    def test_conservative_does_not_overwrite(self):
        # Descripción: conservador → si SH tiene valor distinto, NO escribir
        x, s = self._pair({"Descripción": "DESC X"}, {"Descripción": "DESC Y"})
        x.descripcion = "DESC X"
        s.descripcion = "DESC Y"
        diffs = compute_field_diffs(x, s)
        assert all(d["field"] != "Descripción" for d in diffs)

    def test_conservative_writes_when_sh_empty(self):
        x, s = self._pair({"Descripción": "DESC X"}, {"Descripción": ""})
        x.descripcion = "DESC X"
        diffs = compute_field_diffs(x, s)
        assert {"field": "Descripción", "xlsm": "DESC X", "sh": "", "action": "fill"} in diffs

    def test_empty_xlsm_never_writes(self):
        x, s = self._pair({"Proceso": ""}, {"Proceso": "ZINC"})
        diffs = compute_field_diffs(x, s)
        assert all(d["field"] != "Proceso" for d in diffs)

    def test_dash_propagates_for_overwrite(self):
        # xlsm tiene "-" → propagar como borrado
        x, s = self._pair({"Proceso": "-"}, {"Proceso": "ZINC"})
        x.proceso = "-"
        s.proceso = "ZINC"
        diffs = compute_field_diffs(x, s)
        assert {"field": "Proceso", "xlsm": "-", "sh": "ZINC", "action": "delete"} in diffs

    def test_dash_in_conservative_does_not_propagate(self):
        x, s = self._pair({"Descripción": "-"}, {"Descripción": "DESC Y"})
        x.descripcion = "-"
        s.descripcion = "DESC Y"
        diffs = compute_field_diffs(x, s)
        assert all(d["field"] != "Descripción" for d in diffs)

    def test_labels_set_equal_no_diff(self):
        x, s = self._pair({}, {},
                          xlsm_labels=["PLATA", "ANTITARNISH", "", "", ""],
                          sh_labels=["ANTITARNISH", "PLATA", "", "", ""])
        diffs = compute_field_diffs(x, s)
        assert all(d["field"] != "_labels_" for d in diffs)

    def test_labels_set_xlsm_has_extra(self):
        # xlsm: {PLATA, ANTITARNISH}; sh: {PLATA} → escribir las 5 cols con las del xlsm
        x, s = self._pair({}, {},
                          xlsm_labels=["PLATA", "ANTITARNISH", "", "", ""],
                          sh_labels=["PLATA", "", "", "", ""])
        diffs = compute_field_diffs(x, s)
        label_diffs = [d for d in diffs if d["field"] == "_labels_"]
        assert len(label_diffs) == 1
        assert label_diffs[0]["xlsm_labels"] == ["PLATA", "ANTITARNISH", "", "", ""]
        assert label_diffs[0]["sh_extra"] == []  # SH no tiene extras

    def test_labels_set_sh_has_extra(self):
        # sh: {PLATA, ZINC}; xlsm: {PLATA} → flag extras, escribir solo xlsm labels
        x, s = self._pair({}, {},
                          xlsm_labels=["PLATA", "", "", "", ""],
                          sh_labels=["PLATA", "ZINC", "", "", ""])
        diffs = compute_field_diffs(x, s)
        label_diffs = [d for d in diffs if d["field"] == "_labels_"]
        assert len(label_diffs) == 1
        assert "ZINC" in label_diffs[0]["sh_extra"]

    def test_number_within_tolerance_no_diff(self):
        x, s = self._pair({"Plata (kg/pza)": 0.5000001}, {"Plata (kg/pza)": 0.5})
        diffs = compute_field_diffs(x, s)
        assert all(d["field"] != "Plata (kg/pza)" for d in diffs)
```

- [ ] **Step 2: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestComputeFieldDiffs -v
```

- [ ] **Step 3: Implementar**

```python
def _norm_labels(labels: list[str]) -> list[str]:
    """Normaliza labels: cada uno upper+strip; conserva las 5 posiciones."""
    out: list[str] = []
    for l in (labels + ["", "", "", "", ""])[:5]:
        out.append(str(l or "").strip().upper())
    return out


def _label_set(labels: list[str]) -> set[str]:
    return {l for l in _norm_labels(labels) if l != ""}


def compute_field_diffs(xlsm_row: PartNumberRow, sh_row: PartNumberRow) -> list[dict]:
    """Genera la lista de campos a escribir según FIELD_RULES.

    Cada diff: {field, xlsm, sh, action}
      action ∈ {fill, overwrite, delete}
    Para labels: {field='_labels_', xlsm_labels:[...], sh_labels:[...], sh_extra:[...], action='overwrite'}
    """
    diffs: list[dict] = []

    for rule in FIELD_RULES:
        h = rule["header"]
        action = rule["action"]
        type_ = rule["type"]

        if h == "_labels_":
            x_labels = _norm_labels(xlsm_row.labels)
            s_labels = _norm_labels(sh_row.labels)
            x_set = _label_set(x_labels)
            s_set = _label_set(s_labels)
            if x_set == s_set:
                continue
            # decisión por defecto del spec: solo agregamos las que faltan; flag las que sobran en SH
            sh_extra = sorted(s_set - x_set)
            diffs.append({
                "field": "_labels_",
                "xlsm_labels": x_labels,
                "sh_labels": s_labels,
                "sh_extra": sh_extra,
                "action": "overwrite",
            })
            continue

        x_raw = xlsm_row.raw.get(h)
        s_raw = sh_row.raw.get(h)
        x_str = "" if x_raw is None else str(x_raw).strip()
        s_str = "" if s_raw is None else str(s_raw).strip()

        # xlsm vacío → nunca escribir (vacío = "no tocar" según convención v10/v11)
        if x_str == "":
            continue

        # xlsm == "-" → borrado solo si la columna es overwrite Y SH tiene valor
        if x_str == "-":
            if action == ACTION_OVERWRITE and s_str != "":
                diffs.append({"field": h, "xlsm": "-", "sh": s_str, "action": "delete"})
            continue

        # comparar
        equal = compare_values(x_raw, s_raw, type_)

        if action == ACTION_NEVER:
            continue
        if action == ACTION_CONSERVATIVE:
            # escribir solo si SH vacío (no overwrite)
            if s_str == "":
                diffs.append({"field": h, "xlsm": x_str, "sh": "", "action": "fill"})
            continue
        if action == ACTION_OVERWRITE:
            if not equal:
                act = "overwrite" if s_str != "" else "fill"
                diffs.append({"field": h, "xlsm": x_str, "sh": s_str, "action": act})

    return diffs
```

- [ ] **Step 4: Correr**

```bash
pytest tools/test_dual_source_recovery.py::TestComputeFieldDiffs -v
```

Expected: PASS (12).

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): compute_field_diffs() con reglas mixtas"
```

---

## Task 13: `emit_v11_xlsx()` — genera plantilla v11 poblada

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Test**

```python
import openpyxl as _openpyxl
from tools.dual_source_recovery import emit_v11_xlsx


class TestEmitV11Xlsx:
    def test_emits_one_row_per_correction(self, tmp_path):
        template = "/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/remote/templates/Plantilla_Cotizaciones_v11.xlsm"
        out = tmp_path / "out.xlsm"

        # 1 correction: PN con Proceso a sobreescribir
        corrections = [{
            "idSH": "12345",
            "customer": "SCHNEIDER",
            "pn": "ABC-001",
            "tier": "quoteIBMS",
            "diffs": [
                {"field": "Proceso", "xlsm": "PLATA SELECTIVA", "sh": "", "action": "fill"},
                {"field": "_labels_", "xlsm_labels": ["PLATA", "ANTITARNISH", "", "", ""],
                 "sh_labels": ["PLATA", "", "", "", ""], "sh_extra": [], "action": "overwrite"},
                {"field": "Plata (kg/pza)", "xlsm": "0.5", "sh": "", "action": "fill"},
            ],
        }]

        emit_v11_xlsx(template_path=template, corrections=corrections, out_path=out)

        wb = _openpyxl.load_workbook(out, read_only=True, data_only=True, keep_vba=True)
        ws = wb["Upload"]
        # row 9 = primera fila de datos
        # Id SH en col E (5)
        assert ws.cell(row=9, column=5).value in ("12345", 12345)
        # Cliente en col F (6) - referencia visual
        assert ws.cell(row=9, column=6).value == "SCHNEIDER"
        # PN en col G (7)
        assert ws.cell(row=9, column=7).value == "ABC-001"

    def test_omits_pns_without_diffs(self, tmp_path):
        template = "/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/remote/templates/Plantilla_Cotizaciones_v11.xlsm"
        out = tmp_path / "out.xlsm"
        emit_v11_xlsx(template_path=template, corrections=[], out_path=out)

        wb = _openpyxl.load_workbook(out, read_only=True, data_only=True, keep_vba=True)
        ws = wb["Upload"]
        # row 9 vacía
        assert ws.cell(row=9, column=5).value in (None, "")
```

- [ ] **Step 2: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestEmitV11Xlsx -v
```

- [ ] **Step 3: Implementar**

```python
def emit_v11_xlsx(template_path: str | Path, corrections: list[dict], out_path: str | Path) -> None:
    """Copia la plantilla v11 y agrega 1 fila por correction desde row 9.

    El template tiene macros (.xlsm). Usamos keep_vba=True para preservarlos.
    """
    wb = openpyxl.load_workbook(template_path, keep_vba=True, data_only=False)
    if "Upload" not in wb.sheetnames:
        raise ValueError(f"template no tiene hoja 'Upload': {template_path}")
    ws = wb["Upload"]
    headers = read_header_map(ws, header_row=7)

    # Validar headers requeridos en el template
    required_v11 = ("Id SH", "Cliente", "Número de parte", "Proceso", "Notas adicionales")
    for r in required_v11:
        if r not in headers:
            raise ValueError(f"template v11: header esperado no encontrado: {r!r}")

    # Asegurar 'Etiqueta 1..5' resueltos
    label_cols = [headers.get(f"Etiqueta {i}") for i in range(1, 6)]
    if any(c is None for c in label_cols):
        raise ValueError("template v11: Etiqueta 1-5 no resueltos")

    start_row = 9
    for offset, corr in enumerate(corrections):
        r = start_row + offset
        # referencia visual obligatoria
        ws.cell(row=r, column=headers["Id SH"], value=corr["idSH"])
        ws.cell(row=r, column=headers["Cliente"], value=corr["customer"])
        ws.cell(row=r, column=headers["Número de parte"], value=corr["pn"])

        for d in corr["diffs"]:
            if d["field"] == "_labels_":
                xlsm_labels = d["xlsm_labels"]
                for i, lab in enumerate(xlsm_labels, start=0):
                    if i >= 5:
                        break
                    col = label_cols[i]
                    ws.cell(row=r, column=col, value=lab if lab else None)
                continue
            col = headers.get(d["field"])
            if col is None:
                # campo no existe en v11 (raro) → ignorar pero loguear vía stderr
                print(f"WARN: campo {d['field']!r} no existe en template v11, ignorado", file=sys.stderr)
                continue
            value = d["xlsm"] if d["action"] != "delete" else "-"
            ws.cell(row=r, column=col, value=value)

    out_path = Path(out_path)
    wb.save(out_path)
```

- [ ] **Step 4: Correr**

```bash
pytest tools/test_dual_source_recovery.py::TestEmitV11Xlsx -v
```

Expected: PASS (2). Si openpyxl falla guardando .xlsm por compatibilidad de macros, abortar y reportar — el spec menciona fallback a .xlsx plano.

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): emit_v11_xlsx() con plantilla v11 + labels"
```

---

## Task 14: `emit_json_report()` — auditoría JSON

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Test**

```python
from tools.dual_source_recovery import emit_json_report


class TestEmitJsonReport:
    def test_full_structure(self, tmp_path):
        out = tmp_path / "report.json"
        emit_json_report(
            out_path=out,
            inputs={"srg_xlsm": "a.xlsm", "cg_xlsm": "b.xlsm", "sh_report": "r.xlsx"},
            counts={
                "xlsm_rows_total": 100,
                "sh_rows_total": 200,
                "sh_rows_in_round": 110,
                "matched": 95,
                "suspicious_matches": 5,
                "unmatched_xlsm": 5,
                "unmatched_sh_in_round": 15,
                "duplicate_quoteibms_buckets": 2,
                "corrections_emitted": 80,
            },
            field_correction_counts={"Proceso": 10, "_labels_": 25},
            corrections=[{"idSH": "1", "customer": "C", "pn": "P", "tier": "quoteIBMS", "diffs": []}],
            suspicious_matches=[],
            unmatched_xlsm=[],
            unmatched_sh_in_round=[],
            duplicate_quoteibms=[],
        )
        data = json.loads(out.read_text())
        assert data["counts"]["matched"] == 95
        assert "generated_at" in data
        assert data["inputs"]["srg_xlsm"] == "a.xlsm"
        assert isinstance(data["corrections"], list)
```

- [ ] **Step 2: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestEmitJsonReport -v
```

- [ ] **Step 3: Implementar**

```python
def emit_json_report(
    out_path: str | Path,
    inputs: dict,
    counts: dict,
    field_correction_counts: dict,
    corrections: list,
    suspicious_matches: list,
    unmatched_xlsm: list,
    unmatched_sh_in_round: list,
    duplicate_quoteibms: list,
) -> None:
    from datetime import datetime, timezone
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "inputs": inputs,
        "counts": counts,
        "field_correction_counts": field_correction_counts,
        "corrections": corrections,
        "suspicious_matches": suspicious_matches,
        "unmatched_xlsm": unmatched_xlsm,
        "unmatched_sh_in_round": unmatched_sh_in_round,
        "duplicate_quoteibms": duplicate_quoteibms,
    }
    Path(out_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2))
```

- [ ] **Step 4: Correr**

```bash
pytest tools/test_dual_source_recovery.py::TestEmitJsonReport -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): emit_json_report() con estructura completa"
```

---

## Task 15: CLI + `main()` — pegar todo

**Files:**
- Modify: `tools/dual_source_recovery.py`
- Modify: `tools/test_dual_source_recovery.py`

- [ ] **Step 1: Test smoke end-to-end con archivos sintéticos**

```python
from tools.dual_source_recovery import main


class TestMainSmoke:
    def test_runs_end_to_end(self, tmp_path):
        template = "/Users/oviazcan/Projects/Ecoplating/SteelheadAutomator/remote/templates/Plantilla_Cotizaciones_v11.xlsm"

        # xlsm con 1 PN
        xlsm_srg = _make_xlsm(tmp_path, "srg.xlsm", [
            {"Cliente": "SCHNEIDER", "Número de parte": "ABC-001",
             "Metal base": "COBRE", "Etiqueta 1": "PLATA",
             "Proceso": "PLATA SELECTIVA",
             "Notas adicionales": "F1: PLATA | SPECS: PLATA | DEPT: 16 | METAL: COBRE | PROC: PLATA",
             "QuoteIBMS": "Q-001",
             "Plata (kg/pza)": 0.5},
        ])
        xlsm_cg = _make_xlsm(tmp_path, "cg.xlsm", [])

        # SH report con el mismo PN pero sin Proceso ni predictive (carga parcial)
        sh = _make_sh_report(tmp_path, [
            {"Id SH": 12345, "Cliente": "SCHNEIDER", "Número de parte": "ABC-001",
             "Metal base": "COBRE", "Etiqueta 1": "PLATA",
             "Proceso": "",
             "Notas adicionales": "F1: PLATA | SPECS: PLATA | DEPT: 16 | METAL: COBRE | PROC: PLATA",
             "QuoteIBMS": "Q-001",
             "Plata (kg/pza)": ""},
        ])

        out_xlsx = tmp_path / "out.xlsm"
        out_json = tmp_path / "out.json"

        rc = main([
            "--srg-xlsm", str(xlsm_srg),
            "--cg-xlsm",  str(xlsm_cg),
            "--sh-report", str(sh),
            "--template", template,
            "--out-xlsx", str(out_xlsx),
            "--report-json", str(out_json),
        ])
        assert rc == 0

        # JSON debe tener 1 corrección
        data = json.loads(out_json.read_text())
        assert data["counts"]["matched"] == 1
        assert data["counts"]["corrections_emitted"] == 1
        # Proceso + Plata (kg/pza) entre los campos corregidos
        fields_corrected = {d["field"] for d in data["corrections"][0]["diffs"]}
        assert "Proceso" in fields_corrected
        assert "Plata (kg/pza)" in fields_corrected

        # xlsx output debe existir y tener la fila 9 con id_sh
        wb = openpyxl.load_workbook(out_xlsx, read_only=True, data_only=True, keep_vba=True)
        ws = wb["Upload"]
        assert ws.cell(row=9, column=5).value in ("12345", 12345)
```

- [ ] **Step 2: Correr (fallar)**

```bash
pytest tools/test_dual_source_recovery.py::TestMainSmoke -v
```

- [ ] **Step 3: Implementar `main`**

Reemplazar el stub `main` de Task 1:

```python
def _summarize_corrections(matched: list[MatchedPair]) -> tuple[list[dict], dict[str, int]]:
    """Aplica compute_field_diffs a cada match y genera (corrections[], field_counts)."""
    corrections: list[dict] = []
    field_counts: dict[str, int] = defaultdict(int)
    for pair in matched:
        diffs = compute_field_diffs(pair.xlsm_row, pair.sh_row)
        if not diffs:
            continue
        for d in diffs:
            field_counts[d["field"]] += 1
        corrections.append({
            "idSH": pair.sh_row.id_sh,
            "customer": pair.sh_row.cliente,
            "pn": pair.sh_row.pn,
            "tier": pair.tier,
            "diffs": diffs,
        })
    # orden estable: por (customer, pn)
    corrections.sort(key=lambda c: (c["customer"], c["pn"]))
    return corrections, dict(field_counts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dual-source offline recovery for Steelhead bulk-upload.")
    parser.add_argument("--srg-xlsm", required=True)
    parser.add_argument("--cg-xlsm", required=True)
    parser.add_argument("--sh-report", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--out-xlsx", required=True)
    parser.add_argument("--report-json", required=True)
    args = parser.parse_args(argv)

    print("Loading xlsm originals...", file=sys.stderr)
    xlsm_rows = load_xlsm_originals([
        (args.srg_xlsm, "xlsm_srg"),
        (args.cg_xlsm, "xlsm_cg"),
    ])
    print(f"  xlsm rows total: {len(xlsm_rows)}", file=sys.stderr)

    print("Loading SH report...", file=sys.stderr)
    sh_rows = load_sh_report(args.sh_report)
    print(f"  sh rows total: {len(sh_rows)}", file=sys.stderr)

    sh_round = filter_round(sh_rows)
    print(f"  sh rows in round: {len(sh_round)}", file=sys.stderr)

    # Pre-flight: cobertura
    coverage = len(sh_round) / max(1, len(xlsm_rows))
    if coverage < 0.9:
        print(f"WARN: cobertura xlsm→sh_round={coverage:.0%} < 90%. Revisar regex de marker.", file=sys.stderr)

    print("Matching...", file=sys.stderr)
    match_result = match_xlsm_to_sh(xlsm_rows, sh_round)
    print(f"  matched: {len(match_result.matched)}", file=sys.stderr)
    print(f"  unmatched_xlsm: {len(match_result.unmatched_xlsm)}", file=sys.stderr)
    print(f"  unmatched_sh_in_round: {len(match_result.unmatched_sh_in_round)}", file=sys.stderr)
    print(f"  duplicate_quoteibms: {len(match_result.duplicate_quoteibms)}", file=sys.stderr)

    # Validar Notas + separar sospechosos
    valid_matches: list[MatchedPair] = []
    suspicious: list[dict] = []
    for pair in match_result.matched:
        status = validate_notas(pair.xlsm_row, pair.sh_row)
        if status == "suspicious":
            suspicious.append({
                "idSH": pair.sh_row.id_sh,
                "customer": pair.sh_row.cliente,
                "pn": pair.sh_row.pn,
                "tier": pair.tier,
                "notas_xlsm": pair.xlsm_row.notas[:300],
                "notas_sh": pair.sh_row.notas[:300],
            })
        else:
            valid_matches.append(pair)
    print(f"  suspicious_matches: {len(suspicious)}", file=sys.stderr)

    print("Computing field diffs...", file=sys.stderr)
    corrections, field_counts = _summarize_corrections(valid_matches)
    print(f"  corrections_emitted: {len(corrections)}", file=sys.stderr)

    print(f"Writing xlsx → {args.out_xlsx}", file=sys.stderr)
    emit_v11_xlsx(template_path=args.template, corrections=corrections, out_path=args.out_xlsx)

    print(f"Writing json → {args.report_json}", file=sys.stderr)
    counts = {
        "xlsm_rows_total": len(xlsm_rows),
        "sh_rows_total": len(sh_rows),
        "sh_rows_in_round": len(sh_round),
        "matched": len(match_result.matched),
        "suspicious_matches": len(suspicious),
        "unmatched_xlsm": len(match_result.unmatched_xlsm),
        "unmatched_sh_in_round": len(match_result.unmatched_sh_in_round),
        "duplicate_quoteibms_buckets": len(match_result.duplicate_quoteibms),
        "corrections_emitted": len(corrections),
    }
    emit_json_report(
        out_path=args.report_json,
        inputs={"srg_xlsm": args.srg_xlsm, "cg_xlsm": args.cg_xlsm, "sh_report": args.sh_report},
        counts=counts,
        field_correction_counts=field_counts,
        corrections=corrections,
        suspicious_matches=suspicious,
        unmatched_xlsm=match_result.unmatched_xlsm,
        unmatched_sh_in_round=match_result.unmatched_sh_in_round,
        duplicate_quoteibms=match_result.duplicate_quoteibms,
    )

    # resumen stdout
    print(json.dumps(counts, indent=2))
    return 0
```

- [ ] **Step 4: Correr smoke test**

```bash
pytest tools/test_dual_source_recovery.py::TestMainSmoke -v
```

Expected: PASS.

- [ ] **Step 5: Correr toda la suite**

```bash
pytest tools/test_dual_source_recovery.py -v
```

Expected: ALL PASS (~50+ tests).

- [ ] **Step 6: Commit**

```bash
git add tools/dual_source_recovery.py tools/test_dual_source_recovery.py
git commit -m "feat(dual-source): main() CLI + pipeline completo"
```

---

## Task 16: Bitácora + entry en CLAUDE.md

**Files:**
- Create: `docs/applets/dual-source-recovery.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Crear bitácora**

```markdown
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
```

- [ ] **Step 2: Agregar entry en CLAUDE.md tabla de applets**

Buscar la tabla "Índice de applets" en `CLAUDE.md` y agregar al final:

```markdown
| `dual-source-recovery` (tool standalone, no extensión) | 1.0.0 | [`docs/applets/dual-source-recovery.md`](docs/applets/dual-source-recovery.md) |
```

- [ ] **Step 3: Commit**

```bash
git add docs/applets/dual-source-recovery.md CLAUDE.md
git commit -m "docs(dual-source): bitácora 1.0.0 + entry en índice"
```

---

## Task 17: Smoke run con datos reales 2026-05-27

**Files:** (sin cambios de código)

- [ ] **Step 1: Identificar paths reales**

```bash
ls -lah ~/Downloads/"BD Numeros de Parte Reloaded v23 valores base final SRG.xlsm" \
        ~/Downloads/"BD Numeros de Parte Reloaded v23 valores base final clientes generales.xlsm" \
        ~/Downloads/"ING. Validación de Carga Masiva NP 2026-05-27 (1).xlsx"
```

Expected: 3 archivos existen.

- [ ] **Step 2: Ejecutar el script**

```bash
cd /Users/oviazcan/Projects/Ecoplating/SteelheadAutomator
python3 tools/dual_source_recovery.py \
  --srg-xlsm "/Users/oviazcan/Downloads/BD Numeros de Parte Reloaded v23 valores base final SRG.xlsm" \
  --cg-xlsm  "/Users/oviazcan/Downloads/BD Numeros de Parte Reloaded v23 valores base final clientes generales.xlsm" \
  --sh-report "/Users/oviazcan/Downloads/ING. Validación de Carga Masiva NP 2026-05-27 (1).xlsx" \
  --template "remote/templates/Plantilla_Cotizaciones_v11.xlsm" \
  --out-xlsx "/Users/oviazcan/Downloads/recovery_dualsource_$(date +%Y-%m-%dT%H-%M-%S).xlsm" \
  --report-json "/Users/oviazcan/Downloads/dualsource_report_$(date +%Y-%m-%dT%H-%M-%S).json"
```

Expected:
- `xlsm rows total` ≈ 17 966
- `sh rows total` ≈ 24 678
- `sh rows in round` ≈ 17 000–18 000 (debe ser ≥ 90% de xlsm_rows_total)
- `matched` ≈ 95% de xlsm rows
- `corrections_emitted` > 0 (idealmente cientos a miles)
- Sin warnings de cobertura < 90%
- Exit code 0

- [ ] **Step 3: Revisar JSON output**

```bash
python3 -c "
import json
data = json.load(open('/Users/oviazcan/Downloads/dualsource_report_<timestamp>.json'))
print('Counts:', json.dumps(data['counts'], indent=2))
print('Field corrections:', json.dumps(data['field_correction_counts'], indent=2))
print('Suspicious sample:', data['suspicious_matches'][:3] if data['suspicious_matches'] else 'none')
print('Duplicate QuoteIBMS sample:', data['duplicate_quoteibms'][:3] if data['duplicate_quoteibms'] else 'none')
"
```

Reemplazar `<timestamp>` con el archivo real generado.

Expected: contenido razonable; field_correction_counts muestra dónde están las correcciones (idealmente Proceso, Predictivos, _labels_ liderando).

- [ ] **Step 4: Spot-check 5 PNs random**

```bash
python3 -c "
import json, random
data = json.load(open('/Users/oviazcan/Downloads/dualsource_report_<timestamp>.json'))
sample = random.sample(data['corrections'], min(5, len(data['corrections'])))
for c in sample:
    print(f\"--- {c['customer']} / {c['pn']} (Id SH {c['idSH']}) — tier={c['tier']}\")
    for d in c['diffs']:
        print(f\"   {d['field']}: xlsm={d.get('xlsm', d.get('xlsm_labels'))!r}  sh={d.get('sh', d.get('sh_labels'))!r}  action={d['action']}\")
"
```

Para cada uno, abrir manualmente en SH (`https://app.gosteelhead.com/part-numbers/<idSH>`) y verificar que los campos `sh: ""` están vacíos.

- [ ] **Step 5: Reportar resultado al usuario**

Pegar en chat: `counts` + `field_correction_counts` + lista de 5 PNs spot-checked.

---

## Self-Review

**Spec coverage:**

- Pipeline 7 pasos: Tasks 6 (load_sh_report), 7 (load_xlsm), 8 (filter_round), 9 (match), 10 (validate_notas), 12 (compute_field_diffs), 13 (emit_v11_xlsx), 14 (emit_json_report), 15 (main wire-up). ✓
- Tabla FIELD_RULES con 42 campos: Task 11 cubre la tabla; Task 12 los aplica. ✓
- Discriminador `is_round_marker`: Task 3. ✓
- Mapping por nombre: Task 5 (`read_header_map`). ✓
- Plan de validación spec (4 pasos): Task 17 (cobertura pre-flight automática + spot-check manual). ✓
- Entregables (script + tests + bitácora + CLAUDE.md): Tasks 1-16. ✓
- Edge cases del spec:
  - PN huérfano → `unmatched_xlsm.reason=no_pn_in_sh_round` (Task 9 test 5). ✓
  - Duplicate QuoteIBMS → `duplicate_quoteibms[]` (Task 9 test 2). ✓
  - Sospechoso por Notas → `suspicious_matches[]` (Task 15 main). ✓
  - Predictivo tolerance 1e-6 → Task 11 (`compare_values`). ✓
  - Etiquetas como set → Task 12 test labels_set. ✓
  - `-` propagation → Task 12 tests dash_*. ✓

**Placeholder scan:** revisé y no encontré TBD/TODO/implement-later. Todos los steps tienen código completo o comandos exactos.

**Type consistency:** `MatchedPair`, `MatchResult`, `PartNumberRow` se usan consistentemente. `FIELD_RULES` keys (`header`, `action`, `type`) consistentes entre Task 11 (definición) y Task 12 (consumo). Función `compute_field_diffs` retorna `list[dict]` con shape estable `{field, xlsm, sh, action}` (excepto el caso `_labels_` que tiene shape distinto pero documentado).

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-27-dual-source-offline-recovery.md`. Dos opciones de ejecución:**

**1. Subagent-Driven (recommended)** - Despacho un subagente fresh por task, review entre tasks, iteración rápida.

**2. Inline Execution** - Ejecuto las tasks en esta sesión con executing-plans, batch execution con checkpoints para review.

**¿Cuál prefieres?**
