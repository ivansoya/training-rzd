// Редактор агента разметки: «Холст и шторка», как у графа аугментаций.
//
// Черновик сохраняется сам на каждой правке, версия — только по «Сохранить версию»,
// и прогон в таске всегда идёт версией. В шторке: параметры узла (у «Сети» таблица
// классов прямо здесь), кадр превью с рамками узла и что он нашёл. Числа на проводах —
// рамки с того же кадра: превью считает вход и выход каждого узла за один прогон.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import NotFound, { isMissing } from "../NotFound";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import {
  Background, BackgroundVariant, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node,
} from "@xyflow/react";
import * as aug from "../../api/aug";
import * as api from "../../api/agents";
import type { GraphDoc, GraphEdge, GraphNode } from "../../api/aug";
import { Badge, Button, Icon, LinkButton, MenuItem, Notice, Select, cx } from "../../ui";
import { hasLayer } from "../../ui/useEscape";
import { ago, count } from "../ru";
import { edgeKey, findCycle } from "../aug/counts";
import * as hist from "../aug/history";
import { WireDraft, edgeTypes, type WireData } from "../aug/GraphNodes";
import { keep, load } from "../aug/NodePreview";
import { DRAWER_DEFAULT, clampDrawer } from "../aug/look";
import {
  agentClasses, bindRows, carryClasses, findOrCreate, foldName, frameCalls, isExamples, keepWired, promptsOf, rowTarget, rowsOf,
  sam3Side, textModel, tileSide, unfinished, upgradeDoc, upstream, type ClassDef, type FilterRow, type NetRow, type PromptRow,
} from "./agentDoc";
import AgentClasses from "./AgentClasses";
import AgentFound from "./AgentFound";
import AgentInspector from "./AgentInspector";
import { agentNodeTypes, agentTitle, type AgentNodeData } from "./AgentNodes";
import AgentPalette, { AGENT_MIME } from "./AgentPalette";
import AgentPreviewPane, { useAgentPreview } from "./AgentPreview";
import SixFrames from "./SixFrames";
import WeightsPicker from "./WeightsPicker";
import {
  defaults, filterLine, netBadge, netLine, onePort, plainLine, textLine, toneOf, wireText, type Addable, type AgentKind,
} from "./look";

const DRAFT_WAIT_MS = 700;
// Новый ключ: шторка стала выше, прежняя запомненная высота ей мала.
const DRAWER_KEY = "agent-drawer-h2";
// 60 % места под верхней полосой приложения и шапкой редактора (по 52 px), как в макете А.
const drawerStart = () => Math.max(DRAWER_DEFAULT + 60, Math.round((window.innerHeight - 104) * 0.6));
const GAP = 260;

let seq = 0;
const freshId = (kind: string, taken: Set<string>) => {
  let id: string;
  do id = `${kind}${++seq}_${Date.now() % 1000}`;
  while (taken.has(id));
  return id;
};

const kindOfNode = (n: Node | undefined) => (n?.data as AgentNodeData | undefined)?.kind;

// Номер провода один у холста и у документа: «откуда:гнездо->куда:гнездо».
const wireId = (c: { source?: string | null; sourceHandle?: string | null; target?: string | null; targetHandle?: string | null }) =>
  edgeKey({ from: c.source ?? "", out: c.sourceHandle ?? "out", to: c.target ?? "", in: c.targetHandle ?? "in" });

// В одно входное гнездо провод только один — два потока сводит «Объединение».
const occupies = (e: Edge, c: { target?: string | null; targetHandle?: string | null }) =>
  e.target === c.target && (e.targetHandle ?? null) === (c.targetHandle ?? null);

/** Куда встроить узел по щелчку: выделенный провод, провод после выделенного узла, провод в «Выход». */
function spliceWire(nodes: Node[], edges: Edge[]): Edge | null {
  const picked = nodes.find((n) => n.selected)?.id;
  return (
    edges.find((e) => e.selected) ??
    edges.find((e) => picked && e.source === picked) ??
    edges.find((e) => picked && e.target === picked) ??
    edges.find((e) => kindOfNode(nodes.find((n) => n.id === e.target)) === "output") ??
    null
  );
}

function splice(edges: Edge[], wire: Edge, id: string, [pin, pout]: [string, string]): Edge[] {
  return [
    ...edges.filter((e) => e.id !== wire.id),
    ...[
      { source: wire.source, sourceHandle: wire.sourceHandle, target: id, targetHandle: pin },
      { source: id, sourceHandle: pout, target: wire.target, targetHandle: wire.targetHandle },
    ].map((c) => ({ ...c, id: wireId(c), type: "volume" }) as Edge),
  ];
}

type XY = { x: number; y: number };

/** Место узла в разрыве провода: на шаг правее начала; тесно — конец провода и всё правее отъезжают. */
function roomIn(nodes: Node[], wire: Edge, y?: number): { at: XY; from: number; shift: number } | null {
  const a = nodes.find((n) => n.id === wire.source)?.position;
  const b = nodes.find((n) => n.id === wire.target)?.position;
  if (!a || !b) return null;
  return { at: { x: a.x + GAP, y: y ?? a.y }, from: b.x, shift: b.x > a.x ? Math.max(0, a.x + 2 * GAP - b.x) : 0 };
}

const pushRight = (nodes: Node[], x: number, by: number, skip?: string) =>
  by ? nodes.map((n) => (n.id !== skip && n.position.x >= x ? { ...n, position: { ...n.position, x: n.position.x + by } } : n)) : nodes;

