// Узлы и провода холста.
//
// Провод — это путь, по которому идут кадры, и его толщина растёт с их числом.
// Куда уходит основная масса, видно раньше, чем прочитаны цифры; а это
// единственное, что в графе надо видеть боковым зрением.

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  EdgeLabelRenderer,
  Handle,
  Position,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { getBezierPath } from "@xyflow/react";
import type { CatalogueNode, NodeKind } from "../../api/aug";
import { branches, grid, inputsCount, times, weights, type Fit } from "./counts";

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
  /** Правка параметров прямо с карточки (редактор сетки). Нет её — граф
   *  открыт только для чтения. */
  onParams?: (id: string, next: Record<string, unknown>) => void;
}

const GROUP_CLASS: Record<string, string> = {
  light: "k-light",
  noise: "k-noise",
  weather: "k-weather",
  geometry: "k-geometry",
};

/** Имя узла, как на карточке. Его же пишет превью — в списке узлов и в пути
 *  образца, — и разойтись с карточкой оно не должно. */
export function titleOf(d: NodeData): string {
  const p = d.params;
  const label = p.label as string | undefined;
  switch (d.kind) {
    case "source":
      return label || "Источник";
    case "input":
      return (p.name as string) || label || "Вход";
    case "output":
      return label || (p.name as string) || "Выход";
    case "aug":
      return d.catalogue?.name ?? (p.op as string) ?? "Аугментация";
    case "flow":
      return label || "Поток";
    case "multiply":
      return label || "Умножение";
    case "split_share":
      return label || "Разделитель потока";
    case "split_prob":
      return label || "Вероятностный";
    case "merge":
      return label || "Слияние";
    case "order":
      return label || "Порядок";
    case "group":
      return label || d.group?.name || "Блок";
    case "mosaic":
      return label || "Слияние сеткой";
  }
}

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
  children,
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
  children?: ReactNode;
}) {
  return (
    <div className={`g-node ${klass}${data.problem ? " bad" : ""}`}>
      <Ports ins={ins} outs={outs} />
      <div className="g-node-title">{title}</div>
      {why && <div className="g-node-why">{why}</div>}
      {badge && <div className="g-node-mult">{badge}</div>}
      {children}
      {total && <div className="g-node-total">{total}</div>}
      {/* Глаз есть у каждого узла: превью показывает, что выходит из
          любого, — даже «Слияние» отвечает на вопрос «что тут вперемешку». */}
      <button
        type="button"
        className={`g-eye${data.eye ? " on" : ""}`}
        title="Показать в превью"
        aria-pressed={Boolean(data.eye)}
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
      title={titleOf(d)}
      why="обучающая часть набора"
      total={d.total !== undefined ? ru(d.total) : undefined}
      ins={[]}
      outs={["out"]}
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
      title={titleOf(d)}
      why="гнездо блока"
      ins={[]}
      outs={["out"]}
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
      title={titleOf(d)}
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
      title={titleOf(d)}
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
      title={titleOf(d)}
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
      title={titleOf(d)}
      why="каждый кадр столько раз, своё зерно у копии"
      badge={`×${n}`}
      ins={["in"]}
      outs={["out"]}
    />
  );
}

function SplitNode(kind: "split_share" | "split_prob", why: string) {
  return function Split({ id, data }: NodeProps) {
    const d = data as NodeData;
    const node = { id, type: kind, params: d.params } as const;
    const w = weights(node);
    const total = w.reduce((a, b) => a + b, 0);
    const shares = w
      .map((v) => `${Math.round((v / total) * 100)}`)
      .join(" — ");
    return (
      <Card
        id={id}
        data={d}
        klass="k-flow"
        title={titleOf(d)}
        why={`${why} — ${shares}`}
        ins={["in"]}
        outs={Array.from({ length: branches(node) }, (_, i) => `o${i}`)}
      />
    );
  };
}

export const SplitShareNode = SplitNode(
  "split_share",
  "каждый кадр в одну ветку, по долям"
);
export const SplitProbNode = SplitNode(
  "split_prob",
  "каждый кадр в одну ветку, жребием"
);

function JoinNode(kind: "merge" | "order", why: string) {
  return function Join({ id, data }: NodeProps) {
    const d = data as NodeData;
    const node = { id, type: kind, params: d.params } as const;
    return (
      <Card
        id={id}
        data={d}
        klass="k-flow"
        title={titleOf(d)}
        why={why}
        ins={Array.from({ length: inputsCount(node) }, (_, i) => `i${i}`)}
        outs={["out"]}
      />
    );
  };
}

