// Редактор графа аугментаций.
//
// Черновик сохраняется сам, версия — нет. Версию создаёт явное «Сохранить
// версию»: иначе автосохранение нарожает сотню версий за вечер и обесценит
// саму запись «набор собран версией 7».

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
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
import { GraphError, counts, edgeKey, findCycle } from "./counts";
import { edgeTypes, nodeTypes, ru, type NodeData, type WireData } from "./GraphNodes";
import NodeInspector from "./NodeInspector";
import NodePalette from "./NodePalette";

// Сколько кадров показывать на проводах, пока набор не выбран. Число условное
// и подписано как условное: важны не сами кадры, а во сколько раз их станет
// больше.
const SAMPLE_BASE = 1000;

let seq = 0;
const freshId = (kind: string) => `${kind}${++seq}${Date.now() % 1000}`;

// Номер провода один и тот же у холста и у счёта чисел. Библиотека умеет
// придумывать номера сама, но свои — и тогда число с провода, посчитанное по
// «откуда:гнездо->куда:гнездо», к нему не привязывалось бы: на всяком только
// что протянутом проводе стоял бы прочерк.
const wireId = (c: {
  source?: string | null;
  sourceHandle?: string | null;
  target?: string | null;
  targetHandle?: string | null;
}) =>
  edgeKey({
    from: c.source ?? "",
    out: c.sourceHandle ?? "out",
    to: c.target ?? "",
    in: c.targetHandle ?? "in",
  });

// Провод, приходящий в это же входное гнездо. В одно гнездо провод только
// один — два потока, слитые молча, это «Слияние», и оно обязано быть узлом.
const occupies = (e: Edge, c: { target?: string | null; targetHandle?: string | null }) =>
  e.target === c.target && (e.targetHandle ?? null) === (c.targetHandle ?? null);

