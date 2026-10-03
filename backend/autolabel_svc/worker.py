"""Процесс-воркер: держит загруженную модель и отвечает на запросы очереди.

Протокол сознательно модель-агностичный. SAM2 — первый тип раннера, но не
единственный: обычная модель-детектор появится здесь как ещё один раннер, а не
как ветка внутри SAM2, чтобы цепочку «детектор дал грубо → SAM2 уточнил» можно
было собрать из двух раннеров, ничего не переписывая.

Раннер обязан уметь:
    warm(image_path, image_id)                      — подготовить кадр
    predict(image_path, image_id, prompts, want, refine, space)

и возвращать фигуры в едином виде: {"type", "box": [x, y, w, h], "polygon"?,
"score"}. Бокс отдаёт любой раннер — даже тот, что внутри работает масками.
"""
import traceback

# Ответ на этот id — не запрос, а «модель поднялась» (или нет).
READY = "__ready__"


def _gpu_report() -> dict:
    """Какая карта и сколько памяти взял процесс после загрузки модели."""
    try:
        import torch

        if not torch.cuda.is_available():
            return {}
        props = torch.cuda.get_device_properties(0)
        return {
            "uuid": str(getattr(props, "uuid", "") or "") or None,
            "reserved_mb": int(torch.cuda.memory_reserved(0) // (1024 * 1024)),
        }
    except Exception:  # noqa: BLE001
        return {}


def build_runner(model: str, params: dict):
    # Импорт внутри функции: тяжёлые зависимости не должны грузиться в веб-процессе.
    if model == "sam2":
        from autolabel_svc.runners.sam2_runner import Sam2Runner

        return Sam2Runner(params or {})
    raise ValueError(f"Неизвестная модель: {model}")


def worker_main(model, params, requests, results):
    """Тело процесса. Живёт, пока менеджер не пришлёт None."""
    try:
        runner = build_runner(model, params)
    except Exception as exc:  # noqa: BLE001
        # Не смогли поднять модель — сообщаем менеджеру сразу и на каждый
        # запрос, иначе клиент ждал бы ответа от мёртвого процесса до таймаута.
        error = f"{exc}"
        results.put((READY, {"ok": False, "error": error, "trace": traceback.format_exc()}))
        while True:
            msg = requests.get()
            if msg is None:
                return
            results.put((msg[0], {"ok": False, "error": error}))

    results.put((READY, {"ok": True, **_gpu_report()}))
    while True:
        msg = requests.get()
        if msg is None:
            return
        req_id, op, payload = msg
        try:
            if op == "warm":
                data = runner.warm(payload["image_path"], payload["image_id"])
            elif op == "predict":
                data = runner.predict(
                    payload["image_path"],
                    payload["image_id"],
                    payload.get("prompts") or {},
                    payload.get("want") or ["box"],
                    payload.get("refine") or {},
                    payload.get("space"),
                )
            elif op == "info":
                data = runner.info()
            else:
                raise ValueError(f"Неизвестная операция: {op}")
            results.put((req_id, {"ok": True, "data": data}))
        except Exception as exc:  # noqa: BLE001
            results.put(
                (req_id, {"ok": False, "error": str(exc), "trace": traceback.format_exc()})
            )
