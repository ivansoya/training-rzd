// Превью агента: один кадр через черновик графа — вход и выход каждого узла.
//
// Считает training-worker на карте с тёплыми моделями (training_svc/agent_preview.py),
// пересчёт живой — через 300 мс после правки. Сервер отдаёт все узлы за один прогон:
// смена выбранного узла ничего не пересчитывает, а провода берут отсюда число рамок.
// Перемещение карточек тоже не пересчитывает: координаты в запрос не идут.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Node } from "@xyflow/react";
import * as api from "../../api/agents";
import type { AgentPreview as Result } from "../../api/agents";
import type { GraphDoc } from "../../api/aug";
import { Button, Dialog, Icon, Popover, Select, Switch } from "../../ui";
import { keep, load } from "../aug/NodePreview";
import { unfinished } from "./agentDoc";
import AgentFrame from "./AgentFrame";
import { agentTitle, type AgentNodeData } from "./AgentNodes";
import { droppedOf } from "./look";

const WAIT_MS = 300;
type Step = "same" | "next" | "prev" | "random";

export type AgentPreviewState = ReturnType<typeof useAgentPreview>;

/** Живое превью черновика: кадр проекта помнится на агента. `paused` — не звать сервер (идёт пакет на 6 кадров). */
export function useAgentPreview(graphId: string, doc: GraphDoc, enabled: boolean, paused: boolean) {
  const store = `agent-preview:${graphId}`;
  const [projects, setProjects] = useState<api.PreviewProject[] | null>(null);
  const [pick, setPick] = useState(() => load<{ project?: string; image?: string | null }>(store, {}));
  const [result, setResult] = useState<Result | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const step = useRef<Step>(pick.image ? "same" : "random");
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    api.previewProjects().then((r) => {
      setProjects(r.projects);
      setPick((p) => (p.project && r.projects.some((x) => x.code === p.project) ? p : { project: r.projects[0]?.code }));
    }).catch((e) => setProblem((e as Error).message));
  }, [enabled]);

  const graph = useMemo(() => ({ v: doc.v, nodes: doc.nodes.map(({ pos: _pos, ...n }) => n), edges: doc.edges, classes: doc.classes }), [doc]);
  const key = JSON.stringify(graph);
  // Заведомо неполный граф сервер не зовём: ответ «не выбраны веса» известен и так.
  const missing = unfinished(graph);

  useEffect(() => {
    if (!enabled || paused || !pick.project || missing) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const got = await api.runPreview(
          { graph_id: graphId, doc: graph, project: pick.project!, image_id: pick.image ?? null, step: step.current }, ctrl.signal);
        step.current = "same";
        setResult(got);
        setProblem(null);
        if (got.image.id !== pick.image) {
          const next = { project: pick.project, image: got.image.id };
          keep(store, next);
          setPick(next);
        }
      } catch (e) {
        const err = e as Error & { payload?: { superseded?: boolean } };
        if (err.name === "AbortError" || err.payload?.superseded) return;
        // Прошлый кадр с рамками под ошибкой читался бы как ответ на эту правку.
        setResult(null);
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
  }, [key, enabled, paused, pick.project, nudge, graphId, missing]);

  const go = (s: Exclude<Step, "same">) => {
    step.current = s;
    setNudge((n) => n + 1);
  };
  const setProject = (code: string) => {
    step.current = "random";
    setPick({ project: code });
  };
  const project = projects?.find((p) => p.code === pick.project) ?? null;
  return { projects, project, setProject, result, problem: missing ? null : problem, busy, missing, go };
}

