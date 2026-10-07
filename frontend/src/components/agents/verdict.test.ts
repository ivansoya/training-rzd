import { describe, expect, it } from "vitest";
import type { HumanShape, PreviewDet } from "../../api/agents";
import { iou, judge, reachable } from "./verdict";

const det = (id: string, cls: string, box: [number, number, number, number], conf = 0.9): PreviewDet => ({ id, cls, conf, box });
const man = (cls: string, x: number, y: number, w: number, h: number): HumanShape =>
  ({ cls, color: "#fff", type: "bbox", geometry: { x, y, w, h } });

describe("сверка с разметкой", () => {
  it("классы до узла: свои, сверху и минус выключенное фильтром", () => {
    const nodes = [
      { id: "f", type: "frame" }, { id: "a", type: "text" }, { id: "b", type: "net" }, { id: "m", type: "merge" },
      { id: "x", type: "filter", params: { classes: [{ cls: "dog", on: false }, { cls: "cat", on: true }] } }, { id: "o", type: "output" },
    ];
    const edges = [{ from: "f", to: "a" }, { from: "f", to: "b" }, { from: "a", to: "m" }, { from: "b", to: "m" }, { from: "m", to: "x" }, { from: "x", to: "o" }];
    const own = (n: string) => ({ a: ["cat"], b: ["dog", "car"] } as Record<string, string[]>)[n] ?? [];
    expect([...reachable("a", nodes, edges, own)]).toEqual(["cat"]);
    expect([...reachable("m", nodes, edges, own)].sort()).toEqual(["car", "cat", "dog"]);
    expect([...reachable("o", nodes, edges, own)].sort()).toEqual(["car", "cat"]);
    expect(reachable("f", nodes, edges, own).size).toBe(0);
  });

  it("верно, ложно, не нашёл; чужие классы не сверяются", () => {
    const human = [man("Кот", 0, 0, 10, 10), man("Кот", 50, 50, 10, 10), man("Пёс", 0, 0, 10, 10), man("Ничей", 5, 5, 5, 5)];
    const agentOf = (c: string) => ({ Кот: "cat", Пёс: "dog" } as Record<string, string>)[c] ?? null;
    const out = [det("1", "cat", [1, 1, 10, 10]), det("2", "cat", [200, 200, 10, 10]), det("3", "cat", [0, 0, 10, 10], 0.5)];
    const v = judge(out, human, agentOf, new Set(["cat"]));
    // уверенная «1» забирает рамку, «3» поверх той же — уже ложная
    expect(v.hit.map((h) => h.det.id)).toEqual(["1"]);
    expect(v.wrong.map((d) => d.id).sort()).toEqual(["2", "3"]);
    expect(v.missed).toHaveLength(1);
    expect(v.skipped).toEqual([{ cls: "Пёс", count: 1 }, { cls: "Ничей", count: 1 }]);
    expect(v.byClass).toEqual([{ cls: "cat", hit: 1, wrong: 2, missed: 1 }]);
  });

  it("IoU", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(1 / 3);
    expect(iou([0, 0, 10, 10], [20, 0, 10, 10])).toBe(0);
  });
});
