import { describe, expect, it } from "vitest";
import type { CanvasShape } from "../mag/BoxCanvas";
import { detachContour } from "./shapes";

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
