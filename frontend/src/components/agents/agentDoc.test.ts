import { describe, expect, it } from "vitest";
import {
  CYRILLIC, agentClasses, carryClasses, isExamples, keepWired, offLimits, rowTarget, switchTextModel, unfinished,
} from "./agentDoc";

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

describe("правка графа", () => {
  it("меньше «Входов» — провода в исчезнувшие гнёзда снимаются, прочие остаются", () => {
    const edges = [
      { target: "m", targetHandle: "i0" },
      { target: "m", targetHandle: "i2" },
      { target: "m", targetHandle: "i3" },
      { target: "o", targetHandle: "in" },
    ];
    expect(keepWired(edges, "m", { inputs: 3 }).map((e) => `${e.target}.${e.targetHandle}`)).toEqual(["m.i0", "m.i2", "o.in"]);
    expect(keepWired(edges, "m", { inputs: 2 })).toHaveLength(2);
  });

  it("новые веса: совпавшие по имени классы сохраняют имя в агенте и галочку", () => {
    const got = carryClasses(["person", "rail"], [{ agent: "Человек", on: true }, { agent: "рельс", on: false }], ["rail", "car", "person"]);
    expect(got).toEqual([{ agent: "рельс", on: false }, { agent: "car", on: true }, { agent: "Человек", on: true }]);
    expect(carryClasses([], [], ["a"])).toEqual([{ agent: "a", on: true }]);
  });

  it("пределы чисел: пусто — не ошибка, край — не ошибка, дробь у целого — ошибка", () => {
    const imgsz = { lo: 320, hi: 4096, int: true };
    expect(offLimits(imgsz, undefined)).toBe(false);
    expect(offLimits(imgsz, 320)).toBe(false);
    expect(offLimits(imgsz, 0)).toBe(true);
    expect(offLimits(imgsz, 640.5)).toBe(true);
    expect(offLimits({ lo: 0, hi: 1 }, 7)).toBe(true);
  });

  it("неполный граф превью не зовёт и говорит, чего не хватает", () => {
    const frame = { id: "f", type: "frame" };
    const out = { id: "o", type: "output" };
    const net = (p: Record<string, unknown>) => ({ id: "n", type: "net", params: p });
    const wires = [{ from: "f", to: "n", in: "in" }, { from: "n", to: "o", in: "in" }];
    expect(unfinished({ nodes: [frame, net({ classes: [] }), out], edges: wires })).toBe("«Сеть»: выберите веса.");
    const ok = net({ weights: "w", classes: [{ agent: "a", on: true }] });
    expect(unfinished({ nodes: [frame, ok, out], edges: wires.slice(0, 1) })).toMatch("подключите выход");
    expect(unfinished({ nodes: [frame, { ...ok, params: { ...ok.params, label: "путь", conf: 7 } }, out], edges: wires }))
      .toBe("«Сеть — путь»: исправьте число в поле.");
    expect(unfinished({ nodes: [frame, net({ weights: "w", classes: [{ agent: "a", on: false }] }), out], edges: wires }))
      .toMatch("класс");
    expect(unfinished({ nodes: [frame, ok, out], edges: wires })).toBeNull();
  });
});
