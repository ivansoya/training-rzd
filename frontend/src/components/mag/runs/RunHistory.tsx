// «Прогоны»: идущие и ждущие сверху, ниже история по дням; щелчок по строке — страница прогона.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import * as runsApi from "../../../api/runs";
import type { Run } from "../../../api/runs";
import { useLive } from "../../../live/LiveProvider";
import {
  AnchorButton, Avatar, Badge, Button, Card, Dot, Empty, MenuItem, Notice, PageHeader, Popover, Progress, Select, Seg, Spark,
} from "../../../ui";
import { count, plural } from "../../ru";
import { useConfirm } from "../tasks/Confirm";
import RunDialog, { seedOf } from "./RunDialog";
import type { RunSeed } from "./RunDialog";
import { progress, stageText } from "./runMath";
import { ACTIVE, FINISHED, STATUS, WAITING, clock, dec, duration, etaText, filterRuns, groupByDay } from "./runs";
import type { RunFilter } from "./runs";

const PAGE = 20;

export default function RunHistory() {
  const { code = "" } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RunFilter>("all");
  const [set, setSet] = useState("all");
  const [model, setModel] = useState("all");
  const [shown, setShown] = useState(PAGE);
  const [seed, setSeed] = useState<RunSeed | null>(null);
  const [confirm, confirmNode] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const got = await runsApi.listRuns(code);
      setRuns(got.runs);
      setRole(got.role);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);
  useEffect(() => { void refresh(); }, [refresh]);
  useLive("*", (e) => { if (e.k === "run" || e.k === "*") void refresh(); });

  // Без живой связи идущее всё равно обновляется: опрос, пока что-то не кончилось
  const busy = (runs ?? []).some((r) => !FINISHED.includes(r.status));
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(t);
  }, [busy, refresh]);

  const canEdit = role === "admin" || role === "editor";
  const all = runs ?? [];
  const now = all.filter((r) => ACTIVE.includes(r.status) || WAITING.includes(r.status))
    .sort((a, b) => Number(WAITING.includes(a.status)) - Number(WAITING.includes(b.status))
      || (a.queued_at ?? "").localeCompare(b.queued_at ?? ""));
  const list = useMemo(() => filterRuns(all, { status, set, model }), [all, status, set, model]);
  const groups = groupByDay(list.slice(0, shown));
  const sets = [...new Map(all.filter((r) => r.set).map((r) => [r.set!.id, r.set!.name])).entries()];
  const models = [...new Set(all.map((r) => r.base_model))];
  const nDone = all.filter((r) => r.status === "done").length;
  const nBroken = all.filter((r) => r.status === "stopped" || r.status === "error").length;
  const nActive = all.filter((r) => ACTIVE.includes(r.status)).length;
  const nWait = all.filter((r) => WAITING.includes(r.status)).length;

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { setError((e as Error).message); }
    await refresh();
  };
  const open = (r: Run) => navigate(`/projects/${code}/runs/${r.number}`);
  const stop = (r: Run) => act(() => runsApi.stopRun(code, r.id));
  const resume = (r: Run) => act(() => runsApi.resumeRun(code, r.id));
  const remove = async (r: Run) => {
    const ok = await confirm({ title: `Удалить обучение №${r.number}?`, danger: true, icon: "trash", ok: "Удалить",
      desc: "Веса, метрики и графики уйдут безвозвратно. Набор останется." });
    if (ok) await act(() => runsApi.deleteRun(code, r.id));
  };

  const desc = runs === null ? "Загружаю…" : [
    count(all.length, "обучение", "обучения", "обучений"),
    nActive ? `${nActive} ${plural(nActive, "идёт", "идут", "идут")}` : "",
    nWait ? `${nWait} ${plural(nWait, "ждёт", "ждут", "ждут")} очереди` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className="page rn">
      <PageHeader title="Обучения" desc={desc}
        actions={canEdit && <Button variant="primary" icon="plus" onClick={() => setSeed({})}>Новое обучение</Button>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      {now.length > 0 && (
        <div className="g2 rn-now">
          {now.map((r, i) => <NowCard key={r.id} run={r} first={i === 0} canEdit={canEdit} onOpen={() => open(r)} onStop={() => stop(r)} />)}
        </div>
      )}

      {runs !== null && all.length === 0 ? (
        <Card>
          <Empty icon="activity" title="Обучений ещё не было"
            action={canEdit && <Button variant="primary" icon="plus" onClick={() => setSeed({})}>Новое обучение</Button>}>
            Обучение идёт из готового набора: выберите набор и модель — обучение встанет в очередь.
          </Empty>
        </Card>
      ) : runs !== null && (
        <>
          <div className="rn-bar">
            <Seg label="Состояние" value={status} onChange={(v) => { setStatus(v); setShown(PAGE); }} options={[
              { value: "all", label: <>Все <span className="ui-count">{all.length}</span></> },
              { value: "done", label: <>Готовые <span className="ui-count">{nDone}</span></> },
              { value: "broken", label: <>Прерванные <span className="ui-count">{nBroken}</span></> },
            ]} />
            <Select label="Набор" icon="layers" value={set} onChange={(v) => { setSet(v); setShown(PAGE); }}
              options={[{ value: "all", label: "Все наборы" }, ...sets.map(([id, name]) => ({ value: id, label: name }))]} />
            <Select label="Модель" icon="cpu" value={model} onChange={(v) => { setModel(v); setShown(PAGE); }}
              options={[{ value: "all", label: "Все модели" }, ...models.map((m) => ({ value: m, label: m }))]} />
            <span className="grow" />
            <span className="t-xs t-muted">Сначала новые</span>
          </div>

          {groups.length === 0 && <Card><Empty compact icon="filter" title="Под условия ничего не подошло" /></Card>}
          {groups.map((g) => (
            <section key={g.label} className="ui-card rn-hist">
              <div className="rn-hist-g">{g.label}</div>
              {g.runs.map((r) => (
                <HistoryRow key={r.id} run={r} canEdit={canEdit} onOpen={() => open(r)}
                  weights={runsApi.weightsUrl(code, r.id)} onResume={() => resume(r)}
                  onRepeat={() => setSeed(seedOf(r))} onDelete={() => remove(r)} />
              ))}
            </section>
          ))}
          {list.length > shown && (
            <button type="button" className="rn-more" onClick={() => setShown((n) => n + PAGE)}>
              Показать ещё {count(Math.min(PAGE, list.length - shown), "обучение", "обучения", "обучений")}
            </button>
          )}
        </>
      )}

      {seed && (
        <RunDialog code={code} seed={seed} onClose={() => setSeed(null)}
          onStarted={(r) => { setSeed(null); navigate(`/projects/${code}/runs/${r.number}`); }} />
      )}
      {confirmNode}
    </div>
  );
}

