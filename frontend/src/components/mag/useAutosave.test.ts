import { describe, expect, it } from "vitest";
import { classify, retryDelay } from "./useAutosave";

describe("разбор ошибки записи кадра", () => {
  it("чужая правка — stale, а не просто отказ", () => {
    expect(classify({ status: 409, code: "stale" })).toBe("stale");
  });
  it("отказ сервера не повторяется", () => {
    for (const status of [400, 403, 404, 409]) expect(classify({ status })).toBe("refused");
  });
  it("сеть, таймаут, перегрузка и 5xx повторяются", () => {
    expect(classify(new TypeError("Failed to fetch"))).toBe("failed");
    for (const status of [408, 429, 500, 502]) expect(classify({ status })).toBe("failed");
  });
  it("пауза повтора растёт до 15 с", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});
