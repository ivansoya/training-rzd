// Превью агента: один кадр через черновик графа, вход и выход выбранного узла.
//
// Решения владельца (24.09.2026). Считает training-worker на карте с тёплыми
// моделями (training_svc/agent_preview.py), пересчёт живой — через 300 мс
// после правки. Кадр не меняется, меняется набор рамок, поэтому шторки нет:
// выход узла — сплошным в цвет класса агента, отсеянное узлом — серым
// пунктиром. У «Уточнения SAM» полигон поверх исходной рамки, а там, где SAM
// не справился, — рамка с пометкой. «Разметка человека» — белым контуром.
//
// Сервер отдаёт вход и выход каждого узла за один прогон: смена выбранного
// узла ничего не пересчитывает. Перемещение карточек по холсту — тоже: в
// запрос уходит граф без координат.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../../api/agents";
import type { AgentPreview as Result, PreviewDet } from "../../api/agents";
import type { GraphDoc } from "../../api/aug";
import { TITLES, type AgentNodeData } from "./AgentNodes";

const WAIT_MS = 300;
const MIN_H = 220;
const DEFAULT_H = 380;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* не помним — не страшно */
  }
}

const ring = (pts: [number, number][]) => pts.map((p) => p.join(",")).join(" ");
const pct = (v: number) => v.toFixed(2).replace(".", ",");

function Det({ d, color, dashed, mark }: { d: PreviewDet; color: string; dashed?: boolean; mark?: string }) {
  const [x, y, w, h] = d.box;
  const style = { stroke: color, strokeDasharray: dashed ? "6 4" : undefined } as CSSProperties;
  return (
    <g>
      {d.parts ? (
        d.parts.map((p, i) => <polygon key={i} points={ring(p)} style={{ ...style, fill: `${color}26` }} />)
      ) : (
        <rect x={x} y={y} width={w} height={h} style={style} />
      )}
      <text x={x} y={y} style={{ fill: color }}>
        {`${d.cls} ${pct(d.conf)}${mark ? ` ${mark}` : ""}`}
      </text>
    </g>
  );
}

