// Страница таски по частям: лёгкая часть сразу, потом счётчики, потом сводка каждого ролика
// на разметку сверху вниз; прошлое — из кеша. Тяжёлый ролик не держит остальное.

import { useCallback, useEffect, useRef, useState } from "react";
import { getTask, getTaskEvents, getTaskNumbers, getVideoPending } from "../../../auth/api";
import type { PendingVideo, TaskDetail, TaskEventItem, TaskNumbers } from "../../../auth/api";
import { cached, remember } from "../../../api/cache";
import { useLive } from "../../../live/LiveProvider";
import type { Fresh } from "./useTaskBoard";

interface Snapshot {
  task: TaskDetail;
  numbers: TaskNumbers | null;
  /** Сводка открытого ролика на разметку; null — в таску от него ничего не уйдёт. */
  pending: Record<string, PendingVideo | null>;
}

export interface PageFresh { numbers: Fresh; videos: Record<string, Fresh> }

/** Ролики, чья разметка ещё не стала кадрами: у них есть сводка. */
export const openVideos = (t: TaskDetail) => t.videos.filter((v) => v.mode === "annotate" && !v.annotation_closed_at);

export function useTaskPage(taskId: string, me: string) {
  const key = `${me}:task:${taskId}`;
  const [snap, setSnap] = useState<Snapshot | null>(() => cached<Snapshot>(key)?.v ?? null);
  const [at, setAt] = useState<number | null>(() => cached<Snapshot>(key)?.at ?? null);
  const [events, setEvents] = useState<TaskEventItem[]>([]);
  const [fresh, setFresh] = useState<PageFresh>({ numbers: "wait", videos: {} });
  const [error, setError] = useState<string | null>(null);
  const round = useRef(0);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const put = useCallback((next: Snapshot) => {
    snapRef.current = next;
    setSnap(next);
    remember(key, next);
  }, [key]);

  /** Лёгкая часть и история. Опрос, пока ролик готовится, ходит только за ней. */
  const loadMain = useCallback(async (): Promise<TaskDetail> => {
    const [t, ev] = await Promise.all([getTask(taskId), getTaskEvents(taskId)]);
    const prev = snapRef.current;
    put({ task: t, numbers: prev?.numbers ?? null, pending: prev?.pending ?? {} });
    setEvents(ev);
    return t;
  }, [taskId, put]);

  /** Всё по очереди: лёгкая часть, счётчики, сводки роликов сверху вниз. */
  const load = useCallback(async () => {
    const r = ++round.current;
    let t: TaskDetail;
    try {
      t = await loadMain();
      if (r !== round.current) return;
      setError(null);
    } catch (e) {
      if (r === round.current) setError((e as Error).message);
      return;
    }
    const open = openVideos(t);
    setFresh({ numbers: "load", videos: Object.fromEntries(open.map((v) => [v.id, "wait" as Fresh])) });
    try {
      const n = await getTaskNumbers(taskId);
      if (r !== round.current) return;
      put({ ...snapRef.current!, numbers: n });
    } catch (e) {
      if (r === round.current) setError((e as Error).message);
    }
    if (r !== round.current) return;
    setFresh((f) => ({ ...f, numbers: "ok" }));
    // Сводки закрытых и убранных роликов больше не нужны
    const keep = new Set(open.map((v) => v.id));
    const cur = snapRef.current!;
    put({ ...cur, pending: Object.fromEntries(Object.entries(cur.pending).filter(([id]) => keep.has(id))) });
    for (const v of open) {
      if (r !== round.current) return;
      setFresh((f) => ({ ...f, videos: { ...f.videos, [v.id]: "load" } }));
      try {
        const p = await getVideoPending(taskId, v.id);
        if (r !== round.current) return;
        const now = snapRef.current!;
        put({ ...now, pending: { ...now.pending, [v.id]: p } });
      } catch {
        // Ролик могли убрать между запросами — сводка останется прежней
      }
      if (r !== round.current) return;
      setFresh((f) => ({ ...f, videos: { ...f.videos, [v.id]: "ok" } }));
    }
    setAt(null);
  }, [taskId, loadMain, put]);

  // Другая таска — её кеш и новый заход; ушли со страницы — заход бросаем
  useEffect(() => {
    const c = cached<Snapshot>(key);
    snapRef.current = c?.v ?? null;
    setSnap(c?.v ?? null);
    setAt(c?.at ?? null);
    setFresh({ numbers: "wait", videos: {} });
    void load();
    return () => { round.current += 1; };
  }, [key, load]);

  // Соседи правят таску: состояние и состав — сразу (от них права), правки кадров — пачкой раз в пару секунд
  const timer = useRef<number | undefined>(undefined);
  useLive("task", (e) => {
    if (e.id !== taskId || e.u === me) return;
    if (e.s) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      void load();
      return;
    }
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(() => { timer.current = undefined; void load(); }, 2000);
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** Правка лёгкой части на месте (таги ролика) — без перезапроса. */
  const patchTask = useCallback((fn: (t: TaskDetail) => TaskDetail) => {
    const prev = snapRef.current;
    if (prev) put({ ...prev, task: fn(prev.task) });
  }, [put]);

  /** Сводки всех открытых роликов — свежие, для решения «сдать» или «закрыть», а не из кеша. */
  const pendingNow = useCallback(async (): Promise<PendingVideo[]> => {
    const t = snapRef.current?.task;
    if (!t) return [];
    const out: PendingVideo[] = [];
    for (const v of openVideos(t)) {
      const p = await getVideoPending(taskId, v.id);
      if (p) out.push(p);
    }
    return out;
  }, [taskId]);

  return {
    task: snap?.task ?? null,
    numbers: snap?.numbers ?? null,
    pending: snap?.pending ?? {},
    events,
    fresh,
    /** Время кеша, пока на экране его числа; null — всё свежее. */
    at,
    error,
    setError,
    load,
    loadMain,
    patchTask,
    pendingNow,
  };
}
