// Редактор графа аугментаций: «Холст и шторка» — холст сверху, параметры и превью
// в шторке снизу, узлы в колонке справа.
//
// Черновик сохраняется сам, на каждой правке, версия — нет. Версию создаёт
// явное «Сохранить версию»: иначе автосохранение нарожает сотню версий за
// вечер и обесценит саму запись «набор собран версией 7».

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import NotFound, { isMissing } from "../NotFound";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
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
import * as api from "../../api/aug";
import type { CatalogueNode, GraphDoc, GraphEdge, GraphNode } from "../../api/aug";
import { Badge, Button, LinkButton, MenuItem, Meta, Notice, Select } from "../../ui";
import { ago, count, ru } from "../ru";
import { GraphError, counts, edgeKey, findCycle, fitsPorts, mult, ports } from "./counts";
import * as hist from "./history";
import { WireDraft, edgeTypes, nodeTypes, titleOf, type NodeData, type WireData } from "./GraphNodes";
import NodeInspector from "./NodeInspector";
import NodePalette, { NODE_MIME } from "./NodePalette";
import NodePreview, { keep, load, usePreviewFrame } from "./NodePreview";
import SixPreview from "./SixPreview";
import { DRAWER_DEFAULT, clampDrawer } from "./look";

// Сколько кадров на проводах, пока набор не выбран. Число условное и подписано
// как условное: важны не сами кадры, а во сколько раз их станет больше.
const SAMPLE_BASE = 1000;
// Пауза после последней правки, прежде чем сохранить черновик.
const DRAFT_WAIT_MS = 700;
const DRAWER_KEY = "aug-drawer-h";

// Номер нового узла: счётчик и миллисекунды через разделитель; занятые номера обходим.
let seq = 0;
const freshId = (kind: string, taken: Set<string>) => {
  let id: string;
  do id = `${kind}${++seq}_${Date.now() % 1000}`;
  while (taken.has(id));
  return id;
};

// Узлы с одним входом и одним выходом: их можно встроить в провод щелчком по палитре.
const SPLICE = new Set(["aug", "multiply"]);
const GAP = 260;

/** Куда встроить новый узел: выделенный провод, провод после выделенного узла, провод в «Выход». */
function spliceWire(nodes: Node[], edges: Edge[]): Edge | null {
  const picked = nodes.find((n) => n.selected)?.id;
  const kindOf = (id: string) => (nodes.find((n) => n.id === id)?.data as NodeData | undefined)?.kind;
  return (
    edges.find((e) => e.selected) ??
    edges.find((e) => picked && e.source === picked) ??
    edges.find((e) => picked && e.target === picked) ??
    edges.find((e) => kindOf(e.target) === "output") ??
    null
  );
}

// Номер провода один у холста и у счёта: «откуда:гнездо->куда:гнездо».
const wireId = (c: { source?: string | null; sourceHandle?: string | null; target?: string | null; targetHandle?: string | null }) =>
  edgeKey({ from: c.source ?? "", out: c.sourceHandle ?? "out", to: c.target ?? "", in: c.targetHandle ?? "in" });

// В одно входное гнездо провод только один — два потока, слитые молча, это «Слияние».
const occupies = (e: Edge, c: { target?: string | null; targetHandle?: string | null }) =>
  e.target === c.target && (e.targetHandle ?? null) === (c.targetHandle ?? null);

/** Гнёзда узла, если их ровно по одному: такой узел встаёт в разрыв провода. */
function onePort(d: NodeData, id: string): [string, string] | null {
  try {
    const [ins, outs] = ports({ id, type: d.kind, params: d.params }, d.group);
    return ins.length === 1 && outs.length === 1 ? [ins[0], outs[0]] : null;
  } catch {
    return null;
  }
}

/** Два провода вместо одного: откуда → узел → куда. */
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

/** Место узла в разрыве провода: на шаг правее начала; тесно — конец провода и всё правее него отъезжают. */
function roomIn(nodes: Node[], wire: Edge, y?: number): { at: XY; from: number; shift: number } | null {
  const a = nodes.find((n) => n.id === wire.source)?.position;
  const b = nodes.find((n) => n.id === wire.target)?.position;
  if (!a || !b) return null;
  return { at: { x: a.x + GAP, y: y ?? a.y }, from: b.x, shift: b.x > a.x ? Math.max(0, a.x + 2 * GAP - b.x) : 0 };
}

