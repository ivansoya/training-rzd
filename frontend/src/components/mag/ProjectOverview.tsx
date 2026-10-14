import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { getOverview } from "../../api/overview";
import type { Overview, OverviewClass } from "../../api/overview";
import type { TaskLight } from "../../auth/api";
import { useLive } from "../../live/LiveProvider";
import { useAuth } from "../auth/AuthGate";
import {
  Avatar, Badge, Button, Card, Dot, Empty, Icon, Legend, LineChart, LinkButton, Notice, PageHeader,
  Spark, StackBar, cx,
} from "../../ui";
import { ago, count, pct, ru } from "../ru";
import { gb, liveDevices, serverParts, shortName, useGpuState } from "../shell/useGpuState";
import ExportModal from "./ExportModal";
import { ProjectMenu } from "./ProjectMenu";
import { useProject } from "./ProjectShell";
import { CreateTaskModal } from "./tasks/CreateTaskModal";
import { STATUS, boardParts, boxedRecently, cardLook, sourceLine, statusNote, teamLine } from "./tasks/tasks";
import { CardLine } from "./tasks/TaskBoard";
import { look, useTaskBoard } from "./tasks/useTaskBoard";
import { describeTaskEvent } from "./taskEvents";

const map = (x: number) => x.toLocaleString("ru-RU", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

// Таски в работе важнее закрытых: порядок карточки — что ждёт рук.
const TASK_ORDER: Record<string, number> = { in_progress: 0, updating: 1, queued: 2, done: 3, closed: 4 };
/** Четыре открытые таски карточки — их счётчики и спрашиваем, остальные обзору не нужны. */
const shownOf = (list: TaskLight[]) =>
  list.filter((t) => t.status !== "closed").sort((a, b) => (TASK_ORDER[a.status] ?? 9) - (TASK_ORDER[b.status] ?? 9)).slice(0, 4);
const RUN_BADGE: Record<string, [string, string]> = {
  queued: ["В очереди", ""], waiting_gpu: ["Ждёт карту", ""], preparing: ["Готовится", "var(--c1)"],
  running: ["Идёт", "var(--c1)"], stopping: ["Останавливается", "var(--st-skip)"],
  done: ["Готово", "var(--st-done)"], stopped: ["Остановлено", "var(--st-skip)"], error: ["Ошибка", "var(--destructive)"],
};

/** Обзор: сводка проекта — данные, разметка, таски, обучение и что происходит. */
export default function ProjectOverview() {
  const { detail, refresh } = useProject();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { project, datasets, my_role } = detail;
  const code = project.code;
  const isAdmin = my_role === "admin";
  const canEdit = my_role === "admin" || my_role === "editor";
  const importing = project.status === "importing";

  const { me } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const tasks = useTaskBoard(code, me.user.id, shownOf);
  const refreshTasks = tasks.refresh;
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getOverview(code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);
  // Таски хук спросил сам при входе; дальше — вместе со сводкой
  const reload = useCallback(() => { void load(); void refreshTasks(); }, [load, refreshTasks]);
  useEffect(() => {
    void load();
    const h = window.setInterval(reload, 60_000);
    return () => window.clearInterval(h);
  }, [load, reload]);
  useLive("run", reload);
  useLive("classes", reload);

  // «Все кадры» переехали в галерею датасетов; старая ссылка ведёт туда
  if (search.get("view") === "frames") return <Navigate replace to={`/projects/${code}/datasets`} />;

  const actions = (
    <>
      <Button icon="download" disabled={importing} onClick={() => setExporting(true)}
        title={importing ? "Дождитесь окончания импорта" : "Собрать архив с изображениями и разметкой"}>
        Экспорт
      </Button>
      {isAdmin && <LinkButton icon="upload" to={`/projects/${code}/import`}>Импорт архива</LinkButton>}
      {canEdit && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Новая таска</Button>}
      <ProjectMenu detail={detail} refresh={refresh} />
    </>
  );

  const header = (
    <PageHeader title="Обзор"
      desc={<>{project.name}{data?.updated_at && <> · изменения {ago(data.updated_at)}</>}</>}
      actions={actions} />
  );

  const modals = (
    <>
      {exporting && <ExportModal detail={detail} onClose={() => setExporting(false)} />}
      {creating && (
        <CreateTaskModal isAdmin={isAdmin} onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/projects/${code}/tasks/${id}`)} />
      )}
    </>
  );

  if (importing) {
    return (
      <div className="page">
        {header}
        <Notice tone="warn" action={<LinkButton size="sm" to={`/projects/${code}/import`}>Вернуться к импорту</LinkButton>}>
          <b>Импорт архива не завершён.</b> Работа идёт на сервере — вернитесь и продолжите с того же шага.
        </Notice>
        {modals}
      </div>
    );
  }

  // Данные проекта — кадры датасетов; кадры тасок до приёмки — черновики.
  if (datasets.length === 0) {
    const taskCount = detail.stats.tasks ?? 0;
    return (
      <div className="page">
        {header}
        <Empty icon="database" title="В проекте пока нет данных"
          action={
            <div className="row">
              {isAdmin && <LinkButton variant="primary" icon="upload" to={`/projects/${code}/import`}>Импортировать архив</LinkButton>}
              {taskCount > 0 && <LinkButton to={`/projects/${code}/tasks`}>К таскам</LinkButton>}
            </div>
          }>
          {taskCount ? "Импортируйте YOLO-архив или сдайте кадры таски." : "Импортируйте YOLO-архив."}
        </Empty>
        {modals}
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {data ? (
        <>
          <Kpis data={data} code={code} />
          <div className="g-7-5">
            <ClassBalance rows={data.classes.rows} declared={data.classes.declared} code={code} />
            <TasksCard board={tasks} code={code} />
          </div>
          <div className="g3">
            <RunCard run={data.latest_run} code={code} />
            <ActivityCard data={data} code={code} />
            <GpuCard />
          </div>
        </>
      ) : !error && <Empty compact title="Считаем сводку…" />}
      {modals}
    </div>
  );
}

function Kpi({ label, value, desc, spark, aside }: {
  label: string; value: string; desc: React.ReactNode; spark?: React.ReactNode; aside?: React.ReactNode;
}) {
  return (
    <section className="ui-card kpi">
      <div className="kpi-k"><span>{label}</span>{aside}</div>
      <div className="kpi-v">{value}</div>
      <div className="kpi-d"><span>{desc}</span>{spark}</div>
    </section>
  );
}

function Kpis({ data, code }: { data: Overview; code: string }) {
  const { frames, annotated, boxes, classes, best } = data;
  const share = annotated.share[annotated.share.length - 1] ?? 0;
  const done = annotated.count + annotated.empty;
  return (
    <div className="kpis">
      <Kpi label="Кадров в проекте" value={ru(frames.total)}
        aside={<Link className="kpi-link" to={`/projects/${code}/datasets`}>Все кадры</Link>}
        desc={frames.week ? <><span className="up">+{ru(frames.week)}</span> за неделю</> : "за неделю новых нет"}
        spark={<Spark data={frames.series} color="var(--c1)" label="Кадры за неделю" />} />
      <Kpi label="Размечено" value={pct(share)}
        desc={annotated.empty
          ? `${count(done, "кадр", "кадра", "кадров")}, из них ${ru(annotated.empty)} пустых`
          : count(done, "кадр", "кадра", "кадров")}
        spark={<Spark data={annotated.share} color="var(--st-done)" label="Доля размеченного за неделю" />} />
      <Kpi label="Разметок" value={ru(boxes.total)}
        desc={`размечено ${ru(classes.used)} из ${count(classes.declared, "класса", "классов", "классов")}`}
        spark={<Spark data={boxes.series} color="var(--c4)" label="Разметки за неделю" />} />
      <Kpi label="Лучший mAP50" value={best ? map(best.map50) : "—"}
        desc={best ? `${best.name}, эпоха ${best.epoch}` : "обучений ещё не было"}
        spark={best && best.series.length > 1
          ? <Spark data={best.series} color="var(--c2)" label="mAP50 по эпохам" /> : undefined} />
    </div>
  );
}

function ClassBalance({ rows, declared, code }: { rows: OverviewClass[]; declared: number; code: string }) {
  const used = rows.map((r) => ({ ...r, total: r.train + r.val + r.other }))
    .filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...used.map((r) => r.total));
  const anyOther = used.some((r) => r.other > 0);
  const unused = declared - used.length;
  return (
    <Card title="Баланс классов" desc="Разметки по классам и как они легли на train и val"
      actions={<LinkButton variant="ghost" size="sm" to={`/projects/${code}/classes`}>Все классы</LinkButton>}>
      {used.length === 0 ? <Empty compact icon="tag" title="Разметки пока нет" /> : (
        <>
          <div className="bal">
            {used.map((r) => (
              <div key={r.id} className="bal-r">
                <span className="bal-n" title={r.name}>
                  <span className="ui-swatch" style={{ "--cc": r.color } as React.CSSProperties} />
                  <span className="t-ell">{r.name}</span>
                </span>
                <span className="bal-t" style={{ width: `${Math.max(2, (r.total / max) * 100)}%` }}
                  title={`train ${ru(r.train)} · val ${ru(r.val)}${r.other ? ` · без сплита ${ru(r.other)}` : ""}`}>
                  {r.train > 0 && <i style={{ flex: r.train, background: "var(--c1)" }} />}
                  {r.val > 0 && <i style={{ flex: r.val, background: "var(--c2)" }} />}
                  {r.other > 0 && <i style={{ flex: r.other, background: "var(--destructive)" }} />}
                </span>
                <span className="bal-v ui-mono">{ru(r.total)}</span>
              </div>
            ))}
          </div>
          <div className="bal-f">
            <Legend items={[
              { label: "train", color: "var(--c1)" },
              { label: "val", color: "var(--c2)" },
              ...(anyOther ? [{ label: "без сплита — из тасок", color: "var(--destructive)" }] : []),
            ]} />
            {unused > 0 && <span className="t-faint t-xs">ещё {count(unused, "класс", "класса", "классов")} без разметки</span>}
          </div>
        </>
      )}
    </Card>
  );
}

function TasksCard({ board, code }: { board: ReturnType<typeof useTaskBoard>; code: string }) {
  const tasks = board.list ?? [];
  const working = tasks.filter((t) => t.status === "in_progress" || t.status === "updating").length;
  const shown = shownOf(tasks);
  // Вид строк — тот же, что у карточек доски; легенда — только для полос, что есть на экране
  const faces = Object.fromEntries(shown.flatMap((t) => (board.stats[t.id] ? [[t.id, cardLook(t.status, board.stats[t.id])]] : [])));
  const shownParts = Object.values(faces).flatMap((f) => f.parts.filter((p) => p.value > 0));
  const legend = boardParts({}).concat(shownParts.some((p) => p.label === "Проверено")
    ? [{ value: 0, color: "var(--agent-hi)", label: "Проверено агентом" }] : [])
    .filter((p) => shownParts.some((q) => q.color === p.color));
  const desc = tasks.length
    ? `${count(tasks.length, "таска", "таски", "тасок")}${working ? `, ${ru(working)} в работе` : ""}`
    : undefined;
  return (
    <Card title="Таски" desc={desc}
      actions={<LinkButton variant="ghost" size="sm" to={`/projects/${code}/tasks`}>Все таски</LinkButton>}>
      {board.list === null ? (
        <Empty compact icon="check" title="Загружаем…" />
      ) : shown.length === 0 ? (
        <Empty compact icon="check" title={tasks.length ? "Открытых тасок нет" : "Тасок пока нет"} />
      ) : (
        <>
          <ul className="ov-tasks">
            {shown.map((t) => {
              const s = board.stats[t.id];
              const v = look(s, board.fresh[t.id], board.at);
              const f = faces[t.id];
              return (
                <li key={t.id}>
                  <Dot color={STATUS[t.status].tone} title={STATUS[t.status].label} />
                  <Link className="ov-task-n t-ell" to={`/projects/${code}/tasks/${t.id}`}>{t.name}</Link>
                  <span className="ov-task-w t-xs t-faint">
                    {boxedRecently(t) && <Dot color="var(--st-done)" live />}{statusNote(t)}
                  </span>
                  {/* Числа в пути — заготовки той же высоты: строка не прыгает */}
                  <span className={cx("ov-task-m t-xs t-muted", v.stale && "stale", v.loading && "ui-shim")}>
                    <Icon name={s && (s.sources.cut || s.sources.annotate) ? "film" : "images"} size={14} />
                    <span className="t-ell">
                      {s ? sourceLine(s.sources) : <i className="ui-sk pill" style={{ width: 110 }} />} · {teamLine(t.assignees)}
                    </span>
                  </span>
                  <span className={cx("ov-task-p t-xs", v.stale && "stale", v.loading && "ui-shim")}>
                    {!f ? <i className="ui-sk pill" style={{ width: 120 }} /> : <>
                      {f.parts.some((p) => p.value) && <StackBar parts={f.parts} />}
                      <span className={cx("tb-line", f.quiet && "quiet")} title={f.title}><CardLine line={f.line} /></span>
                    </>}
                  </span>
                </li>
              );
            })}
          </ul>
          {legend.length > 0 && (
            <div className="bal-f">
              <Legend items={legend.map(({ label, color }) => ({ label, color }))} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function RunCard({ run, code }: { run: Overview["latest_run"]; code: string }) {
  if (!run) {
    return (
      <Card title="Обучение">
        <Empty compact icon="activity" title="Обучений ещё не было"
          action={<LinkButton size="sm" to={`/projects/${code}/training?tab=sets`}>К наборам</LinkButton>}>
          Соберите набор и запустите на нём модель.
        </Empty>
      </Card>
    );
  }
  const [label, tone] = run.cpu && run.status === "waiting_gpu" ? ["Ждёт процессор", ""] : RUN_BADGE[run.status] ?? [run.status, ""];
  return (
    <Card title={run.name}
      desc={<>{run.model}{run.imgsz ? ` · ${run.imgsz} px` : ""} · эпоха {run.epoch} из {run.epochs}</>}
      actions={<>
        <Badge tone={tone || undefined} live={run.status === "running"}>{label}</Badge>
        <LinkButton variant="ghost" size="sm" to={`/projects/${code}/runs/${run.id}`}>Открыть</LinkButton>
      </>}>
      <div className="stack-v">
        {run.map50.some((v) => v != null) ? (
          <>
            <LineChart label="mAP по эпохам" width={360} height={190} total={run.epochs}
              series={[
                { data: run.map50, color: "var(--c1)", label: "mAP50", area: true },
                { data: run.map95, color: "var(--c2)", label: "mAP50-95" },
              ]} />
            <Legend items={[
              { label: "mAP50", color: "var(--c1)", kind: "line" },
              { label: "mAP50-95", color: "var(--c2)", kind: "line" },
            ]} />
          </>
        ) : <Empty compact title="Метрики появятся после первой эпохи" />}
      </div>
    </Card>
  );
}

function ActivityCard({ data, code }: { data: Overview; code: string }) {
  return (
    <Card title="Активность">
      {data.activity.length === 0 ? <Empty compact title="Пока тихо" /> : (
        <ul className="feed">
          {data.activity.slice(0, 6).map((a, i) => (
            <li key={i}>
              {a.user ? <Avatar name={a.user} /> : <span className="feed-sys"><Icon name="activity" size={13} /></span>}
              <span>
                {describeTaskEvent(a.kind, a.payload)}
                {a.task && <> · <Link to={`/projects/${code}/tasks/${a.task.id}`}>{a.task.name}</Link></>}
                {a.run && <> · <Link to={`/projects/${code}/runs/${a.run.id}`}>к обучению</Link></>}
              </span>
              <span className="feed-t" title={new Date(a.at).toLocaleString("ru-RU")}>{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GpuCard() {
  const state = useGpuState();
  if (!state) return <Card title="Видеокарта"><Empty compact title="Смотрю на карты…" /></Card>;
  const waiting = state.staff ? state.queue.total : state.queue.mine.length;
  const queueLine = (
    <div className="row between t-sm">
      <span className="t-muted">{state.staff ? "Очередь к картам" : "Ваши задачи в очереди"}</span>
      <Link to="/hardware">{waiting ? count(waiting, "задача ждёт", "задачи ждут", "задач ждут") : "никто не ждёт"}</Link>
    </div>
  );
  const devices = liveDevices(state);
  if (devices.length === 0) {
    return <Card title="Видеокарта"><Empty compact icon="cpu" title="Видеокарт на сервере нет" /></Card>;
  }
  // Одна полоса на весь сервер — сумма по работающим картам; подробности по картам — на «Оборудовании».
  const { parts, load, total } = serverParts(devices);
  const many = devices.length > 1;
  return (
    <Card title={many ? "Видеокарты" : "Видеокарта"}
      desc={many ? `${count(devices.length, "карта", "карты", "карт")} в работе · ${gb(total)} ГБ` : `${shortName(devices[0].name)} · ${gb(total)} ГБ`}
      actions={<Badge tone={load.tone}>{load.label}</Badge>}>
      <div className="stack-v ov-gpu">
        <StackBar parts={parts} height={12} label="Память видеокарт" />
        <Legend items={parts.map((p) => ({ label: <>{p.label} <b>{gb(p.value)}</b></>, color: p.color }))} />
        <hr className="ov-sep" />
        {queueLine}
      </div>
    </Card>
  );
}
