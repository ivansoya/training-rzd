// Узлы и провода холста.
//
// Провод — это путь, по которому идут кадры, и его толщина растёт с их числом.
// Куда уходит основная масса, видно раньше, чем прочитаны цифры; а это
// единственное, что в графе надо видеть боковым зрением.

import {
  EdgeLabelRenderer,
  Handle,
  Position,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { getBezierPath } from "@xyflow/react";
import type { CatalogueNode, NodeKind } from "../../api/aug";
import { branches, inputsCount, times, weights } from "./counts";

/** Что редактор кладёт в провод: число на нём и способ его убрать. */
export interface WireData extends Record<string, unknown> {
  amount?: number;
  kill?: (id: string) => void;
}

export interface NodeData extends Record<string, unknown> {
  kind: NodeKind;
  params: Record<string, unknown>;
  catalogue?: CatalogueNode;
  group?: { in: string[]; out: string[]; name?: string; version?: number };
  eye?: boolean;
  total?: number;          // сколько выходит из этого узла
  problem?: string | null;
  onEye?: (id: string) => void;
}

const GROUP_CLASS: Record<string, string> = {
  light: "k-light",
  noise: "k-noise",
  weather: "k-weather",
  geometry: "k-geometry",
};

export const ru = (n: number) =>
  Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");

function Ports({
  ins,
  outs,
}: {
  ins: string[];
  outs: string[];
}) {
  const at = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;
  return (
    <>
      {ins.map((name, i) => (
        <Handle
          key={`in-${name}`}
          id={name}
          type="target"
          position={Position.Left}
          style={{ top: at(i, ins.length) }}
        />
      ))}
      {outs.map((name, i) => (
        <Handle
          key={`out-${name}`}
          id={name}
          type="source"
          position={Position.Right}
          style={{ top: at(i, outs.length) }}
        />
      ))}
    </>
  );
}

function Card({
  id,
  data,
  klass,
  title,
  why,
  badge,
  total,
  ins,
  outs,
  eye = true,
}: {
  id: string;
  data: NodeData;
  klass: string;
  title: string;
  why?: string;
  badge?: string;
  total?: string;
  ins: string[];
  outs: string[];
  eye?: boolean;
}) {
  return (
    <div className={`g-node ${klass}${data.problem ? " bad" : ""}`}>
      <Ports ins={ins} outs={outs} />
      <div className="g-node-title">{title}</div>
      {why && <div className="g-node-why">{why}</div>}
      {badge && <div className="g-node-mult">{badge}</div>}
      {total && <div className="g-node-total">{total}</div>}
      {eye && (
        <button
          type="button"
          className={`g-eye${data.eye ? " on" : ""}`}
          title="Посмотреть, что вышло здесь"
          onClick={(e) => {
            e.stopPropagation();
            data.onEye?.(id);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <circle cx="7" cy="7" r="1.6" fill="currentColor" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function SourceNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  return (
    <Card
      id={id}
      data={d}
      klass="k-source"
      title={(d.params.label as string) || "Источник"}
      why="обучающая часть набора"
      total={d.total !== undefined ? ru(d.total) : undefined}
      ins={[]}
      outs={["out"]}
      eye={false}
    />
  );
}

export function InputNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  return (
    <Card
      id={id}
      data={d}
      klass="k-source"
      title={(d.params.name as string) || (d.params.label as string) || "Вход"}
      why="гнездо блока"
      ins={[]}
      outs={["out"]}
      eye={false}
    />
  );
}

export function OutputNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  return (
    <Card
      id={id}
      data={d}
      klass="k-output"
      title={(d.params.label as string) || (d.params.name as string) || "Выход"}
      why="в обучающий набор"
      total={d.total !== undefined ? ru(d.total) : undefined}
      ins={["in"]}
      outs={[]}
    />
  );
}

export function AugNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const cat = d.catalogue;
  const chance = Number(d.params.chance ?? 1);
  return (
    <Card
      id={id}
      data={d}
      klass={GROUP_CLASS[cat?.group ?? ""] ?? "k-flow"}
      title={cat?.name ?? (d.params.op as string) ?? "Аугментация"}
      why={cat?.why?.split(".")[0] ?? undefined}
      badge={chance < 1 ? `p ${chance.toFixed(2).replace(".", ",")}` : undefined}
      ins={["in"]}
      outs={["out"]}
    />
  );
}

export function FlowNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const ops = (d.params.ops as { op: string }[] | undefined) ?? [];
  return (
    <Card
      id={id}
      data={d}
      klass="k-flow"
      title={(d.params.label as string) || "Поток"}
      why={
        ops.length
          ? `${ops.length} ${ops.length === 1 ? "трансформ" : "трансформа"} подряд`
          : "пусто — кадры пройдут насквозь"
      }
      ins={["in"]}
      outs={["out"]}
    />
  );
}

export function MultiplyNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const n = times({ id, type: "multiply", params: d.params });
  return (
    <Card
      id={id}
      data={d}
      klass="k-flow"
      title={(d.params.label as string) || "Умножение"}
      why="каждый кадр столько раз, своё зерно у копии"
      badge={`×${n}`}
      ins={["in"]}
      outs={["out"]}
      eye={false}
    />
  );
}

function SplitNode(kind: "split_share" | "split_prob", label: string, why: string) {
  return function Split({ id, data }: NodeProps) {
    const d = data as NodeData;
    const node = { id, type: kind, params: d.params } as const;
    const w = weights(node);
    const total = w.reduce((a, b) => a + b, 0);
    const shares = w
      .map((v) => `${Math.round((v / total) * 100)}`)
      .join(" · ");
    return (
      <Card
        id={id}
        data={d}
        klass="k-flow"
        title={(d.params.label as string) || label}
        why={`${why} · ${shares}`}
        ins={["in"]}
        outs={Array.from({ length: branches(node) }, (_, i) => `o${i}`)}
        eye={false}
      />
    );
  };
}

export const SplitShareNode = SplitNode(
  "split_share",
  "Разделитель потока",
  "каждый кадр в одну ветку, по долям"
);
export const SplitProbNode = SplitNode(
  "split_prob",
  "Вероятностный",
  "каждый кадр в одну ветку, жребием"
);

function JoinNode(kind: "merge" | "order", label: string, why: string) {
  return function Join({ id, data }: NodeProps) {
    const d = data as NodeData;
    const node = { id, type: kind, params: d.params } as const;
    return (
      <Card
        id={id}
        data={d}
        klass="k-flow"
        title={(d.params.label as string) || label}
        why={why}
        ins={Array.from({ length: inputsCount(node) }, (_, i) => `i${i}`)}
        outs={["out"]}
        eye={false}
      />
    );
  };
}

export const MergeNode = JoinNode("merge", "Слияние", "потоки вперемешку");
export const OrderNode = JoinNode(
  "order",
  "Порядок",
  "сперва вся первая ветка, потом вторая"
);

export function GroupNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  return (
    <Card
      id={id}
      data={d}
      klass="k-block"
      title={(d.params.label as string) || d.group?.name || "Блок"}
      why={
        d.group?.version
          ? `мой граф · версия ${d.group.version}`
          : "вложенный граф"
      }
      ins={d.group?.in ?? ["in"]}
      outs={d.group?.out ?? ["out"]}
    />
  );
}