/** Сдвинуть вправо всё, что правее x, кроме самого узла. */
const pushRight = (nodes: Node[], x: number, by: number, skip?: string) =>
  by ? nodes.map((n) => (n.id !== skip && n.position.x >= x ? { ...n, position: { ...n.position, x: n.position.x + by } } : n)) : nodes;

function toFlow(doc: GraphDoc, catalogue: Map<string, CatalogueNode>, onEye: (id: string) => void): [Node[], Edge[]] {
  const nodes: Node[] = doc.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0 },
    data: { kind: n.type, params: n.params ?? {}, catalogue: catalogue.get((n.params?.op as string) ?? ""), onEye } satisfies NodeData,
  }));
  const edges: Edge[] = doc.edges.map((e) => ({
    id: edgeKey(e), source: e.from, sourceHandle: e.out, target: e.to, targetHandle: e.in, type: "volume",
  }));
  return [nodes, edges];
}

function toDoc(nodes: Node[], edges: Edge[]): GraphDoc {
  return {
    v: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: (n.data as NodeData).kind,
      params: (n.data as NodeData).params,
      pos: [Math.round(n.position.x), Math.round(n.position.y)],
    })) as GraphNode[],
    edges: edges.map((e) => ({ from: e.source, out: e.sourceHandle ?? "out", to: e.target, in: e.targetHandle ?? "in" })) as GraphEdge[],
  };
}

/** Точка события на экране — мышь или палец. */
const pointOf = (e: MouseEvent | TouchEvent): [number, number] => {
  const p = "changedTouches" in e ? e.changedTouches[0] : e;
  return [p?.clientX ?? 0, p?.clientY ?? 0];
};

