// Страница прогона: шапка-описание, KPI с разницей к прошлому на том же наборе, графики, параметры.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as runsApi from "../../../api/runs";
import type { EpochRow, Run } from "../../../api/runs";
import { useLive } from "../../../live/LiveProvider";
import {
  AnchorButton, Button, Card, Chip, Dot, Empty, Icon, LinkButton, MenuItem, Notice, PageHeader, Popover, Progress,
} from "../../../ui";
import { ru } from "../../ru";
import { useProject } from "../ProjectShell";
import { useConfirm } from "../tasks/Confirm";
import { ClassesCard, ConfusionCard, CurvesCard, LossCard, MetricsCard } from "./RunCharts";
import RunDialog, { seedOf } from "./RunDialog";
import type { RunSeed } from "./RunDialog";
import { isFinalCheck, left, progress, stageText, trainedEpochs } from "./runMath";
import { ACTIVE, FINISHED, KPI, STATUS, WAITING, dec, delta, duration, paramGroups, yoloAugChips } from "./runs";

export default function RunPage() {
  const { code = "", runId = "" } = useParams<{ code: string; runId: string }>();
  const navigate = useNavigate();
  const { detail } = useProject();
  const [run, setRun] = useState<Run | null>(null);
  const [epochs, setEpochs] = useState<EpochRow[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [seed, setSeed] = useState<RunSeed | null>(null);
  const [fullError, setFullError] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const got = await runsApi.getRun(code, runId);
      const rows = await runsApi.runEpochs(code, got.id);
      setRun(got);
      setEpochs(rows.epochs);
      setMissing(null);
    } catch (e) {
      setMissing((e as Error).message);
    }
  }, [code, runId]);
  useEffect(() => { setRun(null); void refresh(); }, [refresh]);

  // Старые ссылки несут uuid — в адресе остаётся номер
  useEffect(() => {
    if (run && runId !== String(run.number)) navigate(`/projects/${code}/runs/${run.number}`, { replace: true });
  }, [run, runId, code, navigate]);

  useLive("run", (e) => { if (e.id === run?.id || e.k === "*") void refresh(); });
  const going = run != null && !FINISHED.includes(run.status);
  useEffect(() => {
    if (!going) return;
    const t = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(t);
  }, [going, refresh]);

  if (missing && !run) {
    return (
      <div className="page">
        <Empty icon="activity" title={missing} action={<LinkButton to={`/projects/${code}/runs`} icon="back">К обучениям</LinkButton>} />
      </div>
    );
  }
  if (!run) return <div className="page"><Empty compact title="Загружаю обучение…" /></div>;

  const st = STATUS[run.status];
  const manage = run.can_manage !== false && (detail.my_role === "admin" || detail.my_role === "editor");
  const active = ACTIVE.includes(run.status);
  const waiting = WAITING.includes(run.status);
  const shown = trainedEpochs(run, epochs);
  const colorOf = (name: string) => detail.classes.find((c) => c.name.toLowerCase() === name.toLowerCase())?.color;
  const classes = run.per_class?.totals?.classes ?? (run.confusion ? run.confusion.names.length - 1 : null);

  const act = async (fn: () => Promise<unknown>) => {
    setActing(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    await refresh();
    setActing(false);
  };
  const stop = async () => {
    const keep = run.best_epoch ? `Лучшие веса сохранятся — с эпохи ${run.best_epoch}. Потом можно продолжить.`
      : "Эпох ещё не было — весов не останется.";
    if (await confirm({ title: `Остановить обучение №${run.number}?`, desc: keep, ok: "Остановить", icon: "stop", danger: true })) {
      await act(() => runsApi.stopRun(code, run.id));
    }
  };
  const remove = async () => {
    if (!await confirm({ title: `Удалить обучение №${run.number}?`, danger: true, icon: "trash", ok: "Удалить",
      desc: "Веса, метрики и графики уйдут безвозвратно. Набор останется." })) return;
    try {
      await runsApi.deleteRun(code, run.id);
      navigate(`/projects/${code}/runs`);
    } catch (e) { setError((e as Error).message); }
  };

  const head = (() => {
    if (waiting) return { title: st.label, sub: run.queue_reason ?? "Ждёт свободную карту" };
    if (active) {
      const eta = left(run, epochs);
      const vram = run.peak_vram_mb != null ? `${(run.peak_vram_mb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ видеопамяти` : null;
      return { title: `${st.label}: ${stageText(run)}`, sub: [eta && `осталось около ${eta}`, vram].filter(Boolean).join(" · ") || "Первая эпоха ещё не закончилась" };
    }
    const done = run.finished_at ? new Date(run.finished_at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : null;
    if (run.status === "done") return { title: `Готово за ${duration(run.train_seconds)}`, sub: [done, `${run.epochs} эпох`, run.best_epoch && `лучшая — ${run.best_epoch}`].filter(Boolean).join(" · ") };
    const at = Math.max(0, run.current_epoch - 1);
    const where = run.status === "error" ? run.current_epoch : at;
    return { title: `${run.status === "error" ? "Ошибка" : "Остановлено"}${where ? ` на эпохе ${where} из ${run.epochs}` : " до первой эпохи"}`,
      sub: [done, run.resumable ? "можно продолжить с последней законченной эпохи" : null].filter(Boolean).join(" · ") };
  })();

  const graphs = run.set?.graphs ?? [];
  const yolo = yoloAugChips(run.params);
  const mode = String(run.params?.augment_mode ?? "yolo");
  // Явных ручек нет — значит, умолчания ultralytics
  const augText = mode === "off" ? "выключены" : mode === "graph" ? "из графа набора"
    : yolo.length ? "встроенные YOLO" : "встроенные YOLO, рекомендуемые";
  const prev = run.previous;

  return (
    <div className="page rn">
      <PageHeader title={`Обучение №${run.number}`}
        desc={`${run.name} · ${run.base_model}${run.imgsz ? ` · ${run.imgsz} px` : ""}${run.author ? ` · запустил ${run.author}` : ""}`}
        actions={<>
          {manage && (active || waiting) && (
            <Button variant="danger" icon="stop" disabled={acting || run.status === "stopping"} onClick={stop}>
              {waiting ? "Убрать из очереди" : "Остановить"}
            </Button>
          )}
          {manage && run.resumable && (
            <Button icon="play" disabled={acting} onClick={() => act(() => runsApi.resumeRun(code, run.id))}>Продолжить</Button>
          )}
          {run.has_weights && <AnchorButton icon="download" href={runsApi.weightsUrl(code, run.id)}>Веса</AnchorButton>}
          <Popover align="end" width={260} trigger={<Button variant="ghost" icon="more" aria-label="Ещё" />}>
            {(close) => (<>
              {manage && <MenuItem icon="copy" onSelect={() => { close(); setSeed(seedOf(run)); }}>Повторить с этими параметрами</MenuItem>}
              {run.has_weights && <MenuItem icon="sparkle" hint="веса выбираются в узле «Сеть»"
                onSelect={() => { close(); navigate("/agents"); }}>Сделать агента</MenuItem>}
              {manage && <MenuItem icon="trash" danger disabled={active} hint={active ? "сперва остановите" : undefined}
                onSelect={() => { close(); void remove(); }}>Удалить обучение</MenuItem>}
            </>)}
          </Popover>
          {manage && <Button variant="primary" icon="plus" onClick={() => setSeed({ setId: run.set?.id })}>Новое обучение</Button>}
        </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      <section className="ui-card rn-head">
        <div className="row" style={{ gap: 10 }}>
          <Dot color={st.tone} live={st.live} />
          <div className="stack-v" style={{ gap: 0 }}><b>{head.title}</b><span className="t-xs t-muted">{head.sub}</span></div>
        </div>
        <dl className="rn-head-d">
          <div><dt>Обучение</dt><dd className="mono">№{run.number}</dd></div>
          <div><dt>Набор</dt><dd>{run.set ? <>
            <Link to={`/projects/${code}/trainsets/${run.set.id}`}>«{run.set.name}»</Link>
            {run.set.counts && <> · <span className="mono">{ru(run.set.counts.samples ?? 0)}</span> образцов</>}
          </> : "удалён"}</dd></div>
          <div><dt>Аугментации</dt><dd className="row wrap" style={{ gap: 4 }}>
            {graphs.map((g) => (
              <Link key={g.id} to={`/augment/${g.id}`} className="rn-chip-a"><Chip icon="workflow">{g.name} v{g.version}</Chip></Link>
            ))}
            {!graphs.length && yolo.map((y) => <Chip key={y}>{y}</Chip>)}
            {!graphs.length && <span className={yolo.length ? "t-xs t-faint" : "t-muted"}>{augText}</span>}
          </dd></div>
        </dl>
        {active && <Phase run={run} />}
      </section>

      {run.error && (
        <Notice tone="error" action={run.error.length > 300 && (
          <Button size="sm" variant="ghost" onClick={() => setFullError((v) => !v)}>{fullError ? "Свернуть" : "Показать целиком"}</Button>
        )}>
          <span className={fullError ? "rn-err" : "rn-err clamp"}>{run.error}</span>
        </Notice>
      )}
      {!going && run.summary?.stopped_early ? (
        <Notice tone="info">Остановлено раньше срока: прошло {ru(run.summary.epochs_done ?? 0)} из {ru(run.epochs)} эпох,
          дальше качество не улучшалось{typeof run.params?.patience === "number" ? ` ${ru(run.params.patience)} эпох подряд` : ""}.
          Лучшие веса сохранены.</Notice>
      ) : null}

      <div className="kpis">
        {KPI.map((k) => {
          const v = run.best_metrics[k.key];
          const d = delta(v, prev?.best_metrics[k.key]);
          return (
            <section key={k.key} className="ui-card kpi">
              <div className="kpi-k">{k.label}{run.best_epoch && <span className="t-xs t-faint">эпоха {run.best_epoch}</span>}</div>
              <div className="kpi-v">{v != null ? dec(v) : "—"}</div>
              <div className="kpi-d">
                {d && prev ? <span><span className={d.dir === "up" ? "up" : d.dir === "down" ? "down" : undefined}>{d.text}</span>{" "}
                  к <Link to={`/projects/${code}/runs/${prev.number}`}>обучению №{prev.number}</Link></span>
                  : <span>{prev === null || prev === undefined ? (run.set ? "первое на этом наборе" : "набор удалён") : ""}</span>}
              </div>
            </section>
          );
        })}
      </div>

      {shown.length > 0 ? (
        <div className="g2">
          <MetricsCard epochs={shown} total={run.epochs} />
          <LossCard epochs={shown} total={run.epochs} />
        </div>
      ) : (
        <Card title="Метрики по эпохам">
          <p className="t-sm t-muted">{FINISHED.includes(run.status) ? "Ни одна эпоха не закончилась — графика нет."
            : "Первая эпоха ещё не закончилась. График появится, когда будет что на нём рисовать."}</p>
        </Card>
      )}

      {(run.confusion || run.per_class || run.status === "done") && (
        <div className="g2 rn-res">
          <ConfusionCard data={run.confusion} colorOf={colorOf} done={run.status === "done"} />
          <ClassesCard data={run.per_class} colorOf={colorOf} />
        </div>
      )}
      <CurvesCard curves={run.curves} />

      <section className="ui-card rn-prm">
        <div className="row rn-prm-h">
          <h3 className="ui-card-t">Параметры</h3><span className="t-xs t-muted">снимок на момент запуска</span>
          <span className="grow" />
          {manage && <Button size="sm" variant="ghost" icon="copy" onClick={() => setSeed(seedOf(run))}>Повторить с этими параметрами</Button>}
        </div>
        <div className="rn-prm-g">
          {paramGroups(run, classes).filter((g) => g.rows.length).map((g) => (
            <div key={g.title} className="rn-prm-c">
              <div className="rn-prm-t"><Icon name={g.icon} size={14} />{g.title}</div>
              {g.rows.map(([k, v]) => <div key={k} className="rn-prm-r"><span>{k}</span><b className="mono">{v}</b></div>)}
            </div>
          ))}
        </div>
      </section>

      {seed && (
        <RunDialog code={code} seed={seed} onClose={() => setSeed(null)}
          onStarted={(r) => { setSeed(null); navigate(`/projects/${code}/runs/${r.number}`); }} />
      )}
      {confirmNode}
    </div>
  );
}

/** Что идёт прямо сейчас: качаются веса, эпоха по батчам или проверка, и обучение целиком. */
function Phase({ run }: { run: Run }) {
  const final = isFinalCheck(run);
  const part = run.phase === "weights"
    ? { k: "Качаю веса", v: run.val_batch, of: run.val_total, unit: " МБ" }
    : run.phase === "val" || run.phase === "final"
      ? { k: final ? "Итоговая проверка" : "Проверка эпохи", v: run.val_batch, of: run.val_total, unit: "" }
      : { k: `Эпоха ${run.current_epoch}`, v: run.current_batch, of: run.total_batches, unit: " батчей" };
  return (
    <div className="rn-phase">
      <div className="rn-phase-r">
        <span className="t-xs t-muted">{part.k}</span>
        <Progress value={part.v ?? 0} max={Math.max(1, part.of ?? 1)} label={part.k} />
        <span className="mono t-xs">{ru(part.v ?? 0)} / {part.of ? ru(part.of) : "?"}{part.unit}</span>
      </div>
      <div className="rn-phase-r">
        <span className="t-xs t-muted">Обучение целиком</span>
        <Progress value={progress(run)} label="Обучение целиком" />
        <span className="mono t-xs">{Math.min(run.current_epoch, run.epochs)} / {run.epochs} эпох</span>
      </div>
    </div>
  );
}
