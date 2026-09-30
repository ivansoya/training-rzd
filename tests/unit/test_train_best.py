"""Лучшая эпоха и осиротевшие обучения — числами, без базы и торча.

Обе находки аудита 01.10.2026 были «тихими»: лучшая эпоха не записалась ни
у одного рана (ключа fitness в метриках нет), а ран, прерванный перезапуском
воркера, навсегда оставался «идёт».
"""
from datetime import datetime, timedelta, timezone

from training_svc.metrics import best_of, fitness_of
from training_svc.trainer import orphan_verdict

B, M = "metrics/mAP50-95(B)", "metrics/mAP50-95(M)"


def test_пригодность_как_у_ultralytics_84():
    # Рамки: только mAP50-95; mAP50 не входит.
    assert fitness_of({B: 0.4, "metrics/mAP50(B)": 0.9}) == 0.4
    # Сегментация: маски плюс рамки.
    assert abs(fitness_of({B: 0.4, M: 0.3}, "segment") - 0.7) < 1e-9
    assert fitness_of({B: 0.4, M: 0.3}, "detect") == 0.4
    assert fitness_of({"box_loss": 1.0}) is None


def test_лучшая_эпоха_без_строки_итоговой_проверки():
    rows = [(1, {B: 0.2}), (2, {B: 0.5}), (3, {B: 0.4}), (4, {B: 0.9})]
    # Эпох было три; четвёртая строка — итоговая проверка лучших весов.
    assert best_of(rows, last=3) == (2, 0.5)
    assert best_of(rows) == (4, 0.9)
    # Записанная пригодность главнее формулы; равные — за ранней.
    assert best_of([(1, {"fitness": 0.7, B: 0.1}), (2, {B: 0.7})]) == (1, 0.7)
    assert best_of([]) == (None, None)


def test_сирота_по_тишине_дольше_аренды():
    now = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)
    fresh, old = now - timedelta(seconds=20), now - timedelta(seconds=500)
    assert orphan_verdict("running", False, fresh, now, 120) is None
    assert orphan_verdict("running", False, old, now, 120) == "error"
    assert orphan_verdict("running", True, old, now, 120) == "stopped"
    assert orphan_verdict("stopping", False, old, now, 120) == "stopped"
    assert orphan_verdict("preparing", False, None, now, 120) == "error"
    # Законченные и ждущие очереди — не сироты.
    for status in ("done", "error", "stopped", "queued", "waiting_gpu"):
        assert orphan_verdict(status, False, old, now, 120) is None
    # На старте воркера свои раны закрываются сразу.
    assert orphan_verdict("running", False, fresh, now, 0) == "error"