/** «только что», «40 с назад», «5 минут назад». */
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
  // Куда ведёт «назад»: в проект, если пришли из него, иначе в библиотеку.
  const back = (location.state as { back?: string } | null)?.back ?? "/augment";
  const goVersion = (id: string | null) => setSearch(id ? { version: id } : {}, { state: location.state });

  const [missing, setMissing] = useState(false);
  const [graph, setGraph] = useState<api.GraphDetail | null>(null);
  // Имя правится в шапке: буквы сразу, на сервер — одно сохранение по уходу из поля.
  const [title, setTitle] = useState("");
  const [cat, setCat] = useState<api.Catalogue | null>(null);
  const [versions, setVersions] = useState<api.VersionRow[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Узел, закреплённый в превью глазом; нет его — превью идёт за выделением.
  const [eyeOn, setEyeOn] = useState<string | null>(null);
  const togglePin = useCallback((id: string) => setEyeOn((cur) => (cur === id ? null : id)), []);
  // Меню узла по правой кнопке: где открыто и для какого. Координаты — внутри холста.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Провод, над которым держат узел: отпустят — узел встанет в разрыв.
  const [aim, setAim] = useState<string | null>(null);
  const [six, setSix] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerH, setDrawerH] = useState(() => load(DRAWER_KEY, DRAWER_DEFAULT));
  // Черновик: что последним ушло на сервер, когда и есть ли в нём правки вне версий.
  const lastSaved = useRef<string | null>(null);
  const pending = useRef<GraphDoc | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [changed, setChanged] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, getZoom } = useReactFlow();
  // История для Ctrl+Z. Холст и провода читаются из ссылки: обработчик клавиш живёт дольше отрисовки.
  const history = useRef<hist.History>(hist.start(""));
  const live = useRef({ nodes, edges });
  live.current = { nodes, edges };
  // Правка, ушедшая по уходу со страницы или смене версии: загрузка ждёт её.
  const flushing = useRef<Promise<unknown>>(Promise.resolve());
  const frame = usePreviewFrame(graphId ?? "");

  const byOp = useMemo(() => new Map((cat?.nodes ?? []).map((n) => [n.op, n])), [cat]);

  // Старую версию и чужой граф смотрят, но не правят.
  const readOnly = Boolean(wanted) || (graph ? !graph.mine : false);

  // Гнёзда и множитель блока знает только сервер — из паспорта вложенной версии.
  const groups = useMemo(() => {
    const out: Record<string, { ports?: { in: string[]; out: string[] }; multiplier?: number }> = {};
    nodes.forEach((n) => {
      const data = n.data as NodeData;
      if (data.kind === "group" && data.group) {
        out[n.id] = { ports: { in: data.group.in, out: data.group.out }, multiplier: (data.params.multiplier as number) ?? 1 };
      }
    });
    return out;
  }, [nodes]);

  useEffect(() => {
    api.catalogue().then(setCat).catch(() => setCat(null));
  }, []);

  useEffect(() => {
    if (!graphId) return;
    let alive = true;
    lastSaved.current = null;
    (async () => {
      try {
        await flushing.current;
        const got = await api.getGraph(graphId, wanted);
        if (!alive) return;
        setGraph(got);
        setTitle(got.name);
        const [ns, es] = toFlow(got.doc, byOp, togglePin);
        setNodes(ns);
        setEdges(es);
        lastSaved.current = JSON.stringify(toDoc(ns, es));
        history.current = hist.start(lastSaved.current);
        setChanged(Boolean(got.changed));
        setSaveState("saved");
        setSavedAt(got.draft_at ? new Date(got.draft_at).getTime() : null);
        setVersions((await api.listVersions(graphId)).versions);
        // Первый показ: вписать граф, когда библиотека уже знает размеры карточек.
        window.requestAnimationFrame(() => void fitView({ maxZoom: 1, padding: 0.2 }));
      } catch (e) {
        if (!alive) return;
        if (isMissing(e)) setMissing(true);
        else setProblem((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
    // byOp нарочно не в зависимостях: каталог приходит позже и не должен перезатирать правку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId, wanted, setNodes, setEdges]);

  // Давность сохранения в шапке тикает сама.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [savedAt]);

  // Числа на проводах считает браузер — иначе они появлялись бы с задержкой на каждое движение.
  // Поломку графа счёт возвращает рядом с числами, а не кладёт в состояние: иначе круг «провода → числа → провода».
  const plan = useMemo(() => {
    try {
      return { totals: counts(toDoc(nodes, edges), SAMPLE_BASE, groups), flaw: null as string | null };
    } catch (e) {
      return { totals: null, flaw: e instanceof GraphError ? e.message : (e as Error).message };
    }
  }, [nodes, edges, groups]);
  const totals = plan.totals;
  // Ответ сервера относится к отправленному графу: любая правка его снимает.
  const docKey = useMemo(() => JSON.stringify(toDoc(nodes, edges)), [nodes, edges]);
  useEffect(() => setProblem(null), [docKey]);

  const killWire = useCallback((id: string) => setEdges((old) => old.filter((e) => e.id !== id)), [setEdges]);

  // Провода, как их видит холст: число, подсветка и способ себя убрать.
  const wires = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        data: {
          ...(e.data ?? {}),
          amount: totals?.edges[e.id] ?? 0,
          hot: Boolean(selected) && (e.source === selected || e.target === selected),
          aim: e.id === aim,
          kill: readOnly ? undefined : killWire,
        } satisfies WireData,
      })),
    [edges, totals, killWire, readOnly, selected, aim]
  );

  const canConnect = useCallback(
    (conn: Connection | Edge) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return false;
      // Занятое гнездо не отвергаем: прежний провод из него уйдёт.
      const doc = toDoc(nodes, [
        ...edges.filter((e) => !occupies(e, conn)),
        { id: "probe", source: conn.source, target: conn.target, sourceHandle: conn.sourceHandle ?? "out", targetHandle: conn.targetHandle ?? "in" } as Edge,
      ]);
      return !findCycle(doc.nodes, doc.edges);
    },
    [edges, nodes]
  );

  const onConnect = useCallback(
    (conn: Connection) => setEdges((old) => addEdge({ ...conn, id: wireId(conn), type: "volume" }, old.filter((e) => !occupies(e, conn)))),
    [setEdges]
  );

  // Провод перецепляется за конец; брошенный мимо всякого гнезда — снят.
  const moved = useRef(false);
  const onReconnectStart = useCallback(() => {
    moved.current = false;
  }, []);
  const onReconnect = useCallback(
    (old: Edge, conn: Connection) => {
      moved.current = true;
      setEdges((list) => [
        ...list.filter((e) => e.id !== old.id && !occupies(e, conn)),
        { ...old, id: wireId(conn), source: conn.source, sourceHandle: conn.sourceHandle, target: conn.target, targetHandle: conn.targetHandle },
      ]);
    },
    [setEdges]
  );
  const onReconnectEnd = useCallback(
    (_event: unknown, edge: Edge, _side: unknown, state: { toHandle: unknown | null }) => {
      // На гнездо, куда нельзя (вышло бы кольцо), провод возвращается на место.
      if (!moved.current && !state?.toHandle) killWire(edge.id);
    },
    [killWire]
  );

  /** Провод под точкой экрана: ближайший в пределах 14 px экрана при любом масштабе. */
  const wireAt = useCallback(
    (x: number, y: number): string | null => {
      const p = screenToFlowPosition({ x, y });
      const tol = 14 / getZoom();
      let best: string | null = null;
      let bestD = tol;
      for (const g of wrap.current?.querySelectorAll<SVGGElement>(".react-flow__edge[data-id]") ?? []) {
        const path = g.querySelector<SVGPathElement>("path.ge-wire");
        if (!path) continue;
        const len = path.getTotalLength();
        const step = Math.max(2, tol / 2);
        for (let s = 0; s <= len; s += step) {
          const q = path.getPointAtLength(s);
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < bestD) {
            bestD = d;
            best = g.dataset.id ?? null;
          }
        }
      }
      return best;
    },
    [screenToFlowPosition, getZoom]
  );

  const addNode = useCallback(
    (kind: string, params: Record<string, unknown>, at?: { x: number; y: number }, into?: string | null) => {
      const id = freshId(kind, new Set(live.current.nodes.map((n) => n.id)));
      const box = wrap.current?.getBoundingClientRect();
      const data = { kind, params, catalogue: byOp.get((params.op as string) ?? ""), onEye: togglePin } as NodeData;
      const pins = onePort(data, id);
      // Брошенный на провод встаёт в разрыв; по щелчку — в цепочку, висящий сам по себе узел не сохранить.
      const wire = !pins ? null
        : into ? live.current.edges.find((e) => e.id === into) ?? null
        : at || !SPLICE.has(kind) ? null : spliceWire(live.current.nodes, live.current.edges);
      const fit = wire && pins ? roomIn(live.current.nodes, wire, at?.y) : null;
      const point = fit?.at ?? at ?? screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 600) / 2, y: (box?.top ?? 0) + 160 });
      if (wire && pins) setEdges((old) => splice(old, wire, id, pins));
      setNodes((old0) => {
        // Тесно — сдвигаем всё правее точки вставки, чтобы узлы не легли друг на друга.
        const old = fit ? pushRight(old0, fit.from, fit.shift) : old0;
        // Второй «Источник» получает свободный номер: сервер не примет два одинаково подписанных.
        let fresh = params;
        if (kind === "source") {
          const taken = new Set(old.filter((n) => (n.data as NodeData).kind === "source").map((n) => String((n.data as NodeData).params.label ?? "")));
          if (taken.size) {
            let k = taken.size + 1;
            while (taken.has(`Источник ${k}`)) k++;
            fresh = { ...params, label: `Источник ${k}`, name: `Источник ${k}` };
          }
        }
        // Выделение с прежнего снимаем: иначе шторка осталась бы на старом узле.
        return [...old.map((n) => ({ ...n, selected: false })), { id, type: kind, position: point, selected: true, data: { ...data, params: fresh } } as Node];
      });
      setSelected(id);
    },
    [byOp, screenToFlowPosition, setNodes, setEdges]
  );

  const patchParams = useCallback(
    (id: string, next: Record<string, unknown>) => {
      setNodes((old) => old.map((n) => (n.id === id ? { ...n, data: { ...(n.data as NodeData), params: { ...(n.data as NodeData).params, ...next } } } : n)));
      // Веток, входов или ячеек стало меньше — провода с исчезнувших гнёзд уходят той же правкой.
      const was = live.current.nodes.find((n) => n.id === id);
      if (!was) return;
      const d = was.data as NodeData;
      const after = { id, type: d.kind, params: { ...d.params, ...next } } as GraphNode;
      setEdges((old) => {
        const keepEdges = old.filter((e) => fitsPorts(after, { from: e.source, out: e.sourceHandle ?? "out", to: e.target, in: e.targetHandle ?? "in" }));
        return keepEdges.length === old.length ? old : keepEdges;
      });
    },
    [setNodes, setEdges]
  );

  const removeNode = useCallback(
    (id: string) => {
      setNodes((old) => old.filter((n) => n.id !== id));
      setEdges((old) => old.filter((e) => e.source !== id && e.target !== id));
      setSelected(null);
    },
    [setNodes, setEdges]
  );

  const unlink = useCallback((id: string) => setEdges((old) => old.filter((e) => e.source !== id && e.target !== id)), [setEdges]);

  const openMenu = useCallback(
    (event: ReactMouseEvent, node: Node) => {
      if (readOnly) return;
      event.preventDefault();
      const box = wrap.current?.getBoundingClientRect();
      if (!box) return;
      // Меню не уезжает за край холста у карточки в углу.
      setMenu({ id: node.id, x: Math.min(event.clientX - box.left + 4, box.width - 240), y: Math.min(event.clientY - box.top + 4, box.height - 110) });
    },
    [readOnly]
  );

  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  // Висящий узел с одним входом и выходом, брошенный на провод, тоже встаёт в разрыв.
  const spliceable = useCallback(
    (node: Node) => !readOnly && Boolean(onePort(node.data as NodeData, node.id)) && !live.current.edges.some((e) => e.source === node.id || e.target === node.id),
    [readOnly]
  );
  const onNodeDrag = useCallback(
    (event: MouseEvent | TouchEvent, node: Node) => setAim(spliceable(node) ? wireAt(...pointOf(event)) : null),
    [spliceable, wireAt]
  );
  const onNodeDragStop = useCallback(
    (event: MouseEvent | TouchEvent, node: Node) => {
      setAim(null);
      if (!spliceable(node)) return;
      const wire = live.current.edges.find((e) => e.id === wireAt(...pointOf(event)));
      const pins = onePort(node.data as NodeData, node.id);
      if (!wire || !pins) return;
      setEdges((old) => splice(old, wire, node.id, pins));
      const fit = roomIn(live.current.nodes, wire, node.position.y);
      if (fit) setNodes((old) => pushRight(old, fit.from, fit.shift, node.id).map((n) => (n.id === node.id ? { ...n, position: fit.at } : n)));
    },
    [spliceable, wireAt, setEdges, setNodes]
  );

  const onDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    setAim(null);
    const raw = event.dataTransfer.getData(NODE_MIME);
    if (!raw || readOnly) return;
    const { kind, params } = JSON.parse(raw);
    const p = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    // Карточка встаёт серединой под курсор, а не левым верхним углом.
    addNode(kind, params, { x: p.x - 80, y: p.y - 34 }, wireAt(event.clientX, event.clientY));
  };
  const onDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const hit = wireAt(event.clientX, event.clientY);
    if (hit !== aim) setAim(hit);
  };

  // Сколько выходит из узла и висит ли он сам по себе — для карточки. Здесь же
  // доклеивается каталог: он приходит позже графа.
  const onParams = readOnly ? undefined : patchParams;
  const shown = useMemo(() => {
    const out = new Map<string, number>();
    const into = new Map<string, number>();
    const linked = new Set<string>();
    for (const e of edges) {
      const v = totals?.edges[e.id] ?? 0;
      out.set(e.source, (out.get(e.source) ?? 0) + v);
      into.set(e.target, (into.get(e.target) ?? 0) + v);
      linked.add(e.source);
      linked.add(e.target);
    }
    return nodes.map((n) => {
      const d = n.data as NodeData;
      const catalogue = d.catalogue ?? byOp.get((d.params.op as string) ?? "");
      const amount = !totals ? undefined : d.kind === "output" ? into.get(n.id) ?? 0 : d.kind === "source" ? out.get(n.id) ?? 0 : undefined;
      const loose = !linked.has(n.id);
      const eye = n.id === eyeOn;
      return Boolean(d.eye) === eye && catalogue === d.catalogue && d.onParams === onParams && d.amount === amount && Boolean(d.loose) === loose
        ? n
        : { ...n, data: { ...d, eye, catalogue, onParams, amount, loose } };
    });
  }, [nodes, edges, totals, eyeOn, byOp, onParams]);
  const draft = useMemo(() => toDoc(nodes, edges), [nodes, edges]);

  // Снимок в историю — когда правка улеглась: протяжка даёт десятки промежуточных состояний.
  useEffect(() => {
    if (readOnly || lastSaved.current === null) return;
    const text = JSON.stringify(draft);
    const timer = window.setTimeout(() => {
      history.current = hist.record(history.current, text);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft, readOnly]);

  /** Вернуть холст к снимку. Узлы, что были на холсте, сохраняют своё — меняются место и параметры. */
  const restore = useCallback(
    (text: string) => {
      const doc = JSON.parse(text) as GraphDoc;
      const [fresh, es] = toFlow(doc, byOp, togglePin);
      setNodes((old) => {
        const had = new Map(old.map((n) => [n.id, n]));
        return fresh.map((n) => {
          const was = had.get(n.id);
          return was ? { ...was, position: n.position, data: { ...(was.data as NodeData), params: (n.data as NodeData).params } } : n;
        });
      });
      setEdges(es);
    },
    [byOp, setNodes, setEdges]
  );

  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const act = hist.keyAction(e);
      if (!act) return;
      // В текстовом поле Ctrl+Z — отмена набора в поле; ползунок и флажок полями набора не считаются.
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, select, [contenteditable='true']") || (t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(t.type))) return;
      e.preventDefault();
      const nowDoc = JSON.stringify(toDoc(live.current.nodes, live.current.edges));
      const [next, doc] = (act === "undo" ? hist.undo : hist.redo)(history.current, nowDoc);
      history.current = next;
      if (doc !== null) restore(doc);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, restore]);

  // Автосохранение черновика: сравнивается весь документ, с координатами. Выделение в него не входит.
  useEffect(() => {
    if (!graphId || readOnly || lastSaved.current === null) return;
    const text = JSON.stringify(draft);
    if (text === lastSaved.current) return;
    pending.current = draft;
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const got = await api.saveDraft(graphId, draft);
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

  // Ушли, не дождавшись паузы, — последняя правка уходит сразу: и при уходе внутри
  // приложения, и при закрытии вкладки (pagehide), и при смене версии в выпадашке.
  useEffect(() => {
    const flush = () => {
      const doc = pending.current;
      if (graphId && doc && JSON.stringify(doc) !== lastSaved.current) {
        pending.current = null;
        flushing.current = api.saveDraft(graphId, doc, true).catch(() => undefined);
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
      const got = await api.saveVersion(graphId, toDoc(nodes, edges));
      setGraph(got);
      setChanged(false);
      setVersions((await api.listVersions(graphId)).versions);
      setNote(got.fresh === false || got.version === graph?.version ? "Изменений нет — версия та же." : `Сохранено: версия ${got.version}.`);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [graphId, nodes, edges, graph?.version]);

  /** Сохранить имя. Пустое не отправляем: граф без имени не найти в списке. */
  const rename = useCallback(async () => {
    const clean = title.trim();
    if (!graphId || !graph || !clean || clean === graph.name) {
      setTitle(graph?.name ?? "");
      return;
    }
    try {
      await api.patchGraph(graphId, { name: clean });
      setGraph({ ...graph, name: clean });
    } catch (e) {
      setProblem((e as Error).message);
      setTitle(graph.name);
    }
  }, [graphId, graph, title]);

  // Граница холста и шторки: тянется мышью и стрелками, двойной щелчок — как было.
  const room = () => main.current?.clientHeight ?? 800;
  const setDrawer = (h: number, remember = true) => {
    const v = clampDrawer(h, room());
    setDrawerH(v);
    if (remember) keep(DRAWER_KEY, v);
  };
  const grab = useRef<{ y: number; h: number } | null>(null);

  const current = nodes.find((n) => n.id === selected) ?? null;
  const pinned = eyeOn && nodes.some((n) => n.id === eyeOn) ? eyeOn : null;
  const currentShown = shown.find((n) => n.id === selected) ?? null;
  if (missing) return <NotFound message="Граф не найден: его удалили или ссылка неверна." back="/augment" backLabel="К моим графам" />;
  // Сохранять мешает только поломка самого графа; отказ сервера — разовое событие.
  const trouble = plan.flaw;
  const nextVersion = Math.max(0, ...versions.map((v) => v.version)) + 1;
  const output = nodes.find((n) => (n.data as NodeData).kind === "output") ?? null;
  const sources = nodes.filter((n) => (n.data as NodeData).kind === "source").length;

  const saveText = readOnly ? null
    : saveState === "saving" ? "сохраняю черновик…"
    : saveState !== "saved" ? `черновик не сохранился: ${saveState}`
    : savedAt ? `черновик сохранён ${sinceText(savedAt, now)}` : "черновик совпадает с версией";
  const sub = [
    saveText,
    graph ? (graph.version ? `версия ${graph.version} из ${versions.length || graph.version}` : "версий пока нет") : null,
    !readOnly && changed ? "правки вне версий" : null,
    totals ? `${mult(totals.multiplier)} к обучающей части` : null,
  ].filter(Boolean);

  const facts: [ReactNode, ReactNode][] = totals ? [
    ["На входе", <><span className="ui-mono">{ru(SAMPLE_BASE * Math.max(1, sources))}</span> <span className="t-faint">кадров, условно</span></>],
    ["В набор", <span className="ui-mono">{ru(totals.outputs)}</span>],
    ["Рост", <span className="ui-mono">{mult(totals.multiplier)}</span>],
  ] : [];
  if (totals && totals.dropped > 0) facts.push(["Брошено", <span className="ge-warn">{count(totals.dropped, "образец", "образца", "образцов")}</span>]);
  const summary = totals ? <Meta items={facts} /> : <p className="ge-loose">{trouble ?? "Граф пока не считается"}</p>;

  return (
    <div className="ge">
      <header className="ge-h">
        <LinkButton variant="ghost" icon="chevL" to={back} aria-label={back === "/augment" ? "К моим графам" : "К графам проекта"} />
        <div className="ge-title">
          {/* Имя правится здесь: его придумывают, глядя на собранный граф, а не на пустой холст. */}
          <input className="ge-name ui-ctl" value={title} disabled={readOnly} aria-label="Имя графа" size={Math.max(8, title.length)}
            onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setTitle(graph?.name ?? "");
            }} />
          <span className={saveState !== "saved" && saveState !== "saving" ? "bad" : undefined} role="status">{sub.join(" · ")}</span>
        </div>
        {readOnly && graph && <Badge icon="lock">{wanted ? "старая версия — только чтение" : "чужой граф — только чтение"}</Badge>}
        <span className="grow" />
        <Select size="sm" icon="clock" label="Версия" value={wanted ?? "draft"} onChange={(v) => goVersion(v === "draft" ? null : v)}
          options={[
            { value: "draft", label: "Черновик", hint: changed ? "есть правки вне версий" : "совпадает с последней версией" },
            ...versions.map((v) => ({
              value: v.id,
              label: `Версия ${v.version}`,
              hint: [new Date(v.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(".", ""), v.note].filter(Boolean).join(" · "),
            })),
          ]} />
        <Button size="sm" icon="images" disabled={!output} onClick={() => setSix(true)}
          title={output ? "Выход графа на шести случайных кадрах" : "В графе нет «Выхода»"}>Превью на 6 кадрах</Button>
        <Button size="sm" variant="primary" icon="save" disabled={busy || readOnly || Boolean(trouble)} onClick={save}
          title={trouble ? "Сперва почините граф — сохранять нечего" : "Создать новую версию"}>Сохранить версию {nextVersion}</Button>
      </header>

      <div className="ge-body">
        <div className="ge-main" ref={main} style={{ "--dh": `${drawerH}px` } as CSSProperties}>
          <div className="ge-canvas" ref={wrap}>
            <ReactFlow
              className="ge-flow"
              colorMode="dark"
              nodes={shown}
              edges={wires}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              // Правки принимаем всегда: без них холст не умеет даже выделять. Запреты ниже — точечные.
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodesDraggable={!readOnly}
              onConnect={readOnly ? undefined : onConnect}
              onReconnect={readOnly ? undefined : onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              reconnectRadius={12}
              // Отпущенный рядом с гнездом провод цепляется к нему, а не пропадает.
              connectionRadius={30}
              connectionLineComponent={WireDraft}
              edgesReconnectable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
              isValidConnection={canConnect}
              onSelectionChange={({ nodes: picked }) => setSelected(picked[0]?.id ?? null)}
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
              <Button size="sm" icon="fit" aria-label="Вписать граф" onClick={() => void fitView({ maxZoom: 1, padding: 0.2, duration: 200 })} />
              <Button size="sm" icon="zin" aria-label="Приблизить" onClick={() => void zoomIn({ duration: 150 })} />
              <Button size="sm" icon="zout" aria-label="Отдалить" onClick={() => void zoomOut({ duration: 150 })} />
            </div>
            {(trouble || problem || note) && (
              <div className="ge-notes">
                {/* Поломка графа без крестика: убрать её можно, только починив граф. */}
                {trouble && <Notice tone="warn">{trouble}</Notice>}
                {problem && !trouble && <Notice tone="error" onClose={() => setProblem(null)}>{problem}</Notice>}
                {note && <Notice tone="ok" onClose={() => setNote(null)}>{note}</Notice>}
              </div>
            )}
            {menu && nodes.some((n) => n.id === menu.id) && (
              <div className="ui-pop ge-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
                <MenuItem icon="eye" onSelect={() => { togglePin(menu.id); setMenu(null); }}>
                  {menu.id === eyeOn ? "Открепить превью" : "Закрепить в превью"}</MenuItem>
                <MenuItem icon="x" disabled={!edges.some((e) => e.source === menu.id || e.target === menu.id)}
                  onSelect={() => { unlink(menu.id); setMenu(null); }}>Убрать все связи</MenuItem>
                <MenuItem icon="trash" danger hint="Delete" onSelect={() => { removeNode(menu.id); setMenu(null); }}>Удалить узел</MenuItem>
              </div>
            )}
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
            onDoubleClick={() => setDrawer(DRAWER_DEFAULT)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                setDrawer(drawerH + (e.key === "ArrowUp" ? 24 : -24));
              }
            }}>
            <i />
          </div>

          <div className="ge-drawer">
            <NodeInspector
              node={current}
              catalogue={cat}
              readOnly={readOnly}
              totals={totals}
              loose={Boolean((currentShown?.data as NodeData | undefined)?.loose)}
              onChange={(next) => current && patchParams(current.id, next)}
              onRemove={() => current && removeNode(current.id)}
              pinned={Boolean(current) && current?.id === eyeOn}
              onPin={() => current && togglePin(current.id)}
            />
            {graphId && (
              <NodePreview
                frame={frame}
                doc={draft}
                nodes={shown}
                byOp={byOp}
                watch={pinned ?? (selected && nodes.some((n) => n.id === selected) ? selected : null)}
                pinned={Boolean(pinned)}
                onPin={setEyeOn}
                summary={summary}
              />
            )}
          </div>
        </div>

        <NodePalette catalogue={cat} onPick={(kind, params) => addNode(kind, params)} disabled={readOnly} />
      </div>

      <SixPreview open={six} onClose={() => setSix(false)} doc={draft} node={output?.id ?? null}
        nodeTitle={output ? titleOf(output.data as NodeData) : ""} frame={frame} />
    </div>
  );
}

export default function AugGraphEditor() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
