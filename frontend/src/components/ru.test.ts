import { describe, expect, it } from "vitest";
import { count, plural } from "./ru";
import { parseNum } from "./NumInput";

describe("подписи с числом", () => {
  it("согласует слово", () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 1180].map((n) => plural(n, "кадр", "кадра", "кадров"))).toEqual(
      ["кадр", "кадра", "кадров", "кадров", "кадров", "кадр", "кадра", "кадров", "кадров", "кадров"]
    );
    expect(count(29150, "кадр", "кадра", "кадров")).toBe("29 150 кадров");
  });
});

describe("числовое поле", () => {
  it("разбирает и точку, и запятую, и промежуточное — нет", () => {
    expect(parseNum("0.4")).toBe(0.4);
    expect(parseNum("0,4")).toBe(0.4);
    expect(parseNum(".3")).toBe(0.3);
    expect(parseNum("0.")).toBe(0);
    expect(parseNum("")).toBeNull();
    expect(parseNum("-")).toBeNull();
    expect(parseNum("1e3")).toBeNull();
  });
});
