/** История правок одного кадра: снимки разметки целиком.
 *
 * Снимок, а не список действий: разметка кадра и сохраняется целиком
 * (PUT заменяет всё), и отменять её надо так же — без обратной операции на
 * каждый из дюжины видов правки (рамка, вершина, часть, класс, слияние).
 * Кадр редко несёт больше полусотни объектов, сотня снимков — копейки.
 */
export interface History<T> {
  past: T[];
  future: T[];
}

export const LIMIT = 100;

export function empty<T>(): History<T> {
  return { past: [], future: [] };
}

/** Перед правкой: запомнить, что было. Новая правка обрывает ветку повтора. */
export function record<T>(h: History<T>, before: T, limit = LIMIT): History<T> {
  return { past: [...h.past, before].slice(-limit), future: [] };
}

/** Отменить: вернуть последний снимок, текущее уходит в повтор. */
export function undo<T>(h: History<T>, current: T): { h: History<T>; value: T } | null {
  if (!h.past.length) return null;
  return {
    h: { past: h.past.slice(0, -1), future: [current, ...h.future] },
    value: h.past[h.past.length - 1],
  };
}

/** Повторить отменённое. */
export function redo<T>(h: History<T>, current: T): { h: History<T>; value: T } | null {
  if (!h.future.length) return null;
  return {
    h: { past: [...h.past, current], future: h.future.slice(1) },
    value: h.future[0],
  };
}

/** Жест, который ничего не поменял (клик без протяжки рамкой: рамку добавили
 *  и тут же убрали как промах), не должен оставлять пустой шаг отмены. */
export function dropNoop<T>(h: History<T>, current: T, same: (a: T, b: T) => boolean): History<T> {
  const last = h.past[h.past.length - 1];
  return last !== undefined && same(last, current) ? { ...h, past: h.past.slice(0, -1) } : h;
}
