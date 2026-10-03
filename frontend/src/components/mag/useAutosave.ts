import { useCallback, useEffect, useRef, useState } from "react";

/** Состояние записи разметки кадра.
 *  failed — сбой сети или сервера: повторяем сами с растущей паузой;
 *  refused — сервер отказал (4xx): повтор не поможет, решает человек;
 *  stale — кадр изменили, пока он был открыт: запись поверх стёрла бы чужое. */
export type SaveState = "saved" | "saving" | "failed" | "refused" | "stale";

/** Пауза перед повтором записи после сбоя: 1, 2, 4, 8, дальше 15 с. */
export function retryDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 4));
}

/** Как понимать ошибку записи. */
export function classify(e: unknown): "failed" | "refused" | "stale" {
  const err = e as { status?: number; code?: string };
  if (err?.status === 409 && err.code === "stale") return "stale";
  const s = err?.status;
  if (s && s >= 400 && s < 500 && s !== 408 && s !== 429) return "refused";
  return "failed";
}

/** Свежая разметка кадра из ответа 409 «stale». */
export interface StaleFrame<B> {
  boxes: B[];
  rev: number;
  task_status?: string;
}

/** Автосохранение кадра, общее у редактора таски и просмотра датасета.
 *
 *  `persist(rev)` пишет текущий снимок и возвращает новую версию. Записи идут
 *  очередью: вторая ждёт первую, иначе старая разметка легла бы поверх новой.
 *  Версию держим здесь, а не в пропсах: следующая запись очереди может уйти
 *  раньше, чем кадр перерисуется с новой версией, — и получила бы ложный 409. */
export function useAutosave<B>(
  persist: (rev: number | undefined) => Promise<number | undefined>,
  delay = 600
) {
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stale, setStale] = useState<StaleFrame<B> | null>(null);
  const dirty = useRef(false);
  const rev = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<number | undefined>(undefined);
  const stateRef = useRef<SaveState>("saved");
  stateRef.current = state;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const flush = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    const run = async (): Promise<boolean> => {
      if (!dirty.current) return true;
      // Кадр изменили: пока человек не перечитал его, писать нельзя.
      if (stateRef.current === "stale") return false;
      dirty.current = false;
      setState("saving");
      try {
        const next = await persistRef.current(rev.current);
        if (next !== undefined) rev.current = next;
        if (!dirty.current) setState("saved");
        setError(null);
        setAttempt(0);
        return true;
      } catch (e) {
        dirty.current = true;
        setError((e as Error).message);
        const kind = classify(e);
        setState(kind);
        if (kind === "failed") setAttempt((n) => n + 1);
        if (kind === "stale") setStale(((e as { data?: unknown }).data ?? null) as StaleFrame<B> | null);
        return false;
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p;
    return p;
  }, []);

  /** Правка: записать после паузы. */
  const touch = useCallback(() => {
    dirty.current = true;
    if (stateRef.current === "stale") return;
    setState((s) => (s === "failed" ? s : "saving"));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), delay);
  }, [flush, delay]);

  /** Кадр сменился, перечитан или правка отброшена: всё чисто, версия — с сервера. */
  const settle = useCallback((serverRev: number | undefined) => {
    window.clearTimeout(timer.current);
    dirty.current = false;
    rev.current = serverRev;
    setState("saved");
    setError(null);
    setAttempt(0);
    setStale(null);
  }, []);

  // Повтор после сбоя — сам, без новой правки: сеть вернулась, и незаписанное
  // должно дойти, даже если человек больше ничего не трогает.
  useEffect(() => {
    if (state !== "failed") return;
    const h = window.setTimeout(() => void flush(), retryDelay(attempt));
    return () => window.clearTimeout(h);
  }, [state, attempt, flush]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { state, error, stale, dirty, rev, chain, flush, touch, settle };
}
