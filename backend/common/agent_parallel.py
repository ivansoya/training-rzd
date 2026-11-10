"""Копии агента: память, очередь целых роликов и пачек кадров, общий ход.

Очередь и текущая работа — в params прогонов. Выдача под замком родителя:
одна работа принадлежит одной копии и остаётся за ней после сбоя.
"""
import os
import uuid

from sqlalchemy import or_, select

from common import agent_graph, agent_memory, gpu, live, settings, task_frames, video_tracks
from common.models import AgentRun, AgentWeights, Image, TaskVideo, utcnow

ACTIVE = ("queued", "waiting_gpu", "running")
BATCH = 60
MAX_COPIES = max(1, int(os.environ.get("AGENT_MAX", "8")))


def memory(db, doc, cards, scout=False, size=None):
    weights = {n["id"]: db.get(AgentWeights, uuid.UUID(n["params"]["weights"]))
               for n in doc["nodes"] if n.get("type") == "net" and (n.get("params") or {}).get("weights")}
    half = settings.get(db, settings.SAM3_CPU_HALF)
    nets = agent_memory.net_info(weights)
    mem = agent_memory.plan(doc, max((c["cap_mb"] for c in cards), default=0) or None,
                            scout, nets=nets, sam3_cpu_half=half)
    views = agent_memory.frame_views(doc, *size, nets) if size else None
    sig = agent_memory.signature(doc, mem["words"], scout=scout, sam3_cpu_half=half, views=views)
    total, _ = gpu.estimate(db, "agent", sig, mem["total_mb"])
    verdict = agent_memory.verdict(total, mem["heaviest"], cards, mem["units"], gpu.CONTEXT_MB)
    sequential = verdict["state"] == agent_memory.SEQUENTIAL
    if sequential:
        sig = agent_memory.signature(doc, mem["words"], sequential=True, scout=scout,
                                     sam3_cpu_half=half, views=views)
        parts = [gpu.estimate(db, "agent", sig, mem["heaviest"]["mb"])[0] + gpu.CONTEXT_MB]
    else:
        parts = verdict.get("parts") or [total + gpu.CONTEXT_MB]
    return {"mem": mem, "sig": sig, "total": total, "verdict": verdict, "parts": parts,
            "sequential": sequential, "split": verdict["state"] == agent_memory.SPLIT}


def capacity(parts, cards, work_count, limit=MAX_COPIES):
    """Тем же размещением, что у диспетчера, включая контекст каждой копии."""
    slots = agent_memory._slots(cards, True)
    count = 0
    for _ in range(min(work_count, limit)):
        chosen, _why = gpu.place(parts, slots, spread=False, heavy_request=False, busy_kind=True)
        if chosen is None:
            break
        for mb, dev in zip(parts, chosen):
            slots[dev]["held"] += mb
            slots[dev]["busy"] += 1
        count += 1
    return count


def image_rows(db, run):
    q = select(Image.id, Image.file_name).where(Image.task_id == run.task_id, Image.task_status == "new")
    clauses = [task_frames.source_clause(run.task_id, s) for s in run.params.get("sources") or []]
    if not clauses:
        return []
    if all(c is not None for c in clauses):
        q = q.where(or_(*clauses))
    return db.execute(q.order_by(Image.file_name, Image.id)).all()


def items(db, run):
    if run.params.get("mode", "frames") == "frames":
        rows = image_rows(db, run)
        return [{"images": [str(r.id) for r in rows[i:i + BATCH]], "count": len(rows[i:i + BATCH]),
                 "title": f"Пачка кадров {i + 1}–{min(i + BATCH, len(rows))}"}
                for i in range(0, len(rows), BATCH)]
    out = []
    for vid in dict.fromkeys(run.params.get("videos") or []):
        v = db.get(TaskVideo, uuid.UUID(vid))
        if not v or v.task_id != run.task_id:
            continue
        n = v.frame_count or (round(v.duration_ms / 1000 * v.fps) if v.duration_ms and v.fps else 0)
        if not n:
            raise ValueError(f"У ролика «{v.file_name}» пока неизвестна длина. Дождитесь обработки.")
        wanted = agent_graph.sampled(n - 1, run.params["step"])
        if run.params["mode"] == "annotate":
            tracks, singles = task_frames.video_payload(db, v)
            busy = video_tracks.human_frames(tracks, singles, v.empty_frames, wanted)
            wanted = [f for f in wanted if f not in busy]
        if wanted:
            out.append({"videos": [str(v.id)], "wanted": wanted, "count": len(wanted), "title": v.file_name})
    return out


