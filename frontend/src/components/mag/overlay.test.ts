import { describe, expect, it } from "vitest";
import {
  ANCHORS_AT,
  MIDS_AT,
  VERTEX_EDGE,
  affordance,
  diamond,
  factors,
  showVertices,
  toImageDistance,
  toScreen,
  type Rect,
} from "./overlay";

/** Кадр 1000×500, вписанный на экран как 500×250 — то есть вдвое мельче. */
const half: Rect = { l: 100, t: 50, w: 500, h: 250 };
/** Тот же кадр, приближенный вчетверо от исходного размера. */
const zoomed: Rect = { l: -300, t: -200, w: 4000, h: 2000 };

describe("кадр и экран", () => {
  it("переводит точку кадра в точку экрана", () => {
    expect(toScreen(0, 0, 1000, 500, half)).toEqual([100, 50]);
    expect(toScreen(1000, 500, 1000, 500, half)).toEqual([600, 300]);
    expect(toScreen(500, 250, 1000, 500, half)).toEqual([350, 175]);
  });

  it("считает коэффициенты по обеим осям", () => {
    expect(factors(1000, 500, half)).toEqual([0.5, 0.5]);
    expect(factors(1000, 500, zoomed)).toEqual([4, 4]);
  });

  it("переводит экранное расстояние в пиксели кадра", () => {
    // На отдалении вдвое десять экранных пикселей — это двадцать кадровых.
    expect(toImageDistance(10, 1000, 500, half)).toBe(20);
    // На приближении вчетверо — два с половиной.
    expect(toImageDistance(10, 1000, 500, zoomed)).toBe(2.5);
  });

  it("берёт меньший коэффициент, чтобы зона не сузилась ни по одной оси", () => {
    const squished: Rect = { l: 0, t: 0, w: 1000, h: 250 };
    expect(toImageDistance(10, 1000, 500, squished)).toBe(20);
  });
});

describe("что показывать у объекта", () => {
  it("мелкий объект якорей не показывает", () => {
    expect(affordance(30, 30)).toEqual({ corners: false, mids: false });
  });

  it("средний показывает углы", () => {
    expect(affordance(ANCHORS_AT, ANCHORS_AT)).toEqual({ corners: true, mids: false });
  });

  it("крупный показывает и середины", () => {
    expect(affordance(MIDS_AT, MIDS_AT)).toEqual({ corners: true, mids: true });
  });

  it("решает по меньшей стороне", () => {
    // Плашка 300×20: между углами вертикальной грани ставить нечего.
    expect(affordance(300, 20)).toEqual({ corners: false, mids: false });
  });

  it("тот же объект на зуме якоря получает", () => {
    // Объект 20×20 пикселей кадра: на отдалении вдвое это 10 экранных,
    // на приближении вчетверо — 80. Решает экран, а не зум сам по себе.
    expect(affordance(10, 10).corners).toBe(false);
    expect(affordance(80, 80).corners).toBe(true);
  });
});

describe("вершины контура", () => {
  const rect: Rect = { l: 0, t: 0, w: 1000, h: 1000 };
  const big: [number, number][][] = [[[0, 0], [100, 0], [100, 100], [0, 100]]];
  const tiny: [number, number][][] = [[[0, 0], [5, 0], [5, 5], [0, 5]]];

  it("на длинных рёбрах показываются", () => {
    expect(showVertices(big, 1000, 1000, rect)).toBe(true);
  });

  it("на коротких — нет, иначе точки сливаются в ободок", () => {
    expect(showVertices(tiny, 1000, 1000, rect)).toBe(false);
  });

  it("порог меряется на экране, а не в кадре", () => {
    // Тот же мелкий контур, приближенный вдесятеро, правится прекрасно.
    const near: Rect = { l: 0, t: 0, w: 10000, h: 10000 };
    expect(showVertices(tiny, 1000, 1000, near)).toBe(true);
  });

  it("ровно на пороге показываются", () => {
    const edge: [number, number][][] = [
      [[0, 0], [VERTEX_EDGE, 0], [VERTEX_EDGE, VERTEX_EDGE], [0, VERTEX_EDGE]],
    ];
    expect(showVertices(edge, 1000, 1000, rect)).toBe(true);
  });

  it("на пустом объекте вершин нет", () => {
    expect(showVertices([], 1000, 1000, rect)).toBe(false);
  });
});

describe("ромб вершины", () => {
  it("замкнут и стоит вокруг своей точки", () => {
    expect(diamond(50, 40, 4)).toBe("M50 36L54 40L50 44L46 40Z");
  });
});