function toFlow(doc: GraphDoc): [Node[], Edge[]] {
  return [
    doc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0 },
      // «Кадр» и «Выход» в агенте ровно по одному — не удаляются.
      deletable: (n.type as string) !== "frame" && n.type !== "output",
      data: { kind: n.type as AgentKind, params: n.params ?? {} } satisfies AgentNodeData,
    })),
    doc.edges.map((e) => ({ id: edgeKey(e), source: e.from, sourceHandle: e.out, target: e.to, targetHandle: e.in, type: "volume" })),
  ];
}

function toDoc(nodes: Node[], edges: Edge[], classes: ClassDef[]): GraphDoc {
  return {
    v: 1,
    classes,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.data as AgentNodeData).kind,
      params: (n.data as AgentNodeData).params,
      pos: [Math.round(n.position.x), Math.round(n.position.y)],
    })) as GraphNode[],
    edges: edges.map((e) => ({ from: e.source, out: e.sourceHandle ?? "out", to: e.target, in: e.targetHandle ?? "in" })) as GraphEdge[],
  };
}

/** Цепочка узлов развёрнутого вида: столбец — узлы одной глубины от «Кадра», неподключённые — в конце. */
function chainOf(nodes: Node[], edges: Edge[]): string[][] {
  const preds = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.target === n.id).map((e) => e.source)]));
  const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
  const depth = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...(preds.get(id) ?? []).map((p) => walk(p, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const cols: string[][] = [];
  const loose: string[] = [];
  for (const n of nodes) {
    if (!linked.has(n.id) && kindOfNode(n) !== "frame") {
      loose.push(n.id);
      continue;
    }
    const d = walk(n.id, new Set());
    if (!cols[d]) cols[d] = [];
    cols[d].push(n.id);
  }
  return [...cols.filter(Boolean), ...(loose.length ? [loose] : [])];
}

const pointOf = (e: MouseEvent | TouchEvent): [number, number] => {
  const p = "changedTouches" in e ? e.changedTouches[0] : e;
  return [p?.clientX ?? 0, p?.clientY ?? 0];
};

function sinceText(at: number, now: number): string {
  const s = Math.round((now - at) / 1000);
  if (s < 10) return "только что";
  if (s < 60) return `${s} с назад`;
  return ago(new Date(at).toISOString(), now);
}

function Editor() {
  const { graphId } = useParams<{ graphId: string }>();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const wanted = search.get("version") ?? undefined;
  const goVersion = (id: string | null) => setSearch(id ? { version: id } : {}, { state: location.state });

  const [missing, setMissing] = useState(false);
  const [graph, setGraph] = useState<aug.GraphDetail | null>(null);
  const [title, setTitle] = useState("");
  const [versions, setVersions] = useState<aug.VersionRow[]>([]);
  const [shelf, setShelf] = useState<api.Weights[]>([]);
  // Лежат ли веса SAM 3 на сервере; null — ещё не знаем, и не пугаем.
  const [sam3Ready, setSam3Ready] = useState<boolean | null>(null);
  // Наборы образцов, на которые ссылаются строки «Сети по тексту».
  const [sets, setSets] = useState<Map<string, api.ExampleSet>>(new Map());
  const keepSet = useCallback((s: api.ExampleSet) => setSets((old) => new Map(old).set(s.id, s)), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  // Список классов агента — часть документа наравне с узлами: в черновике, в версии и в отмене.
  const [defs, setDefs] = useState<ClassDef[]>([]);
  const defsRef = useRef(defs);
  defsRef.current = defs;
  const [classesOpen, setClassesOpen] = useState(false);
  const [projects, setProjects] = useState<api.ClassSource[] | null>(null);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Узел, закреплённый в превью глазом; нет его — превью идёт за выделением, без выделения — «Выход».
  const [eyeOn, setEyeOn] = useState<string | null>(null);
  const togglePin = useCallback((id: string) => setEyeOn((cur) => (cur === id ? null : id)), []);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [aim, setAim] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [six, setSix] = useState(false);
  // Узел на всё окно: холст прячется, сверху цепочка узлов.
  const [expanded, setExpanded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerH, setDrawerH] = useState(() => load(DRAWER_KEY, drawerStart()));
  const lastSaved = useRef<string | null>(null);
  const pending = useRef<GraphDoc | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [changed, setChanged] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, getZoom } = useReactFlow();
  const history = useRef<hist.History>(hist.start(""));
  const live = useRef({ nodes, edges, defs });
  live.current = { nodes, edges, defs };
  const flushing = useRef<Promise<unknown>>(Promise.resolve());

  // Старую версию и чужого агента смотрят, но не правят.
  const readOnly = Boolean(wanted) || (graph ? !graph.mine : false);
  const byWeights = useMemo(() => new Map(shelf.map((w) => [w.id, w])), [shelf]);
  const weightsOf = useCallback((params: Record<string, unknown>) => byWeights.get(String(params.weights ?? "")), [byWeights]);

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
        await flushing.current;
        const got = await aug.getGraph(graphId, wanted);
        if (!alive) return;
        setGraph(got);
        setTitle(got.name);
        // Документ до списка классов переводится здесь же — как agent_graph.upgrade на сервере.
        const doc = upgradeDoc(got.doc);
        const [ns, es] = toFlow(doc);
        setNodes(ns);
        setEdges(es);
        setDefs(doc.classes);
        lastSaved.current = JSON.stringify(toDoc(ns, es, doc.classes));
        history.current = hist.start(lastSaved.current);
        setChanged(Boolean(got.changed) || got.version === 0);
        setSaveState("saved");
        setSavedAt(got.draft_at ? new Date(got.draft_at).getTime() : null);
        setVersions((await aug.listVersions(graphId)).versions);
        window.requestAnimationFrame(() => void fitView({ maxZoom: 1, padding: 0.2 }));
      } catch (e) {
        if (!alive) return;
        // Мусорный id — «не найден», а не пустой холст с активной кнопкой сохранения.
        if (isMissing(e)) setMissing(true);
        else setProblem((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [graphId, wanted, setNodes, setEdges, fitView]);

  useEffect(() => {
    api.classSources().then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);

  // Esc сворачивает узел, если нет окна поверх и курсор не в поле: там у Esc своя работа.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasLayer()) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    if (!savedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [savedAt]);

  const draft = useMemo(() => toDoc(nodes, edges, defs), [nodes, edges, defs]);
  const docKey = useMemo(() => JSON.stringify({ n: draft.nodes.map(({ pos: _p, ...n }) => n), e: draft.edges }), [draft]);
  // Ответ сервера относится к отправленному графу: правка его снимает.
  useEffect(() => setProblem(null), [docKey]);

  const wantedSets = useMemo(
    () => [...new Set(draft.nodes.filter((n) => (n.type as string) === "text")
      .flatMap((n) => promptsOf(n).filter(isExamples).map((r) => r.set ?? "")).filter(Boolean))],
    [draft]
  );
  // Наборы, которых сервер не вернул: удалены — карточка предложит собрать заново, а не «загружается».
  const [goneSets, setGoneSets] = useState<Set<string>>(new Set());
  useEffect(() => {
    const lack = wantedSets.filter((id) => !sets.has(id) && !goneSets.has(id));
    if (!lack.length) return;
    api.listExamples(lack).then((r) => {
      r.sets.forEach(keepSet);
      const got = new Set(r.sets.map((s) => s.id));
      const gone = lack.filter((id) => !got.has(id));
      if (gone.length) setGoneSets((old) => new Set([...old, ...gone]));
    }).catch(() => undefined);
  }, [wantedSets, sets, goneSets, keepSet]);

  const namesOf = useCallback((id: string) => {
    const node = draft.nodes.find((n) => n.id === id);
    return node ? weightsOf(node.params ?? {})?.names ?? [] : [];
  }, [draft, weightsOf]);
  const classes = useMemo(() => agentClasses(defs, draft.nodes, namesOf), [defs, draft, namesOf]);
  const used = useMemo(() => classes.filter((c) => c.sources.length), [classes]);
  // Превью и разведка подписывают рамки именем класса — цвет ищется по нему.
  const colorMap = useMemo(() => new Map(used.map((c) => [c.name, c])), [used]);
  const colorOf = useCallback((cls: string) => colorMap.get(cls)?.color ?? "var(--muted-fg)", [colorMap]);
  const incomingOf = useCallback((id: string) => {
    const up = upstream(id, draft.edges);
    return agentClasses(defs, draft.nodes.filter((n) => up.has(n.id)), namesOf).filter((c) => c.sources.length).map((c) => c.id);
  }, [defs, draft, namesOf]);

  // Класс по имени — найденный или новый свой. Через ref: за одно действие
  // («включить все») классов заводится несколько, и каждый видит предыдущие.
  const ensureClass = useCallback((name: string) => {
    const [next, id] = findOrCreate(defsRef.current, name);
    if (next !== defsRef.current) {
      defsRef.current = next;
      setDefs(next);
    }
    return id;
  }, []);

  // Класс-ссылка на класс проекта — как «Из проекта» в окне классов: тот же по имени становится ссылкой.
  const ensureRef = useCallback((project: api.ClassSource, c: api.ClassSource["classes"][number]) => {
    const ref = { project: project.id, cls: c.id, project_name: project.name };
    const was = defsRef.current;
    const same = was.find((d) => d.ref?.project === project.id && d.ref.cls === c.id)
      ?? was.find((d) => foldName(d.name) === foldName(c.name));
    const [next, id] = same
      ? [was.map((d) => (d.id === same.id ? { ...d, name: c.name, color: c.color, ref } : d)), same.id]
      : findOrCreate(was, c.name, { color: c.color, ref });
    defsRef.current = next;
    setDefs(next);
    return id;
  }, []);

  // Ссылки на классы проектов держат имя и цвет живыми: переименовали класс в
  // проекте — агент узнаёт об этом при открытии. Класс удалили — ссылка
  // становится своим классом с последним именем. Нет доступа — не трогаем.
  useEffect(() => {
    if (readOnly || !projects || lastSaved.current === null) return;
    const byProject = new Map(projects.map((p) => [p.id, p]));
    let changed = false;
    const next = defs.map((d) => {
      if (!d.ref) return d;
      const project = byProject.get(d.ref.project);
      if (!project) return d;
      const hit = project.classes.find((c) => c.id === d.ref!.cls);
      if (!hit) {
        changed = true;
        const { ref: _gone, ...own } = d;
        return own;
      }
      if (hit.name === d.name && hit.color === d.color && project.name === d.ref.project_name) return d;
      changed = true;
      return { ...d, name: hit.name, color: hit.color, ref: { ...d.ref, project_name: project.name } };
    });
    if (changed) setDefs(next);
  }, [projects, defs, readOnly]);

  // Убрать классы: строки узлов с ними выключаются и помнят имя подсказкой, «Фильтр» их забывает.
  const removeClasses = useCallback((ids: string[]) => {
    const gone = new Map(defsRef.current.filter((d) => ids.includes(d.id)).map((d) => [d.id, d.name]));
    const loose = <R extends NetRow | PromptRow>(r: R): R => {
      if (!r.cls || !gone.has(r.cls)) return r;
      const { cls: _c, ...rest } = r;
      return { ...rest, agent: gone.get(r.cls), on: false } as R;
    };
    setNodes((old) => old.map((n) => {
      const d = n.data as AgentNodeData;
      const p = d.params;
      let next: Record<string, unknown> | null = null;
      if (d.kind === "net") next = { classes: rowsOf({ params: p }).map(loose) };
      else if (d.kind === "text") next = { prompts: promptsOf({ params: p }).map(loose) };
      else if (d.kind === "filter") next = { classes: ((p.classes as FilterRow[] | undefined) ?? []).filter((r) => !gone.has(r.cls)) };
      return next ? { ...n, data: { ...d, params: { ...p, ...next } } } : n;
    }));
    const left = defsRef.current.filter((d) => !gone.has(d.id));
    defsRef.current = left;
    setDefs(left);
  }, [setNodes]);

  const preview = useAgentPreview(graphId ?? "", draft, Boolean(graph?.mine), six);
  const trace = preview.result?.nodes ?? null;
  const flaw = unfinished(draft);
  const frame = preview.project?.frame ?? null;
  // Мс на вызов модели у каждого узла-находчика: время узла в превью, делённое на его
  // вызовы на том кадре (с проходами образцов). Из него итог тайлинга пересчитывается сразу.
  // Берётся лучший замер при тех же модели и входе: первый вызов греет модель и бывает в 30 раз дольше.
  const [speeds, setSpeeds] = useState<Map<string, { key: string; ms: number }>>(() => new Map());
  const result = preview.result;
  useEffect(() => {
    if (!result) return;
    setSpeeds((was) => {
      const next = new Map(was);
      for (const n of draft.nodes) {
        const kind: string = n.type;
        const ms = result.nodes[n.id]?.ms;
        if ((kind !== "net" && kind !== "text") || ms === undefined) continue;
        const p = n.params ?? {};
        const calls = frameCalls(kind, p, result.image.width, result.image.height, tileSide(kind, p, weightsOf(p)?.imgsz),
          (s) => sets.get(s)?.items.length);
        const per = ms / Math.max(1, calls);
        const key = JSON.stringify([p.weights, p.model, p.imgsz, kind === "text" && textModel(p) === "sam3" ? sam3Side(p) : null]);
        const old = next.get(n.id);
        next.set(n.id, { key, ms: old?.key === key ? Math.min(old.ms, per) : per });
      }
      return next;
    });
    // Только на новый ответ: граф к нему уже пришёл, а правка до ответа даст свой.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Свои рамки выбранного узла по строкам — «N на кадре» у описаний и образцов.
  const hits = useMemo(() => {
    const t = selected ? trace?.[selected] : undefined;
    if (!t) return null;
    const own = `${selected}.`;
    const by = new Map<number, number>();
    for (const det of t.out) if (det.id.startsWith(own) && typeof det.row === "number") by.set(det.row, (by.get(det.row) ?? 0) + 1);
    return by;
  }, [selected, trace]);

  const killWire = useCallback((id: string) => setEdges((old) => old.filter((e) => e.id !== id)), [setEdges]);
  const wires = useMemo(
    () => edges.map((e) => {
      const w = wireText(kindOfNode(nodes.find((n) => n.id === e.source)), trace, e.source);
      return {
        ...e,
        data: {
          ...(e.data ?? {}),
          amount: w.amount,
          text: w.text,
          hot: Boolean(selected) && (e.source === selected || e.target === selected),
          aim: e.id === aim,
          kill: readOnly ? undefined : killWire,
        } satisfies WireData,
      };
    }),
    [edges, nodes, trace, killWire, readOnly, selected, aim]
  );

  // Подписи карточек считаются здесь: имя весов живёт на полке, и его смена не правка агента.
  const shown = useMemo(() => {
    const linked = new Set(edges.flatMap((e) => [e.source, e.target]));
    return nodes.map((n) => {
      const d = n.data as AgentNodeData;
      const p = d.params;
      let extra: Partial<AgentNodeData> = {};
      if (d.kind === "net") {
        const w = weightsOf(p);
        extra = { caption: w?.name.replace(/\.pt$/i, ""), why: netLine(p, w, frame), badge: w ? netBadge(p, w.names.length) : undefined, bad: !p.weights };
      } else if (d.kind === "text") {
        const lack = textModel(p) === "sam3" && sam3Ready === false;
        const rows = promptsOf({ params: p });
        const on = rows.filter((r) => r.on && rowTarget(r) && r.cls).length;
        extra = { why: textLine(p, lack, frame), badge: `${on}/${rows.length}`, bad: lack || on === 0 };
      } else if (d.kind === "filter") {
        extra = { why: filterLine(p, incomingOf(n.id)) };
      } else {
        extra = { why: plainLine(d.kind, p) };
      }
      return { ...n, data: { ...d, ...extra, loose: !linked.has(n.id), eye: n.id === eyeOn, onEye: togglePin } };
    });
  }, [nodes, edges, weightsOf, sam3Ready, incomingOf, eyeOn, togglePin, frame]);

  const canConnect = useCallback((conn: Connection | Edge) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return false;
    // Занятое гнездо не отвергаем: прежний провод из него уйдёт.
    const doc = toDoc(nodes, [
      ...edges.filter((e) => !occupies(e, conn)),
      { id: "probe", source: conn.source, target: conn.target, sourceHandle: conn.sourceHandle ?? "out", targetHandle: conn.targetHandle ?? "in" } as Edge,
    ], []);
    return !findCycle(doc.nodes, doc.edges);
  }, [edges, nodes]);

  const onConnect = useCallback(
    (conn: Connection) => setEdges((old) => addEdge({ ...conn, id: wireId(conn), type: "volume" }, old.filter((e) => !occupies(e, conn)))),
    [setEdges]
  );

  // Провод перецепляется за конец; брошенный мимо всякого гнезда — снят.
  const moved = useRef(false);
  const onReconnect = useCallback((old: Edge, conn: Connection) => {
    moved.current = true;
    setEdges((list) => [
      ...list.filter((e) => e.id !== old.id && !occupies(e, conn)),
      { ...old, id: wireId(conn), source: conn.source, sourceHandle: conn.sourceHandle, target: conn.target, targetHandle: conn.targetHandle },
    ]);
  }, [setEdges]);
  const onReconnectEnd = useCallback((_e: unknown, edge: Edge, _s: unknown, state: { toHandle: unknown | null }) => {
    if (!moved.current && !state?.toHandle) killWire(edge.id);
  }, [killWire]);

  /** Провод под точкой экрана: ближайший в пределах 14 px экрана при любом масштабе. */
  const wireAt = useCallback((x: number, y: number): string | null => {
    const p = screenToFlowPosition({ x, y });
    const tol = 14 / getZoom();
    let best: string | null = null;
    let bestD = tol;
    for (const g of wrap.current?.querySelectorAll<SVGGElement>(".react-flow__edge[data-id]") ?? []) {
      const path = g.querySelector<SVGPathElement>("path.ge-wire");
      if (!path) continue;
      const len = path.getTotalLength();
      for (let s = 0; s <= len; s += Math.max(2, tol / 2)) {
        const q = path.getPointAtLength(s);
        const dist = Math.hypot(q.x - p.x, q.y - p.y);
        if (dist < bestD) {
          bestD = dist;
          best = g.dataset.id ?? null;
        }
      }
    }
    return best;
  }, [screenToFlowPosition, getZoom]);

  const addNode = useCallback((kind: Addable, at?: XY, into?: string | null) => {
    const id = freshId(kind, new Set(live.current.nodes.map((n) => n.id)));
    const box = wrap.current?.getBoundingClientRect();
    const pins = onePort(kind);
    // Брошенный на провод встаёт в разрыв; по щелчку — в цепочку перед «Выходом» или за выделенным.
    const wire = !pins ? null : into ? live.current.edges.find((e) => e.id === into) ?? null
      : at ? null : spliceWire(live.current.nodes, live.current.edges);
    const fit = wire && pins ? roomIn(live.current.nodes, wire, at?.y) : null;
    const point = fit?.at ?? at ?? screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2, y: (box?.top ?? 0) + 160 });
    if (wire && pins) setEdges((old) => splice(old, wire, id, pins));
    setNodes((old0) => {
      const old = fit ? pushRight(old0, fit.from, fit.shift) : old0;
      let spot = point;
      // Два щелчка подряд клали узлы друг на друга — занято, сдвигаем лесенкой.
      while (!fit && old.some((n) => Math.abs(n.position.x - spot.x) < 24 && Math.abs(n.position.y - spot.y) < 24))
        spot = { x: spot.x + 36, y: spot.y + 36 };
      return [...old.map((n) => ({ ...n, selected: false })),
        { id, type: kind, position: spot, selected: true, data: { kind, params: defaults(kind) } satisfies AgentNodeData }];
    });
    setSelected(id);
  }, [screenToFlowPosition, setNodes, setEdges]);

  const patchParams = useCallback((id: string, next: Record<string, unknown>) => {
    setNodes((old) => old.map((n) => (n.id === id
      ? { ...n, data: { ...(n.data as AgentNodeData), params: { ...(n.data as AgentNodeData).params, ...next } } } : n)));
    // Входов у «Объединения» стало меньше — провода с исчезнувших гнёзд уходят той же правкой.
    if ("inputs" in next) setEdges((old) => keepWired(old, id, next));
  }, [setNodes, setEdges]);

  const removeNode = useCallback((id: string) => {
    const kind = kindOfNode(live.current.nodes.find((n) => n.id === id));
    if (kind === "frame" || kind === "output") return;
    setNodes((old) => old.filter((n) => n.id !== id));
    setEdges((old) => old.filter((e) => e.source !== id && e.target !== id));
    setSelected(null);
  }, [setNodes, setEdges]);

  const unlink = useCallback((id: string) => setEdges((old) => old.filter((e) => e.source !== id && e.target !== id)), [setEdges]);

  const openMenu = useCallback((event: ReactMouseEvent, node: Node) => {
    if (readOnly) return;
    event.preventDefault();
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    setMenu({ id: node.id, x: Math.min(event.clientX - box.left + 4, box.width - 240), y: Math.min(event.clientY - box.top + 4, box.height - 110) });
  }, [readOnly]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  // Висящий узел с одним входом и выходом, брошенный на провод, тоже встаёт в разрыв.
  const spliceable = useCallback((node: Node) => !readOnly && Boolean(onePort((node.data as AgentNodeData).kind))
    && !live.current.edges.some((e) => e.source === node.id || e.target === node.id), [readOnly]);
  const onNodeDrag = useCallback((event: MouseEvent | TouchEvent, node: Node) =>
    setAim(spliceable(node) ? wireAt(...pointOf(event)) : null), [spliceable, wireAt]);
  const onNodeDragStop = useCallback((event: MouseEvent | TouchEvent, node: Node) => {
    setAim(null);
    if (!spliceable(node)) return;
    const wire = live.current.edges.find((e) => e.id === wireAt(...pointOf(event)));
    const pins = onePort((node.data as AgentNodeData).kind);
    if (!wire || !pins) return;
    setEdges((old) => splice(old, wire, node.id, pins));
    const fit = roomIn(live.current.nodes, wire, node.position.y);
    if (fit) setNodes((old) => pushRight(old, fit.from, fit.shift, node.id).map((n) => (n.id === node.id ? { ...n, position: fit.at } : n)));
  }, [spliceable, wireAt, setEdges, setNodes]);

  const onDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    setAim(null);
    const kind = event.dataTransfer.getData(AGENT_MIME) as Addable;
    if (!kind || readOnly) return;
    const p = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    // Карточка встаёт серединой под курсор.
    addNode(kind, { x: p.x - 84, y: p.y - 34 }, wireAt(event.clientX, event.clientY));
  };
  const onDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const hit = wireAt(event.clientX, event.clientY);
    if (hit !== aim) setAim(hit);
  };

  // Снимок в историю — когда правка улеглась: протяжка даёт десятки промежуточных состояний.
  useEffect(() => {
    if (readOnly || lastSaved.current === null) return;
    const text = JSON.stringify(draft);
    const timer = window.setTimeout(() => { history.current = hist.record(history.current, text); }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, readOnly]);

  const restore = useCallback((text: string) => {
    const doc = JSON.parse(text) as GraphDoc;
    const [fresh, es] = toFlow(doc);
    defsRef.current = doc.classes ?? [];
    setDefs(defsRef.current);
    setNodes((old) => {
      const had = new Map(old.map((n) => [n.id, n]));
      return fresh.map((n) => {
        const was = had.get(n.id);
        return was ? { ...was, position: n.position, data: { ...(was.data as AgentNodeData), params: (n.data as AgentNodeData).params } } : n;
      });
    });
    setEdges(es);
  }, [setNodes, setEdges]);

  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const act = hist.keyAction(e);
      if (!act) return;
      // В текстовом поле Ctrl+Z — отмена набора в поле.
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, select, [contenteditable='true']") || (t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(t.type))) return;
      e.preventDefault();
      const nowDoc = JSON.stringify(toDoc(live.current.nodes, live.current.edges, live.current.defs));
      const [next, doc] = (act === "undo" ? hist.undo : hist.redo)(history.current, nowDoc);
      history.current = next;
      if (doc !== null) restore(doc);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, restore]);

  // Автосохранение черновика: сравнивается весь документ, с координатами.
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
        setSavedAt(Date.now());
        setNow(Date.now());
      } catch (e) {
        setSaveState((e as Error).message);
      }
    }, DRAFT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [draft, graphId, readOnly]);

  // Ушли, не дождавшись паузы, — последняя правка уходит сразу.
  useEffect(() => {
    const flush = () => {
      const doc = pending.current;
      if (graphId && doc && JSON.stringify(doc) !== lastSaved.current) {
        pending.current = null;
        flushing.current = aug.saveDraft(graphId, doc, true).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [graphId, wanted]);

  const save = useCallback(async () => {
    if (!graphId) return;
    setBusy(true);
    setNote(null);
    setProblem(null);
    try {
      const got = await aug.saveVersion(graphId, toDoc(nodes, edges, defs));
      setGraph(got);
      setChanged(false);
      setVersions((await aug.listVersions(graphId)).versions);
      setNote(got.fresh === false || got.version === graph?.version ? "Изменений нет — версия та же." : `Сохранено: версия ${got.version}.`);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [graphId, nodes, edges, defs, graph?.version]);

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

  const room = () => main.current?.clientHeight ?? 800;
  const setDrawer = (h: number, remember = true) => {
    const v = clampDrawer(h, room());
    setDrawerH(v);
    if (remember) keep(DRAWER_KEY, v);
  };
  const grab = useRef<{ y: number; h: number } | null>(null);

  if (missing) return <NotFound message="Агент не найден: его удалили или ссылка неверна." back="/agents" backLabel="К моим агентам" />;

  const current = shown.find((n) => n.id === selected) ?? null;
  const output = nodes.find((n) => kindOfNode(n) === "output") ?? null;
  const pinned = eyeOn && nodes.some((n) => n.id === eyeOn) ? eyeOn : null;
  const watch = pinned ?? (selected && nodes.some((n) => n.id === selected) ? selected : output?.id ?? null);
  const watchNode = nodes.find((n) => n.id === watch);
  const watchKind = kindOfNode(watchNode) ?? null;
  const nextVersion = Math.max(0, ...versions.map((v) => v.version)) + 1;
  const pickedFor = picking ? nodes.find((n) => n.id === picking) : null;

  const saveText = readOnly ? null
    : saveState === "saving" ? "сохраняю черновик…"
    : saveState !== "saved" ? `черновик не сохранился: ${saveState}`
    : savedAt ? `черновик сохранён ${sinceText(savedAt, now)}` : "черновик совпадает с версией";
  const sub = [
    saveText,
    graph ? (graph.version ? `версия ${graph.version} из ${versions.length || graph.version}` : "версий пока нет") : null,
    !readOnly && changed ? "правки вне версий" : null,
  ].filter(Boolean);

  const pick = (id: string) => {
    setSelected(id);
    setNodes((old) => old.map((n) => ({ ...n, selected: n.id === id })));
  };

  return (
    <div className={cx("ge ae", expanded && "exp")}>
      <header className="ge-h">
        <LinkButton variant="ghost" icon="chevL" to="/agents" aria-label="К моим агентам" />
        <div className="ge-title">
          <input className="ge-name ui-ctl" value={title} disabled={readOnly} aria-label="Имя агента" size={Math.max(8, title.length)}
            onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setTitle(graph?.name ?? "");
            }} />
          <span className={saveState !== "saved" && saveState !== "saving" ? "bad" : undefined} role="status">{sub.join(" · ")}</span>
        </div>
        {readOnly && graph && <Badge icon="lock">{wanted ? "старая версия — только чтение" : "чужой агент — только чтение"}</Badge>}
        <span className="grow" />
        <Button size="sm" icon="tags" onClick={() => setClassesOpen(true)} title="Список классов агента: свои и из проектов">
          {count(classes.length, "класс", "класса", "классов")}
        </Button>
        <Select size="sm" icon="clock" label="Версия" value={wanted ?? "draft"} onChange={(v) => goVersion(v === "draft" ? null : v)}
          options={[
            { value: "draft", label: "Черновик", hint: changed ? "есть правки вне версий" : "совпадает с последней версией" },
            ...versions.map((v) => ({
              value: v.id,
              label: `Версия ${v.version}`,
              hint: [new Date(v.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(".", ""), v.note].filter(Boolean).join(" · "),
            })),
          ]} />
        <Button size="sm" icon="images" disabled={!graph?.mine || Boolean(flaw) || !preview.project} onClick={() => setSix(true)}
          title={flaw ?? (!preview.project ? "Нет проекта с кадрами" : "«Выход» агента на шести случайных кадрах")}>Превью на 6 кадрах</Button>
        <Button size="sm" variant="primary" icon="save" disabled={busy || readOnly || Boolean(flaw)} onClick={save}
          title={flaw ? `Сперва доделайте агента: ${flaw}` : "Создать новую версию — её запускают в тасках"}>Сохранить версию {nextVersion}</Button>
      </header>

      <div className="ge-body">
        <div className={cx("ge-main", expanded && "exp")} ref={main} style={{ "--dh": `${drawerH}px` } as CSSProperties}>
          {expanded && (
            <Chain nodes={nodes} edges={edges} trace={trace} selected={selected} onPick={pick} onClose={() => setExpanded(false)} />
          )}
          <div className="ae-top">
            <div className="ge-canvas" ref={wrap}>
              <ReactFlow
                className="ge-flow"
                colorMode="dark"
                nodes={shown}
                edges={wires}
                nodeTypes={agentNodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodesDraggable={!readOnly}
                onConnect={readOnly ? undefined : onConnect}
                onReconnect={readOnly ? undefined : onReconnect}
                onReconnectStart={() => { moved.current = false; }}
                onReconnectEnd={onReconnectEnd}
                reconnectRadius={12}
                connectionRadius={30}
                connectionLineComponent={WireDraft}
                edgesReconnectable={!readOnly}
                nodesConnectable={!readOnly}
                deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
                isValidConnection={canConnect}
                onSelectionChange={({ nodes: picked }) => setSelected(picked[0]?.id ?? null)}
                onNodeDoubleClick={(_e, n) => { pick(n.id); setExpanded(true); }}
                zoomOnDoubleClick={false}
                onNodeContextMenu={openMenu}
                onPaneClick={() => setMenu(null)}
                onMoveStart={() => setMenu(null)}
                onNodeDragStart={() => setMenu(null)}
                onNodeDrag={onNodeDrag}
                onNodeDragStop={onNodeDragStop}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setAim(null); }}
                minZoom={0.25}
                maxZoom={1.8}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "volume" }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              </ReactFlow>
              <div className="ge-tools">
                <Button size="sm" icon="fit" aria-label="Вписать агента" onClick={() => void fitView({ maxZoom: 1, padding: 0.2, duration: 200 })} />
                <Button size="sm" icon="zin" aria-label="Приблизить" onClick={() => void zoomIn({ duration: 150 })} />
                <Button size="sm" icon="zout" aria-label="Отдалить" onClick={() => void zoomOut({ duration: 150 })} />
              </div>
              {(flaw || problem || note) && (
                <div className="ge-notes">
                  {/* Недоделка без крестика: убрать её можно, только доделав агента. */}
                  {flaw && !readOnly && <Notice tone="warn">{flaw}</Notice>}
                  {problem && <Notice tone="error" onClose={() => setProblem(null)}>{problem}</Notice>}
                  {note && <Notice tone="ok" onClose={() => setNote(null)}>{note}</Notice>}
                </div>
              )}
              {menu && nodes.some((n) => n.id === menu.id) && (() => {
                const fixed = ["frame", "output"].includes(kindOfNode(nodes.find((n) => n.id === menu.id)) ?? "");
                return (
                  <div className="ui-pop ge-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
                    <MenuItem icon="eye" onSelect={() => { togglePin(menu.id); setMenu(null); }}>
                      {menu.id === eyeOn ? "Открепить превью" : "Закрепить в превью"}</MenuItem>
                    <MenuItem icon="x" disabled={!edges.some((e) => e.source === menu.id || e.target === menu.id)}
                      onSelect={() => { unlink(menu.id); setMenu(null); }}>Убрать все связи</MenuItem>
                    <MenuItem icon="trash" danger hint={fixed ? "Кадр и выход есть всегда" : "Delete"} disabled={fixed}
                      onSelect={() => { removeNode(menu.id); setMenu(null); }}>Удалить узел</MenuItem>
                  </div>
                );
              })()}
            </div>
            <AgentPalette onPick={(kind) => addNode(kind)} disabled={readOnly} />
          </div>

          <div className="ge-grip" role="separator" aria-orientation="horizontal" aria-label="Граница холста и шторки"
            aria-valuenow={drawerH} tabIndex={0} title="Тяните, чтобы поменять высоту шторки. Двойной щелчок — как было"
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              grab.current = { y: e.clientY, h: drawerH };
            }}
            onPointerMove={(e) => {
              const g = grab.current;
              if (g) setDrawer(g.h + g.y - e.clientY, false);
            }}
            onPointerUp={() => {
              if (grab.current) keep(DRAWER_KEY, drawerH);
              grab.current = null;
            }}
            onPointerCancel={() => { grab.current = null; }}
            onDoubleClick={() => setDrawer(drawerStart())}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                setDrawer(drawerH + (e.key === "ArrowUp" ? 24 : -24));
              }
            }}>
            <i />
          </div>

          <div className="ge-drawer">
            <AgentInspector
              node={current}
              readOnly={readOnly}
              weights={current ? weightsOf((current.data as AgentNodeData).params) : undefined}
              sam3Ready={sam3Ready}
              sets={sets}
              goneSets={goneSets}
              onSet={keepSet}
              classes={classes}
              ensure={ensureClass}
              ensureRef={ensureRef}
              projects={projects}
              onClasses={() => setClassesOpen(true)}
              incoming={current ? incomingOf(current.id) : []}
              loose={Boolean((current?.data as AgentNodeData | undefined)?.loose)}
              onChange={(next) => current && patchParams(current.id, next)}
              onPickWeights={() => current && setPicking(current.id)}
              onRemove={() => current && removeNode(current.id)}
              pinned={Boolean(current) && current?.id === eyeOn}
              onPin={() => current && togglePin(current.id)}
              frame={frame}
              msPerCall={current ? speeds.get(current.id)?.ms : undefined}
              hits={hits}
              expanded={expanded}
              onExpand={() => setExpanded((v) => !v)}
            />
            <div className="ae-col">
              <AgentPreviewPane state={preview} nodes={shown} watch={watch} pinned={Boolean(pinned)} onPin={setEyeOn}
                colorOf={colorOf} enabled={Boolean(graph?.mine)} />
              <AgentFound kind={watchKind} title={watchNode ? agentTitle(watchNode.data as AgentNodeData) : null}
                trace={watch && trace ? trace[watch] : undefined} colorOf={colorOf} />
            </div>
          </div>
        </div>
      </div>

      {pickedFor && (
        <WeightsPicker
          current={String((pickedFor.data as AgentNodeData).params.weights ?? "")}
          onClose={() => setPicking(null)}
          onPick={(w) => {
            setShelf((old) => (old.some((x) => x.id === w.id) ? old : [w, ...old]));
            const p = (pickedFor.data as AgentNodeData).params;
            // Те же веса — таблицу не трогаем: «Выбрать» на текущей строке сбрасывал бы переименования.
            if (p.weights !== w.id) {
              const [next, rows] = bindRows(defsRef.current, carryClasses(weightsOf(p)?.names ?? [], rowsOf({ params: p }), w.names),
                (_r, i) => w.names[i] ?? String(i));
              defsRef.current = next;
              setDefs(next);
              patchParams(pickedFor.id, { weights: w.id, classes: rows, imgsz: w.imgsz ?? undefined });
            }
            setPicking(null);
          }}
        />
      )}
      <AgentClasses open={classesOpen} onClose={() => setClassesOpen(false)} classes={classes} readOnly={readOnly} projects={projects}
        titleOf={(id) => {
          const n = shown.find((k) => k.id === id);
          return n ? agentTitle(n.data as AgentNodeData) : id;
        }}
        onChange={(next) => { defsRef.current = next; setDefs(next); }}
        onRemove={removeClasses}
        onShowNode={(id) => {
          setClassesOpen(false);
          setSelected(id);
          setNodes((old) => old.map((n) => ({ ...n, selected: n.id === id })));
        }} />
      {graphId && (
        <SixFrames open={six} onClose={() => setSix(false)} graphId={graphId} doc={draft} project={preview.project} colorOf={colorOf} />
      )}
    </div>
  );
}

