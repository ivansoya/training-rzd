// Числа на проводах: клиент обязан считать ровно то же, что сервер.
//
// Образцы графов те же самые, что читает pytest (tests/unit/test_graph_plan.py).
// Это и есть страховка: разойдись счёт — и человек увидел бы в редакторе одно,
// а собрал другое, причём заметил бы только по весу набора.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { counts, findCycle, fitsPorts, mult, ports, topo, weights, GraphError } from "./counts";
import type { GraphDoc, GraphNode } from "../../api/aug";

const ROOT = join(process.cwd(), "..", "tests", "fixtures", "graphs");

function load(name: string) {
  return JSON.parse(readFileSync(join(ROOT, `${name}.json`), "utf-8")) as {
    base: number;
    doc: GraphDoc;
    graphs?: Record<string, GraphDoc>;
    expect: {
      outputs: number;
      dropped: number;
      multiplier: number;
      nodes: number;
      edges?: Record<string, number>;
    };
  };
}

describe("счёт по образцам", () => {
  // Блоки клиент сам не разворачивает — их содержимое лежит на сервере,
  // поэтому образец «block» проверяется отдельно, с подставленным множителем.
  for (const name of ["vagony", "shares", "two-sources", "mosaic"]) {
    it(`${name}: числа сходятся с серверными`, () => {
      const fixture = load(name);
      const got = counts(fixture.doc, fixture.base);
      expect(got.outputs).toBeCloseTo(fixture.expect.outputs, 3);
      expect(got.dropped).toBeCloseTo(fixture.expect.dropped, 3);
      expect(got.multiplier).toBeCloseTo(fixture.expect.multiplier, 3);
      expect(got.nodes).toBe(fixture.expect.nodes);
      for (const [wire, value] of Object.entries(fixture.expect.edges ?? {})) {
        expect(got.edges[wire], wire).toBeCloseTo(value, 3);
      }
    });
  }

  it("блок считается по множителю из паспорта версии", () => {
    const fixture = load("block");
    const got = counts(fixture.doc, fixture.base, {
      g1: { ports: { in: ["кадры"], out: ["готово"] }, multiplier: 2 },
      g2: { ports: { in: ["кадры"], out: ["готово"] }, multiplier: 2 },
    });
    expect(got.outputs).toBeCloseTo(fixture.expect.outputs, 3);
  });
});

describe("ветвление и деление", () => {
  it("из гнезда идёт сколько угодно проводов, и поток дублируется", () => {
    const got = counts(load("vagony").doc, 1040);
    expect(got.edges["src:out->mul:in"]).toBe(1040);
    expect(got.edges["src:out->mrg:i2"]).toBe(1040);
    expect(got.outputs).toBe(4160);
  });

  it("источникам можно подать разное", () => {
    // Словарь вместо числа: у графа с двумя источниками в каждый вливают
    // своё, и множитель считается от того, что влили.
    const got = counts(load("two-sources").doc, {
      night_src: 100,
      day_src: 900,
    });
    expect(got.edges["night_src:out->mul:in"]).toBe(100);
    expect(got.edges["day_src:out->mrg:i1"]).toBe(900);
    expect(got.outputs).toBe(1200);
    expect(got.multiplier).toBeCloseTo(1.2, 3);
  });

  it("сумма по веткам разделителя равна входу", () => {
    const got = counts(load("shares").doc, 1000);
    const sum =
      got.edges["cut:o0->a:in"] + got.edges["cut:o1->b:in"] + got.dropped;
    expect(sum).toBeCloseTo(1000, 3);
  });
});

describe("гнёзда", () => {
  const node = (type: string, params: Record<string, unknown> = {}) =>
    ({ id: "n", type, params } as GraphNode);

  it("у разделителя столько выходов, сколько веток", () => {
    expect(ports(node("split_prob", { branches: 3 }))[1]).toEqual([
      "o0",
      "o1",
      "o2",
    ]);
  });

  it("у слияния столько входов, сколько объявлено", () => {
    expect(ports(node("merge", { inputs: 3 }))[0]).toEqual(["i0", "i1", "i2"]);
  });

  it("уменьшили число гнёзд — провода с исчезнувших снимаются, прочие живут", () => {
    const spl = { id: "spl", type: "split_share", params: { branches: 2 } } as GraphNode;
    const mrg = { id: "mrg", type: "merge", params: { inputs: 2 } } as GraphNode;
    const grid = { id: "g", type: "mosaic", params: { rows: 1, cols: 2 } } as GraphNode;
    expect(fitsPorts(spl, { from: "spl", out: "o2", to: "x", in: "in" })).toBe(false);
    expect(fitsPorts(spl, { from: "spl", out: "o1", to: "x", in: "in" })).toBe(true);
    expect(fitsPorts(mrg, { from: "spl", out: "o0", to: "mrg", in: "i2" })).toBe(false);
    expect(fitsPorts(mrg, { from: "spl", out: "o0", to: "mrg", in: "i1" })).toBe(true);
    expect(fitsPorts(grid, { from: "s", out: "out", to: "g", in: "i3" })).toBe(false);
    // Чужой провод и блок (его гнёзда знает только сервер) не трогаем.
    expect(fitsPorts(mrg, { from: "a", out: "o9", to: "b", in: "i9" })).toBe(true);
    expect(fitsPorts({ id: "b", type: "group", params: {} } as GraphNode,
      { from: "b", out: "готово", to: "e", in: "in" })).toBe(true);
  });

  it("множитель пишется с запятой", () => {
    expect(mult(2.4)).toBe("×2,4");
    expect(mult(3)).toBe("×3");
  });

  it("нулевые веса не роняют счёт", () => {
    expect(weights(node("split_prob", { branches: 2, weights: [0, 0] }))).toEqual([
      1, 1,
    ]);
  });
});

describe("кольца", () => {
  const looped = {
    nodes: [
      { id: "s", type: "source" },
      { id: "a", type: "flow", params: { label: "Туман" } },
      { id: "m", type: "merge", params: { inputs: 2 } },
      { id: "e", type: "output" },
    ],
    edges: [
      { from: "s", out: "out", to: "m", in: "i0" },
      { from: "m", out: "out", to: "a", in: "in" },
      { from: "a", out: "out", to: "m", in: "i1" },
      { from: "a", out: "out", to: "e", in: "in" },
    ],
  } as GraphDoc;

  it("кольцо находится и показывается путём", () => {
    const cycle = findCycle(looped.nodes, looped.edges);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("m");
  });

  it("порядок обхода на кольце падает с внятным текстом", () => {
    expect(() => topo(looped.nodes, looped.edges)).toThrow(GraphError);
    expect(() => topo(looped.nodes, looped.edges)).toThrow(/кольцо/);
  });
});
