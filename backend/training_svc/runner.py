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
from common.models import (  # noqa: E402
    TrainRun, TrainSet, TrainSetFeed, utcnow,
)
from training_svc import metrics as metrics_lib, trainer  # noqa: E402

HOT_EVERY = 0.8


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
    run.started_at = run.started_at or utcnow()
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

        # В ultralytics — только белый список ключей: download в yaml исполняется как код.
        data_yaml = trainer.safe_data_yaml(data_yaml, out_dir)
        trainer._disable_builtin_albumentations()
        trainer.pin_memory_policy()
        device = run.device
        is_cpu = str(device) == "cpu"
        # Несколько карт: «2,5» — настоящие номера карт брони, ultralytics поднимет
        # по процессу на карту (см. training_svc/progress.py).
        ddp = "," in str(device)
        if not is_cpu:
            import torch

            # CUDA — до ultralytics: воркер оставил видимыми только карты брони, а
            # select_device перепишет CUDA_VISIBLE_DEVICES на «0». После первой
            # инициализации переменную уже никто не читает.
            torch.cuda.set_device(0)

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

        # Продолжение: last.pt уже есть — ultralytics берёт из него эпоху, оптимизатор и данные
        last_pt = trainer.last_checkpoint(run)
        resume = os.path.isfile(last_pt)
        if resume:
            spec = run.base_weights_path or run.base_model
            model = YOLO(last_pt)
        else:
            spec = trainer.resolve_weights(
                run.base_weights_path or run.base_model, on_progress=fetching
            )
            model = YOLO(spec)

        # Ход вешает класс тренера (training_svc/progress.py): так он доезжает и
        # до дочерних процессов обучения на нескольких картах.
        from training_svc import progress as progress_lib

        progress = progress_lib.CURRENT = progress_lib.Progress(db, run)

        # Загрузчиков по умолчанию: на видеокарте меньше — при закреплённой
        # памяти их избыток вызывает нехватку памяти в потоке закрепления.
        cores = os.cpu_count() or 2
        params = trainer.filter_params(run.params or {})
        has_graph = db.query(TrainSetFeed.id).filter(
            TrainSetFeed.set_id == tset.id,
            TrainSetFeed.graph_version_id.isnot(None),
        ).first() is not None
        overrides, aug_mode = trainer.aug_overrides(params, has_graph)
        overrides["workers"] = min(8, cores) if is_cpu else min(4, cores)
        overrides.update(trainer.train_overrides(params))
        overrides.update(
            data=data_yaml, project=out_dir, name="train", exist_ok=True,
            device=device, plots=False, verbose=False, augment=False,
            amp=not is_cpu, cache=False,
        )
        if resume:
            overrides["resume"] = True
        results = model.train(trainer=progress_lib.trainer_for(run.task), **overrides)
        # На нескольких картах ход писали дочерние процессы — свои числа бегун дочитывает.
        db.refresh(run)

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
        # Номер последней пройденной эпохи пишет ход: у тренера бегуна на нескольких
        # картах эпох не было — учились дочерние процессы.
        done = int(run.current_epoch or 0)
        if done > 0:
            run.summary = dict(run.summary or {}, epochs_done=done, stopped_early=int(done < run.epochs))
        run.params = dict(run.params or {}, augment_mode=aug_mode,
                          weights=os.path.basename(str(spec)))

        # Итоговая проверка: метрики по классам, матрица ошибок и кривые.
        # `model.validator` после обучения пуст — раньше отсюда и брали, и
        # поэтому матрица всегда была пустой.
        run.phase = "final"
        run.val_batch = 0
        db.commit()
        # Ход итоговой проверки уже висит на модели: тренер вешал его в её же словарь обработчиков.
        progress.final = True
        if ddp:
            # Проверка идёт одним процессом на первой карте брони — с батчем одной карты.
            device = "cuda:0"
            overrides["batch"] = max(1, int(overrides.get("batch", 16)) // len(run.device.split(",")))
        got = _final_metrics(model, data_yaml, device, overrides, out_dir)
        if got.get("error"):
            run.per_class = {"rows": [], "totals": None, "error": got["error"]}
        else:
            run.per_class = got.get("per_class")
            run.confusion = got.get("confusion")
            run.curves = got.get("curves")
            if got.get("summary"):
                # Итоги проверки поверх, но не вместо: сколько эпох прошло и
                # была ли ранняя остановка — знает только обучение.
                run.summary = dict(run.summary or {}, **got["summary"])

        # Максимум: на нескольких картах пик обучения записал ход, а здесь — только проверка.
        run.peak_vram_mb = max(run.peak_vram_mb or 0, progress_lib.peak_mb(device) or 0) or None
        run.status = "done"
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="done")

    except KeyboardInterrupt:
        run.status = "stopped"
        trainer.adopt_weights(run)
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s="stopped")
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        db.refresh(run)
        # На нескольких картах «Остановить» роняет дочерние процессы, и сюда
        # приходит их падение, а не KeyboardInterrupt.
        stopped = bool(run.cancel_requested)
        run.status = "stopped" if stopped else "error"
        # Причину процесса карты (progress._note_failure) не затираем кодом выхода.
        run.error = None if stopped else (run.error or str(exc))[:2000]
        trainer.adopt_weights(run)
        run.finished_at = utcnow()
        db.commit()
        live.notify(db, "run", run.id, run.project_id, s=run.status)
        if not stopped:
            raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
