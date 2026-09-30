// «Разметить агентом» в таске и строка хода прогона.
//
// Сопоставление классов агента с классами проекта спрашивается целиком при
// первом запуске в проекте и дальше приходит запомненным — сервер хранит его
// на пару «агент + проект». Одинаковые имена подставляются сами.
//
// Три режима (решения владельца 24.09.2026): новые кадры таски; каждый N-й
// кадр размечаемого ролика, кроме тех, где уже работал человек; разведка —
// агент смотрит ролики любого режима и отмечает, где что нашлось. Разведке
// сопоставление не нужно: в разметку она не пишет ничего.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import * as api from "../../api/agents";
import { useEscape } from "../mag/useEscape";
import { NumInput } from "../NumInput";
import { count, plural, ru } from "../ru";
import Sep from "../Sep";
import { useBackdrop } from "../useBackdrop";
import { useDialog } from "../useDialog";
import ScoutOverview from "./ScoutOverview";
import { sampledCount } from "./scoutMath";

const SOURCE_TITLE: Record<"files" | "videos", string> = {
  files: "Загружено файлами",
  videos: "Ролики",
};

const guess = (
  names: string[],
  classes: api.RunContext["classes"],
  saved: Record<string, string | null> | undefined
) => {
  const byName = new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const ids = new Set(classes.map((c) => c.id));
  const out: Record<string, string | null> = {};
  for (const name of names) {
    const kept = saved?.[name];
    out[name] =
      kept !== undefined && (kept === null || ids.has(kept))
        ? kept
        : byName.get(name.trim().toLowerCase()) ?? null;
  }
  return out;
};