function toFlow(
  doc: GraphDoc,
  catalogue: Map<string, CatalogueNode>,
  groups: Record<string, { in: string[]; out: string[]; name?: string; version?: number }>,
  totals: Record<string, number>,
  onEye: (id: string) => void,
  eyeOn: string | null
): [Node[], Edge[]] {
  const nodes: Node[] = doc.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0 },
    data: {
      kind: n.type,
      params: n.params ?? {},
      catalogue: catalogue.get((n.params?.op as string) ?? ""),
      group: groups[n.id],
      total: totals[n.id],
      eye: eyeOn === n.id,
      onEye,
    } satisfies NodeData,
  }));
  const edges: Edge[] = doc.edges.map((e) => ({
    id: edgeKey(e),
    source: e.from,
    sourceHandle: e.out,
    target: e.to,
    targetHandle: e.in,
    type: "volume",
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

  const [graph, setGraph] = useState<api.GraphDetail | null>(null);
  const [cat, setCat] = useState<api.Catalogue | null>(null);
  const [versions, setVersions] = useState<api.VersionRow[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [eyeOn, setEyeOn] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const byOp = useMemo(
    () => new Map((cat?.nodes ?? []).map((n) => [n.op, n])),
    [cat]
  );

  // Старую версию и чужой граф смотрят, но не правят.
  const readOnly = Boolean(wanted) || (graph ? !graph.mine : false);

  // Гнёзда блоков объявлены во вложенных версиях — их знает только сервер, и
  // множитель блока приходит оттуда же, из паспорта версии.
  const groups = useMemo(() => {
    const out: Record<
      string,
      { ports?: { in: string[]; out: string[] }; multiplier?: number }
    > = {};
    nodes.forEach((n) => {
      const data = n.data as NodeData;
      if (data.kind === "group" && data.group) {
        out[n.id] = {
          ports: { in: data.group.in, out: data.group.out },
          multiplier: (data.params.multiplier as number) ?? 1,
        };
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
    (async () => {
      try {
        const got = await api.getGraph(graphId, wanted);
        if (!alive) return;
        setGraph(got);
        const [ns, es] = toFlow(got.doc, byOp, {}, {}, setEyeOn, null);
        setNodes(ns);
        setEdges(es);
        setVersions((await api.listVersions(graphId)).versions);
      } catch (e) {
        if (alive) setProblem((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
    // byOp нарочно не в зависимостях: каталог приходит позже и не должен
    // перезатирать уже начатую правку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId, wanted, setNodes, setEdges]);

  // Числа на проводах. Считает браузер — иначе они появлялись бы через
  // поездку на сервер, то есть с задержкой на каждое движение мышью.
  //
  // Счёт возвращает и поломку графа рядом с числами, а не кладёт её в
  // состояние: правка состояния прямо во время отрисовки, а следом эффект,
  // дописывающий числа обратно в провода, замыкали круг «провода → числа →
  // провода» — редактор крутился без остановки и не отдавал управление даже
  // на переход по ссылке.
  const plan = useMemo(() => {
    try {
      return {
        totals: counts(toDoc(nodes, edges), SAMPLE_BASE, groups),
        flaw: null as string | null,
      };
    } catch (e) {
      return {
        totals: null,
        flaw: e instanceof GraphError ? e.message : (e as Error).message,
      };
    }
  }, [nodes, edges, groups]);
  const totals = plan.totals;

  const killWire = useCallback(
    (id: string) => setEdges((old) => old.filter((e) => e.id !== id)),
    [setEdges]
  );

  // Провода, как их видит холст: число сверху и способ себя убрать. Отдельно
  // от состояния — иначе дописывание чисел снова стало бы правкой проводов.
  const wires = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        data: {
          ...(e.data ?? {}),
          amount: totals?.edges[e.id] ?? 0,
          kill: readOnly ? undefined : killWire,
        } satisfies WireData,
      })),
    [edges, totals, killWire, readOnly]
  );

  const canConnect = useCallback(
    (conn: Connection | Edge) => {
      if (!conn.source || !conn.target) return false;
      if (conn.source === conn.target) return false;
      // Занятое входное гнездо connection не отвергает: прежний провод из него
      // уйдёт. Отказ молчал — человек тянул провод, отпускал, и ничего не
      // происходило, будто холст сломан.
      const doc = toDoc(nodes, [
        ...edges.filter((e) => !occupies(e, conn)),
        {
          id: "probe",
          source: conn.source,
          target: conn.target,
          sourceHandle: conn.sourceHandle ?? "out",
          targetHandle: conn.targetHandle ?? "in",
        } as Edge,
      ]);
      return !findCycle(doc.nodes, doc.edges);
    },
    [edges, nodes]
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((old) =>
        addEdge(
          { ...conn, id: wireId(conn), type: "volume" },
          // Прежний провод из этого гнезда уходит: в одно гнездо приходит
          // ровно один. Так же ведёт себя всякий нодовый редактор, и так же
          // проверяет граф сервер.
          old.filter((e) => !occupies(e, conn))
        )
      );
    },
    [setEdges]
  );

  // Провод можно перецепить за конец. Брошенный мимо всякого гнезда — снят:
  // это самый короткий способ убрать провод, помимо крестика на нём и клавиши
  // Delete.
  const moved = useRef(false);
  const onReconnectStart = useCallback(() => {
    moved.current = false;
  }, []);
  const onReconnect = useCallback(
    (old: Edge, conn: Connection) => {
      moved.current = true;
      setEdges((list) => [
        ...list.filter((e) => e.id !== old.id && !occupies(e, conn)),
        {
          ...old,
          id: wireId(conn),
          source: conn.source,
          sourceHandle: conn.sourceHandle,
          target: conn.target,
          targetHandle: conn.targetHandle,
        },
      ]);
    },
    [setEdges]
  );
  const onReconnectEnd = useCallback(
    (
      _event: unknown,
      edge: Edge,
      _side: unknown,
      state: { toHandle: unknown | null }
    ) => {
      // Мимо гнезда — снимаем. На гнездо, куда нельзя (вышло бы кольцо), —
      // возвращаем на место: пропасть от неудачного попадания провод не
      // должен.
      if (!moved.current && !state?.toHandle) killWire(edge.id);
    },
    [killWire]
  );

  const addNode = useCallback(
    (kind: string, params: Record<string, unknown>, at?: { x: number; y: number }) => {
      const id = freshId(kind);
      const box = wrap.current?.getBoundingClientRect();
      const point =
        at ??
        screenToFlowPosition({
          x: (box?.left ?? 0) + (box?.width ?? 600) / 2,
          y: (box?.top ?? 0) + 160,
        });
      setNodes((old) => [
        // Снимаем выделение с прежнего: холст держит своё состояние выделения,
        // и без этого инспектор оставался бы пустым сразу после добавления.
        ...old.map((n) => ({ ...n, selected: false })),
        {
          id,
          type: kind,
          position: point,
          selected: true,
          data: {
            kind,
            params,
            catalogue: byOp.get((params.op as string) ?? ""),
            eye: false,
            onEye: setEyeOn,
          } as NodeData,
        } as Node,
      ]);
      setSelected(id);
    },
    [byOp, screenToFlowPosition, setNodes]
  );

  const patchParams = useCallback(
    (id: string, next: Record<string, unknown>) => {
      setNodes((old) =>
        old.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...(n.data as NodeData),
                  params: { ...(n.data as NodeData).params, ...next },
                },
              }
            : n
        )
      );
    },
    [setNodes]
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
      const got = await api.saveVersion(graphId, toDoc(nodes, edges));
      setGraph(got);
      setVersions((await api.listVersions(graphId)).versions);
      setNote(
        got.fresh === false || got.version === graph?.version
          ? "Изменений нет — версия та же."
          : `Сохранено: версия ${got.version}.`
      );
      if (wanted) setSearch({});
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [graphId, nodes, edges, graph?.version, wanted, setSearch]);

  const current = nodes.find((n) => n.id === selected) ?? null;
  // Поломку графа показываем рядом с сорванной загрузкой: и то, и другое
  // мешает сохранить версию, и человеку важно видеть, что именно.
  const trouble = problem ?? plan.flaw;

  return (
    <div className="g-ged">
      <NodePalette
        catalogue={cat}
        onPick={(kind, params) => addNode(kind, params)}
        disabled={readOnly}
      />

      <div className="g-canvas">
        <div className="g-canvas-top">
          <Link to="/augment" className="g-ctx-back" title="К библиотеке">
            ←
          </Link>
          <span className="ttl">{graph?.name ?? "Граф"}</span>
          <span className="ver">
            версия {graph?.version ?? "—"} из {versions.length || "—"}
          </span>
          {totals && (
            <span className="ver" title="Во столько раз вырастет обучающая часть">
              ×{totals.multiplier.toLocaleString("ru-RU")}
            </span>
          )}
          {readOnly && (
            <span className="pill wait">
              {wanted ? "старая версия · только чтение" : "чужой граф"}
            </span>
          )}
          <div className="sp">
            <select
              
              value={wanted ?? ""}
              onChange={(e) =>
                e.target.value ? setSearch({ version: e.target.value }) : setSearch({})
              }
              aria-label="Версия"
            >
              <option value="">текущая</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  версия {v.version}
                  {v.note ? ` · ${v.note}` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="mag-btn"
              disabled={busy || readOnly || Boolean(trouble)}
              onClick={save}
              title={
                trouble
                  ? "Сперва почините граф — сохранять нечего"
                  : "Создать новую версию"
              }
            >
              Сохранить версию
            </button>
          </div>
        </div>

        {trouble && <div className="mag-error">{trouble}</div>}
        {note && <div className="mag-ok">{note}</div>}

        <div className="g-canvas-body" ref={wrap}>
          <ReactFlow
            className="g-graph"
            nodes={nodes}
            edges={wires}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // Правки принимаем всегда: без них холст не умеет даже выделять,
            // и старую версию нельзя было бы разглядывать по узлам. Запреты
            // ниже — точечные: не тянуть, не соединять, не удалять.
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable={!readOnly}
            onConnect={readOnly ? undefined : onConnect}
            onReconnect={readOnly ? undefined : onReconnect}
            onReconnectStart={onReconnectStart}
            onReconnectEnd={onReconnectEnd}
            reconnectRadius={12}
            edgesReconnectable={!readOnly}
            nodesConnectable={!readOnly}
            // Delete — на клавиатуре, за которой сидят: библиотека по
            // умолчанию слушает только Backspace.
            deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
            isValidConnection={canConnect}
            onSelectionChange={({ nodes: picked }) =>
              setSelected(picked[0]?.id ?? null)
            }
            onDrop={(event) => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/mag-node");
              if (!raw || readOnly) return;
              const { kind, params } = JSON.parse(raw);
              addNode(
                kind,
                params,
                screenToFlowPosition({ x: event.clientX, y: event.clientY })
              );
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            fitView
            // Без потолка холст приближает граф из трёх узлов так, что
            // карточки выглядят вдвое крупнее задуманного.
            fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
            minZoom={0.25}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: "volume" }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="#232629"
            />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor="#32363a"
              maskColor="rgba(12,13,14,.72)"
            />
          </ReactFlow>
        </div>

        <div className="g-peek">
          <figure>
            <div className="blank">кадр-образец не выбран</div>
            <figcaption>Было</figcaption>
          </figure>
          <figure>
            <div className="blank">
              {eyeOn ? "нажмите «Показать»" : "выберите узел глазом"}
            </div>
            <figcaption>Стало</figcaption>
          </figure>
          <div className="side">
            <div className="row">
              <span>
                На проводах показано, что станет с{" "}
                <b>{ru(SAMPLE_BASE)}</b> кадрами. Настоящее число подставит
                мастер сборки.
              </span>
            </div>
            {totals && totals.dropped > 0 && (
              <div className="row" style={{ color: "var(--skip)" }}>
                Брошенных веток: {ru(totals.dropped)} образцов никуда не идут.
              </div>
            )}
          </div>
        </div>
      </div>

      <NodeInspector
        node={current}
        catalogue={cat}
        readOnly={readOnly}
        totals={totals}
        onChange={(next) => current && patchParams(current.id, next)}
        onRemove={() => current && removeNode(current.id)}
      />
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
