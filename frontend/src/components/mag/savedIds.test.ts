import { describe, expect, it } from "vitest";
import { withSavedIds } from "./savedIds";

type B = { id?: string; source?: string; x: number };

describe("withSavedIds", () => {
  it("приклеивает id к записанным и пропускает отброшенные", () => {
    const a: B = { x: 1 };
    const b: B = { x: 2 };
    const out = withSavedIds([a, b], [{ id: "1", source: "model" }, null], [a, b]);
    expect(out[0]).toEqual({ id: "1", source: "model", x: 1 });
    expect(out[1]).toBe(b);
  });

  it("правка во время записи остаётся без id", () => {
    const a: B = { x: 1 };
    const moved: B = { x: 5 };
    const out = withSavedIds([a], [{ id: "1", source: "human" }], [moved]);
    expect(out[0]).toBe(moved);
  });

  it("без изменений возвращает тот же массив", () => {
    const a: B = { id: "1", source: "human", x: 1 };
    const cur = [a];
    expect(withSavedIds([a], [{ id: "1", source: "human" }], cur)).toBe(cur);
  });
});
