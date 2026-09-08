"""Отдельный процесс, в котором идёт обучение.

Процесс, а не поток, и это не перестраховка: прервать ultralytics посреди
эпохи можно только сигналом всей группе процессов. Он же изолирует падение —
нехватка видеопамяти уносит один ран, а не воркер со всей очередью.

Состояние пишется в базу, а не в файл рядом с весами. Ради этого всё и
затевалось: пока оно лежало в памяти одного процесса, у сервиса стоял один
рабочий процесс, и тридцать две открытые вкладки останавливали раздел всем.

Запись двухуровневая. Горячее (батчи, потери) — один короткий UPDATE не чаще
раза в восемьсот миллисекунд: у батчей темп больше десяти в секунду, и писать
каждый значило бы утопить базу на пустом месте. Холодное (конец эпохи) — своя
строка плюс уведомление; его ждут открытые вкладки.
"""
import argparse
import os
import time

from sqlalchemy import select

# Каталоги ultralytics для конфигов и кэша — мимо тома с данными.
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp/ultralytics")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/mpl")

from common import config, gpu, live  # noqa: E402
from common.db import SessionLocal  # noqa: E402
from common.models import TrainEpoch, TrainRun, TrainSet, utcnow  # noqa: E402
from training_svc import metrics as metrics_lib, trainer  # noqa: E402

HOT_EVERY = 0.8


