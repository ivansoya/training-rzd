// Карточки узлов агента на холсте. Вид — тот же, что у графа аугментаций
// (.g-node из graph.css): это один редактор с другим набором узлов.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { TITLES, mergeInputs, nodeTitle } from "./agentDoc";

export interface AgentNodeData extends Record<string, unknown> {
  kind: "frame" | "net" | "text" | "merge" | "nms" | "filter" | "sam" | "output";
  params: Record<string, unknown>;
  /** Подпись сети: имя весов и паспорт. Считает редактор — у него полка. */
  caption?: string;
  why?: string;
  /** Сколько классов сети включено в агента. */
  badge?: string;
  /** Узел в таком виде версию не сохранит: нет весов, промтов или SAM 3. */
  bad?: boolean;
  /** Классы агента, что приходят к «Фильтру»: правила для прочих не в счёт. */
  incoming?: string[];
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
  /** Своё имя карточки; без него — имя узла с подписью. */
  title?: string;
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
      <div className="g-node-title">{title ?? nodeTitle(data.kind, data.params)}</div>
      {data.why && <div className="g-node-why">{data.why}</div>}
      {data.badge && <div className="g-node-mult">{data.badge}</div>}
      {children}
    </div>
  );
}

export { TITLES, mergeInputs };

const side = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);

function FilterNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  // Правило класса, которого на входе нет, ничего не режет — и в счёт не идёт.
  const rules = ((d.params.classes as { cls: string; on: boolean; conf: number }[] | undefined) ?? []).filter(
    (r) => (d.incoming ?? []).includes(r.cls) && (!r.on || r.conf > 0)
  ).length;
  const lo = side(d.params.min_side);
  const hi = side(d.params.max_side);
  const size = lo || hi ? `сторона ${lo ?? "0"}–${hi ?? "∞"} px` : null;
  const why = [rules ? `правил ${rules}` : null, size].filter(Boolean).join(", ") || "пропускает всё";
  return <Card data={{ ...d, why }} klass="k-light" ins={["in"]} outs={["out"]} />;
}

const decimal = (v: unknown, d: number) =>
  String(typeof v === "number" && Number.isFinite(v) ? v : d).replace(".", ",");

function NmsNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const why = `IoU ${decimal(d.params.iou, 0.6)}, ${d.params.agnostic ? "между классами" : "внутри класса"}`;
  return <Card data={{ ...d, why }} klass="k-light" ins={["in"]} outs={["out"]} />;
}

function SamNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const model = String(d.params.model ?? "sam2.1_hiera_small").replace("sam2.1_hiera_", "").replace("_plus", "+");
  return (
    <Card data={{ ...d, why: `SAM2.1 ${model} → полигон` }} klass="k-geometry" ins={["in"]} outs={["out"]} />
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
      title={d.params.label ? undefined : d.caption ? `Сеть — ${d.caption}` : "Сеть — выберите веса"}
      ins={["in"]}
      outs={["out"]}
    />
  );
}

// Подпись и значок считает редактор — ему известно, лежат ли веса SAM 3.
function TextNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  return <Card data={d} klass={`k-block${d.bad ? " bad" : ""}`} ins={["in"]} outs={["out"]} />;
}

function MergeNode({ data }: NodeProps) {
  const d = data as AgentNodeData;
  const n = mergeInputs(d.params);
  return (
    <Card
      data={{ ...d, why: `${n} ${n < 5 ? "входа" : "входов"}` }}
      klass="k-noise"
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
  text: TextNode,
  merge: MergeNode,
  nms: NmsNode,
  filter: FilterNode,
  sam: SamNode,
  output: OutputNode,
};
