// Редактор агента разметки.
//
// Тот же механизм, что у графа аугментаций: настоящая копия сохраняется сама
// на каждой правке, версия — только по «Сохранить версию», и прогон в таске
// всегда идёт версией. Отличается набор узлов и правая колонка: у «Сети»
// классов бывает много, поэтому они в своём подокне с поиском, а вкладка
// «Классы агента» показывает, откуда пришёл каждый.
//
// Проверку формы делает сервер при сохранении версии (common/agent_graph.py) —
// второй проверяющий в браузере разошёлся бы с ним на первой правке. Пределы
// чисел — исключение: форма берёт их из той же таблицы (agentDoc.LIMITS) и не
// даёт за них выйти, иначе ошибка всплывала только на «Сохранить версию».

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
import { NumInput } from "../NumInput";
import Sep from "../Sep";
import {
  CYRILLIC, LIMITS, SAM_DEFAULTS, SAM_MODELS, TEXT_IMGSZ, TEXT_MODEL, TEXT_MODELS, TITLES, YOLOE_MB, agentClasses,
  carryClasses, isExamples, keepWired, mergeInputs, offLimits, promptsOf, rowTarget, rowsOf, switchTextModel, textConfDefault,
  textModel, upstream, type FilterRow, type Limit, type NetRow, type PromptRow,
} from "./agentDoc";
import { agentNodeTypes, type AgentNodeData } from "./AgentNodes";
import AgentPreview from "./AgentPreview";
import { ExampleStrip, ExamplesDialog } from "./ExamplesDialog";
import WeightsPicker from "./WeightsPicker";

const DRAFT_WAIT_MS = 700;
type Addable = "net" | "text" | "merge" | "nms" | "filter" | "sam";
const PALETTE = [
  ["net", "Сеть", "k-flow"],
  ["text", "Сеть по тексту", "k-block"],
  ["merge", "Объединение", "k-noise"],
  ["nms", "NMS", "k-light"],
  ["filter", "Фильтр", "k-light"],
  ["sam", "Уточнение SAM", "k-geometry"],
] as const;
let seq = 0;
const freshId = (kind: string) => `${kind}${++seq}${Date.now() % 1000}`;
const occupies = (e: Edge, c: { target?: string | null; targetHandle?: string | null }) =>
  e.target === c.target && (e.targetHandle ?? null) === (c.targetHandle ?? null);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
