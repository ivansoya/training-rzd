// Сверка находок узла с ручной разметкой кадра превью — честная: сверяются только классы,
// которые узел физически может выдать. Ручные рамки прочих классов не считаются пропусками
// и не рисуются на кадре.

import type { HumanShape, PreviewDet } from "../../api/agents";
import { shapeBox } from "./examplePick";

/** Порог совпадения рамок — как mAP50 у обучения. */
export const MATCH_IOU = 0.5;

type Box = [number, number, number, number];
interface GraphNode { id: string; type: string; params?: Record<string, unknown> }

/** Классы агента (id), что могут дойти до выхода узла: свои у узлов поиска и всё, что приходит
 *  сверху, минус выключенное «Фильтром» по пути. `own` — классы, что узел ищет сам. */
export function reachable(id: string, nodes: GraphNode[], edges: { from: string; to: string }[],
  own: (node: string) => string[]): Set<string> {
  const memo = new Map<string, Set<string>>();
  const walk = (cur: string, path: Set<string>): Set<string> => {
    if (memo.has(cur)) return memo.get(cur)!;
    if (path.has(cur)) return new Set();
    const node = nodes.find((n) => n.id === cur);
    const got = new Set(own(cur));
    const next = new Set(path).add(cur);
    for (const e of edges) if (e.to === cur) for (const c of walk(e.from, next)) got.add(c);
    if (node?.type === "filter") {
      const rows = (node.params?.classes as { cls: string; on: boolean }[] | undefined) ?? [];
      for (const r of rows) if (!r.on) got.delete(r.cls);
    }
    memo.set(cur, got);
    return got;
  };
  return walk(id, new Set());
}

export interface Miss { cls: string; box: Box; shape: HumanShape }

export interface Verdict {
  /** Находка совпала с ручной рамкой своего класса. */
  hit: { det: PreviewDet; human: Miss }[];
  /** Ложная: ручной рамки своего класса под ней нет. */
  wrong: PreviewDet[];
  /** Ручная рамка искомого класса, которую узел не нашёл. */
  missed: Miss[];
  /** Ручная разметка классов, которые узел не ищет: в сверку не идёт. По имени класса проекта. */
  skipped: { cls: string; count: number }[];
  /** По классам агента: верно, ложных, пропущено. */
  byClass: { cls: string; hit: number; wrong: number; missed: number }[];
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Сверить выход узла с ручной разметкой. `agentOf` — класс агента (имя) для класса проекта,
 *  null — у агента такого нет; `canFind` — имена классов агента, что узел может выдать. */
export function judge(out: PreviewDet[], human: HumanShape[], agentOf: (projectCls: string) => string | null,
  canFind: Set<string>, threshold = MATCH_IOU): Verdict {
  const skipped = new Map<string, number>();
  const truth: Miss[] = [];
  for (const shape of human) {
    const box = shapeBox(shape.geometry);
    const cls = agentOf(shape.cls);
    if (!box) continue;
    if (!cls || !canFind.has(cls)) skipped.set(shape.cls, (skipped.get(shape.cls) ?? 0) + 1);
    else truth.push({ cls, box, shape });
  }
  const used = new Set<Miss>();
  const hit: Verdict["hit"] = [];
  const wrong: PreviewDet[] = [];
  // Уверенные — первыми: так считает и mAP.
  for (const det of [...out].sort((a, b) => b.conf - a.conf)) {
    let best: Miss | null = null;
    let bestIou = threshold;
    for (const t of truth) {
      if (t.cls !== det.cls || used.has(t)) continue;
      const v = iou(det.box, t.box);
      if (v >= bestIou) { best = t; bestIou = v; }
    }
    if (best) { used.add(best); hit.push({ det, human: best }); } else wrong.push(det);
  }
  const missed = truth.filter((t) => !used.has(t));
  const by = new Map<string, { cls: string; hit: number; wrong: number; missed: number }>();
  const row = (cls: string) => by.get(cls) ?? by.set(cls, { cls, hit: 0, wrong: 0, missed: 0 }).get(cls)!;
  hit.forEach((h) => row(h.det.cls).hit++);
  wrong.forEach((d) => row(d.cls).wrong++);
  missed.forEach((m) => row(m.cls).missed++);
  return {
    hit, wrong, missed,
    skipped: [...skipped].map(([cls, count]) => ({ cls, count })).sort((a, b) => b.count - a.count),
    byClass: [...by.values()].sort((a, b) => (b.hit + b.wrong + b.missed) - (a.hit + a.wrong + a.missed) || a.cls.localeCompare(b.cls)),
  };
}
