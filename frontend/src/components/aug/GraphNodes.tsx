// Узлы и провода холста.
//
// Провод — это путь, по которому идут кадры, и его толщина растёт с их числом.
// Куда уходит основная масса, видно раньше, чем прочитаны цифры; а это
// единственное, что в графе надо видеть боковым зрением.

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  EdgeLabelRenderer,
  Handle,
  Position,
  getBezierPath,
  type ConnectionLineComponentProps,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import type { CatalogueNode, NodeKind } from "../../api/aug";
import { Icon, cx } from "../../ui";
import { branches, grid, inputsCount, times, weights, type Fit } from "./counts";
import { kindOf, paramSummary, toneOf } from "./look";

/** Что редактор кладёт в провод: число на нём, подсветка и способ его убрать. */
export interface WireData extends Record<string, unknown> {
  amount?: number;
  /** Провод выбранного узла — светится. */
  hot?: boolean;
  /** Над проводом держат узел: отпустят — встанет в разрыв. */
  aim?: boolean;
  kill?: (id: string) => void;
  /** Своя подпись вместо числа: у агента «кадр» и честный ноль рамок. */
  text?: string;
}

export interface NodeData extends Record<string, unknown> {
  kind: NodeKind;
  params: Record<string, unknown>;
  catalogue?: CatalogueNode;
  group?: { in: string[]; out: string[]; name?: string; version?: number };
  /** Узел закреплён в превью глазом. */
  eye?: boolean;
  /** Сколько образцов выходит из узла (у «Выхода» — сколько приходит). */
  amount?: number;
  /** Ни одного провода — висит сам по себе. */
  loose?: boolean;
  problem?: string | null;
  onEye?: (id: string) => void;
  /** Правка параметров прямо с карточки (редактор сетки). Нет её — граф
   *  открыт только для чтения. */
  onParams?: (id: string, next: Record<string, unknown>) => void;
}

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
  Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ");

function Ports({ ins, outs }: { ins: string[]; outs: string[] }) {
  const at = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;
  return (
    <>
      {ins.map((name, i) => (
        <Handle key={`in-${name}`} id={name} type="target" position={Position.Left} style={{ top: at(i, ins.length) }} />
      ))}
      {outs.map((name, i) => (
        <Handle key={`out-${name}`} id={name} type="source" position={Position.Right} style={{ top: at(i, outs.length) }} />
      ))}
    </>
  );
}

function Card({ id, data, selected, sub, ins, outs, wide, children }: {
  id: string;
  data: NodeData;
  selected?: boolean;
  sub?: string;
  ins: string[];
  outs: string[];
  wide?: boolean;
  children?: ReactNode;
}) {
  const { icon, label } = kindOf(data.kind, data.catalogue);
  return (
    <div className={cx("ge-node", wide && "wide", selected && "sel", data.loose && "loose", data.problem && "bad")}
      style={{ "--gc": toneOf(data.kind, data.catalogue?.group) } as CSSProperties}>
      <Ports ins={ins} outs={outs} />
      <span className="ge-node-k">
        <Icon name={icon} size={13} />
        <span>{label}</span>
        {/* Глаз закрепляет узел в превью; без него превью идёт за выделением. Второе нажатие — открепить. */}
        <button type="button" className={cx("ge-eye nodrag", data.eye && "on")} title={data.eye ? "Открепить превью" : "Закрепить в превью"}
          aria-label={data.eye ? "Открепить превью" : "Закрепить в превью"} aria-pressed={Boolean(data.eye)}
          onClick={(e) => { e.stopPropagation(); data.onEye?.(id); }}>
          <Icon name="eye" size={13} />
        </button>
      </span>
      <b className="ge-node-t">{titleOf(data)}</b>
      {sub && <small className="ge-node-p">{sub}</small>}
      {children}
    </div>
  );
}

const flowText = (d: NodeData) => (d.amount !== undefined ? ru(d.amount) : undefined);

