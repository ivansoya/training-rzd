import { describe, expect, it } from "vitest";
import type { LabelClass } from "../../../auth/api";
import { hotkey, indexLabel, matchClasses, valShare } from "./classes";

const cls = (i: number, name: string, sc: string | null = null, split?: LabelClass["split"]): LabelClass => ({
  id: `c${i}`, class_index: i, name, color: "#0090ff", superclass_id: sc,
  superclass_name: sc ? `Группа ${sc}` : null, annotations: 0, split,
});

describe("классы", () => {
  it("доля val считается среди train и val, без сплита не мешает", () => {
    expect(valShare(cls(0, "a", null, { train: 3, val: 1, other: 10 }))).toBe(0.25);
    expect(valShare(cls(0, "a", null, { train: 0, val: 0, other: 5 }))).toBeNull();
    expect(valShare(cls(0, "a"))).toBeNull();
  });

  it("клавиша — место по номеру класса, только первые девять", () => {
    const list = Array.from({ length: 12 }, (_, k) => cls(30 - k, `к${k}`));
    expect(hotkey(list, "c19")).toBe(1);
    expect(hotkey(list, "c27")).toBe(9);
    expect(hotkey(list, "c28")).toBeNull();
    expect(hotkey(list, "нет")).toBeNull();
  });

  it("поиск по имени, номеру и группе, отбор по группе", () => {
    const list = [cls(0, "Вагон", "g1"), cls(7, "Опора"), cls(12, "Шпала", "g2")];
    expect(matchClasses(list, "ваг", "all").map((c) => c.name)).toEqual(["Вагон"]);
    expect(matchClasses(list, "#07", "all").map((c) => c.name)).toEqual(["Опора"]);
    expect(matchClasses(list, "без группы", "all").map((c) => c.name)).toEqual(["Опора"]);
    expect(matchClasses(list, "", "none").map((c) => c.name)).toEqual(["Опора"]);
    expect(matchClasses(list, "", "g2").map((c) => c.name)).toEqual(["Шпала"]);
    expect(indexLabel(5)).toBe("#05");
  });
});
