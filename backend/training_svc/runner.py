"""Standalone training runner, launched as a subprocess per training.

Running training in its own process means the parent (Flask) can terminate it
immediately when the user stops/deletes a run — a plain thread running
ultralytics cannot be interrupted mid-epoch.

It reads the initial run state from ``--run-file`` and writes progress to both
the persistent run file and a live file (read by the API).
"""
import argparse
import json
import os
import time


def _save(path, state):
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-file", required=True)
    ap.add_argument("--live-file", required=True)
    ap.add_argument("--model-spec", required=True)
    ap.add_argument("--data-yaml", required=True)
    ap.add_argument("--project", required=True)
    args = ap.parse_args()

    with open(args.run_file, "r", encoding="utf-8") as fh:
        state = json.load(fh)

    def save():
        # Persist (data volume) + mirror to the live file the API streams from.
        _save(args.run_file, state)
        _save(args.live_file, state)

    def save_live():
        # Hot path: only the container-local live file. Called per batch, so it
        # must stay cheap — the persisted run file is updated at epoch borders.
        _save(args.live_file, state)

    state["status"] = "running"
    state["message"] = "Идёт обучение"
    state["phase"] = "train"
    state["current_batch"] = 0
    state["total_batches"] = None
    state["val_batch"] = 0
    state["val_total"] = None
    state["batch_metrics"] = {}
    save()

    try:
        from training_svc import trainer
        from ultralytics import YOLO

        trainer._disable_builtin_albumentations()
        device = state.get("device", "cpu")
        is_cpu = str(device) == "cpu"
        model = YOLO(args.model_spec)

        def _loss_items(trn):
            """Current per-component losses as {box_loss, cls_loss, dfl_loss}."""
            out = {}
            try:
                tloss = getattr(trn, "tloss", None)
                if tloss is not None:
                    for k, v in trn.label_loss_items(tloss).items():
                        out[k.split("/")[-1]] = float(v)
            except Exception:
                pass
            return out

        # Per-iteration progress, mirroring YOLO's own console bar. ultralytics'
        # documented extension point is the callback registry; we hook the
        # train-epoch/-batch events instead of subclassing the trainer.
        last_write = [0.0]

        def _epoch_start(trn):
            state["current_epoch"] = int(getattr(trn, "epoch", 0)) + 1
            try:
                state["total_batches"] = len(trn.train_loader)
            except Exception:
                state["total_batches"] = None
            state["phase"] = "train"
            state["current_batch"] = 0
            state["batch_metrics"] = {}
            state["epoch_started_at"] = time.time()
            save()

        def _batch_end(trn):
            state["current_batch"] = int(state.get("current_batch", 0)) + 1
            bm = _loss_items(trn)
            if bm:
                state["batch_metrics"] = bm
            now = time.time()
            elapsed = now - state.get("epoch_started_at", now)
            if elapsed > 0:
                state["batch_rate"] = state["current_batch"] / elapsed
            # Throttle disk writes — batches can exceed 10/s.
            if now - last_write[0] >= 0.3:
                last_write[0] = now
                save_live()

        # Validation runs after the training batches of each epoch. Surfacing its
        # per-iteration progress makes the post-epoch pause explainable instead of
        # the app seeming to hang. The validator shares the trainer's callbacks.
        def _val_start(validator):
            state["phase"] = "val"
            state["val_batch"] = 0
            try:
                state["val_total"] = len(validator.dataloader)
            except Exception:
                state["val_total"] = None
            state["message"] = "Валидация эпохи"
            save_live()

        def _val_batch_end(validator):
            state["val_batch"] = int(state.get("val_batch", 0)) + 1
            now = time.time()
            if now - last_write[0] >= 0.3:
                last_write[0] = now
                save_live()

        def _cb(trn):
            epoch = int(getattr(trn, "epoch", 0)) + 1
            raw = getattr(trn, "metrics", None) or {}
            metrics = {k: float(v) for k, v in raw.items()
                       if isinstance(v, (int, float))}
            metrics.update(_loss_items(trn))
            row = {"epoch": epoch, **metrics}
            state["current_epoch"] = epoch
            if state.get("total_batches"):
                state["current_batch"] = state["total_batches"]
            state["message"] = "Идёт обучение"
            if state["metrics"] and state["metrics"][-1]["epoch"] == epoch:
                state["metrics"][-1] = row
            else:
                state["metrics"].append(row)
            save()

        model.add_callback("on_train_epoch_start", _epoch_start)
        model.add_callback("on_train_batch_end", _batch_end)
        model.add_callback("on_val_start", _val_start)
        model.add_callback("on_val_batch_end", _val_batch_end)
        model.add_callback("on_fit_epoch_end", _cb)

        # Default DataLoader workers (used only if the user did not set one). On
        # GPU keep fewer: with pin_memory too many can trigger "CUDA out of
        # memory" in the pin-memory thread.
        cpu = os.cpu_count() or 2
        default_workers = min(8, cpu) if is_cpu else min(4, cpu)
        overrides = dict(trainer.DISABLED_AUG)
        overrides["workers"] = default_workers
        # User-provided params (incl. an explicit `workers`) override the default.
        overrides.update(trainer.filter_params(state.get("params", {})))
        overrides.update(
            data=args.data_yaml, project=args.project, name="train",
            exist_ok=True, device=device, plots=False,
            verbose=False, augment=False, amp=not is_cpu, cache=False,
        )
        results = model.train(**overrides)

        best = os.path.join(args.project, "train", "weights", "best.pt")
        if os.path.isfile(best):
            state["has_weights"] = True
            state["weights_path"] = best
        try:
            state["summary"] = {
                k: float(v) for k, v in
                (getattr(results, "results_dict", {}) or {}).items()
                if isinstance(v, (int, float))
            }
        except Exception:
            pass
        state["status"] = "done"
        state["message"] = "Готово"
        state["finished_at"] = time.time()
        save()
    except Exception as exc:  # noqa: BLE001
        state["status"] = "error"
        state["error"] = str(exc)
        state["finished_at"] = time.time()
        save()


if __name__ == "__main__":
    main()
