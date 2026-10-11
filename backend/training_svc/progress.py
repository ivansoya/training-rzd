"""Ход обучения в базу — и в обычном процессе, и в дочерних процессах карт.

Обучение на нескольких картах ultralytics заводит так: пишет временный файл и
запускает его через `torch.distributed.run`, а тот поднимает тренер заново по
имени класса. Обработчики, повешенные на модель в `runner.py`, туда не доезжают —
ни эпохи, ни «Остановить», ни метрики. Поэтому ход вешает сам класс тренера при
создании: в своём процессе — общий с бегуном, в дочернем — свой по `MAG_RUN_ID`,
и только на нулевом ранге — остальные карты молчат.
"""
import os
import time

from sqlalchemy import update
from ultralytics.models.yolo.detect import DetectionTrainer
from ultralytics.models.yolo.segment import SegmentationTrainer
from ultralytics.utils import RANK

from common import gpu, live
from common.db import SessionLocal
from common.models import TrainEpoch, TrainRun, utcnow
from training_svc import metrics as metrics_lib, trainer as trainer_lib

HOT_EVERY = 0.8

# Ход этого процесса: бегун кладёт сюда свой, чтобы тренер повесил именно его.
CURRENT = None


class Progress:
    """Обработчики хода. Запись двухуровневая: горячее (батчи, потери) — один
    короткий UPDATE не чаще раза в 0,8 с; холодное (конец эпохи) — своя строка
    плюс уведомление, его ждут открытые вкладки."""

    def __init__(self, db, run):
        self.db, self.run = db, run
        self.hot = {"last": 0.0, "epoch_started": time.time()}
        # Эпохи кончились — дальше итоговая проверка ultralytics. Она зовёт тот же
        # `on_fit_epoch_end` с номером N+1, и раньше это становилось ещё одной
        # «эпохой»: лишняя точка на графике, «эпоха 3 из 2». Флаг ставим по
        # `trainer.stop`: он поднимается перед обработчиком последней настоящей
        # эпохи — и по сроку, и по ранней остановке.
        self.final = False

    @classmethod
    def from_env(cls):
        run_id = os.environ.get("MAG_RUN_ID")
        if not run_id:
            return None
        db = SessionLocal()
        run = db.get(TrainRun, run_id)
        return cls(db, run) if run is not None else None

    def attach(self, target):
        for event, fn in (("on_train_epoch_start", self.epoch_start), ("on_train_batch_end", self.batch_end),
                          ("on_val_start", self.val_start), ("on_val_batch_end", self.val_batch_end),
                          ("on_fit_epoch_end", self.fit_epoch_end)):
            target.add_callback(event, fn)

    @staticmethod
    def loss_items(trn):
        out = {}
        try:
            tloss = getattr(trn, "tloss", None)
            if tloss is not None:
                for k, v in trn.label_loss_items(tloss).items():
                    out[k.split("/")[-1]] = float(v)
        except Exception:
            pass
        return out

    def hot_write(self, **fields):
        """Короткий UPDATE по горячему пути. Возвращает «нас не сняли?»."""
        now = time.time()
        if now - self.hot["last"] < HOT_EVERY:
            return True
        self.hot["last"] = now
        for key, value in fields.items():
            setattr(self.run, key, value)
        self.run.lease_until = utcnow()
        self.db.commit()
        self.db.refresh(self.run)
        return not self.run.cancel_requested

    def epoch_start(self, trn):
        run = self.run
        run.current_epoch = int(getattr(trn, "epoch", 0)) + 1
        try:
            run.total_batches = len(trn.train_loader)
        except Exception:
            run.total_batches = None
        run.phase = "train"
        run.current_batch = 0
        run.batch_metrics = {}
        self.hot["epoch_started"] = time.time()
        self.hot["last"] = 0.0
        self.db.commit()

    def batch_end(self, trn):
        run = self.run
        run.current_batch = int(run.current_batch or 0) + 1
        got = self.loss_items(trn)
        if not self.hot_write(batch_metrics=got or run.batch_metrics, phase="train"):
            raise KeyboardInterrupt("Обучение сняли.")

    def val_start(self, validator):
        run = self.run
        run.phase = "final" if self.final else "val"
        run.val_batch = 0
        try:
            run.val_total = len(validator.dataloader)
        except Exception:
            run.val_total = None
        self.hot["last"] = 0.0
        self.db.commit()

    def val_batch_end(self, validator):
        self.run.val_batch = int(self.run.val_batch or 0) + 1
        self.hot_write(phase=self.run.phase)

    def fit_epoch_end(self, trn):
        if self.final:
            # Итоговая проверка ultralytics: её числа — лучшие веса, а не эпоха.
            # Свою итоговую проверку бегун делает сам.
            return
        run, db = self.run, self.db
        epoch = int(getattr(trn, "epoch", 0)) + 1
        raw = getattr(trn, "metrics", None) or {}
        metrics = {k: float(v) for k, v in raw.items() if isinstance(v, (int, float))}
        metrics.update(self.loss_items(trn))
        # Пригодность ultralytics выкидывает из словаря метрик и держит отдельно —
        # по ней выбран best.pt. Без неё «лучшая эпоха» не находилась ни у одного рана.
        try:
            fit = float(getattr(trn, "fitness", None))
        except (TypeError, ValueError):
            fit = None
        if fit is None or fit != fit:  # нет или NaN
            fit = metrics_lib.fitness_of(metrics, run.task)
        if fit is not None:
            metrics["fitness"] = fit
        row = db.get(TrainEpoch, (run.id, epoch))
        seconds = time.time() - self.hot["epoch_started"]
        lr = getattr(trn, "lr", None)
        if row is None:
            db.add(TrainEpoch(
                run_id=run.id, epoch=epoch, metrics=metrics, seconds=seconds,
                lr=float(lr.get("lr/pg0", 0) or 0) if isinstance(lr, dict) else None,
            ))
        else:
            row.metrics = metrics
            row.seconds = seconds
        run.current_epoch = epoch
        run.peak_vram_mb = peak_mb(getattr(trn, "device", None)) or run.peak_vram_mb
        fitness = metrics.get("fitness")
        if fitness is not None and (run.best_fitness is None or fitness > run.best_fitness):
            run.best_fitness = fitness
            run.best_epoch = epoch
        db.commit()
        # Уведомление говорит, ЧТО изменилось; состояние вкладка дочитает сама. У
        # NOTIFY предел восемь тысяч байт, и метрики в нём однажды уронили бы транзакцию.
        live.notify(db, "run", run.id, run.project_id, e=epoch)
        if run.gpu_lease_id:
            gpu.beat(db, run.gpu_lease_id, run.peak_vram_mb)
        if getattr(trn, "stop", False):
            self.final = True