export default function AgentPreview({
  graphId,
  doc,
  node,
  colorOf,
}: {
  graphId: string;
  doc: GraphDoc;
  /** Выбранный узел; без выбора — «Выход». */
  node: { id: string; data: AgentNodeData } | null;
  colorOf: Map<string, { color: string }>;
}) {
  const saved = `agent-preview:${graphId}`;
  const [open, setOpen] = useState(() => load("agent-preview-open", true));
  const [height, setHeight] = useState(() => load("agent-preview-h", DEFAULT_H));
  const [projects, setProjects] = useState<{ code: string; name: string; images: number }[]>([]);
  const [pick, setPick] = useState(() => load<{ project?: string; image?: string | null }>(saved, {}));
  const [human, setHuman] = useState(() => load("agent-preview-human", true));
  const [result, setResult] = useState<Result | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const grab = useRef<{ y: number; h: number } | null>(null);
  const step = useRef<"same" | "next" | "prev" | "random">(pick.image ? "same" : "random");
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    api.previewProjects().then((r) => {
      setProjects(r.projects);
      setPick((p) => (p.project && r.projects.some((x) => x.code === p.project) ? p : { project: r.projects[0]?.code }));
    }).catch((e) => setProblem((e as Error).message));
  }, []);

  // Координаты карточек в запрос не идут: перетаскивание узла — не правка агента.
  const graph = useMemo(
    () => ({ v: doc.v, nodes: doc.nodes.map(({ pos: _pos, ...n }) => n), edges: doc.edges }),
    [doc]
  );
  const key = JSON.stringify(graph);

  useEffect(() => {
    if (!open || !pick.project) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const got = await api.runPreview(
          { graph_id: graphId, doc: graph, project: pick.project!, image_id: pick.image ?? null, step: step.current },
          ctrl.signal
        );
        step.current = "same";
        setResult(got);
        setProblem(null);
        if (got.image.id !== pick.image) {
          const next = { project: pick.project, image: got.image.id };
          keep(saved, next);
          setPick(next);
        }
      } catch (e) {
        const err = e as Error & { status?: number; payload?: { superseded?: boolean } };
        if (err.name === "AbortError" || err.payload?.superseded) return;
        setProblem(err.message);
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // `graph` меняется вместе с `key`; ключ — чтобы не дёргать сервер на тот же граф.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open, pick.project, nudge, graphId]);

  const go = (s: "next" | "prev" | "random") => {
    step.current = s;
    setNudge((n) => n + 1);
  };

  const target = node && (node.data.kind !== "frame") ? node : null;
  const outputId = doc.nodes.find((n) => n.type === "output")?.id;
  const shownId = target?.id ?? outputId;
  const trace = shownId && result ? result.nodes[shownId] : undefined;
  const kind = target?.data.kind ?? "output";
  const outIds = new Set(trace?.out.map((d) => d.id));
  const dropped = trace?.in.filter((d) => !outIds.has(d.id)) ?? [];
  const color = (cls: string) => colorOf.get(cls)?.color ?? "#9aa0a6";

  return (
    <section className="g-pv ag-pv" style={open ? { height } : undefined}>
      {open && (
        <div
          className="g-pv-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Высота превью"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            grab.current = { y: e.clientY, h: height };
          }}
          onPointerMove={(e) => {
            if (grab.current) setHeight(Math.max(MIN_H, grab.current.h - (e.clientY - grab.current.y)));
          }}
          onPointerUp={() => {
            grab.current = null;
            keep("agent-preview-h", height);
          }}
        />
      )}
      <div className="g-pv-head">
        <button type="button" className="mag-ghost" aria-expanded={open}
          onClick={() => { keep("agent-preview-open", !open); setOpen(!open); }}>
          {open ? "Скрыть превью" : "Превью"}
        </button>
        {open && (
          <>
            <b>{TITLES[kind]}</b>
            <span className="g-pv-vsep" />
            <label className="g-pv-pick">
              <span>Проект</span>
              <select className="g-pv-select" value={pick.project ?? ""}
                onChange={(e) => { step.current = "random"; setPick({ project: e.target.value }); }}>
                {projects.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </select>
            </label>
            <button type="button" className="mag-ghost" onClick={() => go("prev")} disabled={!result} title="Предыдущий кадр">←</button>
            <button type="button" className="mag-ghost" onClick={() => go("random")}>Случайный</button>
            <button type="button" className="mag-ghost" onClick={() => go("next")} disabled={!result} title="Следующий кадр">→</button>
            <label className="g-pv-chk">
              <input type="checkbox" checked={human} onChange={(e) => { keep("agent-preview-human", e.target.checked); setHuman(e.target.checked); }} />
              Разметка человека
            </label>
            <span className="g-pv-grow" />
            {trace && kind !== "output" && (
              <span className="mono">пришло {trace.in.length} → ушло {trace.out.length}</span>
            )}
            {trace && kind === "output" && <span className="mono">в разметку {trace.out.length}</span>}
            {result && (
              <span className="g-pv-lbl mono">
                {result.device === "cuda" ? "карта" : "процессор"} · {result.ms} мс
              </span>
            )}
          </>
        )}
      </div>
      {open && (
        <div className="ag-pv-body">
          {result?.note && <div className="g-pv-warn block">На процессоре — {result.note}</div>}
          {problem && <div className="g-pv-warn block">{problem}</div>}
          <div className="g-pv-stage">
            {!result ? (
              <p className="g-pv-empty">{busy ? "Считаю кадр…" : problem ? "" : "Выберите проект."}</p>
            ) : (
              <div className={`ag-pv-frame${busy ? " busy" : ""}`}
                style={{ "--ar": `${result.image.width} / ${result.image.height}` } as CSSProperties}>
                <img src={`/api/images/${result.image.id}/file`} alt={result.image.file_name} />
                <svg viewBox={`0 0 ${result.image.width} ${result.image.height}`} preserveAspectRatio="xMidYMid meet"
                  // Кадр идёт в полном размере, и подпись в его пикселях: ~1 % ширины
                  // — это около 13 px на экране при кадре, вписанном в док.
                  style={{ fontSize: Math.max(12, result.image.width / 95) }}>
                  {human && result.human.map((s, i) =>
                    s.type === "polygon"
                      ? (s.geometry.parts ?? []).map((p, k) => <polygon key={`${i}.${k}`} points={ring(p)} className="ag-pv-human" />)
                      : <rect key={i} x={s.geometry.x} y={s.geometry.y} width={s.geometry.w} height={s.geometry.h} className="ag-pv-human" />
                  )}
                  {dropped.map((d) => <Det key={`x${d.id}`} d={d} color="#8a8f98" dashed />)}
                  {kind === "sam" && trace?.in.map((d) => <Det key={`i${d.id}`} d={{ ...d, parts: undefined }} color={color(d.cls)} dashed />)}
                  {trace?.out.map((d) => (
                    <Det key={d.id} d={d} color={color(d.cls)}
                      mark={kind === "sam" ? (d.parts ? `SAM ${pct(d.sam ?? 0)}` : "SAM не справился") : undefined} />
                  ))}
                </svg>
                <div className="ag-pv-name mono">{result.image.file_name} · {result.image.width} × {result.image.height}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
