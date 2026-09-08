// Сколько образцов пройдёт по каждому проводу. Тот же счёт, что на сервере.
//
// Осознанный дубль — такой же, как trackMath.ts и video_tracks.py. Числа
// должны появляться, пока человек тянет провод мышью, а не после поездки на
// сервер; но собирать набор будет сервер, и разойтись им нельзя: человек
// увидел бы одно, а получил другое.
//
// Держатся вместе одним набором образцов: tests/fixtures/graphs/*.json читают
// и pytest (test_graph_plan.py), и vitest (counts.test.ts). Правя одну
// сторону, правь вторую — иначе тесты скажут об этом сразу.

import type { GraphDoc, GraphEdge, GraphNode, NodeKind } from "../../api/aug";

export const MAX_BRANCHES = 12;
export const MAX_INPUTS = 12;
export const MAX_TIMES = 64;

export class GraphError extends Error {}

const SOURCES: NodeKind[] = ["source", "input"];

function whole(node: GraphNode, key: string, dflt: number, low: number, high: number) {
  const raw = (node.params ?? {})[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return dflt;
  return Math.max(low, Math.min(high, Math.round(value)));
}

export const branches = (n: GraphNode) => whole(n, "branches", 2, 2, MAX_BRANCHES);
export const inputsCount = (n: GraphNode) => whole(n, "inputs", 2, 2, MAX_INPUTS);
export const times = (n: GraphNode) => whole(n, "times", 2, 1, MAX_TIMES);

/** Доли или веса разделителя, приведённые к числу веток. */
export function weights(node: GraphNode): number[] {
  const n = branches(node);
  const params = node.params ?? {};
  const raw = (params.shares ?? params.weights) as unknown[] | undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const value = Number(raw?.[i]);
    out.push(Number.isFinite(value) && value > 0 ? value : Number.isFinite(value) ? 0 : 1);
  }
  const total = out.reduce((a, b) => a + b, 0);
  return total > 0 ? out : new Array(n).fill(1);
}

export function ports(
  node: GraphNode,
  groupPorts?: { in: string[]; out: string[] }
): [string[], string[]] {
  switch (node.type) {
    case "source":
    case "input":
      return [[], ["out"]];
    case "output":
      return [["in"], []];
    case "aug":
    case "flow":
    case "multiply":
      return [["in"], ["out"]];
    case "split_share":
    case "split_prob": {
      const n = branches(node);
      return [["in"], Array.from({ length: n }, (_, i) => `o${i}`)];
    }
    case "merge":
    case "order": {
      const n = inputsCount(node);
      return [Array.from({ length: n }, (_, i) => `i${i}`), ["out"]];
    }
    case "group":
      return [groupPorts?.in ?? ["in"], groupPorts?.out ?? ["out"]];
    default:
      throw new GraphError(`Неизвестный узел: ${node.type}`);
  }
}

export const edgeKey = (e: GraphEdge) => `${e.from}:${e.out}->${e.to}:${e.in}`;

export function title(node: GraphNode): string {
  const label = (node.params ?? {}).label ?? (node.params ?? {}).op;
  return label ? `«${label}»` : `узел ${node.id}`;
}

/** Кольцо в графе, если оно есть, — списком номеров узлов. */
export function findCycle(nodes: GraphNode[], edges: GraphEdge[]): string[] | null {
  const outgoing = new Map<string, string[]>();
  edges.forEach((e) => {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to]);
  });
  const colour = new Map<string, number>();
  nodes.forEach((n) => colour.set(n.id, 0));
  const path: string[] = [];

  const walk = (id: string): string[] | null => {
    colour.set(id, 1);
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      if (colour.get(next) === 1) return [...path.slice(path.indexOf(next)), next];
      if (colour.get(next) === 0) {
        const found = walk(next);
        if (found) return found;
      }
    }
    path.pop();
    colour.set(id, 2);
    return null;
  };

  for (const node of nodes) {
    if (colour.get(node.id) === 0) {
      const found = walk(node.id);
      if (found) return found;
    }
  }
  return null;
}

