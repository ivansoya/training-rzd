import { describe, expect, it } from "vitest";
import { CYRILLIC, agentClasses, isExamples, rowTarget, switchTextModel } from "./agentDoc";

describe("«Сеть по тексту»", () => {
  it("порог на умолчании переходит к умолчанию новой модели, правленый остаётся", () => {
    expect(switchTextModel({ model: "l", conf: 0.25 }, "sam3")).toEqual({ model: "sam3", conf: 0.4 });
    expect(switchTextModel({ model: "sam3", conf: 0.4 }, "m")).toEqual({ model: "m", conf: 0.25 });
    expect(switchTextModel({ model: "l", conf: 0.3 }, "sam3")).toEqual({ model: "sam3", conf: 0.3 });
    expect(switchTextModel({}, "sam3")).toEqual({ model: "sam3", conf: 0.4 });
    expect(switchTextModel({ model: "s", conf: 0.25 }, "x")).toEqual({ model: "x", conf: 0.25 });
  });

  it("классы агента: синонимы в один класс, строка без промта и выключенная не в счёт", () => {
    const nodes = [
      { id: "net1", type: "net", params: { classes: [{ agent: "Человек", on: true }] } },
      { id: "t", type: "text", params: { prompts: [
        { prompt: "person", agent: "Человек", on: true },
        { prompt: "worker", agent: "Человек", on: true },
        { prompt: "", agent: "Пусто", on: true },
        { prompt: "rag", agent: "Тряпьё", on: false },
      ] } },
    ];
    const got = agentClasses(nodes, () => ["person"]);
    expect(got.map((c) => [c.name, c.sources.map((s) => s.label)])).toEqual([
      ["Человек", ["№0 person", "«person»", "«worker»"]],
    ]);
  });

  it("строка-образцы — класс агента, без набора — не в счёт", () => {
    const nodes = [{ id: "t", type: "text", params: { prompts: [
      { kind: "examples", set: "s1", agent: "Инструмент", on: true, conf: 0.1 },
      { kind: "examples", set: "", agent: "Пусто", on: true },
      { kind: "text", prompt: "hammer", agent: "Инструмент", on: true },
    ] } }];
    expect(agentClasses(nodes, () => []).map((c) => [c.name, c.sources.map((s) => s.label)])).toEqual([
      ["Инструмент", ["образцы", "«hammer»"]],
    ]);
    expect(rowTarget({ kind: "examples", set: " s1 ", agent: "", on: true })).toBe("s1");
    expect(isExamples({ prompt: "x", agent: "", on: true })).toBe(false);
  });

  it("кириллицу в промте видно, латиницу и цифры — нет", () => {
    expect(CYRILLIC.test("лопата")).toBe(true);
    expect(CYRILLIC.test("РСМ-2000 rail")).toBe(true);
    expect(CYRILLIC.test("orange vest 2")).toBe(false);
  });
});
