// Проверка разметки агента и находки разведки — чистая логика обоих редакторов.
//
// «На проверке» — флаг на рамке. Снимают его «Подтвердить кадр» (со всех) и правка
// самой рамки: так же решает сервер (`common/attribution.settle`), и клиент
// повторяет это сразу, чтобы пунктир исчезал под рукой, а не после записи.

export type Reviewable = {
  id?: string;
  class_index: number;
  x: number; y: number; w: number; h: number;
  parts?: [number, number][][];
  pending?: boolean;
};

const same = (a: Reviewable, b: Reviewable) =>
  a.class_index === b.class_index && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h &&
  JSON.stringify(a.parts ?? null) === JSON.stringify(b.parts ?? null);

/** Правка снимает проверку с правленой рамки; копия непроверенной — уже своя рамка. */
export function settlePending<T extends Reviewable>(prev: readonly T[], next: T[]): T[] {
  const byId = new Map(prev.filter((s) => s.pending && s.id).map((s) => [s.id!, s]));
  const seen = new Set<string>();
  let changed = false;
  const out = next.map((s) => {
    if (!s.pending) return s;
    const was = s.id && !seen.has(s.id) ? byId.get(s.id) : undefined;
    if (s.id) seen.add(s.id);
    if (was && same(was, s)) return s;
    changed = true;
    return { ...s, pending: false };
  });
  return changed ? out : next;
}

/** «Подтвердить кадр»: всё оставшееся на кадре проверено. */
export function confirmAll<T extends Reviewable>(list: readonly T[]): T[] {
  return list.map((s) => (s.pending ? { ...s, pending: false } : s));
}

/** «Отклонить все»: непроверенное агента уходит с кадра. */
export function rejectAll<T extends Reviewable>(list: readonly T[]): T[] {
  return list.filter((s) => !s.pending);
}

export const pendingCount = (list: readonly { pending?: boolean }[]) =>
  list.reduce((n, s) => n + (s.pending ? 1 : 0), 0);

/** Следующая позиция «на проверке» от `from` в сторону `dir`, по кругу; сама `from` — последней.
 *  null — проверять нечего. */
export function nextFlagged(flags: readonly boolean[], from: number, dir: 1 | -1): number | null {
  const n = flags.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (flags[i]) return i;
  }
  return null;
}

/** Следующий кадр ролика из `frames` (по возрастанию) после `cur` в сторону `dir`, по кругу. */
export function nextFrame(frames: readonly number[], cur: number, dir: 1 | -1): number | null {
  if (!frames.length) return null;
  if (dir > 0) return frames.find((f) => f > cur) ?? (frames[0] !== cur ? frames[0] : null);
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i] < cur) return frames[i];
  const last = frames[frames.length - 1];
  return last !== cur ? last : null;
}

/** Ближайшая к курсору риска в пределах `radius` пикселей: её дорожка увеличивает и к ней ведёт щелчок. */
export function nearestTick(xs: readonly number[], x: number, radius = 12): number | null {
  let best: number | null = null;
  let dist = radius;
  xs.forEach((v, i) => {
    const d = Math.abs(v - x);
    if (d <= dist) { dist = d; best = i; }
  });
  return best;
}

type Box = { x: number; y: number; w: number; h: number };

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Находка, которую уже взяли в разметку, призраком не рисуется: рядом рамка того же класса (IoU ≥ 0,5)
 *  или рамка почти ровно на её месте (IoU ≥ 0,9) — «взять» кладёт её туда, класс при этом мог быть другим. */
export function isTaken(g: Box & { class_index: number | null }, boxes: readonly (Box & { class_index: number })[]): boolean {
  return boxes.some((b) => iou(g, b) >= 0.9 || (g.class_index != null && b.class_index === g.class_index && iou(g, b) >= 0.5));
}

/** Чьи находки показывать на кадре `cur`. На паузе — только проверенного разведкой кадра
 *  ровно этого номера. При проигрывании находка держится `hold` кадров до и после своего
 *  кадра: при шаге 25 один кадр из двадцати пяти мелькал бы незаметно. */
export function scoutFrameAt(checked: readonly number[], cur: number, playing: boolean, hold: number): number | null {
  if (!checked.length) return null;
  if (!playing) return checked.includes(cur) ? cur : null;
  let best: number | null = null;
  for (const f of checked) {
    if (Math.abs(f - cur) <= hold && (best === null || Math.abs(f - cur) < Math.abs(best - cur))) best = f;
  }
  return best;
}