def children(db, parent_id):
    return db.execute(select(AgentRun).where(AgentRun.parent_id == parent_id)
                      .order_by(AgentRun.created_at, AgentRun.id).execution_options(populate_existing=True)).scalars().all()


def create(db, parent, work, count):
    parent.is_group = True
    parent.total = sum(w["count"] for w in work)
    parent.params = {**parent.params, "pending": work, "copies": count}
    if parent.params["mode"] != "frames":
        parent.params["videos"] = [v for item in work for v in item["videos"]]
    db.add(parent)
    db.flush()
    for slot in range(count):
        db.add(AgentRun(parent_id=parent.id, project_id=parent.project_id, task_id=parent.task_id,
                        graph_id=parent.graph_id, version_id=parent.version_id, created_by=parent.created_by,
                        params={**{k: v for k, v in parent.params.items() if k not in ("pending", "copies")},
                                "slot": slot + 1}, total=0))


def take(db, run):
    parent = db.execute(select(AgentRun).where(AgentRun.id == run.parent_id)
                        .with_for_update().execution_options(populate_existing=True)).scalar_one()
    db.refresh(run)
    if parent.cancel_requested or run.cancel_requested:
        db.rollback()
        return None
    if run.params.get("assignment"):
        db.commit()
        return run.params["assignment"]
    pending = list(parent.params.get("pending") or [])
    if not pending:
        db.commit()
        return None
    item = pending.pop(0)
    parent.params = {**parent.params, "pending": pending}
    run.params = {**run.params, "assignment": item, "videos": item.get("videos", [])}
    run.stats = {**(run.stats or {}), "item_start": run.processed or 0,
                 "item_stats": {k: (run.stats or {}).get(k, 0) for k in ("boxes", "frames", "videos")}}
    run.total = (run.total or 0) + item["count"]
    db.commit()
    return item


def complete(db, run):
    item = run.params["assignment"]
    run.params = {k: v for k, v in run.params.items() if k != "assignment"}
    stats = {k: v for k, v in (run.stats or {}).items() if k not in ("cursor", "plan")}
    stats["completed_videos"] = [*stats.get("completed_videos", []), *item.get("videos", [])]
    run.stats = stats
    # Кадры, которые за время работы разметил человек, тоже покидают очередь.
    run.processed = run.total
    db.commit()
    sync(db, run.parent_id)


def sync(db, parent_id):
    if not parent_id:
        return
    parent = db.execute(select(AgentRun).where(AgentRun.id == parent_id)
                        .with_for_update().execution_options(populate_existing=True)).scalar_one_or_none()
    if parent is None:
        return
    runs = children(db, parent_id)
    parent.processed = sum(r.processed or 0 for r in runs)
    parent.stats = {"since": (parent.stats or {}).get("since") or [utcnow().isoformat(), 0],
                    **{k: sum((r.stats or {}).get(k, 0) for r in runs) for k in ("boxes", "frames", "videos")}}
    parent.stats["completed_videos"] = [v for r in runs for v in (r.stats or {}).get("completed_videos", [])]
    active = [r for r in runs if r.status in ACTIVE]
    if active:
        parent.status = "running" if any(r.status == "running" for r in active) else "waiting_gpu"
        parent.finished_at = None
    else:
        parent.status = ("done" if not parent.params.get("pending") and not any(r.params.get("assignment") for r in runs)
                         and parent.processed >= (parent.total or 0) else
                         "error" if any(r.status == "error" for r in runs) else
                         "stopped" if parent.cancel_requested or parent.params.get("pending")
                         or any(r.status == "stopped" for r in runs) else "done")
        parent.finished_at = utcnow()
    parent.error = "Есть ошибки в копиях агента. Незавершённую работу можно повторить." if parent.status == "error" else None
    parent.started_at = parent.started_at or next((r.started_at for r in runs if r.started_at), None)
    db.commit()
    live.notify(db, "agent", parent.id, parent.project_id, s=parent.status, n=parent.processed)


def stop(db, run):
    run.cancel_requested = True
    if run.status in ("queued", "waiting_gpu"):
        run.status, run.finished_at = "stopped", utcnow()
        db.commit()
        if run.gpu_lease_id:
            gpu.cancel(db, run.gpu_lease_id, "Снято автором")


def resume(run):
    run.stats = {k: v for k, v in (run.stats or {}).items() if k != "retries"}
    run.status, run.cancel_requested, run.error, run.finished_at, run.queue_reason = "queued", False, None, None, None
