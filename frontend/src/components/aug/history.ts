// История правок графа для Ctrl+Z / Ctrl+Shift+Z.
//
// Снимки документа целиком (строкой JSON), а не список обратимых действий:
// правок у холста десяток видов (узел, провод, параметр, перецепка, сетка),
// и у каждого была бы своя «обратная операция», которую легко забыть. Граф —
// десятки узлов, снимок стоит килобайты, сотня снимков — ничто.
//
// Чистые функции без React: так историю можно закрыть тестом, а редактор
// только решает, когда записать снимок и что сделать с вынутым.

export const LIMIT = 100;

export interface History {
  past: string[];
  present: string;
  future: string[];
}

export const start = (doc: string): History => ({ past: [], present: doc, future: [] });

/** Записать новое состояние. То же самое — не запись: иначе щелчок без
 *  правки тоже пришлось бы отменять. Новая правка стирает «вперёд». */
export function record(h: History, doc: string, limit = LIMIT): History {
  if (doc === h.present) return h;
  return { past: [...h.past, h.present].slice(-limit), present: doc, future: [] };
}

/** Шаг назад от `current` — того, что сейчас на холсте. Если на холсте есть
 *  ещё не записанная правка, она сперва записывается: иначе Ctrl+Z сразу
 *  после правки перепрыгнул бы через неё, и вернуть её было бы нельзя. */
export function undo(h: History, current: string): [History, string | null] {
  const now = record(h, current);
  if (!now.past.length) return [now, null];
  const doc = now.past[now.past.length - 1];
  return [{ past: now.past.slice(0, -1), present: doc, future: [now.present, ...now.future] }, doc];
}

export function redo(h: History, current: string): [History, string | null] {
  // Правка поверх отменённого стирает «вперёд» — повторять уже нечего.
  if (current !== h.present) return [record(h, current), null];
  if (!h.future.length) return [h, null];
  const [doc, ...rest] = h.future;
  return [{ past: [...h.past, h.present].slice(-LIMIT), present: doc, future: rest }, doc];
}

/** Нажатие — отмена, повтор или ни то ни другое. По `code`, а не `key`: в
 *  русской раскладке `key` у этой клавиши «я», и Ctrl+Z молчал бы. */
export function keyAction(e: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.code === "KeyZ") return e.shiftKey ? "redo" : "undo";
  if (e.code === "KeyY" && !e.shiftKey) return "redo";
  return null;
}