// Проходов TTA на вид — как agent_graph.variants на сервере.
const tta = (p: Record<string, unknown>) => (p.tta_flip ? 2 : 1) * (p.tta_scales ? 3 : 1);
const decimal = (v: number) => String(v).replace(".", ",");

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
  // Лежат ли веса SAM 3 на сервере; null — ещё не знаем, и не пугаем.
  const [sam3Ready, setSam3Ready] = useState<boolean | null>(null);
  // Наборы образцов, на которые ссылаются строки: паспорт и миниатюры.
  const [sets, setSets] = useState<Map<string, api.ExampleSet>>(new Map());
  const keepSet = useCallback((s: api.ExampleSet) => setSets((old) => new Map(old).set(s.id, s)), []);
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
    api.listWeights().then((r) => {
      setShelf(r.weights);
      setSam3Ready(r.sam3 ?? null);
    }).catch(() => undefined);
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

  const wantedSets = useMemo(
    () => [...new Set(draft.nodes.filter((n) => n.type === ("text" as string))
      .flatMap((n) => promptsOf(n).filter(isExamples).map((r) => r.set ?? "")).filter(Boolean))],
    [draft]
  );
  useEffect(() => {
    const missing = wantedSets.filter((id) => !sets.has(id));
    if (missing.length) api.listExamples(missing).then((r) => r.sets.forEach(keepSet)).catch(() => undefined);
  }, [wantedSets, sets, keepSet]);

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

  const namesOf = useCallback(
    (id: string) => {
      const node = draft.nodes.find((n) => n.id === id);
      return node ? weightsOf(node.params ?? {})?.names ?? [] : [];
    },
    [draft, weightsOf]
  );
  const classes = useMemo(() => agentClasses(draft.nodes, namesOf), [draft, namesOf]);
  const colorOf = useMemo(() => new Map(classes.map((c) => [c.name, c])), [classes]);
  // Классы, что приходят к выбранному узлу: «Фильтр» показывает только их.
  const incoming = useMemo(() => {
    if (!selected) return [];
    const up = upstream(selected, draft.edges);
    return agentClasses(draft.nodes.filter((n) => up.has(n.id)), namesOf).map((c) => c.name);
  }, [selected, draft, namesOf]);

  // Подписи карточек считаются здесь, а не хранятся в документе: имя весов
  // живёт на полке, и переименование файла не должно рождать правку графа.
  const shown = useMemo(
    () =>
      nodes.map((n) => {
        const d = n.data as AgentNodeData;
        if (d.kind === "text") {
          const model = textModel(d.params);
          const rows = promptsOf(d);
          const on = rows.filter((r) => r.on && rowTarget(r) && r.agent.trim()).length;
          const exN = rows.filter((r) => r.on && rowTarget(r) && isExamples(r)).length;
          const missing = model === "sam3" && sam3Ready === false;
          const yolo = model !== "sam3";
          return {
            ...n,
            data: {
              ...d,
              why: missing
                ? "нет весов SAM 3"
                : [
                    yolo ? `YOLOE-26 ${model}` : "SAM 3",
                    exN ? `${on - exN ? `${on - exN} сл. + ` : ""}${exN} обр.` : null,
                    `conf ${decimal(num(d.params.conf, textConfDefault(model)))}`,
                    yolo && d.params.tiles ? "плитки" : null,
                    yolo && tta(d.params) > 1 ? `TTA ×${tta(d.params)}` : null,
                  ].filter(Boolean).join(", "),
              badge: `${on}/${rows.length}`,
              bad: missing || on === 0,
            },
          };
        }
        if (d.kind === "filter") {
          const up = upstream(n.id, draft.edges);
          return { ...n, data: { ...d, incoming: agentClasses(draft.nodes.filter((x) => up.has(x.id)), namesOf).map((c) => c.name) } };
        }
        if (d.kind !== "net") return n;
        const w = weightsOf(d.params);
        const rows = rowsOf({ params: d.params });
        const caption = w ? w.name.replace(/\.pt$/i, "") : undefined;
        return {
          ...n,
          data: {
            ...d,
            caption,
            why: w
              ? [
                  // С подписью имя весов уходит из заголовка сюда: без него две
                  // сети на одних весах не отличить от сетей на разных.
                  d.params.label ? caption : null,
                  `${w.task}, ${num(d.params.imgsz, w.imgsz ?? 640)}, conf ${String(num(d.params.conf, 0.25)).replace(".", ",")}`,
                  d.params.tiles ? "плитки" : null,
                  tta(d.params) > 1 ? `TTA ×${tta(d.params)}` : null,
                ].filter(Boolean).join(", ")
              : undefined,
            badge: w ? `${rows.filter((r) => r.on).length}/${w.names.length}` : undefined,
          },
        };
      }),
    [nodes, weightsOf, sam3Ready, draft, namesOf]
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
    (id: string, next: Record<string, unknown>) => {
      setNodes((old) =>
        old.map((n) =>
          n.id === id
            ? { ...n, data: { ...(n.data as AgentNodeData), params: { ...(n.data as AgentNodeData).params, ...next } } }
            : n
        )
      );
      if ("inputs" in next) setEdges((old) => keepWired(old, id, next));
    },
    [setNodes, setEdges]
  );

  const addNode = useCallback(
    (kind: Addable, at?: { x: number; y: number }) => {
      const id = freshId(kind);
      const box = wrap.current?.getBoundingClientRect();
      const point =
        at ?? screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2, y: (box?.top ?? 0) + 160 });
      const params = {
        net: { weights: null, classes: [], conf: 0.25 },
        text: { model: TEXT_MODEL, prompts: [], conf: textConfDefault(TEXT_MODEL), imgsz: TEXT_IMGSZ },
        merge: { inputs: 2 },
        nms: { iou: 0.6, agnostic: false },
        filter: { classes: [], min_side: null, max_side: null },
        sam: { ...SAM_DEFAULTS },
      }[kind];
      setNodes((old) => {
        // Два щелчка по палитре подряд клали узлы ровно друг на друга, и
        // второй казался пропавшим. Занято — сдвигаем лесенкой.
        let spot = point;
        while (old.some((n) => Math.abs(n.position.x - spot.x) < 24 && Math.abs(n.position.y - spot.y) < 24))
          spot = { x: spot.x + 36, y: spot.y + 36 };
        return [
          ...old.map((n) => ({ ...n, selected: false })),
          { id, type: kind, position: spot, selected: true, data: { kind, params } as AgentNodeData },
        ];
      });
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
        {PALETTE.map(([kind, label, klass]) => (
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
              if (PALETTE.some(([k]) => k === kind) && !readOnly)
                addNode(kind as Addable, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
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

        {graphId && (
          <AgentPreview
            graphId={graphId}
            doc={draft}
            node={current ? { id: current.id, data: current.data as AgentNodeData } : null}
            colorOf={colorOf}
          />
        )}
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
              sam3Ready={sam3Ready}
              sets={sets}
              onSet={keepSet}
              colorOf={colorOf}
              incoming={incoming}
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
            const p = (pickedFor.data as AgentNodeData).params;
            // Те же веса — таблицу не трогаем: «Выбрать» на текущей строке
            // молча сбрасывал переименования и выключенные классы.
            if (p.weights !== w.id)
              patchParams(pickedFor.id, {
                weights: w.id,
                classes: carryClasses(weightsOf(p)?.names ?? [], rowsOf({ params: p }), w.names),
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
                {s.label}
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
  sam3Ready,
  sets,
  onSet,
  colorOf,
  incoming,
  onChange,
  onPickWeights,
  onRemove,
}: {
  node: Node | null;
  readOnly: boolean;
  weights?: api.Weights;
  sam3Ready: boolean | null;
  sets: Map<string, api.ExampleSet>;
  onSet: (set: api.ExampleSet) => void;
  colorOf: Map<string, { color: string; sources: unknown[] }>;
  incoming: string[];
  onChange: (next: Record<string, unknown>) => void;
  onPickWeights: () => void;
  onRemove: () => void;
}) {
  if (!node) return <p className="ag-muted">Выберите узел на холсте.</p>;
  const d = node.data as AgentNodeData;
  const p = d.params;
  const model = textModel(p);
  const missing = d.kind === "text" && model === "sam3" && sam3Ready === false;
  // Пределы — из той же таблицы, что у сервера. Значение вне их (сохранённое
  // до пределов) подсвечено: поле держит его, пока человек не исправит.
  const limit = (key: string): Limit | undefined => LIMITS[d.kind]?.[key];
  const numInput = (key: string, value: number | undefined, step: number, empty?: boolean) => {
    const lim = limit(key);
    const bad = offLimits(lim, p[key]);
    return (
      <NumInput
        id={`ag-${key}`}
        value={value}
        min={lim?.lo}
        max={lim?.hi}
        step={step}
        integer={lim?.int}
        allowEmpty={empty}
        placeholder={empty ? "—" : undefined}
        disabled={readOnly}
        aria-invalid={bad || undefined}
        title={bad && lim ? `от ${decimal(lim.lo)} до ${decimal(lim.hi)}` : undefined}
        // Пустое необязательное поле — «без предела», поэтому null, а не умолчание.
        onValue={(v) => onChange({ [key]: v ?? null })}
      />
    );
  };
  const field = (key: string, label: string, value: number, step: number) => (
    <div className="mag-field ag-num">
      <label htmlFor={`ag-${key}`}>{label}</label>
      {numInput(key, value, step)}
    </div>
  );
  const optional = (key: string, label: string, value: unknown) => (
    <div className="mag-field ag-num">
      <label htmlFor={`ag-${key}`}>{label}</label>
      {numInput(key, typeof value === "number" ? value : undefined, 1, true)}
    </div>
  );

  const passes = (
    <>
      {(
        [
          ["tiles", "Плитки размером со вход и целый кадр"],
          ["tta_flip", "TTA: отражение по горизонтали"],
          ["tta_scales", "TTA: масштабы ×0,8 и ×1,25"],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="ag-check ag-flag">
          <input type="checkbox" checked={Boolean(p[key])} disabled={readOnly}
            onChange={(e) => onChange({ [key]: e.target.checked })} />
          {label}
        </label>
      ))}
      {Boolean(p.tiles) && (
        <div className="ag-two">
          {field("overlap", "Перекрытие плиток", num(p.overlap, 0.2), 0.05)}
          {field("glue", "Склейка от, IoS", num(p.glue, 0.5), 0.05)}
        </div>
      )}
    </>
  );

  return (
    <div className="ag-node">
      <div className="g-insp-name">{TITLES[d.kind]}</div>
      {d.kind !== "frame" && d.kind !== "output" && (
        <div className="mag-field">
          <label htmlFor="ag-label">Подпись</label>
          <input id="ag-label" value={String(p.label ?? "")} disabled={readOnly} maxLength={60}
            onChange={(e) => onChange({ label: e.target.value || undefined })} />
        </div>
      )}

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
          {/* IoU здесь нет: у yolo26 NMS нет вовсе, у yolo11 и v8 он встроен
              с мягким 0,7. Гасить дубли — узлом «NMS», его видно на холсте. */}
          <div className="ag-two">
            {field("conf", "Уверенность от", num(p.conf, 0.25), 0.05)}
            {field("imgsz", "Размер входа", num(p.imgsz, weights?.imgsz ?? 640), 32)}
          </div>
          {passes}
        </>
      )}

      {d.kind === "text" && (
        <>
          <div className="mag-field">
            <label>Модель</label>
            <div className="ag-seg" role="group" aria-label="Модель">
              {TEXT_MODELS.map((m) => (
                <button key={m} type="button" aria-pressed={model === m} disabled={readOnly}
                  onClick={() => onChange(switchTextModel(p, m))}>
                  {m === "sam3" ? "SAM 3" : m}
                </button>
              ))}
            </div>
            <div className="ag-seg-cap"><span>YOLOE-26</span></div>
          </div>
          <div className={`ag-weights${missing ? " ag-miss" : ""}`}>
            {model !== "sam3" ? (
              <>
                <b className="mono">yoloe-26{model}-seg.pt</b>
                <span>{YOLOE_MB[model]} МБ <Sep /> в образе <Sep /> только рамки</span>
              </>
            ) : missing ? (
              <>
                <b>Нет весов SAM 3 на сервере</b>
                <span>Нужен файл _autolabel/sam3/sam3.pt — без него версию не сохранить.</span>
              </>
            ) : (
              <>
                <b className="mono">sam3.pt</b>
                <span>3,45 ГБ <Sep /> на сервере <Sep /> рамка и контур</span>
              </>
            )}
          </div>
          <PromptTable
            rows={promptsOf({ params: p })}
            readOnly={readOnly}
            colorOf={colorOf}
            nodeConf={num(p.conf, textConfDefault(model))}
            sets={sets}
            onSet={onSet}
            onRows={(rows) => onChange({ prompts: rows })}
          />
          {model === "sam3" ? (
            <>
              <div className="ag-two">
                {field("conf", "Порог узла", num(p.conf, textConfDefault(model)), 0.05)}
              </div>
              <div className="ag-cap">Контур</div>
              <div className="ag-two">
                {field("polygon_points", "Точек до", num(p.polygon_points, SAM_DEFAULTS.polygon_points), 8)}
                {field("min_area", "Кусок от, px²", num(p.min_area, SAM_DEFAULTS.min_area), 16)}
              </div>
              <label className="ag-check ag-flag">
                <input type="checkbox" checked={p.fill_holes !== false} disabled={readOnly}
                  onChange={(e) => onChange({ fill_holes: e.target.checked })} />
                Заливать дыры
              </label>
            </>
          ) : (
            <>
              <div className="ag-two">
                {field("conf", "Порог узла", num(p.conf, textConfDefault(model)), 0.05)}
                {field("imgsz", "Размер входа", num(p.imgsz, TEXT_IMGSZ), 32)}
              </div>
              {passes}
            </>
          )}
        </>
      )}

      {d.kind === "merge" && field("inputs", "Входов", mergeInputs(p), 1)}

      {d.kind === "nms" && (
        <>
          {field("iou", "IoU от", num(p.iou, 0.6), 0.05)}
          <label className="ag-check ag-flag">
            <input type="checkbox" checked={Boolean(p.agnostic)} disabled={readOnly}
              onChange={(e) => onChange({ agnostic: e.target.checked })} />
            Между классами
          </label>
        </>
      )}

      {d.kind === "filter" && (
        <>
          <FilterClasses
            names={incoming}
            rows={(p.classes as FilterRow[] | undefined) ?? []}
            readOnly={readOnly}
            colorOf={colorOf}
            onRows={(rows) => onChange({ classes: rows })}
          />
          <div className="ag-two">
            {optional("min_side", "Сторона от, px", p.min_side)}
            {optional("max_side", "Сторона до, px", p.max_side)}
          </div>
        </>
      )}

      {d.kind === "sam" && (
        <>
          <div className="mag-field">
            <label htmlFor="ag-model">Модель</label>
            <select id="ag-model" value={String(p.model ?? SAM_DEFAULTS.model)} disabled={readOnly}
              onChange={(e) => onChange({ model: e.target.value })}>
              {SAM_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="mag-field">
            <label htmlFor="ag-detail">Детализация</label>
            <select id="ag-detail" value={String(p.detail ?? SAM_DEFAULTS.detail)} disabled={readOnly}
              onChange={(e) => onChange({ detail: e.target.value })}>
              <option value="auto">Как решит модель</option>
              <option value="object">Объект целиком</option>
              <option value="part">Часть</option>
              <option value="subpart">Подчасть</option>
            </select>
          </div>
          <div className="ag-two">
            {field("score_min", "Порог маски", num(p.score_min, SAM_DEFAULTS.score_min), 0.05)}
            {field("min_area", "Кусок от, px²", num(p.min_area, SAM_DEFAULTS.min_area), 16)}
          </div>
          <div className="ag-two">
            {field("polygon_points", "Точек до", num(p.polygon_points, SAM_DEFAULTS.polygon_points), 8)}
            <label className="ag-check">
              <input type="checkbox" checked={p.fill_holes !== false} disabled={readOnly}
                onChange={(e) => onChange({ fill_holes: e.target.checked })} />
              Заливать дыры
            </label>
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

/** Таблица «Сети по тексту»: строка — слово или набор образцов → класс
 *  агента, у каждой свой порог (пусто — порог узла). Строки заводит человек,
 *  поэтому здесь есть «Добавить» и крестик, которых нет у классов сети. Слово
 *  по-русски не запрещено — модель его примет, только найдёт хуже или не то. */
function PromptTable({
  rows,
  readOnly,
  colorOf,
  nodeConf,
  sets,
  onSet,
  onRows,
}: {
  rows: PromptRow[];
  readOnly: boolean;
  colorOf: Map<string, { color: string; sources: unknown[] }>;
  nodeConf: number;
  sets: Map<string, api.ExampleSet>;
  onSet: (set: api.ExampleSet) => void;
  onRows: (rows: PromptRow[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off">("all");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  // Раскрытые полосы образцов — по id набора, а не по номеру строки: номер
  // съезжал при удалении строки выше, и раскрытой оказывалась соседняя.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  const set = (i: number, patch: Partial<PromptRow>) => onRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const q = query.trim().toLowerCase();
  const label = (r: PromptRow) => (isExamples(r) ? sets.get(r.set ?? "")?.class_name ?? "образцы" : r.prompt ?? "");
  const visible = rows
    .map((r, i) => ({ ...r, i }))
    .filter((r) => filter === "all" || (filter === "on" ? r.on : !r.on))
    .filter((r) => !q || `${label(r)} ${r.agent}`.toLowerCase().includes(q));
  const add = () => {
    const clean = prompt.trim();
    if (!clean) return;
    onRows([...rows, { kind: "text", prompt: clean, agent: agent.trim() || clean, on: true }]);
    setPrompt("");
    setAgent("");
  };
  const toggle = (id: string) =>
    setOpen((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div className="ag-cls">
      <div className="ag-cls-h">
        <div className="ag-cls-title">
          <b>Строки</b>
          <span className="mono">
            {rows.length} <Sep /> в агент {rows.filter((r) => r.on).length}
          </span>
        </div>
        <input className="ag-search" placeholder="Поиск по слову, образцам и классу" value={query}
          onChange={(e) => setQuery(e.target.value)} />
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
              <button type="button" title="Включить все" onClick={() => onRows(rows.map((r) => ({ ...r, on: true })))}>
                + все
              </button>
              <button type="button" title="Выключить все" onClick={() => onRows(rows.map((r) => ({ ...r, on: false })))}>
                − все
              </button>
            </>
          )}
        </div>
      </div>
      <div className="ag-pr ag-cr-head">
        <span />
        <span />
        <span>слово / образцы</span>
        <span>класс агента</span>
        <span className="ag-pr-thr-h">порог</span>
        <span />
      </div>
      <div className="ag-cls-body ag-pr-body">
        {rows.length === 0 && <p className="ag-muted">Строк нет — добавьте слово или образцы ниже.</p>}
        {rows.length > 0 && visible.length === 0 && <p className="ag-muted">Ничего не найдено.</p>}
        {visible.map((r) => {
          const c = r.on ? colorOf.get(r.agent.trim()) : undefined;
          const ex = isExamples(r);
          const exSet = ex ? sets.get(r.set ?? "") : undefined;
          const cyr = !ex && CYRILLIC.test(r.prompt ?? "");
          return (
            <div key={r.i} className={`ag-pr${r.on ? "" : " off"}${cyr ? " cyr" : ""}`}>
              <input
                type="checkbox"
                checked={r.on}
                disabled={readOnly}
                aria-label={label(r) || "строка"}
                onChange={(e) => set(r.i, { on: e.target.checked })}
              />
              <span className={`ag-kind${ex ? " ex" : ""}`} title={ex ? "образцы" : "слово"}>{ex ? "обр" : "сл"}</span>
              {ex ? (
                <button type="button" className="ag-src-btn" aria-expanded={open.has(r.set ?? "")} onClick={() => toggle(r.set ?? "")}>
                  <b>{exSet?.class_name ?? "набор"} {open.has(r.set ?? "") ? "▾" : "▸"}</b>
                  <span className="mono">{exSet ? <>{exSet.items.length} обр. <Sep /> {exSet.project}</> : "загружаю…"}</span>
                </button>
              ) : (
                <input
                  className="ag-pr-in mono"
                  value={r.prompt ?? ""}
                  disabled={readOnly}
                  aria-label="Слово"
                  onChange={(e) => set(r.i, { prompt: e.target.value })}
                />
              )}
              <span className="ag-an">
                <i className="ag-dot" style={{ background: c?.color ?? "var(--hair)" }} />
                <input
                  value={r.agent}
                  disabled={readOnly}
                  aria-label={`Класс агента для ${label(r)}`}
                  title={r.agent}
                  onChange={(e) => set(r.i, { agent: e.target.value })}
                  onBlur={(e) => !e.target.value.trim() && set(r.i, { agent: label(r) })}
                />
                {c && c.sources.length > 1 && (
                  <b className="ag-merge" title="В этот класс агента сходятся несколько строк">
                    ×{c.sources.length}
                  </b>
                )}
              </span>
              <NumInput
                className="ag-pr-thr mono"
                min={0}
                max={1}
                step={0.05}
                allowEmpty
                disabled={readOnly}
                placeholder={String(nodeConf).replace(".", ",")}
                value={typeof r.conf === "number" ? r.conf : undefined}
                aria-label="Порог строки"
                aria-invalid={offLimits({ lo: 0, hi: 1 }, r.conf) || undefined}
                onValue={(v) => set(r.i, { conf: v ?? null })}
              />
              {!readOnly ? (
                <button type="button" className="ag-x" aria-label={`Удалить строку ${label(r)}`}
                  onClick={() => onRows(rows.filter((_, k) => k !== r.i))}>
                  ×
                </button>
              ) : <span />}
              {cyr && <span className="ag-pr-warn">Слово по-русски — модель понимает английский</span>}
              {ex && open.has(r.set ?? "") && exSet && (
                <ExampleStrip
                  set={exSet}
                  readOnly={readOnly}
                  onSet={(next) => {
                    onSet(next);
                    // Набор неизменяем: правка рождает новый id — раскрытой
                    // остаётся та же строка.
                    setOpen((old) => new Set([...old].map((id) => (id === exSet.id ? next.id : id))));
                    set(r.i, { set: next.id });
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <>
          <form className="ag-pr-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input className="ag-search mono" placeholder="слово" value={prompt}
              aria-label="Новое слово" onChange={(e) => setPrompt(e.target.value)} />
            <input className="ag-search" placeholder="класс агента" value={agent} list="ag-agent-classes"
              aria-label="Класс агента для нового слова" onChange={(e) => setAgent(e.target.value)} />
            <button type="submit" className="mag-ghost" disabled={!prompt.trim()}>+ Слово</button>
            <datalist id="ag-agent-classes">
              {[...colorOf.keys()].map((name) => <option key={name} value={name} />)}
            </datalist>
          </form>
          <div className="ag-pr-ex">
            <button type="button" className="ag-ex-btn" onClick={() => setDialog(true)}>+ Образцы из разметки</button>
          </div>
        </>
      )}
      {dialog && (
        <ExamplesDialog
          onClose={() => setDialog(false)}
          onDone={(made, agentName) => {
            onSet(made);
            // Образцы шкалой ниже слов: у YOLOE лучший F1 по ним при 0,05–0,15.
            onRows([...rows, { kind: "examples", set: made.id, agent: agentName, on: true, conf: 0.1 }]);
            setOpen((old) => new Set(old).add(made.id));
            setDialog(false);
          }}
        />
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

/** Таблица «Фильтра»: классы, что приходят на вход, с галочкой и порогом.
 *  Строки держатся за имя класса агента. Класса нет в сохранённой таблице —
 *  он пропускается с порогом 0: так же считает и сервер. */
function FilterClasses({
  names,
  rows,
  readOnly,
  colorOf,
  onRows,
}: {
  names: string[];
  rows: FilterRow[];
  readOnly: boolean;
  colorOf: Map<string, { color: string }>;
  onRows: (rows: FilterRow[]) => void;
}) {
  const byName = new Map(rows.map((r) => [r.cls, r]));
  const table = names.map((cls) => byName.get(cls) ?? { cls, on: true, conf: 0 });
  // Строки классов, которых выше больше нет, не выбрасываем: вернётся класс —
  // вернётся и его правило.
  const set = (cls: string, patch: Partial<FilterRow>) =>
    onRows([...rows.filter((r) => !names.includes(r.cls)), ...table.map((r) => (r.cls === cls ? { ...r, ...patch } : r))]);

  return (
    <div className="ag-cls ag-flt">
      <div className="ag-cls-h">
        <div className="ag-cls-title">
          <b>Классы на входе</b>
          <span className="mono">{names.length}</span>
        </div>
      </div>
      <div className="ag-cr ag-cr-head">
        <span />
        <span>класс агента</span>
        <span>уверенность от</span>
      </div>
      <div className="ag-cls-body">
        {names.length === 0 && <p className="ag-muted">Выше нет сетей с классами.</p>}
        {table.map((r) => (
          <div key={r.cls} className={`ag-cr${r.on ? "" : " off"}`}>
            <input type="checkbox" checked={r.on} disabled={readOnly} aria-label={r.cls}
              onChange={(e) => set(r.cls, { on: e.target.checked })} />
            <span className="ag-an">
              <i className="ag-dot" style={{ background: colorOf.get(r.cls)?.color ?? "var(--hair)" }} />
              <span className="ag-wn" title={r.cls}>{r.cls}</span>
            </span>
            <NumInput className="ag-conf mono" min={0} max={1} step={0.05} value={r.conf}
              disabled={readOnly || !r.on} aria-label={`Порог для ${r.cls}`}
              aria-invalid={offLimits({ lo: 0, hi: 1 }, r.conf) || undefined}
              onValue={(v) => set(r.cls, { conf: v ?? 0 })} />
          </div>
        ))}
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
