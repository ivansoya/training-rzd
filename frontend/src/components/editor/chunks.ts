// Разметка ролика кусками: у агента десятки тысяч одиночных рамок на ролик, одним ответом это секунды.
// Куски режутся по сводке каркаса (кадр → рамок) на границе кадра и покрывают весь ролик.

/** Кусок кадров [from, to). */
export interface Chunk { from: number; to: number }

/** Куски по ~`limit` рамок: граница всегда между кадрами, кадр целиком в одном куске.
 *  Покрывают [0, last] без дыр — новая рамка на любом кадре попадает в известный кусок. */
export function chunkPlan(marks: [number, number, number, ...unknown[]][], last: number, limit = 1500): Chunk[] {
  const sorted = [...marks].sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return [];
  const end = Math.max(last + 1, sorted[sorted.length - 1][0] + 1);
  const out: Chunk[] = [];
  let from = 0;
  let rows = 0;
  sorted.forEach(([, n], i) => {
    rows += n;
    const next = sorted[i + 1];
    if (rows >= limit && next) {
      out.push({ from, to: next[0] });
      from = next[0];
      rows = 0;
    }
  });
  out.push({ from, to: end });
  return out;
}

export const chunkAt = (chunks: Chunk[], frame: number) => chunks.findIndex((c) => frame >= c.from && frame < c.to);

/** Какой кусок грузить следующим: тот, где стоит указатель, дальше к концу, потом с начала.
 *  Перемотали в незагруженное — этот кусок и пойдёт следующим. */
export function nextChunk(chunks: Chunk[], loaded: Set<number>, frame: number): number | null {
  const at = Math.max(0, chunkAt(chunks, frame));
  for (let k = 0; k < chunks.length; k++) {
    const i = (at + k) % chunks.length;
    if (!loaded.has(i)) return i;
  }
  return null;
}