/** Цепочка узлов над развёрнутым узлом: щелчок переключает узел, числа — рамки с кадра превью. */
function Chain({ nodes, edges, trace, selected, onPick, onClose }: {
  nodes: Node[]; edges: Edge[]; trace: Record<string, { out: unknown[] }> | null; selected: string | null;
  onPick: (id: string) => void; onClose: () => void;
}) {
  const cols = useMemo(() => chainOf(nodes, edges), [nodes, edges]);
  const chip = (id: string) => {
    const d = nodes.find((n) => n.id === id)?.data as AgentNodeData | undefined;
    if (!d) return null;
    const out = trace?.[id]?.out.length;
    return (
      <button key={id} type="button" className={cx("ae-cn", id === selected && "on")} aria-pressed={id === selected} onClick={() => onPick(id)}
        title={agentTitle(d)}>
        <i style={{ background: toneOf(d.kind) }} />
        <span className="t-ell">{String(d.params.label ?? "").trim() || agentTitle(d)}</span>
        {out !== undefined && d.kind !== "frame" && <b className="ui-mono">{out}</b>}
      </button>
    );
  };
  return (
    <div className="ae-chain">
      <Button size="sm" icon="shrink" onClick={onClose} title="Вернуть холст">Свернуть<kbd className="ae-kbd">Esc</kbd></Button>
      <div className="ae-chain-l">
        {cols.map((col, k) => (
          <Fragment key={k}>
            {k > 0 && <Icon name="chevR" size={14} className="ae-chain-sep" />}
            {col.length > 1 ? <span className="ae-pair">{col.map(chip)}</span> : chip(col[0])}
          </Fragment>
        ))}
      </div>
      <span className="t-xs t-faint ae-chain-note">числа — рамки с кадра превью</span>
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