def peak_mb(device):
    """Сколько видеопамяти держит этот процесс на своей карте.

    Резерв аллокатора, а не выделенное: соседу мешает именно резерв. И у torch, а
    не у nvidia-smi: в контейнере тот показывает всю карту вместе с чужими задачами.
    На нескольких картах это карта нулевого ранга — у остальных столько же."""
    if device is None or str(device) == "cpu":
        return None
    try:
        import torch

        return int(torch.cuda.max_memory_reserved(device) // (1024 * 1024))
    except Exception:
        return None


def _hook(trn):
    # Дочерний процесс карты — чистый интерпретатор: заплатки бегуна в нём заново.
    trainer_lib._disable_builtin_albumentations()
    trainer_lib.pin_memory_policy()
    if RANK not in (-1, 0):
        return
    progress = CURRENT or Progress.from_env()
    if progress is not None:
        progress.attach(trn)


def _note_failure(exc):
    """Процесс карты упал — его причину бегун покажет вместо «Command … exit status 1»:
    сам бегун видит только код выхода. Пишет первый упавший."""
    run_id = os.environ.get("MAG_RUN_ID")
    if RANK == -1 or not run_id:
        return
    db = SessionLocal()
    try:
        db.execute(update(TrainRun).where(TrainRun.id == run_id, TrainRun.error.is_(None))
                   .values(error=f"{type(exc).__name__}: {exc}"[:2000]))
        db.commit()
    finally:
        db.close()


class _Mag:
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        _hook(self)

    def train(self):
        try:
            return super().train()
        except Exception as exc:
            _note_failure(exc)
            raise


class MagDetectionTrainer(_Mag, DetectionTrainer):
    pass


class MagSegmentationTrainer(_Mag, SegmentationTrainer):
    pass


def trainer_for(task):
    return MagSegmentationTrainer if task == "segment" else MagDetectionTrainer
