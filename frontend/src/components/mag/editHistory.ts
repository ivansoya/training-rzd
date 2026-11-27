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

/** К какому снимку ведёт следующий шаг. */
export function peek<T>(h: History<T>, dir: "undo" | "redo"): T | undefined {
  return dir === "undo" ? h.past[h.past.length - 1] : h.future[0];
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

/** Истории по кадрам (решение 27.11.2026, вместо общей сквозь кадры от 20.10.2026):
 *  команда закреплена за кадром, на котором её сделали, и Ctrl+Z ходит только по
 *  истории показанного кадра. Пролистав сотню кадров, отменой не уехать назад. */
export type ByFrame<K, T> = ReadonlyMap<K, History<T>>;

/** Сколько кадров помнят свою историю; сверх — забываются тронутые давнее всех. */
export const FRAMES = 200;

export function at<K, T>(m: ByFrame<K, T>, key: K): History<T> {
  return m.get(key) ?? empty<T>();
}

/** Записать историю кадра. Пустую не храним: кадр без шагов ничего не стоит. */
export function put<K, T>(m: ByFrame<K, T>, key: K, h: History<T>, limit = FRAMES): ByFrame<K, T> {
  const next = new Map(m);
  next.delete(key);
  if (h.past.length || h.future.length) next.set(key, h);
  for (const k of next.keys()) {
    if (next.size <= limit) break;
    next.delete(k);
  }
  return next;
}

/** Временное выделение полуавтомата бросили, не закрепив (ушли с кадра, выключили A):
 *  возвращать его шаги не к чему. С вершины отмены и с начала повтора снимаются шаги,
 *  которые разметку не меняют (`same` с текущим), а с повтора — и снимки с выделением
 *  (`transient`). Иначе вернувшийся на кадр первым Ctrl+Z воскрешал бы давно брошенное
 *  выделение, а Ctrl+Shift+Z делал бы шаг, после которого ничего не меняется. */
export function dropTransient<T>(
  h: History<T>, current: T, same: (a: T, b: T) => boolean, transient: (s: T) => boolean
): History<T> {
  let p = h.past.length;
  while (p > 0 && same(h.past[p - 1], current)) p--;
  let f = 0;
  while (f < h.future.length && (transient(h.future[f]) || same(h.future[f], current))) f++;
  return p === h.past.length && f === 0 ? h : { past: h.past.slice(0, p), future: h.future.slice(f) };
}
