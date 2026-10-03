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
export const MAX_GRID = 4;
export const FITS = ["letterbox", "stretch"] as const;
export type Fit = (typeof FITS)[number];

export class GraphError extends Error {}

const SOURCES: NodeKind[] = ["source", "input"];

// int() и float() питона: null и "" — не числа, дробь отбрасывается, а не округляется.
const FLOAT_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

function pyFloat(raw: unknown): number | null {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && FLOAT_TEXT.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function pyInt(raw: unknown): number | null {
  if (typeof raw === "string") return /^\s*[+-]?\d+\s*$/.test(raw) ? parseInt(raw, 10) : null;
  const value = pyFloat(raw);
  return value === null ? null : Math.trunc(value);
}

/** Список из `a or b or []` питона: пустой список там ложен. */
function listOf(...raws: unknown[]): unknown[] {
  const hit = raws.find((r) => (Array.isArray(r) ? r.length > 0 : !!r));
  return Array.isArray(hit) ? hit : [];
}

function whole(node: GraphNode, key: string, dflt: number, low: number, high: number) {
  const value = pyInt((node.params ?? {})[key]);
  if (value === null) return dflt;
  return Math.max(low, Math.min(high, value));
}

export const branches = (n: GraphNode) => whole(n, "branches", 2, 2, MAX_BRANCHES);
export const inputsCount = (n: GraphNode) => whole(n, "inputs", 2, 2, MAX_INPUTS);
export const times = (n: GraphNode) => whole(n, "times", 2, 1, MAX_TIMES);

/** Доли столбцов или строк сетки: n чисел, в сумме единица. Уже 5 % ячейка
 *  не бывает — её перегородку потом не поймать мышью. */
function shares(raw: unknown, n: number): number[] {
  const list = listOf(raw);
  const out = Array.from({ length: n }, (_, i) => {
    const v = pyFloat(list[i]);
    return v === null ? 1 : Math.max(0.05, v);
  });
  const total = out.reduce((a, b) => a + b, 0);
  return out.map((v) => v / total);
}

/** Сетка «Слияния сеткой», приведённая к пределам — как schema.grid. */
export function grid(node: GraphNode) {
  const rows = whole(node, "rows", 2, 1, MAX_GRID);
  const cols = whole(node, "cols", 2, 1, MAX_GRID);
  const params = node.params ?? {};
  const rawFit = Array.isArray(params.fit) ? (params.fit as unknown[]) : [];
  return {
    rows,
    cols,
    colW: shares(params.col_w, cols),
    rowH: shares(params.row_h, rows),
    fit: Array.from({ length: rows * cols }, (_, i) =>
      FITS.includes(rawFit[i] as Fit) ? (rawFit[i] as Fit) : FITS[0]
    ),
    width: whole(node, "width", 1280, 64, 4096),
    height: whole(node, "height", 1280, 64, 4096),
  };
}

/** Доли или веса разделителя, приведённые к числу веток. */
export function weights(node: GraphNode): number[] {
  const n = branches(node);
  const params = node.params ?? {};
  const raw = listOf(params.shares, params.weights);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const value = pyFloat(raw[i]);
    out.push(value === null ? 1 : Math.max(0, value));
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
    case "mosaic": {
      const g = grid(node);
      return [Array.from({ length: g.rows * g.cols }, (_, i) => `i${i}`), ["out"]];
    }
    default:
      throw new GraphError(`Неизвестный узел: ${node.type}`);
  }
}

export const edgeKey = (e: GraphEdge) => `${e.from}:${e.out}->${e.to}:${e.in}`;

/** Множитель графа словами экрана: «×2,4». Один на редактор, библиотеку,
 *  проект и мастер — раньше половина писала «×2.4», половина «×2,4». */
export const mult = (m: number) =>
  `×${m.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`;

/** Цел ли провод после правки узла `node`: гнездо, к которому он приходит или
 *  из которого выходит, у узла ещё есть.
 *
 *  Число веток, входов и ячеек сетки — параметр узла. Уменьшили его — провод
 *  с исчезнувшего гнезда остался бы в документе: на холсте его не нарисовать
 *  (гнезда нет), убрать мышью нельзя, версия не сохраняется, счёт брошенного
 *  врёт. Снимаем такие провода вместе с правкой, а не отказываем в ней.
 *  Блоки не трогаем: их гнёзда знает только сервер. */
export function fitsPorts(node: GraphNode, e: GraphEdge): boolean {
  if (node.type === "group" || (e.from !== node.id && e.to !== node.id)) return true;
  const [ins, outs] = ports(node);
  return (e.from !== node.id || outs.includes(e.out)) && (e.to !== node.id || ins.includes(e.in));
}

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
  /** Сколько «Источников» у графа: по одному на каждый в мастере сборки
   *  спрашивают, что в него вливать. */
  source_count: number;
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
 *
 * `base` — что вливается в источники. Числом, когда спрашивает редактор: там
 * неизвестно, сколько кадров придёт, и каждому источнику дают одну и ту же
 * условную тысячу. Словарём `{ номер узла: кадров }`, когда счёт делают под
 * конкретную строку сборки.
 */
export function counts(
  doc: GraphDoc,
  base: number | Record<string, number> = 1,
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
  let totalIn = 0;
  const fed = typeof base === "number" ? null : base;

  // Сколько образцов на самом бедном входе: столько сеток и выйдет.
  const shortest = (node: GraphNode) => {
    const [ins] = ports(node);
    return ins.length
      ? Math.min(
          ...ins.map((name) =>
            (inEdges.get(`${node.id}:${name}`) ?? []).reduce(
              (a, e) => a + (perEdge[edgeKey(e)] ?? 0),
              0
            )
          )
        )
      : 0;
  };

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
      const got = fed ? fed[node.id] ?? 0 : (base as number);
      totalIn += got;
      produced = { out: got };
    } else if (node.type === "output") {
      outputs += arriving(node);
      continue;
    } else if (node.type === "multiply") {
      produced = { out: arriving(node) * times(node) };
    } else if (node.type === "mosaic") {
      produced = { out: shortest(node) };
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
      else if (node.type === "mosaic") dropped += shortest(node);
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
    // От того, что реально влили, а не от условной тысячи: у графа с двумя
    // источниками «×3 на тысячу» иначе означало бы то шесть тысяч, то три —
    // в зависимости от числа источников, а не от того, что граф делает.
    multiplier: totalIn ? round(outputs / totalIn) : 0,
    source_count: nodes.filter((n) => SOURCES.includes(n.type)).length,
    nodes: nodes.length,
  };
}
