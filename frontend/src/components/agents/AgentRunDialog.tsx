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
import { Badge, Button, Check, Dialog, Empty, Field, Icon, LinkButton, Notice, Progress, Radio, Select } from "../../ui";
import { NumInput } from "../NumInput";
import { count, plural, ru } from "../ru";
import ClassMap, { guess, useAutoMapped } from "./ClassMap";
import { VERDICT, VerdictChip, gb, short } from "./GpuVerdict";
import ScoutOverview from "./ScoutOverview";
import { sampledCount } from "./scoutMath";

const SOURCE_TITLE: Record<"files" | "videos", string> = { files: "Загружено файлами", videos: "Нарезано из роликов" };
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

  useEffect(() => {
    api.runContext(taskId).then((got) => {
      setCtx(got);
      // Первым — тот, что влезает: подключённые к проекту идут раньше своих.
      const first = got.agents.find((a) => a.verdict.state !== "never") ?? got.agents[0];
      if (first) {
        setAgentId(first.id);
        setVersionId(first.head);
      }
      setSources(new Set(initial?.sources ?? ["files", "videos"].filter((s) => (got.sources[s]?.new ?? 0) > 0)));
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
    && (mode === "scout" || (v.mode === "annotate" && !v.closed)));
  const chosen = eligible.filter((v) => videos.has(v.id));
  const total = mode === "frames"
    ? ctx ? [...sources].reduce((sum, s) => sum + (ctx.sources[s]?.new ?? 0), 0) : 0
    : chosen.reduce((sum, v) => sum + sampledCount(v.frames ?? 0, step), 0);
  const mapped = Object.values(mapping).filter(Boolean).length;
  const replacing = ctx ? [...sources].reduce((sum, s) => sum + (ctx.sources[s]?.agent ?? 0), 0) : 0;
  // Из блока ролики блока остаются выбранными и после смены режима
  const pickMode = (m: api.RunMode) => { setMode(m); setVideos(new Set(initial?.videos)); };
  const shows = (m: api.RunMode) => !initial?.modes || initial.modes.includes(m);
  const sourceKeys = ctx ? Object.keys(ctx.sources) : [];
  const sourceTitle = (s: string) => SOURCE_TITLE[s as "files" | "videos"]
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
    const look = VERDICT[a.verdict.state];
    const ver = a.versions.find((v) => v.id === a.head)?.version;
    const who = a.group === "project" ? `${a.mine ? "мой" : a.owner ?? "владелец удалён"} · v${ver}` : `v${ver} · запуск не подключает агента к проекту`;
    return [...head, {
      value: a.id,
      label: (
        <span className="ar-opt">
          <span className="t-ell">{a.name}</span>
          <span className={`ar-opt-v ${look.tone}`} title={a.verdict.reason}><Icon name={look.icon} size={13} />{gb(a.verdict.want_mb)} ГБ</span>
        </span>
      ),
      hint: a.verdict.state === "sequential" ? `${who} · только поочерёдно, медленнее` : who,
    }];
  });

  const start = async () => {
    if (!agent || !version) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.startRun(taskId, {
        graph_id: agent.id, version_id: version.id, mode, sources: [...sources], videos: chosen.map((v) => v.id), step, gap, mapping,
      }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const videoList = (
    <div className="ar-list">
      {eligible.length === 0 && <p className="t-xs t-faint">Подходящих роликов нет.</p>}
      {eligible.map((v) => (
        <Check key={v.id} checked={videos.has(v.id)} onChange={(on) => setVideos((old) => toggled(old, v.id, on))}>
          <span className="ui-mono t-ell" title={v.file_name}>{v.file_name}</span>
          <span className="t-xs t-faint">{v.frames == null ? "—" : count(v.frames, "кадр", "кадра", "кадров")} · {v.mode === "cut" ? "нарезка" : "разметка"}</span>
        </Check>
      ))}
    </div>
  );
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
    <Dialog open onOpenChange={(v) => !v && onClose()} width={720} title="Разметить агентом"
      desc="Агент ставит рамки с пометкой «модель» — человек их проверяет. Разметку людей агент не трогает"
      footer={<>
        {ready && est && <VerdictChip est={est} source className="ar-vd" />}
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        {ready && (
          <Button variant="agent" icon="sparkle" onClick={start}
            disabled={busy || never || !ctx.can_run || total === 0 || (mode !== "scout" && mapped === 0)}
            title={never ? verdict?.reason : mode !== "scout" && mapped === 0 ? "Сопоставьте хотя бы один класс" : undefined}>
            {startText}{verdict?.state === "wait" ? " · в очередь" : ""}
          </Button>
        )}
      </>}>
      <div className="ar">
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
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
                    hint: `${new Date(v.created_at).toLocaleDateString("ru-RU")} · ${count(v.classes.length, "класс", "класса", "классов")}`,
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
                  <p><b>Не поместится ни на одну карту.</b> {verdict.reason} Поочерёдно не поможет: узел не делится, а на процессоре агенты не считают.</p>
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
  const frames = run.stats.frames ?? 0;
  const result = run.status !== "done" ? null : run.mode === "scout"
    ? `разведано роликов: ${ru(run.stats.videos ?? 0)}, находки на ${ru(frames)} ${plural(frames, "кадре", "кадрах", "кадрах")}`
    : `${count(run.stats.boxes ?? 0, "рамка", "рамки", "рамок")} на ${ru(frames)} ${plural(frames, "кадре", "кадрах", "кадрах")}`;
  return (
    <div className="ar-bar" role="status">
      <Badge icon="sparkle" tone="var(--agent)">{run.agent ?? "агент"} v{run.version}</Badge>
      <span className="ui-mono t-sm">{ru(run.processed)} / {run.total == null ? "—" : ru(run.total)}</span>
      <span className="t-sm">{run.status === "running" && run.mode === "scout" ? "разведывает" : STATUS[run.status]}</span>
      {result && <span className="t-sm t-muted">{result}</span>}
      {run.error && <span className="t-sm ge-warn">{run.error}</span>}
      {stopError && <span className="t-sm ge-warn">Не остановился: {stopError}</span>}
      {run.queue_reason && (run.status === "waiting_gpu" || run.status === "queued") && <span className="t-xs t-muted">{run.queue_reason}</span>}
      {active && <span className="ar-prog"><Progress value={run.total ? run.processed / run.total : 0} label="Ход прогона" color="var(--agent)" /></span>}
      <span className="grow" />
      {run.status === "done" && run.mode === "scout" && run.videos.length > 0 && (
        <Button size="sm" variant="ghost" icon="activity" onClick={() => setStatsOpen(true)}>Статистика</Button>
      )}
      {active ? (
        // Без catch отказ сервера уходил в pageerror, а кнопка «ничего не делала».
        <Button size="sm" variant="ghost" icon="stop" onClick={() => {
          setStopError(null);
          api.stopRun(run.id).then(onRun, (e: Error) => setStopError(e.message));
        }}>Остановить</Button>
      ) : (
        <Button size="sm" variant="ghost" icon="x" onClick={() => onRun(null)}>Скрыть</Button>
      )}
      {statsOpen && <ScoutOverview taskId={taskId} onClose={() => setStatsOpen(false)} />}
    </div>
  );
}
