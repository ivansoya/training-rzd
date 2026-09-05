import { describe, expect, it } from "vitest";
import {
  MIN_POINTS,
  bounds,
  canClose,
  closesRing,
  insertVertex,
  moveParts,
  moveVertex,
  nearestEdge,
  removePart,
  removeVertex,
  type Point,
  type Ring,
} from "./polygon";

/** Квадрат со стороной side. */
function square(x: number, y: number, side: number): Ring {
  return [
    [x, y],
    [x + side, y],
    [x + side, y + side],
    [x, y + side],
  ];
}

/** Площадь кольца шнурками — только для проверок: правка формы менять не
 *  должна, и это единственный способ сказать это числом. */
function area(ring: Ring): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    total += x1 * y2 - x2 * y1;
  }
  return Math.abs(total) / 2;
}

describe("охватывающая рамка", () => {
  it("охватывает все части", () => {
    expect(bounds([square(0, 0, 10), square(50, 20, 10)])).toEqual({
      x: 0,
      y: 0,
      w: 60,
      h: 30,
    });
  });

  it("на пустом объекте рамки нет", () => {
    expect(bounds([])).toBeNull();
  });

  it("рамка одной части — она сама", () => {
    expect(bounds([square(10, 20, 30)])).toEqual({ x: 10, y: 20, w: 30, h: 30 });
  });
});

describe("вершины", () => {
  it("вставляет вершину между концами ребра, а не в конец", () => {
    const parts = [square(0, 0, 100)];
    const next = insertVertex(parts, 0, 0, [50, 0]);
    expect(next[0]).toHaveLength(5);
    expect(next[0][1]).toEqual([50, 0]);
    // Форма не вывернулась: площадь та же.
    expect(area(next[0])).toBeCloseTo(area(parts[0]));
  });

  it("вставляет на последнее ребро, замыкающее кольцо", () => {
    const next = insertVertex([square(0, 0, 100)], 0, 3, [0, 50]);
    expect(next[0]).toHaveLength(5);
    expect(next[0][4]).toEqual([0, 50]);
    expect(area(next[0])).toBeCloseTo(10000);
  });

  it("убирает вершину", () => {
    const parts = [[...square(0, 0, 100), [50, 120] as Point]];
    expect(removeVertex(parts, 0, 4)[0]).toHaveLength(4);
  });

  it("не опускает кольцо ниже трёх точек", () => {
    const parts: Ring[] = [[[0, 0], [10, 0], [5, 10]]];
    expect(removeVertex(parts, 0, 0)).toBe(parts);
    expect(MIN_POINTS).toBe(3);
  });

  it("трогает только своё кольцо", () => {
    const parts = [square(0, 0, 10), square(50, 0, 10)];
    const next = moveVertex(parts, 1, 0, [-5, -5]);
    expect(next[0]).toBe(parts[0]);
    expect(next[1][0]).toEqual([-5, -5]);
  });
});

describe("части", () => {
  it("двигает все части сразу", () => {
    const next = moveParts([square(0, 0, 10), square(50, 0, 10)], 5, 5);
    expect(next[0][0]).toEqual([5, 5]);
    expect(next[1][0]).toEqual([55, 5]);
  });

  it("сдвиг не меняет формы", () => {
    const next = moveParts([square(0, 0, 10)], 100, -30);
    expect(area(next[0])).toBeCloseTo(100);
  });

  it("убирает часть", () => {
    expect(removePart([square(0, 0, 10), square(50, 0, 10)], 0)).toHaveLength(1);
  });

  it("последнюю часть не убирает — это уже удаление объекта", () => {
    const parts = [square(0, 0, 10)];
    expect(removePart(parts, 0)).toBe(parts);
  });
});

describe("рисование", () => {
  it("замыкает от трёх точек", () => {
    expect(canClose([[0, 0], [10, 0]])).toBe(false);
    expect(canClose([[0, 0], [10, 0], [5, 10]])).toBe(true);
  });

  it("клик рядом с первой точкой — просьба замкнуть", () => {
    const draft: Ring = [[0, 0], [10, 0], [5, 10]];
    expect(closesRing(draft, [2, 2], 5)).toBe(true);
    expect(closesRing(draft, [9, 9], 5)).toBe(false);
  });

  it("порог — расстояние, а не координата", () => {
    const draft: Ring = [[100, 100], [200, 100], [150, 200]];
    expect(closesRing(draft, [103, 104], 5)).toBe(true);
    expect(closesRing(draft, [104, 104], 5)).toBe(false);
  });

  it("на пустом черновике замыкать нечего", () => {
    expect(closesRing([], [0, 0], 5)).toBe(false);
  });
});

describe("ближайшая грань", () => {
  const sq = square(0, 0, 100);

  it("находит грань, которую разделит новая точка", () => {
    const hit = nearestEdge([sq], [50, -8]);
    expect(hit).toEqual({ part: 0, edge: 0, at: [50, 0] });
  });

  it("сажает точку на грань, а не в курсор", () => {
    // Курсор в стороне от контура: точка обязана лечь на саму грань, иначе
    // контур вывернется, а рука при вставке всегда чуть промахивается.
    const hit = nearestEdge([sq], [120, 50]);
    expect(hit?.at).toEqual([100, 50]);
  });

  it("на конце грани прижимается к вершине, а не уезжает за неё", () => {
    expect(nearestEdge([sq], [-40, -40])?.at).toEqual([0, 0]);
  });

  it("находит замыкающую грань", () => {
    const hit = nearestEdge([sq], [-8, 50]);
    expect(hit?.edge).toBe(3);
    expect(hit?.at).toEqual([0, 50]);
  });

  it("выбирает между частями по расстоянию", () => {
    const parts = [square(0, 0, 10), square(500, 0, 10)];
    expect(nearestEdge(parts, [505, -5])?.part).toBe(1);
  });

  it("с ограничением ищет только в своей части", () => {
    // Части выделяются по отдельности: чужая грань не перехватывает вставку,
    // даже когда она ближе.
    const parts = [square(0, 0, 10), square(500, 0, 10)];
    const hit = nearestEdge(parts, [505, -5], 0);
    expect(hit?.part).toBe(0);
  });

  it("на пустом объекте грани нет", () => {
    expect(nearestEdge([], [0, 0])).toBeNull();
  });
});
