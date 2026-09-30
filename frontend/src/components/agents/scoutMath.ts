// Счёт для окон разведки: время, окно шкалы, ближайший кадр, цвета классов.
// Без React — чтобы проверяться тестом и не тянуть циклы между окнами.

import { PALETTE } from "./agentDoc";

/** 0:59, 12:05, 1:02:05 — время ролика в секундах. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Проверенный кадр под указателем — ближайший из `checked` (по возрастанию). */
export function nearest(checked: number[], frame: number): number {
  let lo = 0;
  let hi = checked.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (checked[mid] < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && frame - checked[lo - 1] < checked[lo] - frame ? lo - 1 : lo;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Круглые отметки шкалы внутри окна [a, b] кадров — примерно шесть штук,
 *  в секундах. Края окна подписываются отдельно, поэтому отметки у самых
 *  краёв выброшены: подписи наезжали бы друг на друга. */
export function timeTicks(a: number, b: number, fps: number): number[] {
  const from = a / fps;
  const to = b / fps;
  const every = STEPS.find((s) => s >= (to - from) / 6) ?? 3600;
  const edge = (to - from) * 0.06;
  const out: number[] = [];
  for (let s = Math.ceil(from / every) * every; s <= to; s += every) {
    if (s - from > edge && to - s > edge) out.push(s);
  }
  return out;
}

/** Окно шкалы в кадрах: не уже `min`, не шире ролика, не за его краями. */
export function clampView(a: number, span: number, last: number, min: number): { a: number; b: number } {
  const width = Math.max(Math.min(min, last), Math.min(last, span));
  const start = Math.max(0, Math.min(last - width, a));
  return { a: start, b: start + width };
}

/** Цвет класса на всю таску: по алфавиту всех найденных классов. Иначе один и
 *  тот же класс в двух роликах красился бы по-разному — в общей статистике
 *  это читалось бы как два класса. */
export function scoutColors(names: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(names)].sort((x, y) => x.localeCompare(y, "ru"));
  return new Map(sorted.map((n, i) => [n, PALETTE[i % PALETTE.length]]));
}

/** Сколько кадров агент посмотрит в ролике из `frames` кадров при шаге
 *  `step` — как agent_graph.sampled: 0, step, … до последнего включительно,
 *  то есть ⌈frames / step⌉. Прежнее ⌊frames / step⌋ + 1 обещало на кадр
 *  больше, когда длина делится на шаг (1181 при 1180 на сервере). */
export const sampledCount = (frames: number, step: number) =>
  frames > 0 ? Math.ceil(frames / Math.max(1, Math.floor(step))) : 0;
