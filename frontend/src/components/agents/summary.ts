// Сводка агента в узле «Выход»: время и вызовы модели по узлам, классы агента на кадре превью.
// Вызовы считаются тем же счётом, что потолок на сервере (agentDoc.frameCalls).

import type { PreviewDet } from "../../api/agents";
import {
  SAM_DEFAULTS, SAM_MODELS, TEXT_IMGSZ, frameCalls, sam3Side, textHalf, textModel, tileSide, viewCount, type AgentClass,
} from "./agentDoc";
import type { AgentKind } from "./look";

export interface SummaryNode {
  id: string;
  kind: AgentKind;
  title: string;
  params: Record<string, unknown>;
  /** Веса «Сети»: имя и вход. */
  weights?: { name: string; imgsz: number | null };
}

export interface NodeStat {
  id: string;
  kind: AgentKind;
  title: string;
  /** Модель и вход, «—» у узлов без модели. */
  model: string;
  /** Видов кадра: целый и тайлы; у узлов без тайлинга — 1. */
  views: number | null;
  /** Вызовов модели на кадр превью; у «Уточнения SAM» — кадр кодируется раз, рамки отдельно. */
  calls: number | null;
  /** «Уточнение SAM»: рамок на входе. */
  boxes: number | null;
  ms?: number;
  out: number | null;
}

type Trace = Record<string, { in: PreviewDet[]; out: PreviewDet[]; ms?: number }>;

export function nodeStats(nodes: SummaryNode[], frame: { w: number; h: number } | null, trace: Trace | null,
  setSize: (id: string) => number | undefined): NodeStat[] {
  return nodes.filter((n) => n.kind !== "frame" && n.kind !== "output").map((n) => {
    const p = n.params;
    const searcher = n.kind === "net" || n.kind === "text";
    const side = tileSide(n.kind, p, n.weights?.imgsz);
    const v = searcher && frame ? viewCount(p, frame.w, frame.h, side) : null;
    const views = v ? v.whole + v.tiles : null;
    const t = trace?.[n.id];
    return {
      id: n.id, kind: n.kind, title: n.title, model: modelOf(n), views,
      calls: searcher && frame ? frameCalls(n.kind, p, frame.w, frame.h, side, setSize) : null,
      boxes: n.kind === "sam" && t ? t.in.length : null,
      ms: t?.ms, out: t ? t.out.length : null,
    };
  });
}

function modelOf(n: SummaryNode): string {
  const p = n.params;
  if (n.kind === "net") return n.weights ? `${n.weights.name} · ${num(p.imgsz) ?? n.weights.imgsz ?? 640}` : "веса не выбраны";
  if (n.kind === "text") {
    const m = textModel(p);
    return m === "sam3" ? `SAM 3 · ${sam3Side(p)}` : `YOLOE-26 ${m} · ${num(p.imgsz) ?? TEXT_IMGSZ}${textHalf(p) ? " · fp16" : ""}`;
  }
  if (n.kind === "sam") {
    const id = String(p.model ?? SAM_DEFAULTS.model);
    return SAM_MODELS.find(([v]) => v === id)?.[1] ?? id;
  }
  return "—";
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface ClassStat { cls: AgentClass; count: number; from: { node: string; title: string; labels: string[] }[] }

/** Классы агента: сколько рамок у «Выхода» на кадре превью и из каких узлов приходит каждый. */
export function classStats(classes: AgentClass[], out: PreviewDet[] | null, titleOf: (id: string) => string): ClassStat[] {
  return classes.filter((c) => c.sources.length).map((c) => {
    const from = new Map<string, string[]>();
    for (const s of c.sources) from.set(s.node, [...(from.get(s.node) ?? []), s.label]);
    return {
      cls: c,
      count: out ? out.filter((d) => d.cls === c.name).length : 0,
      from: [...from].map(([node, labels]) => ({ node, title: titleOf(node), labels })),
    };
  }).sort((a, b) => b.count - a.count || a.cls.name.localeCompare(b.cls.name));
}
