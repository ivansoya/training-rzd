// Таски проекта по частям: лёгкий список сразу, счётчики — по одной таске по очереди; прошлое — из кеша.

import { useCallback, useEffect, useRef, useState } from "react";
import { getTaskStats, listTasks } from "../../../auth/api";
import type { TaskLight, TaskStats } from "../../../auth/api";
import { cached, remember } from "../../../api/cache";
import { requestOrder } from "./tasks";

/** Счётчики таски в этом заходе: ждут очереди, в пути, пришли. */
export type Fresh = "wait" | "load" | "ok";

interface Snapshot { list: TaskLight[]; canCreate: boolean; isAdmin: boolean; stats: Record<string, TaskStats> }

const waiting = (snap: Snapshot | null) => Object.fromEntries((snap?.list ?? []).map((t) => [t.id, "wait" as Fresh]));

/** `pick` — какие таски считать (обзор проекта — только показанные); без него — все. */
export function useTaskBoard(code: string, me: string, pick?: (list: TaskLight[]) => TaskLight[]) {
  const key = `${me}:board:${code}`;
  const [snap, setSnap] = useState<Snapshot | null>(() => cached<Snapshot>(key)?.v ?? null);
  // Когда сняты показанные числа из кеша; null — числа этого захода
  const [at, setAt] = useState<number | null>(() => cached<Snapshot>(key)?.at ?? null);
  const [fresh, setFresh] = useState<Record<string, Fresh>>(() => waiting(snap));
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const round = useRef(0);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const put = useCallback((next: Snapshot) => {
    snapRef.current = next;
    setSnap(next);
    remember(key, next);
  }, [key]);

  /** `only` — спросить счётчики только этих таск (после перетаскивания), список — всегда. */
  const refresh = useCallback(async (only?: string[]) => {
    const r = ++round.current;
    setListing(true);
    let list: TaskLight[];
    try {
      const d = await listTasks(code);
      if (r !== round.current) return;
      list = d.tasks;
      const keep = new Set(list.map((t) => t.id));
      // Счётчики ушедших таск в кеше не нужны
      const stats = Object.fromEntries(Object.entries(snapRef.current?.stats ?? {}).filter(([id]) => keep.has(id)));
      put({ list, canCreate: d.can_create, isAdmin: d.is_admin, stats });
      setError(null);
    } catch (e) {
      if (r === round.current) setError((e as Error).message);
      return;
    } finally {
      if (r === round.current) setListing(false);
    }
    const wanted = new Set((pickRef.current ? pickRef.current(list) : list).map((t) => t.id));
    const ids = (only ?? requestOrder(list, me)).filter((id) => wanted.has(id));
    setFresh((f) => ({ ...f, ...Object.fromEntries(ids.map((id) => [id, "wait" as Fresh])) }));
    for (const id of ids) {
      if (r !== round.current) return;
      setFresh((f) => ({ ...f, [id]: "load" }));
      let s: TaskStats | null = null;
      try {
        s = await getTaskStats(id);
      } catch {
        // Таска могла уйти между списком и счётчиками — карточка останется без чисел
      }
      if (r !== round.current) return;
      const prev = snapRef.current;
      if (prev && s) put({ ...prev, stats: { ...prev.stats, [id]: s } });
      setFresh((f) => ({ ...f, [id]: "ok" }));
    }
    if (!only) setAt(null);
  }, [code, me, put]);

  // Другой проект — его кеш и новый заход; ушли со страницы — заход бросаем
  useEffect(() => {
    const c = cached<Snapshot>(key);
    snapRef.current = c?.v ?? null;
    setSnap(c?.v ?? null);
    setAt(c?.at ?? null);
    setFresh(waiting(c?.v ?? null));
    void refresh();
    return () => { round.current += 1; };
  }, [key, refresh]);

  /** Карточка переезжает сразу; ответ сервера её поправит. */
  const patch = useCallback((id: string, fields: Partial<TaskLight>) => {
    const prev = snapRef.current;
    if (prev) put({ ...prev, list: prev.list.map((t) => (t.id === id ? { ...t, ...fields } : t)) });
  }, [put]);

  return {
    list: snap?.list ?? null,
    canCreate: snap?.canCreate ?? false,
    isAdmin: snap?.isAdmin ?? false,
    stats: snap?.stats ?? {},
    fresh,
    /** Время кеша, пока на экране его числа; null — всё свежее. */
    at,
    listing,
    error,
    refresh,
    patch,
  };
}

/** Как рисовать числа: заготовка (их ещё нет), бледное (из кеша, пока свежие не пришли),
 *  переливание — только у того, чей запрос в пути. `value` — что уже есть; null — тоже ответ. */
export function look(value: unknown, fresh: Fresh | undefined, at: number | null) {
  const has = value !== undefined;
  return { has, loading: fresh === "load", stale: has && at !== null && fresh !== "ok" };
}
export type Look = ReturnType<typeof look>;
