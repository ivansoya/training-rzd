import { describe, expect, it } from "vitest";
import type { CanvasShape } from "../mag/BoxCanvas";
import { detachContour, mergeContours, togglePolygonSelection } from "./shapes";

const compound: CanvasShape = {
  id: "original", class_index: 2, kind: "polygon", source: "model", pending: true, conf: 0.9,
  x: 0, y: 0, w: 60, h: 30,
  parts: [
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[50, 20], [60, 20], [60, 30], [50, 30]],
  ],
};

describe("контур в отдельный объект", () => {
  it.each([0, 1])("переносит часть %i, пересчитывает обе рамки, оставляет исходный id", (part) => {
    const neighbor: CanvasShape = { class_index: 0, x: 100, y: 100, w: 10, h: 10 };
    const before = [neighbor, compound];
    const next = detachContour(before, 1, part);
    expect(next).toHaveLength(3);
    expect(next[0]).toBe(neighbor);
    expect(next[1]).toMatchObject({ id: "original", parts: [compound.parts![1 - part]], pending: false });
    expect(next[2]).toEqual({
      class_index: 2, kind: "polygon", parts: [compound.parts![part]], source: "human",
      ...(part === 0 ? { x: 0, y: 0, w: 10, h: 10 } : { x: 50, y: 20, w: 10, h: 10 }),
    });
    expect(next[1]).toMatchObject(part === 1 ? { x: 0, y: 0, w: 10, h: 10 } : { x: 50, y: 20, w: 10, h: 10 });
    expect(before[1]).toBe(compound);
    expect(compound.parts).toHaveLength(2);
    expect(compound.pending).toBe(true);
  });

  it("не меняет единственный контур и не создаёт объект из неверного индекса", () => {
    const shapes = [compound, { ...compound, parts: [compound.parts![0]] }];
    expect(detachContour(shapes, 1, 0)).toBe(shapes);
    expect(detachContour(shapes, -1, 0)).toBe(shapes);
    expect(detachContour(shapes, 0, -1)).toBe(shapes);
    expect(detachContour(shapes, 0, 2)).toBe(shapes);
  });
});

it("Ctrl+клик добавляет и снимает полигоны одного класса", () => {
  const shapes = [compound, { ...compound, id: "b" }, { ...compound, class_index: 3 }];
  const added = togglePolygonSelection(shapes, 0, new Set(), 1)!;
  expect([...added.group]).toEqual([0, 1]);
  expect(togglePolygonSelection(shapes, added.selected, added.group, 2)).toBeNull();
  const removed = togglePolygonSelection(shapes, added.selected, added.group, 0)!;
  expect(removed.selected).toBe(1);
  expect(removed.group.size).toBe(0);
});

describe("объединение контуров", () => {
  it("сохраняет id выбранного объекта, все части и соседние объекты", () => {
    const other: CanvasShape = { ...compound, id: "other", pending: false,
      parts: [[[70, 10], [80, 10], [80, 20], [70, 20]]] };
    const neighbor: CanvasShape = { class_index: 0, x: 100, y: 100, w: 10, h: 10 };
    const result = mergeContours([other, neighbor, compound], new Set([0, 2]), 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(neighbor);
    expect(result[1]).toMatchObject({ id: "original", class_index: 2, pending: false, x: 0, y: 0, w: 80, h: 30 });
    expect(result[1].parts).toEqual([...other.parts!, ...compound.parts!]);
  });

  it("не объединяет разные классы, рамки или неверный выбор", () => {
    const shapes = [compound, { ...compound, class_index: 3 }, { class_index: 2, x: 0, y: 0, w: 5, h: 5 }];
    expect(mergeContours(shapes, new Set([0, 1]), 0)).toBe(shapes);
    expect(mergeContours(shapes, new Set([0, 2]), 0)).toBe(shapes);
    expect(mergeContours(shapes, new Set([0, 5]), 0)).toBe(shapes);
    expect(mergeContours(shapes, new Set([0]), 0)).toBe(shapes);
  });

  it("объединяет больше двух объектов за один шаг", () => {
    const shapes = [compound, { ...compound, id: "b" }, { ...compound, id: "c" }];
    const result = mergeContours(shapes, new Set([0, 1, 2]), 1);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
    expect(result[0].parts).toHaveLength(6);
  });
});
