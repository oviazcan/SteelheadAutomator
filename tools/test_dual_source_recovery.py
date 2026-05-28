"""Tests for tools/dual_source_recovery.py."""

from __future__ import annotations

import pytest

from tools.dual_source_recovery import (
    ROUND_MARKER_TOKENS,
    is_round_marker,
    main,
    make_fingerprint,
    norm,
)


def test_module_imports():
    """El módulo debe importarse sin errores."""
    from tools import dual_source_recovery as m
    assert callable(m.main)


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
