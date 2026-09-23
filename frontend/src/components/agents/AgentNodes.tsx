// Карточки узлов агента на холсте. Вид — тот же, что у графа аугментаций
// (.g-node из graph.css): это один редактор с другим набором узлов.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";

export interface AgentNodeData extends Record<string, unknown> {
  kind: "frame" | "net" | "merge" | "filter" | "sam" | "output";
  params: Record<string, unknown>;
  /** Подпись сети: имя весов и паспорт. Считает редактор — у него полка. */
  caption?: string;
  why?: string;
  /** Сколько классов сети включено в агента. */
  badge?: string;
}

function Card({
  data,
  klass,
  title,
  ins,
  outs,
  children,
}: {
  data: AgentNodeData;
  klass: string;
  title: string;
  ins: string[];
  outs: string[];
  children?: ReactNode;
}) {
  const at = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;
  return (
    <div className={`g-node ${klass}`}>
      {ins.map((name, i) => (
        <Handle key={name} id={name} type="target" position={Position.Left} style={{ top: at(i, ins.length) }} />
      ))}
      {outs.map((name, i) => (
        <Handle key={name} id={name} type="source" position={Position.Right} style={{ top: at(i, outs.length) }} />
      ))}
      <div className="g-node-title">{title}</div>
      {data.why && <div className="g-node-why">{data.why}</div>}
      {data.badge && <div className="g-node-mult">{data.badge}</div>}
      {children}
    </div>
  );
}

export const mergeInputs = (params: Record<string, unknown>) =>
  Math.max(2, Math.min(8, Number(params.inputs ?? 2) || 2));

export const TITLES: Record<AgentNodeData["kind"], string> = {
  frame: "Кадр",
  net: "Сеть",
  merge: "Объединение",
  filter: "Фильтр",
  sam: "Уточнение SAM",
  output: "Выход",
};

const side = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);

function FilterNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const rules = ((d.params.classes as { on: boolean; conf: number }[] | undefined) ?? []).filter(
    (r) => !r.on || r.conf > 0
  ).length;
  const lo = side(d.params.min_side);
  const hi = side(d.params.max_side);
  const size = lo || hi ? `сторона ${lo ?? "0"}–${hi ?? "∞"} px` : null;
  const why = [rules ? `правил ${rules}` : null, size].filter(Boolean).join(", ") || "пропускает всё";
  return <Card data={{ ...d, why }} klass="k-light" title="Фильтр" ins={["in"]} outs={["out"]} />;
}

function SamNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const model = String(d.params.model ?? "sam2.1_hiera_small").replace("sam2.1_hiera_", "").replace("_plus", "+");
  return (
    <Card data={{ ...d, why: `SAM2.1 ${model} → полигон` }} klass="k-geometry" title="Уточнение SAM" ins={["in"]} outs={["out"]} />
  );
}

function FrameNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  return <Card data={{ ...d, why: "кадр таски" }} klass="k-source" title="Кадр" ins={[]} outs={["out"]} />;
}

function NetNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  return (
    <Card
      data={d}
      klass={`k-flow${d.params.weights ? "" : " bad"}`}
      title={d.caption ? `Сеть — ${d.caption}` : "Сеть — выберите веса"}
      ins={["in"]}
      outs={["out"]}
    />
  );
}

function MergeNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const n = mergeInputs(d.params);
  return (
    <Card
      data={{ ...d, why: `NMS, IoU ${String(d.params.iou ?? 0.55).replace(".", ",")}` }}
      klass="k-noise"
      title="Объединение"
      ins={Array.from({ length: n }, (_, i) => `i${i}`)}
      outs={["out"]}
    />
  );
}

function OutputNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  return <Card data={{ ...d, why: "в разметку" }} klass="k-output" title="Выход" ins={["in"]} outs={[]} />;
}

export const agentNodeTypes = {
  frame: FrameNode,
  net: NetNode,
  merge: MergeNode,
  filter: FilterNode,
  sam: SamNode,
  output: OutputNode,
};
