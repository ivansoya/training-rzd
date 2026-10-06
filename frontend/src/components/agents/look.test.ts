import { describe, expect, it } from "vitest";
import type { PreviewDet } from "../../api/agents";
import {
  NEUTRAL_TONE, PALETTE, droppedOf, filterLine, freeName, netBadge, netLine, onePort, plainLine, tally, textLine, toneOf, wireText,
} from "./look";

const det = (id: string, cls: string): PreviewDet => ({ id, cls, conf: 0.5, box: [0, 0, 10, 10] });

describe("вид узлов агента", () => {
  it("цвет по группе: поиск c1, уточнение c4, концы c2, обработка нейтральная", () => {
    expect(toneOf("net")).toBe("var(--c1)");
    expect(toneOf("text")).toBe("var(--c1)");
    expect(toneOf("sam")).toBe("var(--c4)");
    expect(toneOf("frame")).toBe("var(--c2)");
    expect(toneOf("output")).toBe("var(--c2)");
    expect(toneOf("nms")).toBe(NEUTRAL_TONE);
  });

  it("в палитре нет «Кадра» и «Выхода»", () => {
    const kinds = PALETTE.flatMap((g) => g.items.map((i) => i.kind as string));
    expect(kinds).not.toContain("frame");
    expect(kinds).not.toContain("output");
    expect(kinds).toHaveLength(6);
  });

  it("в разрыв встают узлы с одним входом и выходом", () => {
    expect(onePort("net")).toEqual(["in", "out"]);
    expect(onePort("sam")).toEqual(["in", "out"]);
    expect(onePort("merge")).toBeNull();
    expect(onePort("frame")).toBeNull();
    expect(onePort("output")).toBeNull();
  });

  it("строка сети: паспорт весов и тайлы на кадре проекта", () => {
    const w = { name: "rzd.pt", task: "detect", imgsz: 960 };
    const rsm = { w: 2688, h: 1520 };
    expect(netLine({ conf: 0.3 }, w)).toBe("detect, 960, conf 0,3");
    expect(netLine({ label: "вагоны", tiles: true, tta_flip: true }, w)).toBe("rzd, detect, 960, conf 0,25, тайл 960");
    // 1 целый + 5×3 тайлов по 640 — как agent_graph.passes
    expect(netLine({ tiles: true, tile: 640 }, w, rsm)).toBe("detect, 960, conf 0,25, тайл 640 ×16");
    expect(netLine({ tiles: true, tile: 640, whole: false }, w, rsm)).toBe("detect, 960, conf 0,25, тайл 640 ×15, без целого");
    expect(netLine({}, undefined)).toBe("веса не выбраны");
  });

  it("строка сети по тексту: слова и образцы", () => {
    const prompts = [
      { prompt: "car", cls: "c1", on: true },
      { kind: "examples", set: "s1", cls: "c2", on: true },
      { prompt: "", cls: "c3", on: true },
      { prompt: "bus", on: true },
    ];
    expect(textLine({ model: "l", prompts }, false)).toBe("YOLOE-26 l, 1 сл. + 1 обр., conf 0,25");
    expect(textLine({ model: "sam3", prompts }, true)).toBe("нет весов SAM 3");
  });

  it("строка фильтра считает правила только для пришедших классов", () => {
    const p = { classes: [{ cls: "a", on: false, conf: 0 }, { cls: "b", on: true, conf: 0.4 }, { cls: "c", on: true, conf: 0 }], min_side: 8 };
    expect(filterLine(p, ["a", "c"])).toBe("правил 1, сторона 8–∞ px");
    expect(filterLine({}, [])).toBe("пропускает всё");
  });

  it("строки простых узлов", () => {
    expect(plainLine("nms", { iou: 0.5, agnostic: true })).toBe("IoU 0,5, между классами");
    expect(plainLine("merge", { inputs: 3 })).toBe("3 входа · подряд");
    expect(plainLine("sam", { model: "sam2.1_hiera_base_plus" })).toBe("SAM2.1 base+ → контур");
  });

  it("включённые классы сети", () => {
    expect(netBadge({ classes: [{ agent: "a", on: true }, { agent: "b", on: false }] }, 5)).toBe("1/5");
  });
});

describe("счёт рамок", () => {
  const trace = { n1: { in: [], out: [det("n1.0", "a"), det("n1.1", "b")] } };

  it("провод от кадра подписан словом, прочие — числом рамок", () => {
    expect(wireText("frame", trace, "f")).toEqual({ text: "кадр", amount: 0 });
    expect(wireText("net", trace, "n1")).toEqual({ text: "2", amount: 2 });
    expect(wireText("nms", trace, "x")).toEqual({ text: "—", amount: 0 });
    expect(wireText("nms", null, "n1")).toEqual({ text: "—", amount: 0 });
  });

  it("пришло и ушло по классам, отсеянное — по номерам рамок", () => {
    const node = { in: [det("1", "a"), det("2", "a"), det("3", "b")], out: [det("1", "a")] };
    expect(tally(node)).toEqual([{ cls: "a", into: 2, out: 1 }, { cls: "b", into: 1, out: 0 }]);
    expect(droppedOf(node).map((d) => d.id)).toEqual(["2", "3"]);
    expect(tally(undefined)).toEqual([]);
  });

  it("свободное имя агента", () => {
    expect(freeName([])).toBe("Новый агент");
    expect(freeName(["Новый агент", "Новый агент 2"])).toBe("Новый агент 3");
  });
});
