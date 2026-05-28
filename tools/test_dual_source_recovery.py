"""Tests for tools/dual_source_recovery.py."""

from __future__ import annotations

import pytest

from tools.dual_source_recovery import main


def test_module_imports():
    """El módulo debe importarse sin errores."""
    from tools import dual_source_recovery as m
    assert callable(m.main)


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
