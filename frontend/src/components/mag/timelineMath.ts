/** The ruler and every lane share one pixel-to-frame mapping. */
export function timelineFrame(x: number, left: number, width: number, last: number) {
  return Math.max(0, Math.min(last, Math.round((x - left) / Math.max(1, width) * last)));
}

export function extensionFrame(edge: number, delta: number, width: number, last: number, side: "start" | "end") {
  const next = Math.max(0, Math.min(last, Math.round(edge + delta / Math.max(1, width) * last)));
  return side === "start" ? Math.min(edge, next) : Math.max(edge, next);
}

/** Ширина цифры подписи шкалы (моноширинный 11px) с запасом. */
export const TICK_DIGIT_PX = 7;

export function timelineTicks(last: number, width: number) {
  if (last <= 0) return [0];
  const wanted = last / Math.max(1, Math.floor(width / 60));
  const power = 10 ** Math.floor(Math.log10(Math.max(1, wanted)));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= wanted) ?? power * 10;
  const ticks = Array.from({ length: Math.floor(last / step) + 1 }, (_, i) => i * step);
  if (ticks.at(-1) !== last) {
    // Последняя подпись прижата к правому краю и тянется влево на всю свою
    // длину, предыдущая стоит по центру засечки. Места между ними нужно по
    // длине самих подписей: прежний порог в 38 px был меньше пятизначного
    // числа, и на длинном ролике они слипались в «2800029149».
    const prev = ticks[ticks.length - 1];
    const need = (String(prev).length / 2 + String(last).length) * TICK_DIGIT_PX + 6;
    if (ticks.length > 1 && (last - prev) / last * width < need) ticks.pop();
    ticks.push(last);
  }
  return ticks;
}

/** Куски полосы жизни, которые видно: из `[start, end]` вычтены зоны.
 *
 * Отрезок зоны полуоткрыт `[от, до)`, поэтому кадр `до` снова виден и полоса
 * с него начинается заново. Разрыв в полосе и есть главный знак того, что
 * объекта тут нет: штриховка поверх сплошной полосы читается хуже. */
export function visibleSpans(
  start: number,
  end: number,
  hidden: [number, number][]
): [number, number][] {
  const spans: [number, number][] = [];
  let cursor = start;
  for (const [from, to] of [...hidden].sort((a, b) => a[0] - b[0])) {
    if (to <= cursor || from > end) continue;
    if (from > cursor) spans.push([cursor, Math.min(from, end)]);
    cursor = Math.max(cursor, to);
  }
  if (cursor <= end) spans.push([cursor, end]);
  return spans;
}
