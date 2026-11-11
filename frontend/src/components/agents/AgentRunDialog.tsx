// «Разметить агентом» в таске и строка хода прогона.
//
// Сопоставление классов агента с классами проекта спрашивается целиком при первом запуске
// в проекте и дальше приходит запомненным — сервер хранит его на пару «агент + проект»
// по id класса агента. Одинаковые имена подставляются сами, а класс агента, взятый из
// этого проекта, сопоставлен намертво — его строка с замком.
//
// Три режима (решения владельца 24.09.2026): новые кадры таски; каждый N-й кадр размечаемого
// ролика, кроме тех, где уже работал человек; разведка — агент смотрит ролики любого режима
// и отмечает, где что нашлось. Разведке сопоставление не нужно: в разметку она не пишет ничего.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../../api/agents";
import { Badge, Button, Check, Dialog, Empty, Field, Icon, LinkButton, Notice, Progress, Radio, Select, cx } from "../../ui";
import { NumInput } from "../NumInput";
import { count, plural, ru } from "../ru";
import Sep, { withSep } from "../Sep";
import ClassMap, { guess, useAutoMapped } from "./ClassMap";
import CpuConfirm, { refusalOf, type CardRefusal } from "../hardware/CpuConfirm";
import { VerdictChip, gb, short, verdictLook } from "./GpuVerdict";
import ScoutOverview from "./ScoutOverview";
import RunVideoPicker from "./RunVideoPicker";
import { sampledCount } from "./scoutMath";
import { leftText, reelLine, runPct } from "../mag/tasks/tasks";

const SOURCE_TITLE: Record<"files" | "videos" | "dataset", string> = {
  files: "Загружено файлами", videos: "Нарезано из роликов", dataset: "Из датасета",
};
const toggled = <T,>(set: Set<T>, v: T, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(v); else next.delete(v);
  return next;
};