export function SourceNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const n = flowText(d);
  return <Card id={id} data={d} selected={selected} sub={n ? `${n} кадров · условно` : "обучающая часть набора"} ins={[]} outs={["out"]} />;
}

export function InputNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  return <Card id={id} data={d} selected={selected} sub="гнездо блока" ins={[]} outs={["out"]} />;
}

export function OutputNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const n = flowText(d);
  return <Card id={id} data={d} selected={selected} sub={n ? `в набор ${n}` : "в обучающий набор"} ins={["in"]} outs={[]} />;
}

export function AugNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  return <Card id={id} data={d} selected={selected} sub={paramSummary(d.catalogue, d.params) || undefined} ins={["in"]} outs={["out"]} />;
}

export function FlowNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const ops = (d.params.ops as { op: string }[] | undefined) ?? [];
  return (
    <Card id={id} data={d} selected={selected} ins={["in"]} outs={["out"]}
      sub={ops.length ? `${ops.length} ${ops.length === 1 ? "трансформ" : "трансформа"} подряд` : "пусто — кадры пройдут насквозь"} />
  );
}

export function MultiplyNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const n = times({ id, type: "multiply", params: d.params });
  return <Card id={id} data={d} selected={selected} sub={`×${n} · своё зерно у копии`} ins={["in"]} outs={["out"]} />;
}

function SplitNode(kind: "split_share" | "split_prob", how: string) {
  return function Split({ id, data, selected }: NodeProps) {
    const d = data as NodeData;
    const node = { id, type: kind, params: d.params } as const;
    const w = weights(node);
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const shares = w.map((v) => `${Math.round((v / total) * 100)}`).join(" — ");
    return (
      <Card id={id} data={d} selected={selected} sub={`${shares} · ${how}`} ins={["in"]}
        outs={Array.from({ length: branches(node) }, (_, i) => `o${i}`)} />
    );
  };
}

export const SplitShareNode = SplitNode("split_share", "по долям");
export const SplitProbNode = SplitNode("split_prob", "жребием");

function JoinNode(kind: "merge" | "order", how: string) {
  return function Join({ id, data, selected }: NodeProps) {
    const d = data as NodeData;
    const n = inputsCount({ id, type: kind, params: d.params });
    return (
      <Card id={id} data={d} selected={selected} sub={`${n} входа · ${how}`}
        ins={Array.from({ length: n }, (_, i) => `i${i}`)} outs={["out"]} />
    );
  };
}

export const MergeNode = JoinNode("merge", "вперемешку");
export const OrderNode = JoinNode("order", "ветка за веткой");

export function GroupNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  return (
    <Card id={id} data={d} selected={selected} sub={d.group?.version ? `мой граф · версия ${d.group.version}` : "вложенный граф"}
      ins={d.group?.in ?? ["in"]} outs={d.group?.out ?? ["out"]} />
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
      const cut = Math.min(edges[at + 2] - 0.05, Math.max(edges[at] + 0.05, f));
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
    <div ref={box} className={cx("ge-grid nodrag", !edit && "locked")} style={{ width: g.width * k, height: g.height * k }}>
      {g.fit.map((fit, i) => {
        const r = Math.floor(i / g.cols);
        const c = i % g.cols;
        return (
          <button key={i} type="button" className={cx("ge-grid-cell", fit)} disabled={!edit}
            style={{ left: `${xs[c] * 100}%`, top: `${ys[r] * 100}%`, width: `${g.colW[c] * 100}%`, height: `${g.rowH[r] * 100}%` }}
            title={`Вход ${i + 1}: ${fit === "letterbox" ? "с полями" : "растянуть"}`}
            onClick={(e) => { e.stopPropagation(); toggle(i); }}>
            <b>{i + 1}</b>
            <span>{fit === "letterbox" ? "поля" : "тянуть"}</span>
          </button>
        );
      })}
      {xs.slice(1, -1).map((x, i) => (
        <div key={`x${i}`} className="ge-grid-bar v" style={{ left: `${x * 100}%` }} onPointerDown={drag("x", i)} />
      ))}
      {ys.slice(1, -1).map((y, i) => (
        <div key={`y${i}`} className="ge-grid-bar h" style={{ top: `${y * 100}%` }} onPointerDown={drag("y", i)} />
      ))}
    </div>
  );
}