def _peak_mb(device):
    """Сколько видеопамяти держит этот процесс.

    Берём резерв аллокатора, а не выделенное: соседу по карте мешает именно
    резерв. И берём у torch, а не у nvidia-smi: в контейнере тот показывает
    всю карту вместе с чужими задачами, и приписывать чужое своей — вернейший
    способ раздуть оценку до полной карты и заблокировать её навсегда.
    """
    if str(device) == "cpu":
        return None
    try:
        import torch

        idx = int(str(device).split(":")[-1]) if ":" in str(device) else 0
        return int(torch.cuda.max_memory_reserved(idx) // (1024 * 1024))
    except Exception:
        return None


def _final_metrics(model, data_yaml, device, overrides, out_dir):
    """Итоговая проверка лучших весов — и всё, что с неё можно снять.

    Отдельным проходом, а не по ходу обучения: матрица ошибок считается лишь
    при `plots=True`, и платить за неё каждой эпохой незачем — нужна она один
    раз и по лучшей модели, а не по последней. После `model.train()` в
    `model` уже лежат лучшие веса, поэтому проверять надо именно его.

    Сбой разбора не роняет обучение: веса посчитаны, и терять их из-за
    неудачной таблицы было бы обидно вдвойне. Причина в этом случае доедет
    до экрана вместе с пустой таблицей.
    """
    grabbed = {}

    def keep(validator):
        grabbed["v"] = validator

    try:
        model.add_callback("on_val_end", keep)
        with trainer.confusion_enabled():
            model.val(
                data=data_yaml,
                device=device,
                imgsz=overrides.get("imgsz", 640),
                batch=overrides.get("batch", 16),
                plots=True,       # ради счёта матрицы; рисование отключено
                verbose=False,
                project=out_dir,
                name="val",
                exist_ok=True,
            )
        validator = grabbed.get("v")
        if validator is None:
            return {"error": "Проверка не позвала обработчик — метрик нет."}
        return metrics_lib.from_validator(validator)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Метрики не собрались: {exc}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    args = ap.parse_args()

    db = SessionLocal()
    run = db.get(TrainRun, args.run_id)
    if run is None:
        raise SystemExit("Ран не найден.")
    tset = db.get(TrainSet, run.set_id) if run.set_id else None
    if tset is None or not tset.dir_path:
        run.status = "error"
        run.error = "Обучающий набор удалён — учиться не на чем."
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="error")
        db.close()
        return

    run.status = "running"
    run.started_at = utcnow()
    run.pid = os.getpid()
    db.commit()
    live.notify(db, "run", run.id, run.project_id, s="running")

    data_yaml = os.path.join(
        config.DATA_DIR, tset.dir_path or "", "data.yaml"
    )
    out_dir = config.run_dir(run.project_id, run.id)
    os.makedirs(out_dir, exist_ok=True)

    try:
        from ultralytics import YOLO

        trainer._disable_builtin_albumentations()
        trainer.pin_memory_policy()
        device = run.device
        is_cpu = str(device) == "cpu"

        # Веса — с тома; нет на томе — качаются, и это видно как отдельная
        # фаза, а не как молчание перед первой эпохой.
        fetched = {"last": 0.0}

        def fetching(have, total):
            now = time.time()
            if now - fetched["last"] < HOT_EVERY:
                return
            fetched["last"] = now
            run.phase = "weights"
            run.val_batch = int(have // (1 << 20))
            run.val_total = int(total // (1 << 20)) if total else None
            run.lease_until = utcnow()
            db.commit()

        spec = trainer.resolve_weights(
            run.base_weights_path or run.base_model, on_progress=fetching
        )
        model = YOLO(spec)

        hot = {"last": 0.0, "epoch_started": time.time()}

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

        def hot_write(**fields):
            """Короткий UPDATE по горячему пути. Возвращает «нас не сняли?»."""
            now = time.time()
            if now - hot["last"] < HOT_EVERY:
                return True
            hot["last"] = now
            for key, value in fields.items():
                setattr(run, key, value)
            run.lease_until = utcnow()
            db.commit()
            db.refresh(run)
            return not run.cancel_requested

        def epoch_start(trn):
            run.current_epoch = int(getattr(trn, "epoch", 0)) + 1
            try:
                run.total_batches = len(trn.train_loader)
            except Exception:
                run.total_batches = None
            run.phase = "train"
            run.current_batch = 0
            run.batch_metrics = {}
            hot["epoch_started"] = time.time()
            hot["last"] = 0.0
            db.commit()

        def batch_end(trn):
            run.current_batch = int(run.current_batch or 0) + 1
            got = loss_items(trn)
            alive = hot_write(
                batch_metrics=got or run.batch_metrics, phase="train"
            )
            if not alive:
                raise KeyboardInterrupt("Обучение сняли.")

        def val_start(validator):
            run.phase = "val"
            run.val_batch = 0
            try:
                run.val_total = len(validator.dataloader)
            except Exception:
                run.val_total = None
            hot["last"] = 0.0
            db.commit()

        def val_batch_end(validator):
            run.val_batch = int(run.val_batch or 0) + 1
            hot_write(phase="val")

        def fit_epoch_end(trn):
            epoch = int(getattr(trn, "epoch", 0)) + 1
            raw = getattr(trn, "metrics", None) or {}
            metrics = {
                k: float(v) for k, v in raw.items()
                if isinstance(v, (int, float))
            }
            metrics.update(loss_items(trn))
            row = db.get(TrainEpoch, (run.id, epoch))
            seconds = time.time() - hot["epoch_started"]
            if row is None:
                db.add(TrainEpoch(
                    run_id=run.id, epoch=epoch, metrics=metrics,
                    lr=float(getattr(trn, "lr", {}).get("lr/pg0", 0) or 0)
                    if isinstance(getattr(trn, "lr", None), dict) else None,
                    seconds=seconds,
                ))
            else:
                row.metrics = metrics
                row.seconds = seconds
            run.current_epoch = epoch
            run.peak_vram_mb = _peak_mb(device) or run.peak_vram_mb
            fitness = metrics.get("fitness")
            if fitness is not None and (
                run.best_fitness is None or fitness > run.best_fitness
            ):
                run.best_fitness = fitness
                run.best_epoch = epoch
            db.commit()
            # Уведомление говорит, ЧТО изменилось; состояние вкладка дочитает
            # сама. У NOTIFY предел восемь тысяч байт, и класть в него метрики
            # значило бы однажды уронить транзакцию посреди эпохи.
            live.notify(db, "run", run.id, run.project_id, e=epoch)
            if run.gpu_lease_id:
                gpu.beat(db, run.gpu_lease_id, run.peak_vram_mb)

        model.add_callback("on_train_epoch_start", epoch_start)
        model.add_callback("on_train_batch_end", batch_end)
        model.add_callback("on_val_start", val_start)
        model.add_callback("on_val_batch_end", val_batch_end)
        model.add_callback("on_fit_epoch_end", fit_epoch_end)

        # Загрузчиков по умолчанию: на видеокарте меньше — при закреплённой
        # памяти их избыток вызывает нехватку памяти в потоке закрепления.
        cores = os.cpu_count() or 2
        params = trainer.filter_params(run.params or {})
        has_graph = bool(tset.graph_version_id or tset.val_graph_version_id)
        overrides, aug_mode = trainer.aug_overrides(params, has_graph)
        overrides["workers"] = min(8, cores) if is_cpu else min(4, cores)
        overrides.update(trainer.train_overrides(params))
        overrides.update(
            data=data_yaml, project=out_dir, name="train", exist_ok=True,
            device=device, plots=False, verbose=False, augment=False,
            amp=not is_cpu, cache=False,
        )
        results = model.train(**overrides)

        best = os.path.join(out_dir, "train", "weights", "best.pt")
        if os.path.isfile(best):
            run.weights_path = os.path.relpath(best, config.DATA_DIR)
            run.weights_bytes = os.path.getsize(best)
        try:
            run.summary = {
                k: float(v) for k, v in
                (getattr(results, "results_dict", {}) or {}).items()
                if isinstance(v, (int, float))
            }
        except Exception:
            pass
        # Сколько эпох прошло на самом деле: ранняя остановка по `patience`
        # заканчивает раньше, и «30 из 100» на экране без объяснения
        # выглядит как обрыв.
        try:
            done = int(getattr(model.trainer, "epoch", -1)) + 1
            if done > 0:
                run.summary = dict(run.summary or {}, epochs_done=done,
                                   stopped_early=int(done < run.epochs))
        except Exception:
            pass
        run.params = dict(run.params or {}, augment_mode=aug_mode,
                          weights=os.path.basename(str(spec)))

        # Итоговая проверка: метрики по классам, матрица ошибок и кривые.
        # `model.validator` после обучения пуст — раньше отсюда и брали, и
        # поэтому матрица всегда была пустой.
        run.phase = "val"
        run.val_batch = 0
        db.commit()
        final = _final_metrics(model, data_yaml, device, overrides, out_dir)
        if final.get("error"):
            run.per_class = {"rows": [], "totals": None, "error": final["error"]}
        else:
            run.per_class = final.get("per_class")
            run.confusion = final.get("confusion")
            run.curves = final.get("curves")
            if final.get("summary"):
                # Итоги проверки поверх, но не вместо: сколько эпох прошло и
                # была ли ранняя остановка — знает только обучение.
                run.summary = dict(run.summary or {}, **final["summary"])

        run.peak_vram_mb = _peak_mb(device) or run.peak_vram_mb
        run.status = "done"
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="done")

    except KeyboardInterrupt:
        run.status = "stopped"
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="stopped")
    except Exception as exc:  # noqa: BLE001
        run.status = "error"
        run.error = str(exc)[:2000]
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="error")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
