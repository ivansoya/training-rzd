// Редактор агента разметки.
//
// Тот же механизм, что у графа аугментаций: настоящая копия сохраняется сама
// на каждой правке, версия — только по «Сохранить версию», и прогон в таске
// всегда идёт версией. Отличается набор узлов и правая колонка: у «Сети»
// классов бывает много, поэтому они в своём подокне с поиском, а вкладка
// «Классы агента» показывает, откуда пришёл каждый.
//
// Проверку формы делает сервер при сохранении версии (common/agent_graph.py) —
// второй проверяющий в браузере разошёлся бы с ним на первой правке.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import * as aug from "../../api/aug";
import * as api from "../../api/agents";
import type { GraphDoc, GraphEdge, GraphNode } from "../../api/aug";
import { edgeKey, findCycle } from "../aug/counts";
import Banner from "../Banner";
import Sep from "../Sep";
import { agentClasses, rowsOf, type NetRow } from "./agentDoc";
import { agentNodeTypes, mergeInputs, type AgentNodeData } from "./AgentNodes";
import WeightsPicker from "./WeightsPicker";

const DRAFT_WAIT_MS = 700;
let seq = 0;
const freshId = (kind: string) => `${kind}${++seq}${Date.now() % 1000}`;
const occupies = (e: Edge, c: { target?: string | null; targetHandle?: string | null }) =>
  e.target === c.target && (e.targetHandle ?? null) === (c.targetHandle ?? null);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function toFlow(doc: GraphDoc): [Node[], Edge[]] {
  return [
    doc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0 },
      deletable: (n.type as string) !== "frame" && n.type !== "output",
      data: { kind: n.type, params: n.params ?? {} } as AgentNodeData,
    })),
    doc.edges.map((e) => ({
      id: edgeKey(e),
      source: e.from,
      sourceHandle: e.out,
      target: e.to,
      targetHandle: e.in,
    })),
  ];
}

function toDoc(nodes: Node[], edges: Edge[]): GraphDoc {
  return {
    v: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.data as AgentNodeData).kind,
      params: (n.data as AgentNodeData).params,
      pos: [Math.round(n.position.x), Math.round(n.position.y)],
    })) as GraphNode[],
    edges: edges.map((e) => ({
      from: e.source,
      out: e.sourceHandle ?? "out",
      to: e.target,
      in: e.targetHandle ?? "in",
    })) as GraphEdge[],
  };
}