function NowCard({ run, first, canEdit, onOpen, onStop }: {
  run: Run; first: boolean; canEdit: boolean; onOpen: () => void; onStop: () => void;
}) {
  const st = STATUS[run.status];
  const waiting = WAITING.includes(run.status);
  const map50 = run.best_metrics["metrics/mAP50(B)"];
  return (
    <section className="ui-card rn-nowc" role="link" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}>
      <div className="row between">
        <span className="row"><Dot color={st.tone} live={st.live} />
          <b>№{run.number} · {run.base_model}{run.imgsz ? ` · ${run.imgsz}` : ""}</b></span>
        {waiting ? <Badge>{first ? "В очереди первым" : st.label}</Badge>
          : map50 != null && <span className="mono t-sm">mAP50 {dec(map50)}</span>}
      </div>
      <Progress value={waiting ? 0 : progress(run)} label="Ход обучения" />
      <div className="row between t-xs t-muted">
        <span className="t-ell">{waiting ? (run.queue_reason ?? "Ждёт свободную карту")
          : [stageText(run), etaText(run)].filter(Boolean).join(" · ")}</span>
        {waiting && canEdit ? (
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onStop(); }}>Убрать из очереди</Button>
        ) : run.peak_vram_mb != null && <span>{(run.peak_vram_mb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ</span>}
      </div>
    </section>
  );
}

