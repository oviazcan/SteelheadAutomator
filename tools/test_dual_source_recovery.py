"""Tests for tools/dual_source_recovery.py."""

from __future__ import annotations

import pytest

from tools.dual_source_recovery import main


def test_module_imports():
    """El módulo debe importarse sin errores."""
    from tools import dual_source_recovery as m
    assert callable(m.main)
