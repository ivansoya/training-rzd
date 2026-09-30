/** Где на плитке подпись рамки, если картинка кадрирована `object-fit: cover`.
 *
 * Слой рамок (`ShapeMini`, `xMidYMid slice`) кадрируется как картинка, а
 * подписи стояли по несрезанным долям кадра: `left = x / w`. На плитке 4:3 у
 * кадра 16:9 это расхождение в четверть ширины — подпись съезжала с рамки на
 * два десятка пикселей, а у рамок, ушедших за край кадрирования, висела на
 * краю плитки без рамки под ней. Считаем то же кадрирование, что и браузер.
 *
 * Чистая арифметика, без DOM: проверяется в `tileCrop.test.ts`.
 */

/** Форма плитки — `.mag-tile { aspect-ratio: 4 / 3 }` в dataset.css. */
export const TILE_RATIO = 4 / 3;

/** Доли плитки (0…100) для левого верхнего угла рамки, или null, если рамка
 *  целиком за краем кадрирования. Угол, срезанный краем, прижимаем к краю —
 *  подпись остаётся у видимой части рамки. */
export function labelAt(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  tile = TILE_RATIO
): { left: number; top: number } | null {
  // Видимое окно кадра: по длинной стороне срезаются поровну оба края.
  let vx = 0;
  let vy = 0;
  let vw = width;
  let vh = height;
  if (width / height > tile) {
    vw = height * tile;
    vx = (width - vw) / 2;
  } else {
    vh = width / tile;
    vy = (height - vh) / 2;
  }
  if (box.x >= vx + vw || box.x + box.w <= vx || box.y >= vy + vh || box.y + box.h <= vy) {
    return null;
  }
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  return {
    left: clamp(((box.x - vx) / vw) * 100),
    top: clamp(((box.y - vy) / vh) * 100),
  };
}