export function topo(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  nodes.forEach((n) => {
    incoming.set(n.id, 0);
    outgoing.set(n.id, []);
  });
  edges.forEach((e) => {
    outgoing.get(e.from)?.push(e.to);
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  });

  // Порядок среди равных — по номеру узла: план обязан быть одинаковым от
  // запуска к запуску, иначе «пересобрать так же» перестаёт работать.
  const ready = [...incoming.entries()]
    .filter(([, c]) => c === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift() as string;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
    ready.sort();
  }
  if (order.length !== nodes.length) {
    const cycle = findCycle(nodes, edges) ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const names = cycle.map((id) => title(byId.get(id) as GraphNode)).join(" → ");
    throw new GraphError(`Провода образуют кольцо: ${names}.`);
  }
  return order;
}

export interface Counts {
  edges: Record<string, number>;
  outputs: number;
  dropped: number;
  multiplier: number;
  nodes: number;
}

/**
 * Числа на проводах.
 *
 * Дробные нарочно: у вероятностного разделителя 1000 × 0,3 — это ожидание, а
 * не обещание, и редактор пишет «≈ 300». Округлять здесь значило бы врать
 * точностью, которой нет.
 *
 * Блоки (`group`) этот счёт не разворачивает: их содержимое лежит на сервере.
 * Для них берётся множитель из паспорта версии, а если его нет — единица, и
 * редактор помечает такой провод как приблизительный.
 */
export function counts(
  doc: GraphDoc,
  base = 1,
  groupInfo?: Record<string, { ports?: { in: string[]; out: string[] }; multiplier?: number }>
): Counts {
  const nodes = doc.nodes ?? [];
  const edges = doc.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = topo(nodes, edges);

  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  edges.forEach((e) => {
    const o = `${e.from}:${e.out}`;
    const i = `${e.to}:${e.in}`;
    outEdges.set(o, [...(outEdges.get(o) ?? []), e]);
    inEdges.set(i, [...(inEdges.get(i) ?? []), e]);
  });

  const perEdge: Record<string, number> = {};
  let outputs = 0;

  const arriving = (node: GraphNode) => {
    const [ins] = ports(node, groupInfo?.[node.id]?.ports);
    let got = 0;
    ins.forEach((name) => {
      (inEdges.get(`${node.id}:${name}`) ?? []).forEach((e) => {
        got += perEdge[edgeKey(e)] ?? 0;
      });
    });
    return got;
  };

  for (const id of order) {
    const node = byId.get(id) as GraphNode;
    let produced: Record<string, number> = {};

    if (SOURCES.includes(node.type)) {
      produced = { out: base };
    } else if (node.type === "output") {
      outputs += arriving(node);
      continue;
    } else if (node.type === "multiply") {
      produced = { out: arriving(node) * times(node) };
    } else if (node.type === "split_share" || node.type === "split_prob") {
      const got = arriving(node);
      const w = weights(node);
      const total = w.reduce((a, b) => a + b, 0);
      w.forEach((weight, i) => {
        produced[`o${i}`] = (got * weight) / total;
      });
    } else if (node.type === "group") {
      const got = arriving(node);
      const mult = groupInfo?.[node.id]?.multiplier ?? 1;
      const [, outs] = ports(node, groupInfo?.[node.id]?.ports);
      outs.forEach((name) => {
        produced[name] = (got * mult) / Math.max(1, outs.length);
      });
    } else {
      produced = { out: arriving(node) };
    }

    Object.entries(produced).forEach(([port, value]) => {
      (outEdges.get(`${id}:${port}`) ?? []).forEach((e) => {
        perEdge[edgeKey(e)] = value;
      });
    });
  }

  // Образцы, ушедшие в гнездо, из которого не идёт ни одного провода: ветка
  // брошена осознанно, но потерянное надо назвать, а не потерять молча.
  let dropped = 0;
  nodes.forEach((node) => {
    if (node.type === "output") return;
    const [, outs] = ports(node, groupInfo?.[node.id]?.ports);
    const got = arriving(node);
    outs.forEach((port) => {
      if (outEdges.get(`${node.id}:${port}`)?.length) return;
      if (SOURCES.includes(node.type)) return;
      if (node.type === "multiply") dropped += got * times(node);
      else if (node.type === "split_share" || node.type === "split_prob") {
        const w = weights(node);
        const idx = Number(port.slice(1)) || 0;
        dropped += (got * w[idx]) / w.reduce((a, b) => a + b, 0);
      } else dropped += got;
    });
  });

  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    edges: Object.fromEntries(
      Object.entries(perEdge).map(([k, v]) => [k, round(v)])
    ),
    outputs: round(outputs),
    dropped: round(dropped),
    multiplier: base ? round(outputs / base) : 0,
    nodes: nodes.length,
  };
}
