/** The ruler and every lane share one pixel-to-frame mapping. */
export function timelineFrame(x: number, left: number, width: number, last: number) {
  return Math.max(0, Math.min(last, Math.round((x - left) / Math.max(1, width) * last)));
}

export function extensionFrame(edge: number, delta: number, width: number, last: number, side: "start" | "end") {
  const next = Math.max(0, Math.min(last, Math.round(edge + delta / Math.max(1, width) * last)));
  return side === "start" ? Math.min(edge, next) : Math.max(edge, next);
}

export function timelineTicks(last: number, width: number) {
  if (last <= 0) return [0];
  const wanted = last / Math.max(1, Math.floor(width / 60));
  const power = 10 ** Math.floor(Math.log10(Math.max(1, wanted)));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= wanted) ?? power * 10;
  const ticks = Array.from({ length: Math.floor(last / step) + 1 }, (_, i) => i * step);
  if (ticks.at(-1) !== last) {
    if (ticks.length > 1 && (last - ticks[ticks.length - 1]) / last * width < 38) ticks.pop();
    ticks.push(last);
  }
  return ticks;
}
