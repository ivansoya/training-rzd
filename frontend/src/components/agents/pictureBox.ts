// Окно рамок своей картинки: геометрия в пикселях файла. Экран переводит мышь в пиксели сам.
// Мельче 8 px рамка серверу не нужна (agent_examples.MIN_SIDE) — её не создаём.

export type Box = [number, number, number, number];
export type Point = [number, number];
export type Corner = "nw" | "ne" | "sw" | "se";

export const MIN_SIDE = 8;

export const usable = (b: Box) => Math.min(b[2], b[3]) >= MIN_SIDE;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Рамка по двум точкам в любом порядке, обрезанная краем картинки `w×h`. */
export function spanBox(a: Point, b: Point, w: number, h: number): Box {
  const x0 = clamp(Math.min(a[0], b[0]), 0, w), x1 = clamp(Math.max(a[0], b[0]), 0, w);
  const y0 = clamp(Math.min(a[1], b[1]), 0, h), y1 = clamp(Math.max(a[1], b[1]), 0, h);
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Сдвинуть рамку, не выпуская за край. */
export function moveBox(box: Box, dx: number, dy: number, w: number, h: number): Box {
  return [clamp(box[0] + dx, 0, w - box[2]), clamp(box[1] + dy, 0, h - box[3]), box[2], box[3]];
}

/** Тянуть угол: противоположный стоит на месте, перетянутый за него угол меняет сторону. */
export function resizeBox(box: Box, corner: Corner, p: Point, w: number, h: number): Box {
  const [x, y, bw, bh] = box;
  const fixed: Point = [corner.includes("w") ? x + bw : x, corner.includes("n") ? y + bh : y];
  return spanBox(fixed, p, w, h);
}

/** Угол рамки под точкой: `tol` — в пикселях файла (экран пересчитывает свой допуск). */
export function cornerAt(box: Box, p: Point, tol: number): Corner | null {
  const [x, y, w, h] = box;
  const corners: [Corner, number, number][] = [["nw", x, y], ["ne", x + w, y], ["sw", x, y + h], ["se", x + w, y + h]];
  const hit = corners.find(([, cx, cy]) => Math.abs(p[0] - cx) <= tol && Math.abs(p[1] - cy) <= tol);
  return hit ? hit[0] : null;
}

/** Рамка под точкой: из вложенных — самая мелкая, её иначе не достать. −1 — мимо всех. */
export function boxAt(boxes: Box[], p: Point): number {
  let best = -1;
  boxes.forEach((b, k) => {
    const inside = p[0] >= b[0] && p[0] <= b[0] + b[2] && p[1] >= b[1] && p[1] <= b[1] + b[3];
    if (inside && (best < 0 || b[2] * b[3] < boxes[best][2] * boxes[best][3])) best = k;
  });
  return best;
}

/** Те же ли рамки — сохранять ли картинку при уходе с неё. */
export const sameBoxes = (a: Box[], b: Box[]) =>
  a.length === b.length && a.every((x, k) => x.every((v, i) => Math.abs(v - b[k][i]) < 0.05));

/** Округление до десятой пикселя — как хранит сервер. */
export const tidy = (b: Box): Box => b.map((v) => Math.round(v * 10) / 10) as Box;
