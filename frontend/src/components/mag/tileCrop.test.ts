import { describe, expect, it } from "vitest";
import { labelAt } from "./tileCrop";

describe("подпись рамки на кадрированной плитке", () => {
  it("кадр той же формы, что плитка, — доли как есть", () => {
    expect(labelAt({ x: 400, y: 150, w: 10, h: 10 }, 800, 600)).toEqual({ left: 50, top: 25 });
  });

  it("широкий кадр срезан по бокам: подпись сдвигается, а не стоит по долям", () => {
    // 1600×900 на плитке 4:3: видно 1200 по ширине, срезано по 200 с краёв.
    const at = labelAt({ x: 800, y: 0, w: 10, h: 10 }, 1600, 900)!;
    expect(at.left).toBeCloseTo(50);
    const edge = labelAt({ x: 200, y: 450, w: 10, h: 10 }, 1600, 900)!;
    expect(edge.left).toBeCloseTo(0);
    expect(edge.top).toBeCloseTo(50);
  });

  it("высокий кадр срезан сверху и снизу", () => {
    // 600×1000: видно 450 по высоте, срезано по 275.
    const at = labelAt({ x: 300, y: 500, w: 10, h: 10 }, 600, 1000)!;
    expect(at.top).toBeCloseTo(50);
  });

  it("рамка целиком за краем кадрирования подписи не получает", () => {
    expect(labelAt({ x: 1450, y: 100, w: 100, h: 100 }, 1600, 900)).toBeNull();
    expect(labelAt({ x: 0, y: 0, w: 150, h: 100 }, 1600, 900)).toBeNull();
  });

  it("частично срезанная рамка — подпись у края плитки", () => {
    expect(labelAt({ x: 100, y: 450, w: 200, h: 10 }, 1600, 900)!.left).toBe(0);
  });
});