function Editor() {
  const { graphId } = useParams<{ graphId: string }>();
  const [search, setSearch] = useSearchParams();
  const wanted = search.get("version") ?? undefined;
  const [graph, setGraph] = useState<aug.GraphDetail | null>(null);
  const [title, setTitle] = useState("");
  const [versions, setVersions] = useState<aug.VersionRow[]>([]);
  const [shelf, setShelf] = useState<api.Weights[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"node" | "classes">("node");
  const [picking, setPicking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastSaved = useRef<string | null>(null);
  const pending = useRef<GraphDoc | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [changed, setChanged] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const readOnly = Boolean(wanted);
  const byWeights = useMemo(() => new Map(shelf.map((w) => [w.id, w])), [shelf]);
  const weightsOf = useCallback(
    (params: Record<string, unknown>) => byWeights.get(String(params.weights ?? "")),
    [byWeights]
  );

  useEffect(() => {
    api.listWeights().then((r) => setShelf(r.weights)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!graphId) return;
    let alive = true;
    lastSaved.current = null;
    (async () => {
      try {
        const got = await aug.getGraph(graphId, wanted);
        if (!alive) return;
        setGraph(got);
        setTitle(got.name);
        const [ns, es] = toFlow(got.doc);
        setNodes(ns);
        setEdges(es);
        lastSaved.current = JSON.stringify(toDoc(ns, es));
        setChanged(Boolean(got.changed) || got.version === 0);
        setSaveState("saved");
        setVersions((await aug.listVersions(graphId)).versions);
      } catch (e) {
        if (alive) setProblem((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [graphId, wanted, setNodes, setEdges]);

  const draft = useMemo(() => toDoc(nodes, edges), [nodes, edges]);

  // Автосохранение настоящей копии — как у графа аугментаций.
  useEffect(() => {
    if (!graphId || readOnly || lastSaved.current === null) return;
    const text = JSON.stringify(draft);
    if (text === lastSaved.current) return;
    pending.current = draft;
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const got = await aug.saveDraft(graphId, draft);
        lastSaved.current = text;
        pending.current = null;
        setChanged(got.changed);
        setSaveState("saved");
      } catch (e) {
        setSaveState((e as Error).message);
      }
    }, DRAFT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [draft, graphId, readOnly]);

  useEffect(() => {
    const flush = () => {
      const doc = pending.current;
      if (graphId && doc && JSON.stringify(doc) !== lastSaved.current) {
        pending.current = null;
        aug.saveDraft(graphId, doc, true).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [graphId]);

  const classes = useMemo(
    () =>
      agentClasses(draft.nodes, (id) => {
        const node = draft.nodes.find((n) => n.id === id);
        return node ? weightsOf(node.params ?? {})?.names ?? [] : [];
      }),
    [draft, weightsOf]
  );
  const colorOf = useMemo(() => new Map(classes.map((c) => [c.name, c])), [classes]);

  // Подписи карточек считаются здесь, а не хранятся в документе: имя весов
  // живёт на полке, и переименование файла не должно рождать правку графа.
  const shown = useMemo(
    () =>
      nodes.map((n) => {
        const d = n.data as AgentNodeData;
        if (d.kind !== "net") return n;
        const w = weightsOf(d.params);
        const rows = rowsOf({ params: d.params });
        return {
          ...n,
          data: {
            ...d,
            caption: w ? w.name.replace(/\.pt$/i, "") : undefined,
            why: w
              ? `${w.task}, ${num(d.params.imgsz, w.imgsz ?? 640)}, conf ${String(num(d.params.conf, 0.25)).replace(".", ",")}`
              : undefined,
            badge: w ? `${rows.filter((r) => r.on).length}/${w.names.length}` : undefined,
          },
        };
      }),
    [nodes, weightsOf]
  );

  const canConnect = useCallback(
    (conn: Connection | Edge) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return false;
      const doc = toDoc(nodes, [
        ...edges.filter((e) => !occupies(e, conn)),
        { id: "probe", source: conn.source, target: conn.target,
          sourceHandle: conn.sourceHandle ?? "out", targetHandle: conn.targetHandle ?? "in" } as Edge,
      ]);
      return !findCycle(doc.nodes, doc.edges);
    },
    [edges, nodes]
  );

  const onConnect = useCallback(
    (conn: Connection) =>
      setEdges((old) =>
        addEdge(
          {
            ...conn,
            id: edgeKey({
              from: conn.source ?? "",
              out: conn.sourceHandle ?? "out",
              to: conn.target ?? "",
              in: conn.targetHandle ?? "in",
            }),
          },
          old.filter((e) => !occupies(e, conn))
        )
      ),
    [setEdges]
  );

  const patchParams = useCallback(
    (id: string, next: Record<string, unknown>) =>
      setNodes((old) =>
        old.map((n) =>
          n.id === id
            ? { ...n, data: { ...(n.data as AgentNodeData), params: { ...(n.data as AgentNodeData).params, ...next } } }
            : n
        )
      ),
    [setNodes]
  );

  const addNode = useCallback(
    (kind: "net" | "merge", at?: { x: number; y: number }) => {
      const id = freshId(kind);
      const box = wrap.current?.getBoundingClientRect();
      const point =
        at ?? screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2, y: (box?.top ?? 0) + 160 });
      const params =
        kind === "net"
          ? { weights: null, classes: [], conf: 0.25, iou: 0.6 }
          : { inputs: 2, iou: 0.55 };
      setNodes((old) => [
        ...old.map((n) => ({ ...n, selected: false })),
        { id, type: kind, position: point, selected: true, data: { kind, params } as AgentNodeData },
      ]);
      setSelected(id);
      setTab("node");
    },
    [screenToFlowPosition, setNodes]
  );

  const removeNode = useCallback(
    (id: string) => {
      setNodes((old) => old.filter((n) => n.id !== id));
      setEdges((old) => old.filter((e) => e.source !== id && e.target !== id));
      setSelected(null);
    },
    [setNodes, setEdges]
  );

  const save = useCallback(async () => {
    if (!graphId) return;
    setBusy(true);
    setNote(null);
    setProblem(null);
    try {
      const got = await aug.saveVersion(graphId, toDoc(nodes, edges));
      setGraph(got);
      setChanged(false);
      setVersions((await aug.listVersions(graphId)).versions);
      setNote(got.fresh === false || got.version === graph?.version ? "Изменений нет — версия та же." : `Сохранено: версия ${got.version}.`);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [graphId, nodes, edges, graph?.version]);

  const rename = useCallback(async () => {
    const clean = title.trim();
    if (!graphId || !graph || !clean || clean === graph.name) {
      setTitle(graph?.name ?? "");
      return;
    }
    try {
      await aug.patchGraph(graphId, { name: clean });
      setGraph({ ...graph, name: clean });
    } catch (e) {
      setProblem((e as Error).message);
      setTitle(graph.name);
    }
  }, [graphId, graph, title]);

  const current = nodes.find((n) => n.id === selected) ?? null;
  const pickedFor = picking ? nodes.find((n) => n.id === picking) : null;

  return (
    <div className="g-ged ag-ged">
      <aside className="g-pal">
        <h4>Узлы</h4>
        {(
          [
            ["net", "Сеть", "k-flow"],
            ["merge", "Объединение", "k-noise"],
          ] as const
        ).map(([kind, label, klass]) => (
          <button
            key={kind}
            type="button"
            className={`g-pal-item ${klass}`}
            disabled={readOnly}
            draggable={!readOnly}
            onDragStart={(e) => e.dataTransfer.setData("application/mag-agent-node", kind)}
            onClick={() => addNode(kind)}
          >
            {label}
          </button>
        ))}
      </aside>

      <div className="g-canvas">
        <div className="g-canvas-top">
          <Link to="/agents" className="g-ctx-back" title="К агентам">←</Link>
          <input
            className="ttl"
            value={title}
            disabled={readOnly}
            aria-label="Имя агента"
            size={Math.max(8, title.length)}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setTitle(graph?.name ?? "");
            }}
          />
          <span className="ver">
            {graph?.version ? `версия ${graph.version} из ${versions.length}` : "версий нет"}
          </span>
          {!readOnly && changed && <span className="ver edits">правки вне версий</span>}
          {!readOnly && (
            <span className={`g-saved${saveState === "saved" || saveState === "saving" ? "" : " bad"}`} role="status">
              {saveState === "saved" ? "сохранено" : saveState === "saving" ? "сохраняю…" : `не сохранилось: ${saveState}`}
            </span>
          )}
          {readOnly && <span className="pill wait">старая версия — только чтение</span>}
          <div className="sp">
            <select
              value={wanted ?? ""}
              onChange={(e) => (e.target.value ? setSearch({ version: e.target.value }) : setSearch({}))}
              aria-label="Версия"
            >
              <option value="">настоящая</option>
              {versions.length > 0 && (
                <optgroup label="Версии">
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      версия {v.version}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button type="button" className="mag-btn" disabled={busy || readOnly} onClick={save}>
              Сохранить версию
            </button>
          </div>
        </div>

        {problem && <div className="mag-error">{problem}</div>}
        {note && <Banner onClose={() => setNote(null)}>{note}</Banner>}

        <div className="g-canvas-body" ref={wrap}>
          <ReactFlow
            className="g-graph"
            nodes={shown}
            edges={edges}
            nodeTypes={agentNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            edgesReconnectable={false}
            onConnect={readOnly ? undefined : onConnect}
            deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
            isValidConnection={canConnect}
            onSelectionChange={({ nodes: picked }) => {
              setSelected(picked[0]?.id ?? null);
              if (picked[0]) setTab("node");
            }}
            onDrop={(event) => {
              event.preventDefault();
              const kind = event.dataTransfer.getData("application/mag-agent-node");
              if ((kind === "net" || kind === "merge") && !readOnly)
                addNode(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
            minZoom={0.25}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#232629" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      <aside className="ag-side">
        <div className="ag-side-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "node"} onClick={() => setTab("node")}>
            Узел
          </button>
          <button type="button" role="tab" aria-selected={tab === "classes"} onClick={() => setTab("classes")}>
            Классы агента <span className="mono">{classes.length}</span>
          </button>
        </div>
        <div className="ag-side-body">
          {tab === "classes" ? (
            <AgentClassList classes={classes} />
          ) : (
            <NodePanel
              node={current}
              readOnly={readOnly}
              weights={current ? weightsOf((current.data as AgentNodeData).params) : undefined}
              colorOf={colorOf}
              onChange={(next) => current && patchParams(current.id, next)}
              onPickWeights={() => current && setPicking(current.id)}
              onRemove={() => current && removeNode(current.id)}
            />
          )}
        </div>
      </aside>

      {pickedFor && (
        <WeightsPicker
          current={String((pickedFor.data as AgentNodeData).params.weights ?? "")}
          onClose={() => setPicking(null)}
          onPick={(w) => {
            setShelf((old) => (old.some((x) => x.id === w.id) ? old : [w, ...old]));
            // Новые веса — новая таблица классов: номера прежней к ним не
            // относятся. Имя класса агента по умолчанию — имя из весов.
            patchParams(pickedFor.id, {
              weights: w.id,
              classes: w.names.map((name) => ({ agent: name, on: true })),
              imgsz: w.imgsz ?? undefined,
            });
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

function AgentClassList({ classes }: { classes: ReturnType<typeof agentClasses> }) {
  if (!classes.length) return <p className="ag-muted">Классов нет: выберите веса у «Сети» и включите классы.</p>;
  return (
    <div className="ag-cls">
      {classes.map((c) => (
        <div key={c.name} className="ag-ac">
          <i className="ag-dot" style={{ background: c.color }} />
          <span>{c.name}</span>
          {c.sources.length > 1 && <b className="ag-merge">×{c.sources.length}</b>}
          <span className="ag-src">
            {c.sources.map((s) => (
              <span key={`${s.node}:${s.index}`}>
                №{s.index} {s.weightsName}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function NodePanel({
  node,
  readOnly,
  weights,
  colorOf,
  onChange,
  onPickWeights,
  onRemove,
}: {
  node: Node | null;
  readOnly: boolean;
  weights?: api.Weights;
  colorOf: Map<string, { color: string; sources: unknown[] }>;
  onChange: (next: Record<string, unknown>) => void;
  onPickWeights: () => void;
  onRemove: () => void;
}) {
  if (!node) return <p className="ag-muted">Выберите узел на холсте.</p>;
  const d = node.data as AgentNodeData;
  const p = d.params;
  const field = (key: string, label: string, value: number, step: number) => (
    <div className="mag-field ag-num">
      <label htmlFor={`ag-${key}`}>{label}</label>
      <input
        id={`ag-${key}`}
        type="number"
        step={step}
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange({ [key]: e.target.value === "" ? undefined : Number(e.target.value) })}
      />
    </div>
  );

  return (
    <div className="ag-node">
      <div className="g-insp-name">
        {d.kind === "net" ? "Сеть" : d.kind === "merge" ? "Объединение" : d.kind === "frame" ? "Кадр" : "Выход"}
      </div>

      {d.kind === "net" && (
        <>
          <div className="ag-weights">
            {weights ? (
              <>
                <b className="mono">{weights.name}</b>
                <span>
                  {weights.task} <Sep /> imgsz {weights.imgsz ?? "—"} <Sep />{" "}
                  {weights.names.length} кл.
                </span>
                {weights.run && <span>из обучения «{weights.run.name}»</span>}
              </>
            ) : (
              <span className="ag-warn-text">Веса не выбраны</span>
            )}
          </div>
          {!readOnly && (
            <button type="button" className="mag-ghost ag-wide" onClick={onPickWeights}>
              {weights ? "Сменить веса" : "Выбрать веса"}
            </button>
          )}
          {weights && (
            <NetClasses
              names={weights.names}
              rows={rowsOf({ params: p })}
              readOnly={readOnly}
              colorOf={colorOf}
              onRows={(rows) => onChange({ classes: rows })}
            />
          )}
          <div className="ag-two">
            {field("conf", "Уверенность от", num(p.conf, 0.25), 0.05)}
            {field("iou", "IoU для NMS", num(p.iou, 0.6), 0.05)}
          </div>
          {field("imgsz", "Размер входа", num(p.imgsz, weights?.imgsz ?? 640), 32)}
        </>
      )}

      {d.kind === "merge" && (
        <>
          <div className="ag-two">
            {field("inputs", "Входов", mergeInputs(p), 1)}
            {field("iou", "IoU одного объекта", num(p.iou, 0.55), 0.05)}
          </div>
        </>
      )}

      {(d.kind === "frame" || d.kind === "output") && <p className="ag-muted">Параметров нет.</p>}

      {!readOnly && d.kind !== "frame" && d.kind !== "output" && (
        <button type="button" className="mag-ghost mag-danger ag-wide" onClick={onRemove}>
          Удалить узел
        </button>
      )}
    </div>
  );
}

/** Подокно классов сети: номер и имя из весов, класс агента правится в строке.
 *  Классов у сети бывает несколько десятков — поэтому поиск и фильтр, а не
 *  список галочек. */
function NetClasses({
  names,
  rows,
  readOnly,
  colorOf,
  onRows,
}: {
  names: string[];
  rows: NetRow[];
  readOnly: boolean;
  colorOf: Map<string, { color: string; sources: unknown[] }>;
  onRows: (rows: NetRow[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const table: NetRow[] = names.map((n, i) => rows[i] ?? { agent: n, on: false });
  const set = (i: number, patch: Partial<NetRow>) =>
    onRows(table.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const q = query.trim().toLowerCase();
  const visible = table
    .map((r, i) => ({ ...r, i, name: names[i] }))
    .filter((r) => filter === "all" || (filter === "on" ? r.on : !r.on))
    .filter((r) => !q || `${r.name} ${r.agent}`.toLowerCase().includes(q));

  return (
    <div className="ag-cls ag-net-cls">
      <div className="ag-cls-h">
        <div className="ag-cls-title">
          <b>Классы сети</b>
          <span className="mono">
            {names.length} <Sep /> в агент {table.filter((r) => r.on).length}
          </span>
        </div>
        <input className="ag-search" placeholder="Поиск по имени" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="ag-pills">
          {(
            [
              ["all", "Все"],
              ["on", "Включены"],
              ["off", "Выключены"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
          <span className="ag-grow" />
          {!readOnly && (
            <>
              <button type="button" title="Включить все" onClick={() => onRows(table.map((r) => ({ ...r, on: true })))}>
                + все
              </button>
              <button type="button" title="Выключить все" onClick={() => onRows(table.map((r) => ({ ...r, on: false })))}>
                − все
              </button>
            </>
          )}
        </div>
      </div>
      <div className="ag-cr ag-cr-head">
        <span />
        <span>№</span>
        <span>в весах</span>
        <span>класс агента</span>
      </div>
      <div className="ag-cls-body">
        {visible.length === 0 && <p className="ag-muted">Ничего не найдено.</p>}
        {visible.map((r) => {
          const c = r.on ? colorOf.get(r.agent.trim()) : undefined;
          return (
            <div key={r.i} className={`ag-cr${r.on ? "" : " off"}`}>
              <input
                type="checkbox"
                checked={r.on}
                disabled={readOnly}
                aria-label={r.name}
                onChange={(e) => set(r.i, { on: e.target.checked })}
              />
              <span className="mono ag-id">{r.i}</span>
              <span className="mono ag-wn" title={r.name}>
                {r.name}
              </span>
              <span className="ag-an">
                <i className="ag-dot" style={{ background: c?.color ?? "var(--hair)" }} />
                <input
                  value={r.agent}
                  disabled={readOnly}
                  aria-label={`Класс агента для ${r.name}`}
                  onChange={(e) => set(r.i, { agent: e.target.value })}
                  onBlur={(e) => !e.target.value.trim() && set(r.i, { agent: r.name })}
                />
                {c && c.sources.length > 1 && (
                  <b className="ag-merge" title="В этот класс агента сходятся несколько классов сетей">
                    ×{c.sources.length}
                  </b>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AgentEditor() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
