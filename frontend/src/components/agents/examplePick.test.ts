import { describe, expect, it } from "vitest";
import type { ClassBox } from "../../api/agents";
import { MAX_SET, addFor, bandOf, filterBoxes, moved, randomDistinct, sameName, shapeBox, stepFor, tilesOf, type Picked } from "./examplePick";

const box = (uid: string, group: number, b: [number, number, number, number], dataset = "d1"): ClassBox =>
  ({ uid, image_id: `i-${uid}`, file_name: `${uid}.jpg`, dataset, frame: [2688, 1520], box: b, video: null, t: null, group });

describe("окно «Образцы класса»", () => {
  it("полоса размера по большей стороне", () => {
    expect(bandOf([0, 0, 30, 27])).toBe("small");
    expect(bandOf([0, 0, 42, 199])).toBe("mid");
    expect(bandOf([0, 0, 117, 1520])).toBe("big");
  });

  it("фильтр размера и датасетов", () => {
    const all = [box("a", 0, [0, 0, 30, 27]), box("b", 1, [0, 0, 42, 199], "d2"), box("c", 2, [0, 0, 30, 30], "d2")];
    expect(filterBoxes(all, "small", new Set()).map((b) => b.uid)).toEqual(["a", "c"]);
    expect(filterBoxes(all, "all", new Set(["d2"])).map((b) => b.uid)).toEqual(["a"]);
  });

  it("похожие одной плиткой — середина серии", () => {
    const all = [box("a", 0, [0, 0, 9, 9]), box("b", 0, [0, 0, 9, 9]), box("c", 0, [0, 0, 9, 9]), box("d", 1, [0, 0, 9, 9])];
    const tiles = tilesOf(all, true);
    expect(tiles.map((t) => [t.box.uid, t.members.length])).toEqual([["b", 3], ["d", 1]]);
    expect(tilesOf(all, false)).toHaveLength(4);
  });

  it("случайно +N разных: по одной из группы, занятые группы пропускаются", () => {
    const all = [box("a", 0, [0, 0, 9, 9]), box("b", 0, [0, 0, 9, 9]), box("c", 1, [0, 0, 9, 9]), box("d", 2, [0, 0, 9, 9])];
    const chosen: Picked[] = [{ uid: "d", image_id: "i-d", box: [0, 0, 9, 9], file_name: "d.jpg", group: 2 }];
    const got = randomDistinct(all, chosen, 6, () => 0);
    expect(got).toHaveLength(2);
    expect(new Set(got.map((b) => b.group))).toEqual(new Set([0, 1]));
    expect(randomDistinct(all, [], 1, () => 0)).toHaveLength(1);
    expect(addFor("sam3")).toBe(6);
    expect(addFor("l")).toBe(MAX_SET);
    expect(stepFor("sam3", 10)).toBe(1);
    expect(stepFor("l", 250)).toBe(6);
  });

  it("перенос, рамка многоугольника, имена", () => {
    expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(shapeBox({ parts: [[[10, 10], [30, 12]], [[12, 50]]] })).toEqual([10, 10, 20, 40]);
    expect(shapeBox({ x: 1, y: 2, w: 3, h: 4 })).toEqual([1, 2, 3, 4]);
    expect(shapeBox({ x: 1, y: 2, w: 0, h: 4 })).toBeNull();
    expect(sameName(" Металлический ", "металлический")).toBe(true);
    expect(sameName("Ёлка", "елка")).toBe(true);
  });
});