export function MosaicNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const g = grid({ id, type: "mosaic", params: d.params });
  return (
    <Card id={id} data={d} selected={selected} wide sub={`${g.rows} × ${g.cols}, кадр ${g.width} × ${g.height}`}
      ins={Array.from({ length: g.rows * g.cols }, (_, i) => `i${i}`)} outs={["out"]}>
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

// Гнездо ловит мышь кругом 22 px, а видна точка 10 px: провод начинается у точки, а не у края круга.
const PIN_INSET = 6;
const DOT_R = 5;
const inset = (x: number, pos: Position) => (pos === Position.Right ? x - PIN_INSET : pos === Position.Left ? x + PIN_INSET : x);

// Пока провод тянут, библиотека отдаёт центры гнёзд — сдвигаем к краю точки.
const dot = (x: number, pos: Position) => (pos === Position.Right ? x + DOT_R : pos === Position.Left ? x - DOT_R : x);

/** Провод, который тянут к гнезду, — от края точки, как и готовые провода. */
export function WireDraft({ fromX, fromY, toX, toY, fromPosition, toPosition, toHandle, connectionStatus }: ConnectionLineComponentProps) {
  const snapped = Boolean(toHandle) && connectionStatus === "valid";
  const [path] = getBezierPath({
    sourceX: dot(fromX, fromPosition), sourceY: fromY, sourcePosition: fromPosition,
    targetX: snapped ? dot(toX, toPosition) : toX, targetY: toY, targetPosition: toPosition,
  });
  return <path className="react-flow__connection-path" d={path} fill="none" />;
}

/**
 * Провод с числом на нём.
 *
 * Толщина — от объёма: логарифм, а не пропорция. Пропорция дала бы на потоке
 * из ста тысяч линию во весь экран, а разница между тысячей и тремя тысячами
 * пропала бы вовсе.
 */
export function VolumeEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: inset(sourceX, sourcePosition), sourceY, sourcePosition, targetX: inset(targetX, targetPosition), targetY, targetPosition,
  });
  const wire = data as WireData | undefined;
  const amount = Number(wire?.amount ?? 0);
  const kill = wire?.kill;
  const width = amount > 0 ? Math.min(6, 1.2 + Math.log10(amount + 1) * 0.85) : 1.4;

  return (
    <>
      {/* Невидимая жила поверх пути: в провод толщиной в полтора пикселя курсором не попасть. */}
      <path className="react-flow__edge-interaction" d={path} fill="none" stroke="transparent" strokeWidth={22} />
      <path id={id} className={cx("ge-wire", (selected || wire?.hot) && "hot", wire?.aim && "aim")} d={path}
        fill="none" strokeWidth={wire?.aim ? Math.max(width, 3) : width} strokeLinecap="round" />
      <EdgeLabelRenderer>
        <span className={cx("ge-wl", (selected || wire?.hot) && "hot")}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          {wire?.text ?? (amount > 0 ? ru(amount) : "—")}
        </span>
        {/* Крестик — кнопкой в слое подписей: в SVG он оказывался под ручками перецепки. */}
        {selected && kill && (
          <button type="button" className="ge-wire-kill nodrag nopan" title="Убрать провод" aria-label="Убрать провод"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 22}px)` }}
            onClick={(e) => { e.stopPropagation(); kill(id); }}>
            <Icon name="x" size={12} />
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { volume: VolumeEdge };
