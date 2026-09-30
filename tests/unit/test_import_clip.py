"""Рамка архива, торчащая за кадр, режется по кадру как рамка и считается.

До 01.10.2026 подрезались только координаты по одной: у «0.95 0.5 0.2 0.2»
каждое число в [0,1], и рамка уходила за правый край, а отчёт писал
«0 подрезано».
"""
import pytest

from datasets_svc.importer import _parse_label_text, clip_box


def test_рамка_за_краем_режется_по_кадру():
    shapes, clipped, err = _parse_label_text("1 0.95 0.5 0.2 0.2\n")
    assert err is None and clipped == 1
    cx, cy, w, h = shapes[0]["v"]
    assert cx + w / 2 == pytest.approx(1.0)
    assert cx - w / 2 == pytest.approx(0.85)
    assert (cy, h) == (0.5, 0.2)


def test_рамка_в_кадре_не_тронута_и_не_считается():
    shapes, clipped, err = _parse_label_text("0 0.5 0.5 0.4 0.4\n0 0.1 0.1 0.2 0.2\n")
    assert err is None and clipped == 0
    assert shapes[0]["v"] == [0.5, 0.5, 0.4, 0.4]
    assert shapes[1]["v"] == [0.1, 0.1, 0.2, 0.2]


def test_счёт_по_фигуре_а_не_по_координате():
    """Рамка, торчащая в углу (два края), — один подрезанный объект."""
    _, clipped, _ = _parse_label_text("0 0.02 0.98 0.1 0.1\n")
    assert clipped == 1


def test_clip_box_угол():
    cx, cy, w, h = clip_box([0.0, 1.0, 0.2, 0.4])
    assert (cx - w / 2, cx + w / 2) == pytest.approx((0.0, 0.1))
    assert (cy - h / 2, cy + h / 2) == pytest.approx((0.8, 1.0))
