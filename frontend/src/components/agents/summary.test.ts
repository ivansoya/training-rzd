import { describe, expect, it } from "vitest";
import type { PreviewDet } from "../../api/agents";
import type { AgentClass } from "./agentDoc";
import { classStats, nodeStats, type SummaryNode } from "./summary";

const det = (cls: string): PreviewDet => ({ id: `n.${cls}`, cls, conf: 0.9, box: [0, 0, 10, 10] } as PreviewDet);

describe("сводка агента в «Выходе»", () => {
  it("узлы: модель, вызовы на кадр, время; кадр и выход пропускаются", () => {
    const nodes: SummaryNode[] = [
      { id: "f", kind: "frame", title: "Кадр", params: {} },
      { id: "t", kind: "text", title: "SAM 3", params: { model: "sam3", side: 1008, prompts: [{ kind: "text", prompt: "nut", cls: "c", on: true }] } },
      { id: "n", kind: "nms", title: "NMS", params: {} },
      { id: "s", kind: "sam", title: "Уточнение", params: {} },
      { id: "o", kind: "output", title: "Выход", params: {} },
    ];
    const trace = { t: { in: [], out: [det("a")], ms: 200 }, s: { in: [det("a"), det("b")], out: [det("a")], ms: 40 } };
    const got = nodeStats(nodes, { w: 2688, h: 1520 }, trace, () => undefined);
    expect(got.map((n) => n.id)).toEqual(["t", "n", "s"]);
    expect(got[0]).toMatchObject({ model: "SAM 3 · 1008", calls: 1, views: 1, ms: 200, out: 1 });
    expect(got[1]).toMatchObject({ model: "—", calls: null, ms: undefined });
    expect(got[2]).toMatchObject({ model: "SAM2.1 small", boxes: 2, calls: null });
  });

  it("классы: счёт на кадре и источники по узлам, неиспользуемые не показываются", () => {
    const classes = [
      { id: "1", name: "Инструмент", color: "#f00", sources: [{ node: "y", index: 0, label: "«wrench»" }, { node: "y", index: 1, label: "«hammer»" }, { node: "s", index: 2, label: "образцы" }] },
      { id: "2", name: "Человек", color: "#0f0", sources: [{ node: "s", index: 0, label: "образцы" }] },
      { id: "3", name: "Пустой", color: "#00f", sources: [] },
    ] as AgentClass[];
    const got = classStats(classes, [det("Человек"), det("Человек"), det("Инструмент")], (id) => id.toUpperCase());
    expect(got.map((c) => [c.cls.name, c.count])).toEqual([["Человек", 2], ["Инструмент", 1]]);
    expect(got[1].from).toEqual([{ node: "y", title: "Y", labels: ["«wrench»", "«hammer»"] }, { node: "s", title: "S", labels: ["образцы"] }]);
  });
});