export default function AgentRunDialog({
  taskId,
  onClose,
  onStarted,
}: {
  taskId: string;
  onClose: () => void;
  onStarted: (run: api.RunView) => void;
}) {
  const [ctx, setCtx] = useState<api.RunContext | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [versionId, setVersionId] = useState<string>("");
  const [sources, setSources] = useState<Set<"files" | "videos">>(new Set());
  const [mode, setMode] = useState<api.RunMode>("frames");
  const [videos, setVideos] = useState<Set<string>>(new Set());
  const [step, setStep] = useState(25);
  const [gap, setGap] = useState(2);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useDialog();
  useEscape(onClose);

  useEffect(() => {
    api
      .runContext(taskId)
      .then((got) => {
        setCtx(got);
        const first = got.agents[0];
        if (first) {
          setAgentId(first.id);
          setVersionId(first.head);
        }
        setSources(new Set((["files", "videos"] as const).filter((s) => got.sources[s].new > 0)));
      })
      .catch((e) => setError(e.message));
  }, [taskId]);

  const agent = ctx?.agents.find((a) => a.id === agentId);
  const version = agent?.versions.find((v) => v.id === versionId) ?? agent?.versions[0];
  const names = useMemo(() => version?.classes ?? [], [version]);

  // Новая версия или новый агент — сопоставление пересчитывается от
  // запомненного: у версии 3 может быть класс, которого не было у версии 2.
  useEffect(() => {
    if (ctx && agent) setMapping(guess(names, ctx.classes, ctx.mappings[agent.id]));
  }, [ctx, agent, names]);

  const auto = useMemo(() => {
    if (!ctx) return new Set<string>();
    const saved = agent ? ctx.mappings[agent.id] : undefined;
    return new Set(names.filter((n) => saved?.[n] === undefined && mapping[n]));
  }, [ctx, agent, names, mapping]);

  const eligible = (ctx?.videos ?? []).filter((v) => mode === "scout" || (v.mode === "annotate" && !v.closed));
  const chosen = eligible.filter((v) => videos.has(v.id));
  const total =
    mode === "frames"
      ? ctx ? [...sources].reduce((sum, s) => sum + ctx.sources[s].new, 0) : 0
      : chosen.reduce((sum, v) => sum + sampledCount(v.frames ?? 0, step), 0);
  const mapped = Object.values(mapping).filter(Boolean).length;
  const replacing = ctx ? [...sources].reduce((sum, s) => sum + ctx.sources[s].agent, 0) : 0;

  const start = async () => {
    if (!agent || !version) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(
        await api.startRun(taskId, {
          graph_id: agent.id,
          version_id: version.id,
          mode,
          sources: [...sources],
          videos: chosen.map((v) => v.id),
          step,
          gap,
          mapping,
        })
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mag-backdrop" {...useBackdrop(onClose)}>
      <div ref={box} className="mag-modal ag-run" role="dialog" aria-modal="true" aria-labelledby="ag-run-title"
        tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h1 id="ag-run-title">Разметить агентом</h1>
        {error && <div className="mag-error">{error}</div>}
        {!ctx && !error && <p className="ag-muted">Загружаю…</p>}

        {ctx && !ctx.can_run && (
          <p className="mag-error">Запускать агента можно в своей таске: исполнителю или администратору проекта.</p>
        )}

        {ctx && ctx.agents.length === 0 && (
          <div className="mag-empty-big">
            <b>Агентов с сохранённой версией нет.</b>
            <Link className="mag-btn" to="/agents">
              К агентам
            </Link>
          </div>
        )}

        {ctx && agent && (
          <>
            <div className="ag-two">
              <div className="mag-field">
                <label htmlFor="ag-agent">Агент</label>
                <select id="ag-agent" value={agentId} onChange={(e) => {
                  const next = ctx.agents.find((a) => a.id === e.target.value);
                  setAgentId(e.target.value);
                  setVersionId(next?.head ?? "");
                }}>
                  {ctx.agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div className="mag-field">
                <label htmlFor="ag-version">Версия</label>
                <select id="ag-version" value={version?.id ?? ""} onChange={(e) => setVersionId(e.target.value)}>
                  {agent.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      версия {v.version} — {new Date(v.created_at).toLocaleDateString("ru-RU")}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="g-pv-seg ag-modes" role="group" aria-label="Режим">
              {(
                [
                  ["frames", "Кадры"],
                  ["annotate", "Разметка ролика"],
                  ["scout", "Разведка"],
                ] as const
              ).map(([m, label]) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => {
                  setMode(m);
                  setVideos(new Set());
                }}>
                  {label}
                </button>
              ))}
            </div>

            {mode === "frames" ? (
              <div className="ag-run-sec">
                <span className="g-label">Что размечать</span>
                {(["files", "videos"] as const).map((s) => (
                  <label key={s} className="ag-blk">
                    <input
                      type="checkbox"
                      checked={sources.has(s)}
                      disabled={ctx.sources[s].new === 0}
                      onChange={(e) => {
                        const next = new Set(sources);
                        if (e.target.checked) next.add(s);
                        else next.delete(s);
                        setSources(next);
                      }}
                    />
                    <span>{SOURCE_TITLE[s]}</span>
                    <span className="n">
                      {ru(ctx.sources[s].new)}
                      <small>{plural(ctx.sources[s].new, "новый кадр", "новых кадра", "новых кадров")}</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="ag-run-sec">
                <span className="g-label">
                  {mode === "annotate" ? "Размечаемые ролики с незакрытой разметкой" : "Ролики таски"}
                </span>
                {eligible.length === 0 && <p className="ag-muted">Подходящих роликов нет.</p>}
                {eligible.map((v) => (
                  <label key={v.id} className="ag-blk">
                    <input
                      type="checkbox"
                      checked={videos.has(v.id)}
                      onChange={(e) => {
                        const next = new Set(videos);
                        if (e.target.checked) next.add(v.id);
                        else next.delete(v.id);
                        setVideos(next);
                      }}
                    />
                    <span className="mono ag-vname" title={v.file_name}>{v.file_name}</span>
                    <span className="n">
                      {v.frames == null ? "—" : ru(v.frames)}
                      <small>
                        {v.frames == null ? "кадров" : plural(v.frames, "кадр", "кадра", "кадров")} <Sep />{" "}
                        {v.mode === "cut" ? "нарезка" : "разметка"}
                      </small>
                    </span>
                  </label>
                ))}
                <div className="ag-two">
                  <div className="mag-field ag-num">
                    <label htmlFor="ag-step">Каждый N-й кадр</label>
                    <NumInput id="ag-step" min={1} max={10000} integer value={step}
                      onValue={(v) => v !== undefined && setStep(v)} />
                  </div>
                  {mode === "scout" && (
                    <div className="mag-field ag-num">
                      <label htmlFor="ag-gap">Склеивать разрывы до, с</label>
                      <NumInput id="ag-gap" min={0} max={60} step={0.5} value={gap}
                        onValue={(v) => v !== undefined && setGap(v)} />
                    </div>
                  )}
                </div>
                {mode === "annotate" && (
                  <p className="mag-note">Кадры, где уже работал человек, агент пропустит. Его рамки уйдут на проверку при закрытии разметки.</p>
                )}
              </div>
            )}

            {mode !== "scout" && <div className="ag-run-sec">
              <span className="g-label">
                Классы агента → классы проекта
                {auto.size > 0 && <> <Sep /> {auto.size} подставлено по имени</>}
              </span>
              <div className="ag-map-scroll">
                <table className="ag-map">
                  <tbody>
                    {names.map((name) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>
                          <select
                            aria-label={`Класс проекта для «${name}»`}
                            value={mapping[name] ?? ""}
                            onChange={(e) => setMapping({ ...mapping, [name]: e.target.value || null })}
                          >
                            <option value="">Не размечать</option>
                            {ctx.classes.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.class_index} — {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="auto">{auto.has(name) ? "по имени" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>}

            {mode === "frames" && replacing > 0 && (
              <p className="mag-note">
                На {ru(replacing)} {plural(replacing, "кадре", "кадрах", "кадрах")} уже есть непроверенная разметка агента — она будет заменена.
                Разметку людей агент не трогает.
              </p>
            )}
          </>
        )}

        <div className="ag-foot">
          <button type="button" className="mag-ghost" onClick={onClose}>
            Отмена
          </button>
          {ctx && agent && (
            <button
              type="button"
              className="mag-btn"
              disabled={busy || !ctx.can_run || total === 0 || (mode !== "scout" && mapped === 0)}
              title={mode !== "scout" && mapped === 0 ? "Сопоставьте хотя бы один класс" : undefined}
              onClick={start}
            >
              {mode === "scout"
                ? `Разведать ${count(chosen.length, "ролик", "ролика", "роликов")}`
                : `Разметить ${mode === "annotate" ? "до " : ""}${count(total, "кадр", "кадра", "кадров")}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS: Record<api.RunView["status"], string> = {
  queued: "в очереди",
  waiting_gpu: "ждёт видеокарту",
  running: "размечает",
  done: "готово",
  error: "ошибка",
  stopped: "остановлен",
};

/** Строка хода прогона в шапке таски. Опрос раз в две секунды — только пока
 *  прогон идёт и страница открыта. */
export function AgentRunBar({
  taskId,
  run,
  onRun,
  onFinished,
}: {
  taskId: string;
  run: api.RunView | null;
  onRun: (run: api.RunView | null) => void;
  onFinished: () => void;
}) {
  const active = run ? api.ACTIVE.includes(run.status) : false;
  const [statsOpen, setStatsOpen] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const poll = useCallback(async () => {
    try {
      const got = await api.runContext(taskId);
      const last = got.runs[0] ?? null;
      onRun(last);
      if (last && !api.ACTIVE.includes(last.status)) onFinished();
    } catch {
      /* следующий опрос попробует ещё раз */
    }
  }, [taskId, onRun, onFinished]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, [active, poll]);

  if (!run) return null;
  const pct = run.total ? Math.round((run.processed / run.total) * 100) : 0;
  return (
    <div className="ag-progress" role="status">
      <span className="ag-badge">
        {run.agent ?? "агент"} v{run.version}
      </span>
      <span className="mono">
        {ru(run.processed)} / {run.total == null ? "—" : ru(run.total)}
      </span>
      <Sep />
      <span>{run.status === "running" && run.mode === "scout" ? "разведывает" : STATUS[run.status]}</span>
      {run.status === "done" && (
        <>
          <Sep />
          <span>
            {run.mode === "scout"
              ? `разведано роликов: ${ru(run.stats.videos ?? 0)}, находки на ${ru(run.stats.frames ?? 0)} ${plural(run.stats.frames ?? 0, "кадре", "кадрах", "кадрах")}`
              : `${count(run.stats.boxes ?? 0, "рамка", "рамки", "рамок")} на ${ru(run.stats.frames ?? 0)} ${plural(run.stats.frames ?? 0, "кадре", "кадрах", "кадрах")}`}
          </span>
          {run.mode === "scout" && run.videos.length > 0 && (
            <button type="button" className="mag-ghost mag-ghost-inline" onClick={() => setStatsOpen(true)}>
              Статистика
            </button>
          )}
        </>
      )}
      {run.error && <span className="ag-warn-text">{run.error}</span>}
      {stopError && <span className="ag-warn-text">Не остановился: {stopError}</span>}
      {run.queue_reason && run.status === "waiting_gpu" && <span className="ag-muted">{run.queue_reason}</span>}
      {active && (
        <span className="bar">
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
      {active && (
        <button type="button" className="mag-ghost mag-ghost-inline" onClick={() => {
          setStopError(null);
          // Без catch отказ сервера уходил в pageerror, а человек видел
          // кнопку, которая «ничего не делает».
          api.stopRun(run.id).then(onRun, (e: Error) => setStopError(e.message));
        }}>
          Остановить
        </button>
      )}
      {!active && (
        <button type="button" className="mag-ghost mag-ghost-inline" onClick={() => onRun(null)}>
          Скрыть
        </button>
      )}
      {statsOpen && <ScoutOverview taskId={taskId} onClose={() => setStatsOpen(false)} />}
    </div>
  );
}
