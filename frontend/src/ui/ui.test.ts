import { describe, expect, it } from "vitest";
import { cx, hueOf, initialsOf, rangePercent, stackShares } from "./cx";
import { nextTri } from "./Form";

describe("примитивы", () => {
  it("cx выбрасывает ложное", () => {
    expect(cx("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("заливка ползунка в пределах 0–100", () => {
    expect(rangePercent(50, 0, 200)).toBe(25);
    expect(rangePercent(-5, 0, 10)).toBe(0);
    expect(rangePercent(15, 0, 10)).toBe(100);
    expect(rangePercent(3, 5, 5)).toBe(0);
    expect(rangePercent(NaN, 0, 10)).toBe(0);
  });

  it("инициалы", () => {
    expect(initialsOf("Иван Соя")).toBe("ИС");
    expect(initialsOf("  tester ")).toBe("TE");
    expect(initialsOf("")).toBe("?");
  });

  it("оттенок устойчив", () => {
    expect(hueOf("Иван")).toBe(hueOf("Иван"));
    expect(hueOf("Иван")).toBeGreaterThanOrEqual(0);
    expect(hueOf("Иван")).toBeLessThan(360);
  });

  it("доли полосы: мусор и минусы — ноль, сумма — 100", () => {
    const s = stackShares([1, 3, -2, NaN]);
    expect(s).toEqual([25, 75, 0, 0]);
    expect(stackShares([0, 0])).toEqual([0, 0]);
  });

  it("три состояния идут по кругу", () => {
    expect(nextTri(null)).toBe("in");
    expect(nextTri("in")).toBe("ex");
    expect(nextTri("ex")).toBe(null);
  });
});