export default function AgentRunDialog({ taskId, initial, onClose, onStarted }: {
  taskId: string;
  /** Открыть настроенным: из блока таски или редактора ролика. `modes` — какие режимы
   *  показать, `sources` — блоки кадров, `videos` — ролики. */
  initial?: { mode: api.RunMode; videos?: string[]; sources?: string[]; modes?: api.RunMode[]; within?: string[] };
  onClose: () => void;
  onStarted: (run: api.RunView) => void;
}) {
  const [ctx, setCtx] = useState<api.RunContext | null>(null);
  const [agentId, setAgentId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<api.RunMode>(initial?.mode ?? "frames");
  const [videos, setVideos] = useState<Set<string>>(() => new Set(initial?.videos));
  const [step, setStep] = useState(25);
  const [gap, setGap] = useState(2);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parallel, setParallel] = useState(false);
  const [copies, setCopies] = useState("auto");
  const [custom, setCustom] = useState("");
  const [capacity, setCapacity] = useState<{ key: string; plan: api.ParallelCapacity } | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);
  // Агент больше карты или карты выключены — окно «на процессоре или отменить» (11.10.2026).
  const [refusal, setRefusal] = useState<CardRefusal | null>(null);

  useEffect(() => {
    api.runContext(taskId).then((got) => {
      setCtx(got);
      // Первым — тот, что влезает: подключённые к проекту идут раньше своих.
      const first = got.agents.find((a) => a.verdict.state !== "never") ?? got.agents[0];
      if (first) {
        setAgentId(first.id);
        setVersionId(first.head);
      }
      setSources(new Set(initial?.sources ?? ["files", "videos", "dataset"].filter((s) => (got.sources[s]?.new ?? 0) > 0)));
    }).catch((e) => setError(e.message));
  }, [taskId]);

  const agent = ctx?.agents.find((a) => a.id === agentId);
  const version = agent?.versions.find((v) => v.id === versionId) ?? agent?.versions[0];
  const list = useMemo(() => version?.classes ?? [], [version]);

  // Новая версия или новый агент — сопоставление пересчитывается от запомненного.
  useEffect(() => {
    if (ctx && agent) setMapping(guess(list, ctx.classes, ctx.mappings[agent.id]));
  }, [ctx, agent, list]);

  const auto = useAutoMapped(list, ctx && agent ? ctx.mappings[agent.id] : undefined, mapping);

  // Из блока — только его ролики: разведка блока «Ролики на разметку» не берёт ролики нарезки
  const eligible = (ctx?.videos ?? []).filter((v) => (!initial?.within || initial.within.includes(v.id))
    && (mode === "scout" || v.mode === "annotate"));
  const chosen = eligible.filter((v) => videos.has(v.id));
  const capacityKey = JSON.stringify({ version_id: version?.id, mode, sources: [...sources].sort(),
    videos: chosen.map((v) => v.id).sort(), step });
  useEffect(() => {
    if (!parallel || !version?.id) return;
    let alive = true;
    const refresh = () => {
      api.parallelCapacity(taskId, JSON.parse(capacityKey)).then((plan) => {
        if (alive) { setCapacity({ key: capacityKey, plan }); setCapacityError(null); }
      }, (e: Error) => { if (alive) { setCapacity(null); setCapacityError(e.message); } });
    };
    setCapacityError(null);
    const timer = window.setTimeout(refresh, 250);
    const poll = window.setInterval(refresh, 10000);
    return () => { alive = false; window.clearTimeout(timer); window.clearInterval(poll); };
  }, [parallel, taskId, capacityKey, version?.id]);
  const plan = capacity?.key === capacityKey ? capacity.plan : null;
  const maxCopies = plan?.max_count ?? 0;
  const requested = copies === "auto" ? maxCopies : Number(copies === "custom" ? custom : copies);
  const countError = copies === "custom" && !/^[1-9]\d*$/.test(custom) ? "Введите целое число от 1."
    : plan && requested > maxCopies ? `Сейчас доступно до ${maxCopies} агентов.` : null;
  const parallelBlocked = parallel && (!plan || maxCopies === 0 || !!countError);
  const total = mode === "frames"
    ? ctx ? [...sources].reduce((sum, s) => sum + (ctx.sources[s]?.new ?? 0), 0) : 0
    : chosen.reduce((sum, v) => sum + sampledCount(v.frames ?? 0, step), 0);
  const mapped = Object.values(mapping).filter(Boolean).length;
  const replacing = ctx ? [...sources].reduce((sum, s) => sum + (ctx.sources[s]?.agent ?? 0), 0) : 0;
  // Из блока ролики блока остаются выбранными и после смены режима
  const pickMode = (m: api.RunMode) => { setMode(m); setVideos(new Set(initial?.videos)); };
  const shows = (m: api.RunMode) => !initial?.modes || initial.modes.includes(m);
  const sourceKeys = ctx ? Object.keys(ctx.sources) : [];
  const sourceTitle = (s: string) => SOURCE_TITLE[s as keyof typeof SOURCE_TITLE]
    ?? `Из разметки «${ctx?.videos.find((v) => v.id === s)?.file_name ?? "ролика"}»`;

  // Вердикт сервера — у текущей версии агента; у старой версии памяти может нужно другое.
  const verdict = agent && version?.id === agent.head ? agent.verdict : null;
  const never = verdict?.state === "never";
  const cards = ctx?.resources.cards ?? [];
  const est = verdict && ctx ? {
    verdict, total_mb: verdict.state === "sequential" ? verdict.want_mb : verdict.want_mb, estimate_mb: verdict.want_mb,
    measured: 0, units: [], heaviest: null, nodes: {}, words: {}, sam3_cpu_half: true, cards, queued: ctx.resources.queued,
  } as api.Estimate : null;
  const ordered = ctx ? [...ctx.agents].sort((a, b) => Number(a.group !== "project") - Number(b.group !== "project")) : [];
  const agentOptions = ordered.flatMap((a, i) => {
    const head = i === 0 || ordered[i - 1].group !== a.group
      ? [{ value: `group:${a.group}`, disabled: true,
        label: <span className="ar-grp">{a.group === "project" ? "Подключённые к проекту" : "Мои, не подключённые"}</span> }]
      : [];
    const look = verdictLook(a.verdict);
    const ver = a.versions.find((v) => v.id === a.head)?.version;
    const who = a.group === "project" ? [a.mine ? "мой" : a.owner ?? "владелец удалён", `v${ver}`] : [`v${ver}`, "запуск не подключает агента к проекту"];
    return [...head, {
      value: a.id,
      label: (
        <span className="ar-opt">
          <span className="t-ell">{a.name}</span>
          <span className={`ar-opt-v ${look.tone}`} title={a.verdict.reason}><Icon name={look.icon} size={13} />{gb(a.verdict.want_mb)} ГБ</span>
        </span>
      ),
      hint: withSep(a.verdict.state === "sequential" ? [...who, "только поочерёдно, медленнее"] : who),
    }];
  });

  const start = async (device?: "cpu") => {
    if (!agent || !version) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.startRun(taskId, {
        graph_id: agent.id, version_id: version.id, mode, sources: [...sources], videos: chosen.map((v) => v.id), step, gap, mapping,
        ...(device ? { device } : {}),
        ...(parallel ? { parallel: true, copies: copies === "auto" ? "auto" : requested } : {}),
      }));
    } catch (e) {
      const why = refusalOf(e);
      if (why && !parallel) setRefusal(why);
      else setError((e as Error).message);
      setBusy(false);
    }
  };

  const videoList = <RunVideoPicker key={mode} rows={eligible} tags={ctx?.tags ?? []} value={videos} onChange={setVideos} />;
  const numField = (label: string, value: number, set: (v: number) => void, props: { min: number; max: number; step?: number; integer?: boolean }) => (
    <Field label={label}>
      {(id) => <NumInput id={id} className="ui-input ui-ctl ui-mono" value={value} {...props} onValue={(v) => v !== undefined && set(v)} />}
    </Field>
  );
  const ready = ctx && agent;
  const startText = mode === "scout"
    ? `Разведать ${count(chosen.length, "ролик", "ролика", "роликов")}`
    : `Разметить ${mode === "annotate" ? "до " : ""}${count(total, "кадр", "кадра", "кадров")}`;

  return (
    <Dialog open onOpenChange={(v) => !busy && !v && onClose()} width={760} height={760} className="ar-dialog" closable={!busy} title="Разметить агентом"
      desc="Агент ставит рамки с пометкой «модель» — человек их проверяет. Разметку людей агент не трогает"
      footer={<>
        {ready && est && <VerdictChip est={est} source className="ar-vd" />}
        <span className="grow" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        {ready && (
          <Button variant="agent" icon="sparkle" onClick={() => void start()}
            disabled={busy || parallelBlocked || !ctx.can_run || total === 0 || (mode !== "scout" && mapped === 0)}
            title={mode !== "scout" && mapped === 0 ? "Сопоставьте хотя бы один класс" : undefined}>
            {parallel ? parallelBlocked ? "Запустить агентов" : `Запустить ${count(requested, "агента", "агентов", "агентов")}` : startText}{!parallel && (verdict?.state === "wait" || (verdict?.state === "split" && !verdict.ready)) && <><Sep />в очередь</>}
          </Button>
        )}
      </>}>
      <div className="ar">
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        {refusal && (
          <CpuConfirm refusal={refusal} busy={busy} onCancel={() => setRefusal(null)} onCpu={() => void start("cpu")} />
        )}
        {!ctx && !error && <p className="t-sm t-muted">Загружаю…</p>}
        {ctx && !ctx.can_run && <Notice tone="warn">Запускать агента можно в своей таске: исполнителю или администратору проекта.</Notice>}
        {ctx && ctx.agents.length === 0 && (
          <Empty icon="sparkle" title="Агентов с сохранённой версией нет" action={<LinkButton to="/agents" icon="forward">К моим агентам</LinkButton>}>
            Соберите агента и сохраните версию — запускается всегда версия.
          </Empty>
        )}

        {ready && (
          <>
            <div className="ar-2">
              <Field label="Агент">
                {(id) => <Select id={id} full label="Агент" value={agentId} onChange={(v) => {
                  setAgentId(v);
                  setVersionId(ctx.agents.find((a) => a.id === v)?.head ?? "");
                }} options={agentOptions} />}
              </Field>
              <Field label="Версия">
                {(id) => <Select id={id} full label="Версия" value={version?.id} onChange={setVersionId}
                  options={agent.versions.map((v) => ({
                    value: v.id, label: `Версия ${v.version}`,
                    hint: withSep([new Date(v.created_at).toLocaleDateString("ru-RU"), count(v.classes.length, "класс", "класса", "классов")]),
                  }))} />}
              </Field>
            </div>

            <div className="ar-modes" role="radiogroup" aria-label="Режим">
              {shows("frames") && <Radio name="ar-mode" checked={mode === "frames"} onChange={() => pickMode("frames")} title="Новые кадры таски"
                hint="Кадры, до которых ещё не дошли руки">
                <div className="ar-list">
                  {sourceKeys.filter((s) => !initial?.sources || initial.sources.includes(s)).map((s) => (
                    <Check key={s} checked={sources.has(s)} disabled={ctx.sources[s].new === 0}
                      onChange={(on) => setSources((old) => toggled(old, s, on))}>
                      <span className="t-ell">{sourceTitle(s)}</span>
                      <span className="t-xs t-faint">{ru(ctx.sources[s].new)} {plural(ctx.sources[s].new, "новый кадр", "новых кадра", "новых кадров")}</span>
                    </Check>
                  ))}
                  {replacing > 0 && (
                    <p className="t-xs ge-warn">
                      На {ru(replacing)} {plural(replacing, "кадре", "кадрах", "кадрах")} есть непроверенная разметка агентов:
                      рамки этого агента будут заменены, с рамками других новые находки сравниваются — остаётся уверенная.
                    </p>
                  )}
                </div>
              </Radio>}
              {shows("annotate") && <Radio name="ar-mode" checked={mode === "annotate"} onChange={() => pickMode("annotate")} title="Разметка ролика"
                hint="Каждый N-й кадр размечаемых роликов; кадры, где работал человек, пропускаются">
                {videoList}
                <div className="ar-2">{numField("Каждый N-й кадр", step, setStep, { min: 1, max: 10000, integer: true })}</div>
              </Radio>}
              {shows("scout") && <Radio name="ar-mode" checked={mode === "scout"} onChange={() => pickMode("scout")} title="Разведка"
                hint="Где в роликах что нашлось — в разметку ничего не пишет">
                {videoList}
                <div className="ar-2">
                  {numField("Каждый N-й кадр", step, setStep, { min: 1, max: 10000, integer: true })}
                  {numField("Склеивать разрывы до, с", gap, setGap, { min: 0, max: 60, step: 0.5 })}
                </div>
              </Radio>}
            </div>

            <section className="ar-parallel" aria-label="Выполнение">
              <div className="ar-parallel-head">
                <b className="t-sm">Выполнение</b>
                <div className="ui-seg ui-seg-sm" role="group" aria-label="Количество экземпляров">
                  <button aria-pressed={!parallel} onClick={() => setParallel(false)}>Один агент</button>
                  <button aria-pressed={parallel} onClick={() => { setParallel(true); setCopies("auto"); }}><Icon name="layers" size={14} />Несколько агентов</button>
                </div>
              </div>
              <div className={cx("ar-expand", parallel && "open")} {...(!parallel ? { inert: "" } : {})}>
                <div><div className="ar-parallel-options">
                  <Field label="Количество агентов">
                    {(id) => <Select id={id} full label="Количество агентов" value={copies} onChange={setCopies}
                      options={[{ value: "auto", label: "Максимум по видеопамяти", hint: "Пересчитается перед запуском" },
                        ...Array.from({ length: maxCopies }, (_, i) => ({ value: String(i + 1), label: count(i + 1, "агент", "агента", "агентов") })),
                        { value: "custom", label: "Своё количество…" }]} />}
                  </Field>
                  <div className="ar-capacity t-xs t-muted" aria-live="polite">
                    {capacityError || (!plan ? "Проверяю видеопамять…" : `Сейчас до ${maxCopies} агентов · ${gb(plan.per_copy_mb)} ГБ на копию`)}
                  </div>
                  <div className={cx("ar-expand", copies === "custom" && "open")} {...(copies !== "custom" ? { inert: "" } : {})}>
                    <div><Field label="Своё количество">
                      {(id) => <input id={id} className="ui-input ui-ctl ui-mono" type="text" inputMode="numeric" value={custom}
                        maxLength={6} onChange={(e) => setCustom(e.target.value)} aria-invalid={!!countError}
                        aria-describedby="ar-count-help" placeholder="Например, 3" />}
                    </Field></div>
                  </div>
                  <p id="ar-count-help" className={cx("t-xs", countError ? "ge-warn" : "t-muted")}>
                    {countError || (maxCopies === 0 && plan ? "Нет свободной видеопамяти или подходящей работы для запуска."
                      : mode === "frames" ? "Копии одного агента делят кадры пачками по 60, без повторов."
                      : "Свободная копия берёт следующий ролик целиком. Один ролик между копиями не делится.")}
                  </p>
                  <p className="t-xs t-faint">Количество фиксируется при запуске. Ошибка одной копии не останавливает остальные.</p>
                </div></div>
              </div>
            </section>

            {mode !== "scout" && list.length > 0 && (
              <ClassMap list={list} classes={ctx.classes} mapping={mapping} auto={auto} onMapping={setMapping} />
            )}

            {verdict?.state === "wait" && (
              <div className="ar-why wait">
                <Icon name="clock" size={16} />
                <span>
                  <b>Встанет в очередь.</b> Агенту нужно {gb(verdict.want_mb)} ГБ, сейчас свободно{" "}
                  {cards.map((c) => `${gb(c.free_mb)} из ${gb(c.cap_mb)} на ${short(c.name)}`).join(", ")}
                  {ctx.resources.queued ? `, впереди ${count(ctx.resources.queued, "работа", "работы", "работ")}` : ""}.
                  Процессор не используется: прогон дождётся карты и начнётся сам.
                </span>
              </div>
            )}
            {verdict?.state === "split" && (
              <div className={`ar-why ${verdict.ready ? "split" : "wait"}`}>
                <Icon name={verdict.ready ? "split" : "clock"} size={16} />
                <span>
                  <b>{verdict.ready ? `Пойдёт ${verdictLook(verdict).word}.` : "Встанет в очередь."}</b>{" "}
                  {(verdict.placement ?? []).map((p) => `карта ${p.index} — ${p.units.map((u) => `${u.label} ${gb(u.mb)} ГБ`).join(", ")}`).join("; ")}.
                </span>
              </div>
            )}
            {verdict?.state === "sequential" && (
              <div className="ar-why seq">
                <Icon name="layers" size={16} />
                <span><b>Пойдёт поочерёдно.</b> {verdict.reason}</span>
              </div>
            )}
            {never && verdict && (
              <div className="ar-why no">
                <Icon name="ban" size={16} />
                <div>
                  <p><b>Не поместится ни на одну карту.</b> {verdict.reason} Поочерёдно не поможет: узел не делится. Запуск предложит процессор.</p>
                  <p className="t-xs t-muted">
                    Что сделать в агенте: уменьшить «Слов за проход» у SAM 3, взять вход 644 вместо 1008 или выключить тайлинг.
                  </p>
                  <LinkButton size="sm" icon="external" to={`/agents/${agent.id}`}>Открыть агента</LinkButton>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
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

/** Строка хода прогона в шапке таски. Опрос раз в две секунды — только пока прогон идёт и страница открыта. */
export function AgentRunBar({ taskId, run, onRun, onFinished }: {
  taskId: string;
  run: api.RunView | null;
  onRun: (run: api.RunView | null) => void;
  onFinished: () => void;
}) {
  const active = run ? api.ACTIVE.includes(run.status) : false;
  const [statsOpen, setStatsOpen] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [acting, setActing] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const poll = useCallback(async () => {
    try {
      const got = await api.taskRuns(taskId);
      const last = got.runs[0] ?? null;
      onRun(last);
      if (last && !api.ACTIVE.includes(last.status)) onFinished();
    } catch {
      /* следующий опрос попробует ещё раз */
    }
  }, [taskId, onRun, onFinished]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: number;
    const next = async () => {
      await poll();
      if (alive) timer = window.setTimeout(next, 2000);
    };
    timer = window.setTimeout(next, 2000);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [active, poll]);

  if (!run) return null;
  const control = async (id: string, action: "stop" | "resume") => {
    setStopError(null); setActing(true);
    try {
      const got = await (action === "stop" ? api.stopRun(id) : api.resumeRun(id));
      if (id === run.id || got.parallel) onRun(got);
      await poll();
    } catch (e) { setStopError((e as Error).message); }
    finally { setActing(false); }
  };
  const frames = run.stats.frames ?? 0;
  const failed = run.parallel?.copies.filter((c) => c.status === "error").length ?? 0;
  const result = run.status !== "done" ? null : run.mode === "scout"
    ? `разведано роликов: ${ru(run.stats.videos ?? 0)}, находки на ${ru(frames)} ${plural(frames, "кадре", "кадрах", "кадрах")}`
    : `${count(run.stats.boxes ?? 0, "рамка", "рамки", "рамок")} на ${ru(frames)} ${plural(frames, "кадре", "кадрах", "кадрах")}`;
  return (
    <div className={cx("ar-bar", run.status === "done" && "done")} role="region" aria-label="Ход агента">
      <div className="ar-identity">
        <Badge icon={run.status === "done" ? "tick" : "sparkle"} tone={run.status === "done" ? "var(--st-done)" : "var(--agent)"}>{run.agent ?? "агент"} v{run.version}</Badge>
        {run.parallel && <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
          icon={expanded ? "chevU" : "chevD"}>{count(run.parallel.count, "агент", "агента", "агентов")}</Button>}
      </div>
      <div className="ar-summary">
      <span className="ui-mono t-sm">{ru(run.processed)} / {run.total == null ? "—" : ru(run.total)}</span>
      <span className="t-sm" aria-live="polite">{run.stopping ? "останавливается" : run.status === "running" && run.mode === "scout" ? "разведывает" : run.cpu && run.status === "waiting_gpu" ? "ждёт процессор" : STATUS[run.status]}</span>
      {active && <span className="t-sm">{withSep([reelLine(run), `${runPct(run)} %`, leftText(run)])}</span>}
      {result && <span className="t-sm t-muted">{result}</span>}
      {run.error && <span className="t-sm ge-warn">{run.error}</span>}
      {failed > 0 && active && <Badge tone="var(--st-skip)">{count(failed, "ошибка", "ошибки", "ошибок")}</Badge>}
      {stopError && <span className="t-sm ge-warn">{stopError}</span>}
      {run.queue_reason && (run.status === "waiting_gpu" || run.status === "queued") && <span className="t-xs t-muted">{run.queue_reason}</span>}
      {/* Пока агент идёт — перелив по всей дорожке: при 0 % заливки не видно, а движение видно; ждущий стоит */}
      {(active || run.status === "done") && <span className={cx("ar-prog", run.status === "running" && "ui-shim")}>
        <Progress value={run.total ? run.processed / run.total : 0} label="Ход прогона" color={run.status === "done" ? "var(--st-done)" : "var(--agent)"} /></span>}
      <span className="grow" />
      {run.status === "done" && run.mode === "scout" && run.videos.length > 0 && (
        <Button size="sm" variant="ghost" icon="activity" onClick={() => setStatsOpen(true)}>Статистика</Button>
      )}
      {active ? (
        // Без catch отказ сервера уходил в pageerror, а кнопка «ничего не делала».
        <Button size="sm" variant="ghost" icon="stop" disabled={acting || run.stopping} onClick={() => void control(run.id, "stop")}>Остановить{run.parallel ? " всех" : ""}</Button>
      ) : <>
        {(run.status === "stopped" || run.status === "error") && (
          <Button size="sm" variant="ghost" icon="play" disabled={acting} onClick={() => void control(run.id, "resume")}>{run.status === "error" ? "Повторить ошибки" : "Продолжить"}</Button>
        )}
        <Button size="sm" variant="ghost" icon="x" onClick={() => onRun(null)}>Скрыть</Button>
      </>}
      </div>
      {run.parallel && <div className={cx("ar-expand ar-copies", expanded && "open")} {...(!expanded ? { inert: "" } : {})}>
        <div><div className="ar-copy-list">
          {run.parallel.copies.map((copy) => <div key={copy.id} className={cx("ar-copy", copy.status)}>
            <span className="ar-copy-slot ui-mono">{String(copy.slot).padStart(2, "0")}</span>
            <div className="ar-copy-main">
              <div className="ar-copy-title"><b>Агент {copy.slot}</b><span className="t-xs t-muted">{copy.stopping ? "останавливается" : copy.status === "running" && run.mode === "scout" ? "разведывает" : STATUS[copy.status]}</span></div>
              <p className="t-xs t-muted t-ell" title={copy.current ?? undefined}>{copy.current ?? (copy.status === "done" ? "Работа завершена"
                : copy.status === "error" ? "Не удалось подготовить копию" : copy.status === "stopped" ? "Ожидает продолжения" : "Подготовка к работе")}</p>
              <Progress value={copy.item_total ? Math.min(1, (copy.item_processed ?? 0) / copy.item_total) : copy.status === "done" ? 1 : 0}
                label={`Ход агента ${copy.slot}`} color={copy.status === "done" ? "var(--st-done)" : "var(--agent)"} />
              {copy.error && <p className="t-xs ge-warn">{copy.error}</p>}
            </div>
            <span className="t-xs ui-mono t-muted">{copy.item_total ? `${ru(copy.item_processed ?? 0)} / ${ru(copy.item_total)}` : `${ru(copy.processed)} кадров`}</span>
            {api.ACTIVE.includes(copy.status) ? <Button size="sm" variant="ghost" icon="stop" disabled={acting || copy.stopping}
              aria-label={`Остановить агента ${copy.slot}`} onClick={() => void control(copy.id, "stop")} />
              : (copy.status === "stopped" || copy.status === "error") && <Button size="sm" variant="ghost" icon="play" disabled={acting || run.stopping}
                onClick={() => void control(copy.id, "resume")}>{copy.status === "error" ? "Повторить" : "Продолжить"}</Button>}
          </div>)}
          <p className="t-xs t-faint">{run.status === "done" ? run.mode === "scout" ? "Результаты разведки сохранены в роликах." : "Разметка агента готова к проверке."
            : <>В очереди: {ru(run.parallel.pending)} {plural(run.parallel.pending, "задание", "задания", "заданий")}. Свободная копия берёт следующее.</>}</p>
        </div></div>
      </div>}
      {statsOpen && <ScoutOverview taskId={taskId} onClose={() => setStatsOpen(false)} />}
    </div>
  );
}