function HistoryRow({ run, canEdit, weights, onOpen, onResume, onRepeat, onDelete }: {
  run: Run; canEdit: boolean; weights: string;
  onOpen: () => void; onResume: () => void; onRepeat: () => void; onDelete: () => void;
}) {
  const st = STATUS[run.status];
  const m50 = run.best_metrics["metrics/mAP50(B)"];
  const m95 = run.best_metrics["metrics/mAP50-95(B)"];
  const live = ACTIVE.includes(run.status);
  const graphs = run.set?.graphs ?? [];
  const stopClick = (e: SyntheticEvent) => e.stopPropagation();
  const why = run.status === "error" ? run.error : run.status === "stopped" && run.resumable
    ? `Остановлено на эпохе ${Math.max(0, run.current_epoch - 1)} из ${run.epochs}, можно продолжить` : null;
  return (
    <div className="rn-row" role="link" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      aria-label={`Обучение №${run.number}`}>
      <span className="row" style={{ gap: 10 }}>
        <Dot color={st.tone} live={st.live} title={st.label} />
        <span className="stack-v" style={{ gap: 0 }}><b className="mono">№{run.number}</b><span className="t-xs t-faint">{clock(run.created_at)}</span></span>
      </span>
      <span className="stack-v rn-row-m">
        <span className="row" style={{ gap: 6 }}>
          <b className="rn-row-n">{run.base_model}</b>
          {run.imgsz && <span className="mono t-xs t-muted">{run.imgsz} px</span>}
          {run.status === "done" ? null : live ? <Badge tone={st.tone}>{stageText(run)}</Badge>
            : <Badge tone={st.tone}>{st.label}</Badge>}
        </span>
        <span className="t-xs t-muted t-ell">
          {run.set ? run.set.name : "набор удалён"}{graphs.length ? ` · ${graphs.map((g) => g.name).join(", ")}` : ""}
        </span>
        {why && <span className={run.status === "error" ? "t-xs rn-bad t-ell" : "t-xs rn-warn t-ell"} title={why}>{why}</span>}
      </span>
      <span className="rn-row-sp">{run.spark.length > 1
        ? <Spark data={run.spark} color={live ? "var(--c1)" : "var(--muted-fg)"} width={120} height={30} label="mAP50 по эпохам" />
        : <span className="t-xs t-faint">—</span>}</span>
      <span className="stack-v rn-row-m1"><b className="mono">{m50 != null ? dec(m50) : "—"}</b><span className="t-xs t-faint">mAP50</span></span>
      <span className="stack-v rn-row-m2"><span className="mono t-sm">{m95 != null ? dec(m95) : "—"}</span><span className="t-xs t-faint">mAP50-95</span></span>
      <span className="t-sm t-muted rn-row-t">{duration(run.train_seconds)}</span>
      <span>{run.author && <Avatar name={run.author} />}</span>
      <span className="row rn-row-a" style={{ gap: 2 }} onClick={stopClick} onKeyDown={stopClick}>
        {canEdit && run.resumable ? <Button size="sm" icon="play" onClick={onResume}>Продолжить</Button>
          : run.has_weights && <AnchorButton size="sm" variant="ghost" icon="download" href={weights} aria-label="Скачать веса" title="Скачать веса" />}
        {canEdit && (
          <Popover align="end" width={220} trigger={<Button size="sm" variant="ghost" icon="more" aria-label="Действия" />}>
            {(close) => (<>
              <MenuItem icon="copy" onSelect={() => { close(); onRepeat(); }}>Повторить с этими параметрами</MenuItem>
              {run.resumable && run.has_weights && (
                <MenuItem icon="download" onSelect={() => { close(); window.location.href = weights; }}>Скачать веса</MenuItem>
              )}
              <MenuItem icon="trash" danger disabled={!FINISHED.includes(run.status)} onSelect={() => { close(); onDelete(); }}
                hint={FINISHED.includes(run.status) ? undefined : "сперва остановите"}>Удалить</MenuItem>
            </>)}
          </Popover>
        )}
      </span>
    </div>
  );
}
