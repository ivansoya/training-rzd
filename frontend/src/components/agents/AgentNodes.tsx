// Карточки узлов агента на холсте — тот же вид, что у графа аугментаций (ge-node):
// род с иконкой и глазом, имя, строка параметров. Провода — общие (aug/GraphNodes).

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import { Icon, cx } from "../../ui";
import { mergeInputs, nodeTitle } from "./agentDoc";
import { iconOf, roleOf, toneOf, type AgentKind } from "./look";

export interface AgentNodeData extends Record<string, unknown> {
  kind: AgentKind;
  params: Record<string, unknown>;
  /** Имя весов у «Сети» без подписи — считает редактор, у него полка. */
  caption?: string;
  /** Строка под именем. */
  why?: string;
  /** Сколько классов сети или строк текста включено. */
  badge?: string;
  /** Узел в таком виде версию не сохранит: нет весов, строк или SAM 3. */
  bad?: boolean;
  /** Ни одного провода. */
  loose?: boolean;
  /** Закреплён в превью глазом. */
  eye?: boolean;
  onEye?: (id: string) => void;
}

/** Имя узла, как на карточке и в превью. */
export function agentTitle(d: AgentNodeData): string {
  if (d.kind === "net" && !d.params.label) return d.caption ? `Сеть — ${d.caption}` : "Сеть";
  return nodeTitle(d.kind, d.params);
}

/** Входные гнёзда — как agent_graph.ports. */
const insOf = (d: AgentNodeData) =>
  d.kind === "frame" ? [] : d.kind === "merge" ? Array.from({ length: mergeInputs(d.params) }, (_, i) => `i${i}`) : ["in"];

function AgentCard({ id, data, selected }: NodeProps) {
  const d = data as AgentNodeData;
  const ins = insOf(d);
  const outs = d.kind === "output" ? [] : ["out"];
  const at = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;
  return (
    <div className={cx("ge-node", selected && "sel", d.loose && "loose", d.bad && "bad")}
      style={{ "--gc": toneOf(d.kind) } as CSSProperties}>
      {ins.map((name, i) => (
        <Handle key={`in-${name}`} id={name} type="target" position={Position.Left} style={{ top: at(i, ins.length) }} />
      ))}
      {outs.map((name, i) => (
        <Handle key={`out-${name}`} id={name} type="source" position={Position.Right} style={{ top: at(i, outs.length) }} />
      ))}
      <span className="ge-node-k">
        <Icon name={iconOf(d.kind)} size={13} />
        <span>{roleOf(d.kind)}</span>
        {d.badge && <span className="ae-badge">{d.badge}</span>}
        <button type="button" className={cx("ge-eye nodrag", d.eye && "on")} title={d.eye ? "Открепить превью" : "Закрепить в превью"}
          aria-label={d.eye ? "Открепить превью" : "Закрепить в превью"} aria-pressed={Boolean(d.eye)}
          onClick={(e) => { e.stopPropagation(); d.onEye?.(id); }}>
          <Icon name="eye" size={13} />
        </button>
      </span>
      <b className="ge-node-t">{agentTitle(d)}</b>
      {d.why && <small className="ge-node-p">{d.why}</small>}
    </div>
  );
}

export const agentNodeTypes = {
  frame: AgentCard, net: AgentCard, text: AgentCard, merge: AgentCard,
  nms: AgentCard, filter: AgentCard, sam: AgentCard, output: AgentCard,
};
