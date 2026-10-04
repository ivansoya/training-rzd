// Кадры одной группы галереи: первая порция, «показать ещё», «показать все».
//
// Смена фильтра (`resetKey`) начинает выборку заново; ответ на прежний фильтр
// отбрасывается по номерку, как в useGallery.

import { useCallback, useEffect, useRef, useState } from "react";

export const FIRST = 60;
export const MORE = 200;

export function useGroupFrames<T>(
  load: (offset: number, limit: number) => Promise<{ items: T[]; matched: number }>,
  resetKey: string,
) {
  const [items, setItems] = useState<T[]>([]);
  const [matched, setMatched] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const have = useRef(0);
  have.current = items.length;

  const fetchChunk = useCallback(async (mine: number, offset: number, limit: number) => {
    const got = await loader.current(offset, limit);
    if (mine !== ticket.current) return null;
    setMatched(got.matched);
    setItems((prev) => (offset === 0 ? got.items : [...prev, ...got.items]));
    return got;
  }, []);

  const run = useCallback(async (job: (mine: number) => Promise<void>) => {
    const mine = ticket.current;
    setLoading(true);
    try {
      await job(mine);
      if (mine === ticket.current) setError(null);
    } catch (e) {
      if (mine === ticket.current) setError((e as Error).message);
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const mine = ++ticket.current;
    setItems([]);
    setMatched(null);
    void run(async () => { await fetchChunk(mine, 0, FIRST); });
  }, [resetKey, run, fetchChunk]);

  const more = useCallback((n = MORE) => {
    if (loading || (matched !== null && have.current >= matched)) return;
    void run(async (mine) => { await fetchChunk(mine, have.current, n); });
  }, [loading, matched, run, fetchChunk]);

  // Всё порциями по 200 — сервер больше за раз не отдаёт
  const all = useCallback(() => {
    if (loading) return;
    void run(async (mine) => {
      let offset = have.current;
      for (;;) {
        const got = await fetchChunk(mine, offset, MORE);
        if (!got || !got.items.length) return;
        offset += got.items.length;
        if (offset >= got.matched) return;
      }
    });
  }, [loading, run, fetchChunk]);

  return { items, setItems, matched, loading, error, more, all };
}