export default function AgentPreviewPane({ state, nodes, watch, pinned, onPin, colorOf, enabled }: {
  state: AgentPreviewState;
  nodes: Node[];
  /** Узел в превью: закреплённый, выделенный или «Выход». */
  watch: string | null;
  pinned: boolean;
  onPin: (id: string | null) => void;
  colorOf: (cls: string) => string;
  /** Чужой агент: превью считает только владелец. */
  enabled: boolean;
}) {
  const { projects, project, setProject, result, problem, busy, missing, go } = state;
  const [human, setHuman] = useState(() => load("agent-preview-human", true));
  const [full, setFull] = useState(false);
  const node = nodes.find((n) => n.id === watch);
  const d = node?.data as AgentNodeData | undefined;
  const trace = watch && result ? result.nodes[watch] : undefined;
  const layers = trace && {
    out: d?.kind === "frame" ? [] : trace.out,
    dropped: droppedOf(trace),
    samIn: d?.kind === "sam" ? trace.in : undefined,
    sam: d?.kind === "sam",
    human: human ? result!.human : [],
  };
  const setHumanKept = (v: boolean) => { setHuman(v); keep("agent-preview-human", v); };
  const frameText = result ? `${result.image.file_name} · ${result.image.width} × ${result.image.height}` : "";

  const nav = (big?: boolean) => (
    <>
      <Button size={big ? undefined : "sm"} variant="ghost" icon="chevL" disabled={!result} aria-label="Предыдущий кадр" onClick={() => go("prev")} />
      <Button size={big ? undefined : "sm"} variant="ghost" icon="shuffle" onClick={() => go("random")} disabled={!project}>Случайный</Button>
      <Button size={big ? undefined : "sm"} variant="ghost" icon="chevR" disabled={!result} aria-label="Следующий кадр" onClick={() => go("next")} />
    </>
  );

  let stage: ReactNode;
  if (!enabled) stage = <Empty icon="lock">Превью считает только владелец агента</Empty>;
  else if (missing) stage = <Empty icon="route">{missing}</Empty>;
  else if (problem) stage = <Empty icon="alert" bad>{problem}</Empty>;
  else if (projects && !projects.length) stage = <Empty icon="images">Нет проектов с кадрами — превью не на чем показать</Empty>;
  else if (!result || !layers) stage = <Empty>{busy ? "Считаю кадр…" : "Готовлю превью…"}</Empty>;
  else stage = <AgentFrame image={result.image} layers={layers} colorOf={colorOf} busy={busy} onOpen={() => setFull(true)} />;

  return (
    <section className="ge-sec ge-pv ae-pv">
      <div className="ge-sec-h">
        {/* Выбор в списке закрепляет узел, как глаз на карточке. */}
        <Select size="sm" icon={pinned ? "eye" : "pointer"} label="Узел в превью" value={watch ?? undefined} placeholder="Узел не выбран"
          onChange={(id) => onPin(id)} options={nodes.map((n) => ({ value: n.id, label: agentTitle(n.data as AgentNodeData) }))} />
        {watch && (
          <Button size="sm" variant="ghost" icon="eye" className={pinned ? "ge-pin on" : "ge-pin"} aria-pressed={pinned}
            onClick={() => onPin(pinned ? null : watch)}
            title={pinned ? "Открепить — превью снова пойдёт за выделением" : "Закрепить: превью останется на этом узле"}>
            {pinned ? "Закреплён" : "За выделением"}
          </Button>
        )}
        <span className="grow" />
        <Popover align="end" width={300} trigger={<Button size="sm" variant="ghost" icon="settings" aria-label="Настройки превью" />}>
          <div className="ge-pv-set">
            {projects && projects.length > 0 && (
              <div className="ui-field">
                <div className="ui-field-l"><label>Проект</label></div>
                <Select full size="sm" label="Проект" value={project?.code} onChange={setProject}
                  options={projects.map((p) => ({ value: p.code, label: p.name, hint: `${p.images} кадров` }))} />
              </div>
            )}
            <div className="ge-flag">
              <span>Разметка человека</span>
              <Switch checked={human} label="Разметка человека" onChange={setHumanKept} />
            </div>
          </div>
        </Popover>
        <Button size="sm" variant="ghost" icon="fit" disabled={!layers} aria-label="Превью во весь экран" onClick={() => setFull(true)} />
      </div>
      <div className="ge-pv-stage">{stage}</div>
      {result && !problem && !missing && (
        <>
          <div className="ae-pv-nav">{nav()}</div>
          <p className="t-xs t-faint">
            <span className="ae-pv-file t-ell" title={frameText}>{frameText}</span>
            {result.device === "cuda" ? "на карте" : "на процессоре"} · {result.ms} мс{project ? ` · ${project.name}` : ""}
            {result.note ? ` — ${result.note}` : ""}
          </p>
        </>
      )}

      <Dialog open={full && Boolean(layers)} onOpenChange={setFull} width={4000} height={4000} bare className="ge-full"
        title={d ? agentTitle(d) : "Превью"} desc={frameText}>
        {result && layers && (
          <div className="ge-full-b">
            <div className="ge-full-stage">
              <AgentFrame image={result.image} layers={layers} colorOf={colorOf} busy={busy} />
            </div>
            <div className="ge-full-bar">
              {nav(true)}
              <label className="ge-six-flag" htmlFor="ae-full-human">
                <Switch id="ae-full-human" checked={human} onChange={setHumanKept} />
                <span>Разметка человека</span>
              </label>
              <span className="grow" />
              {trace && <span className="t-sm t-muted">пришло <b className="ui-mono">{trace.in.length}</b> → ушло <b className="ui-mono">{trace.out.length}</b></span>}
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}

function Empty({ icon, bad, children }: { icon?: "lock" | "route" | "alert" | "images"; bad?: boolean; children: ReactNode }) {
  return (
    <div className={bad ? "ge-no-prev bad" : "ge-no-prev"}>
      {icon && <Icon name={icon} size={22} />}
      <span>{children}</span>
    </div>
  );
}
