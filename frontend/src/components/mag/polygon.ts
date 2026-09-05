/** Правка полигональной разметки в редакторе: вершины, части, замыкание.
 *
 * Объект-полигон — это несколько колец: вагон за стойкой виден двумя
 * половинами, и обводка обязана показывать то же, что охватывает рамка.
 * Хранится он одной аннотацией с `geometry = {parts: [[[x, y], …], …]}` в
 * пикселях изображения.
 *
 * С `datasets_svc/polygon.py` тут совпадает **одна** функция — `bounds`, — и
 * совпадать она обязана: редактор ставит подпись класса по той же рамке, по
 * которой сервер сводит полигон к боксу при выгрузке боксами. Расхождение
 * выглядело бы как «подпись съехала», а означало бы другой датасет. Всё
 * остальное здесь — жесты, которых на сервере нет; склейка перемычкой,
 * наоборот, живёт только на сервере: её место в выгрузке, а не в хранении.
 *
 * Попадания в фигуру здесь нет намеренно: разметка нарисована элементами SVG,
 * и попадание в них считает браузер. Своя проверка «точка внутри кольца» была
 * бы вторым ответом на тот же вопрос — и первым, который разойдётся с тем, что
 * человек видит. А вот `nearestEdge` браузер не заменяет: вопрос «какую грань
 * разделит новая точка» о фигуре, а не о попадании.
 *
 * Разбора и подрезки геометрии тут тоже нет: и то и другое делает сервер
 * (`shapes.to_wire` / `shapes.from_wire`), и делает один раз. Второй разбор на
 * клиенте означал бы два места, где решают, что такое правильное кольцо.
 *
 * Чистая арифметика без DOM: проверяется числами в `polygon.test.ts`, и набор
 * идёт в node — обращение к `window` тут падает.
 */

/** Меньше трёх точек — не фигура, а отрезок. То же число в polygon.py. */
export const MIN_POINTS = 3;

export type Point = [number, number];
export type Ring = Point[];

/** Охватывающая рамка всех частей — по ней ставится подпись класса и по ней
 *  же сервер сводит полигон к боксу при выгрузке боксами.
 *
 *  Считается по всем частям сразу: рамка вокруг одной половины разорванного
 *  объекта была бы неправдой. */
export function bounds(
  parts: Ring[]
): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of parts) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Квадрат расстояния от точки до отрезка и доля пути вдоль него.
 *  Квадрат — потому что корень здесь ничего не решает, а берётся он столько же
 *  раз, сколько отрезков. */
function segDist(a: Point, b: Point, p: Point): { d2: number; t: number } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t =
    len2 > 0
      ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2))
      : 0;
  const dx = a[0] + t * vx - p[0];
  const dy = a[1] + t * vy - p[1];
  return { d2: dx * dx + dy * dy, t };
}

/** Грань, ближайшая к точке, и место на ней.
 *
 * Отвечает на вопрос «куда встанет новая вершина»: не в курсор, а на грань,
 * которую она разделит. Иначе точка, поставленная в стороне от контура,
 * вывернула бы его — а рука при вставке всегда чуть промахивается.
 *
 * `only` ограничивает поиск одной частью: когда части выделяются по
 * отдельности, чужая грань не должна перехватывать вставку, даже если она
 * ближе.
 */
export function nearestEdge(
  parts: Ring[],
  p: Point,
  only?: number | null
): { part: number; edge: number; at: Point } | null {
  let best: { part: number; edge: number; at: Point; d2: number } | null = null;
  parts.forEach((ring, part) => {
    if (only != null && part !== only) return;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const { d2, t } = segDist(a, b, p);
      if (!best || d2 < best.d2) {
        best = {
          part,
          edge: i,
          at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
          d2,
        };
      }
    }
  });
  if (!best) return null;
  const hit = best as { part: number; edge: number; at: Point };
  return { part: hit.part, edge: hit.edge, at: hit.at };
}

// --------------------------------------------------------------------------- //
// Правка
// --------------------------------------------------------------------------- //

/** Новая вершина на ребре: она встаёт между его концами, а не в конец кольца.
 *  Порядок точек и есть форма — добавленная не туда точка вывернула бы контур. */
export function insertVertex(
  parts: Ring[],
  part: number,
  edge: number,
  at: Point
): Ring[] {
  return parts.map((ring, i) =>
    i === part ? [...ring.slice(0, edge + 1), at, ...ring.slice(edge + 1)] : ring
  );
}

/** Убрать вершину. Ниже трёх точек кольцо не опускается — вместо этого
 *  возвращается прежний массив, и вызывающий видит, что ничего не изменилось.
 *  Молча превратить контур в отрезок нельзя: он перестал бы быть фигурой,
 *  оставаясь в датасете. */
export function removeVertex(parts: Ring[], part: number, vertex: number): Ring[] {
  const ring = parts[part];
  if (!ring || ring.length <= MIN_POINTS) return parts;
  return parts.map((r, i) => (i === part ? r.filter((_, k) => k !== vertex) : r));
}

export function moveVertex(
  parts: Ring[],
  part: number,
  vertex: number,
  to: Point
): Ring[] {
  return parts.map((ring, i) =>
    i === part ? ring.map((p, k) => (k === vertex ? to : p)) : ring
  );
}

/** Сдвинуть весь объект — все части сразу. Часть, оставшаяся на месте,
 *  разорвала бы объект, который человек считает одним. */
export function moveParts(parts: Ring[], dx: number, dy: number): Ring[] {
  return parts.map((ring) => ring.map(([x, y]) => [x + dx, y + dy] as Point));
}

/** Убрать часть из объекта. Последняя часть не убирается: пустой объект — это
 *  удаление объекта, и решать это должен редактор, а не геометрия. */
export function removePart(parts: Ring[], part: number): Ring[] {
  if (parts.length <= 1) return parts;
  return parts.filter((_, i) => i !== part);
}

// --------------------------------------------------------------------------- //
// Рисование
// --------------------------------------------------------------------------- //

/** Можно ли замкнуть контур, который сейчас рисуют. */
export function canClose(draft: Ring): boolean {
  return draft.length >= MIN_POINTS;
}

/** Попал ли клик в первую точку рисуемого контура — то есть просят ли замкнуть.
 *
 * Порог задаётся в пикселях изображения: экранные в них переводит вызывающий,
 * потому что только он знает текущий масштаб. Проверяется отдельно от
 * `canClose`, потому что попасть в начало можно и на второй точке — тогда
 * замыкать нечего, но и сбрасывать рисование не за что.
 */
export function closesRing(draft: Ring, p: Point, tolerance: number): boolean {
  if (!draft.length) return false;
  const [x, y] = draft[0];
  const dx = x - p[0];
  const dy = y - p[1];
  return dx * dx + dy * dy <= tolerance * tolerance;
}
