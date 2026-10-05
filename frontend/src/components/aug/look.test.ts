import { describe, expect, it } from "vitest";
import type { CatalogueNode, ParamSpec } from "../../api/aug";
import { NEUTRAL_TONE, argText, clampDrawer, freeName, kindOf, num, paramSummary, toneOf } from "./look";

const spec = (over: Partial<ParamSpec>): ParamSpec => ({ key: "k", label: "Угол", kind: "number", default: 0, ...over });

const rotate: CatalogueNode = {
  op: "Rotate", name: "Поворот", group: "geometry", group_title: "Геометрия", why: "", available: true, reason: null,
  params: [spec({ key: "limit", int: true, default: 10 })],
  chance: spec({ key: "chance", label: "Как часто", default: 0.5 }),
};

describe("look", () => {
  it("числа по-русски", () => {
    expect(num(0.5)).toBe("0,5");
    expect(num(0.123)).toBe("0,12");
    expect(num(7.6, true)).toBe("8");
  });

  it("значение параметра словами", () => {
    expect(argText(spec({ kind: "range" }), [-8, 8])).toBe("±8");
    expect(argText(spec({ kind: "range" }), [0.02, 0.08])).toBe("0,02–0,08");
    expect(argText(spec({ kind: "flag", label: "Сохранить края" }), true)).toBe("сохранить края");
    expect(argText(spec({ kind: "flag" }), false)).toBe("");
    expect(argText(spec({ kind: "choice" }), "reflect")).toBe("reflect");
  });

  it("строка параметров с вероятностью", () => {
    expect(paramSummary(rotate, { args: { limit: 8 }, chance: 1 })).toBe("угол 8");
    expect(paramSummary(rotate, { chance: 0.5 })).toBe("угол 10 · p 0,5");
    expect(paramSummary(undefined, { chance: 1 })).toBe("");
  });

  it("род узла: аугментация — по группе каталога", () => {
    expect(kindOf("aug", rotate)).toEqual({ icon: "rotate", label: "Геометрия" });
    expect(kindOf("multiply").label).toBe("Поток");
    expect(kindOf("source").icon).toBe("database");
  });

  it("шторка не съедает холст", () => {
    expect(clampDrawer(50, 800)).toBe(140);
    expect(clampDrawer(900, 800)).toBe(680);
    expect(clampDrawer(300, 800)).toBe(300);
  });

  it("свободное имя нового графа", () => {
    expect(freeName([])).toBe("Новый граф");
    expect(freeName(["Новый граф", "Новый граф 2"])).toBe("Новый граф 3");
  });

  it("цвет узла по группе", () => {
    expect(toneOf("aug", "geometry")).toBe("var(--c1)");
    expect(toneOf("aug", "weather")).toBe("var(--c5)");
    expect(toneOf("aug", "неизвестная")).toBe(NEUTRAL_TONE);
    expect(toneOf("output")).toBe("var(--c2)");
    expect(toneOf("merge")).toBe(NEUTRAL_TONE);
  });
});
