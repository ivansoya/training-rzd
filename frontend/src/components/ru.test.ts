import { describe, expect, it } from "vitest";
import { ago, count, plural } from "./ru";
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

describe("давность", () => {
  const now = new Date(2026, 9, 4, 15, 0).getTime();
  const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m, d, h, mi).toISOString();
  it("минуты, часы, вчера, дата", () => {
    expect(ago(at(2026, 9, 4, 14, 59, ), now)).toBe("1 минуту назад");
    expect(ago(new Date(now - 20_000).toISOString(), now)).toBe("только что");
    expect(ago(at(2026, 9, 4, 14, 48), now)).toBe("12 минут назад");
    expect(ago(at(2026, 9, 4, 10), now)).toBe("5 часов назад");
    expect(ago(at(2026, 9, 3, 23), now)).toBe("вчера");
    expect(ago(at(2026, 7, 5, 12), now)).toBe("5 авг");
    expect(ago(at(2025, 7, 5, 12), now)).toMatch(/2025/);
  });
});