export const MergeNode = JoinNode("merge", "потоки вперемешку");
export const OrderNode = JoinNode("order", "сперва вся первая ветка, потом вторая");

export function GroupNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  return (
    <Card
      id={id}
      data={d}
      klass="k-block"
      title={titleOf(d)}
      why={
        d.group?.version
          ? `мой граф — версия ${d.group.version}`
          : "вложенный граф"
      }
      ins={d.group?.in ?? ["in"]}
      outs={d.group?.out ?? ["out"]}
    />
  );
}

// Ящик редактора сетки на карточке, в пикселях холста.
const GRID_BOX = 172;
const GRID_MAX_H = 150;

/** Редактор сетки прямо в карточке: перегородки тянутся, щелчок по ячейке
 *  переключает вписывание. Номер ячейки — номер входа сверху вниз. */
function GridEditor({ id, data }: { id: string; data: NodeData }) {
  const g = grid({ id, type: "mosaic", params: data.params });
  const box = useRef<HTMLDivElement>(null);
  const edit = data.onParams;
  const k = Math.min(GRID_BOX / g.width, GRID_MAX_H / g.height);
  const acc = (list: number[]) => list.reduce<number[]>((a, v) => [...a, a[a.length - 1] + v], [0]);
  const xs = acc(g.colW);
  const ys = acc(g.rowH);

  // Тянем перегородку: меняются доли двух соседних столбцов (строк), сумма
  // их остаётся прежней — остальные ячейки не шевелятся.
  const drag = (axis: "x" | "y", at: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!edit) return;
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const list = axis === "x" ? g.colW : g.rowH;
    const edges = axis === "x" ? xs : ys;
    const move = (ev: PointerEvent) => {
      const r = box.current!.getBoundingClientRect();
      const f = axis === "x" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      const lo = edges[at] + 0.05;
      const hi = edges[at + 2] - 0.05;
      const cut = Math.min(hi, Math.max(lo, f));
      const next = list.slice();
      next[at] = cut - edges[at];
      next[at + 1] = edges[at + 2] - cut;
      const rounded = next.map((v) => Math.round(v * 1000) / 1000);
      edit(id, axis === "x" ? { col_w: rounded } : { row_h: rounded });
    };
    const stop = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
  };

  const toggle = (i: number) => {
    if (!edit) return;
    const next: Fit[] = g.fit.slice();
    next[i] = next[i] === "letterbox" ? "stretch" : "letterbox";
    edit(id, { fit: next });
  };

  return (
    <div
      ref={box}
      className={`g-grid nodrag${edit ? "" : " locked"}`}
      style={{ width: g.width * k, height: g.height * k }}
    >
      {g.fit.map((fit, i) => {
        const r = Math.floor(i / g.cols);
        const c = i % g.cols;
        return (
          <button
            key={i}
            type="button"
            className={`g-grid-cell ${fit}`}
            style={{
              left: `${xs[c] * 100}%`,
              top: `${ys[r] * 100}%`,
              width: `${g.colW[c] * 100}%`,
              height: `${g.rowH[r] * 100}%`,
            }}
            disabled={!edit}
            title={`Вход ${i + 1}: ${fit === "letterbox" ? "с полями" : "растянуть"}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(i);
            }}
          >
            <b>{i + 1}</b>
            <span>{fit === "letterbox" ? "поля" : "тянуть"}</span>
          </button>
        );
      })}
      {xs.slice(1, -1).map((x, i) => (
        <div
          key={`x${i}`}
          className="g-grid-bar v"
          style={{ left: `${x * 100}%` }}
          onPointerDown={drag("x", i)}
        />
      ))}
      {ys.slice(1, -1).map((y, i) => (
        <div
          key={`y${i}`}
          className="g-grid-bar h"
          style={{ top: `${y * 100}%` }}
          onPointerDown={drag("y", i)}
        />
      ))}
    </div>
  );
}

export function MosaicNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const g = grid({ id, type: "mosaic", params: d.params });
  return (
    <Card
      id={id}
      data={d}
      klass="k-geometry g-node-wide"
      title={titleOf(d)}
      why={`${g.rows} × ${g.cols}, кадр ${g.width} × ${g.height}`}
      ins={Array.from({ length: g.rows * g.cols }, (_, i) => `i${i}`)}
      outs={["out"]}
    >
      <GridEditor id={id} data={d} />
    </Card>
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
  mosaic: MosaicNode,
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