export const nodeTypes = {
  source: SourceNode,
  input: InputNode,
  output: OutputNode,
  aug: AugNode,
  flow: FlowNode,
  multiply: MultiplyNode,
  split_share: SplitShareNode,
  split_prob: SplitProbNode,
  merge: MergeNode,
  order: OrderNode,
  group: GroupNode,
};

/**
 * Провод с числом на нём.
 *
 * Толщина — от объёма: логарифм, а не пропорция. Пропорция дала бы на потоке
 * из ста тысяч линию во весь экран, а разница между тысячей и тремя тысячами
 * пропала бы вовсе.
 */
export function VolumeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const wire = data as WireData | undefined;
  const amount = Number(wire?.amount ?? 0);
  const kill = wire?.kill;
  const width = amount > 0 ? Math.min(6, 1.2 + Math.log10(amount + 1) * 0.85) : 1.4;
  const text = amount > 0 ? ru(amount) : "—";
  const half = Math.max(20, text.length * 6 + 12);

  return (
    <>
      {/* Невидимая жила поверх пути. В провод толщиной в полтора пикселя
          курсором не попасть, а рисовать провода толще — врать о потоке:
          толщина здесь значит объём. Поэтому область попадания шире вида. */}
      <path
        className="react-flow__edge-interaction"
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
      />
      <path
        id={id}
        className="g-wire"
        d={path}
        fill="none"
        stroke={selected ? "var(--red)" : "#4a5157"}
        strokeWidth={width}
        strokeLinecap="round"
      />
      <rect
        className="g-wire-plate"
        x={labelX - half / 2}
        y={labelY - 9}
        width={half}
        height={18}
        rx={3}
      />
      <text className="g-wire-text" x={labelX} y={labelY + 1}>
        {text}
      </text>
      {/* Крестик — обычной кнопкой в слое подписей, а не фигурой внутри
          провода: поверх провода библиотека кладёт свои круглые ручки
          перецепки, и нарисованный в SVG крестик оказывался под ними —
          щелчок доставался ручке. */}
      {selected && kill && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="g-wire-kill nodrag nopan"
            style={{
              // Над табличкой с числом, а не сбоку от неё: сбоку крестик
              // упирался в гнездо соседнего узла, когда провод короткий.
              transform: `translate(-50%, -50%) translate(${labelX}px, ${
                labelY - 20
              }px)`,
            }}
            title="Убрать провод"
            onClick={(e) => {
              e.stopPropagation();
              kill(id);
            }}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { volume: VolumeEdge };
