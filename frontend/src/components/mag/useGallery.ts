// Листание кадров: страницы и лента одним состоянием.
//
// Вынесено из страницы датасета, когда таких страниц стало три: сам датасет,
// все кадры проекта и собранный обучающий набор. Три копии пагинации разошлись
// бы на первой же правке — а расходиться им нельзя, человек ходит между ними и
// ждёт одинакового поведения.
//
// Здесь же лечится гонка, которой копия страдала: быстрая смена фильтра
// посылала два запроса, и вернуться они могли в обратном порядке — на экране
// оказывался ответ на прежний фильтр. Каждая выборка берёт номерок, и ответ с
// устаревшим номерком выбрасывается.

import { useCallback, useEffect, useRef, useState } from "react";

export const PAGE = 60;

export type Mode = "pages" | "feed";

export interface Chunk<T> {
  items: T[];
  matched: number;
}

export function useGallery<T>(
  load: (offset: number, limit: number) => Promise<Chunk<T>>,
  mode: Mode
) {
  const [items, setItems] = useState<T[]>([]);
  const [matched, setMatched] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);

  const fetchPage = useCallback(
    async (next: number, append: boolean) => {
      const mine = ++ticket.current;
      setLoading(true);
      try {
        const got = await load(next * PAGE, PAGE);
        if (mine !== ticket.current) return;
        setMatched(got.matched);
        setItems((prev) => (append ? [...prev, ...got.items] : got.items));
        setPage(next);
        setError(null);
      } catch (e) {
        if (mine === ticket.current) setError((e as Error).message);
      } finally {
        if (mine === ticket.current) setLoading(false);
      }
    },
    [load]
  );

  // Смена фильтра — и смена режима — начинают выборку с начала: в ленте
  // дописывать страницу к результатам прежнего фильтра нельзя.
  useEffect(() => {
    fetchPage(0, false);
  }, [fetchPage, mode]);

  const more = useCallback(() => {
    if (loading || items.length >= matched) return;
    fetchPage(page + 1, true);
  }, [loading, items.length, matched, page, fetchPage]);

  const goto = useCallback(
    (next: number) => {
      fetchPage(next, false);
    },
    [fetchPage]
  );

  return {
    items,
    setItems,
    matched,
    page,
    pages: Math.max(1, Math.ceil(matched / PAGE)),
    loading,
    error,
    more,
    goto,
  };
}
