import { describe, expect, it } from "vitest";
import {
  CYRILLIC, PALETTE, agentClasses, bindRows, carryClasses, collagePasses, findOrCreate, frameCalls, isExamples, keepWired, offLimits,
  promptMax, rowTarget, sam3Side, statClasses, switchTextModel, tileSide, unfinished, upgradeDoc,
} from "./agentDoc";
import type { PromptRow } from "./agentDoc";

describe("«Сеть по тексту»", () => {
  it("порог на умолчании переходит к умолчанию новой модели, правленый остаётся", () => {
    expect(switchTextModel({ model: "l", conf: 0.25 }, "sam3")).toEqual({ model: "sam3", conf: 0.4, side: 1008 });
    expect(switchTextModel({ model: "sam3", conf: 0.4 }, "m")).toEqual({ model: "m", conf: 0.25 });
    expect(switchTextModel({ model: "l", conf: 0.3 }, "sam3")).toEqual({ model: "sam3", conf: 0.3, side: 1008 });
    expect(switchTextModel({}, "sam3")).toEqual({ model: "sam3", conf: 0.4, side: 1008 });
    expect(switchTextModel({ model: "s", conf: 0.25 }, "x")).toEqual({ model: "x", conf: 0.25 });
  });

  it("вход SAM 3: только 644 и 1008, без поля — 644; уже выбранный вход смена модели не трогает", () => {
    expect(sam3Side({})).toBe(644);
    expect(sam3Side({ side: 1008 })).toBe(1008);
    expect(sam3Side({ side: 900 })).toBe(644);
    expect(switchTextModel({ model: "l", side: 644 }, "sam3")).not.toHaveProperty("side");
    expect(tileSide("text", { model: "sam3", side: 1008 })).toBe(1008);
    expect(tileSide("text", { model: "sam3" })).toBe(644);
    expect(promptMax("sam3")).toBe(100);
    expect(promptMax("l")).toBe(200);
  });

  it("проходы образцов: на широком кадре 12 за проход, на квадратном тайле 6 — как collage_passes", () => {
    expect(collagePasses(13, 2688, 1520)).toEqual([Array.from({ length: 12 }, (_, i) => i), [12]]);
    expect(collagePasses(13, 1008, 1008).map((p) => p.length)).toEqual([6, 6, 1]);
    expect(collagePasses(0, 2688, 1520)).toEqual([]);
  });

  it("вызовов на кадр — как agent_graph.calls: слова порциями на 1008, проходы каждого набора на каждом виде", () => {
    const rows = [
      ...["a", "b", "c", "d", "e"].map((w) => ({ kind: "text" as const, prompt: w, cls: "c1", on: true })),
      { kind: "examples" as const, set: "s1", cls: "c1", on: true },
      { kind: "examples" as const, set: "s2", cls: "c1", on: false },
    ];
    const p = { model: "sam3", side: 1008, prompts: rows };
    const count = (s: string) => (s === "s1" ? 13 : undefined);
    expect(frameCalls("text", p, 2688, 1520, 1008, count)).toBe(2 + 2);
    // тайлы 1008: 4×2 тайла и целый кадр; на тайле образцы идут по 6
    expect(frameCalls("text", { ...p, tiles: true }, 2688, 1520, 1008, count)).toBe(4 + 8 * (2 + 3));
    expect(frameCalls("text", { ...p, side: 644 }, 2688, 1520, 644)).toBe(1 + 1);
    expect(frameCalls("text", { model: "l", prompts: rows, tiles: true }, 2688, 1520, 1280)).toBe(1 + 3 * 2);
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
    const up = upgradeDoc({ nodes });
    const got = agentClasses(up.classes, up.nodes, () => ["person"]);
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
    const up = upgradeDoc({ nodes });
    expect(agentClasses(up.classes, up.nodes, () => []).map((c) => [c.name, c.sources.map((s) => s.label)])).toEqual([
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

describe("порог строк-образцов", () => {
  it("у SAM 3 пусто, у YOLOE 0,1; смена модели переносит нетронутый порог", () => {
    const rows = [{ kind: "examples" as const, set: "a", agent: "X", on: true, conf: 0.1 },
      { kind: "examples" as const, set: "b", agent: "Y", on: true, conf: 0.3 }];
    const got = switchTextModel({ model: "l", prompts: rows }, "sam3") as { prompts: PromptRow[] };
    expect(got.prompts[0].conf).toBeUndefined();
    expect(got.prompts[1].conf).toBe(0.3);
    const back = switchTextModel({ model: "sam3", prompts: got.prompts }, "l") as { prompts: PromptRow[] };
    expect(back.prompts[0].conf).toBe(0.1);
  });
});

describe("список классов агента", () => {
  it("старый документ — классы по появлению, цвета палитры, строки по id; как agent_graph.upgrade", () => {
    const doc = {
      nodes: [
        { id: "a", type: "net", params: { classes: [{ agent: "вагон", on: true }, { agent: "знак", on: false }] } },
        { id: "b", type: "net", params: { classes: [{ agent: "рельс", on: true }, { agent: "Вагон", on: true }] } },
        { id: "f", type: "filter", params: { classes: [{ cls: "вагон", on: true, conf: 0.5 }, { cls: "призрак", on: true, conf: 0 }] } },
      ],
    };
    const up = upgradeDoc(doc);
    expect(up.classes).toEqual([{ id: "c1", name: "вагон", color: PALETTE[0] }, { id: "c2", name: "рельс", color: PALETTE[1] }]);
    expect(up.nodes[0].params.classes).toEqual([{ cls: "c1", on: true }, { agent: "знак", on: false }]);
    expect(up.nodes[1].params.classes).toEqual([{ cls: "c2", on: true }, { cls: "c1", on: true }]);
    expect(up.nodes[2].params.classes).toEqual([{ cls: "c1", on: true, conf: 0.5 }]);
    expect(upgradeDoc(up)).toBe(up);
  });

  it("имя без регистра находит класс, новое заводит со свободным цветом", () => {
    const [defs, id] = findOrCreate([{ id: "c1", name: "Вагон", color: PALETTE[0] }], " вагон ");
    expect(id).toBe("c1");
    const [more, made] = findOrCreate(defs, "рельс");
    expect(more).toHaveLength(2);
    expect(more[1]).toMatchObject({ id: made, name: "рельс", color: PALETTE[1] });
    expect(findOrCreate(defs, "  ")[1]).toBeNull();
  });

  it("включённым строкам без класса — класс по подсказке или по имени из весов", () => {
    const [defs, rows] = bindRows([], [{ on: true, agent: "вагон" }, { on: true }, { on: false, agent: "знак" }], (_r, i) => `w${i}`);
    expect(defs.map((c) => c.name)).toEqual(["вагон", "w1"]);
    expect(rows[0]).toEqual({ on: true, cls: defs[0].id });
    expect(rows[2]).toEqual({ on: false, agent: "знак" });
  });

  it("паспорт версии: старый — имена, новый — объекты с цветом", () => {
    expect(statClasses(["a", "b"])).toEqual([{ name: "a", color: PALETTE[0] }, { name: "b", color: PALETTE[1] }]);
    expect(statClasses([{ id: "c1", name: "a", color: "#000" }])).toEqual([{ id: "c1", name: "a", color: "#000" }]);
    expect(statClasses(undefined)).toEqual([]);
  });
});
