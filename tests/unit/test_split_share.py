"""Сборка набора: доли разделителя на подмножестве кадров и имена узлов в предупреждениях."""
import hashlib
import uuid
from types import SimpleNamespace

import pytest

pytest.importorskip("albumentations")
pytest.importorskip("cv2")

from dataprep_svc import engine  # noqa: E402


def test_доли_держатся_внутри_строки():
    every = [SimpleNamespace(id=uuid.UUID(int=i * 7919 + 1)) for i in range(600)]
    # Строка берёт часть отбора — половину по отпечатку, как деление train/val.
    row = [img for img in every if hashlib.sha1(str(img.id).encode()).digest()[0] < 68]
    rank_of = engine.ranks(row)
    first = sum(engine.place(rank_of[img.id]) * 3 < 2 for img in row)
    assert abs(first - len(row) * 2 / 3) <= 1, (first, len(row))
    assert sorted(rank_of.values()) == list(range(len(row)))


def test_узел_в_предупреждении_назван_по_русски():
    assert engine.node_label({"id": "aug2135", "type": "aug",
                              "params": {"op": "RandomBrightnessContrast"}}) == "«Яркость и контраст»"
    assert engine.node_label({"id": "crop", "type": "flow",
                              "params": {"label": "Кадрирование", "ops": []}}) == "«Кадрирование»"
