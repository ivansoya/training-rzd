// Таски: доска по состояниям; карточку тащат в соседнюю колонку — это смена состояния.

import { useCallback, useEffect, useState } from "react";
import type { DragEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { listTasks, setTaskStatus } from "../../../auth/api";
import type { TaskBoardItem, TaskStatus } from "../../../auth/api";
import { Avatar, Badge, Button, Dot, Empty, Icon, Input, Notice, PageHeader, Seg, StackBar, cx } from "../../../ui";
import { useAuth } from "../../auth/AuthGate";
import { ago, count, ru } from "../../ru";
import { useProject } from "../ProjectShell";
import { useConfirm } from "./Confirm";
import { CreateTaskModal } from "./CreateTaskModal";
import { BOARD, STATES, STATUS, boardColumns, canMove, closePlan, closeText, sourceLine, stateParts, waitingOf } from "./tasks";

const CLOSED_SHOWN = 2;

/** Что случится, если бросить карточку в колонку. */
const DROP: Record<TaskStatus, string> = {
  queued: "Вернуть на очередь",
  in_progress: "Взять в работу",
  done: "Готово — размеченное уйдёт в датасет",
  updating: "Вернуться к разметке",
  closed: "Закрыть — спросим подтверждение",
};

export default function TaskBoard() {
  const { detail } = useProject();
  const { me } = useAuth();
  const navigate = useNavigate();
  const code = detail.project.code;
  const [tasks, setTasks] = useState<TaskBoardItem[] | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [who, setWho] = useState<"all" | "mine">("all");
  const [allClosed, setAllClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drag, setDrag] = useState<{ id: string; from: TaskStatus } | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();

  const load = useCallback(async () => {
    try {
      const d = await listTasks(code);
      setTasks(d.tasks);
      setCanCreate(d.can_create);
      setIsAdmin(d.is_admin);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);
  useEffect(() => { void load(); }, [load]);

  const list = tasks ?? [];
  const { cols, shown } = boardColumns(list, query, who === "mine" ? me.user.id : null);
  const working = list.filter((t) => t.status === "in_progress").length;
  const desc = tasks === null ? "Загружаем…" : [
    count(list.length, "таска", "таски", "тасок"),
    working ? `${ru(working)} в работе` : null,
    `${count(waitingOf(list), "кадр ждёт", "кадра ждут", "кадров ждут")} решения`,
  ].filter(Boolean).join(" · ");

  const endDrag = () => { setDrag(null); setOver(null); };

  async function drop(to: TaskStatus) {
    const d = drag;
    endDrag();
    const t = d && list.find((x) => x.id === d.id);
    if (!d || !t || d.from === to || !canMove(d.from, to)) return;
    if (to === "closed") {
      const ok = await confirm({
        title: `Закрыть «${t.name}»?`, desc: "Закрытую таску нельзя вернуть в работу.",
        lines: closeText(closePlan(t.counts, t.sources.cut + t.sources.annotate), t.target_dataset?.name ?? null),
        ok: "Закрыть таску", icon: "archive", danger: true,
      });
      if (!ok) return;
    }
    if (to === "done" && t.pending_frames > 0) {
      const ok = await confirm({
        title: "Сдать с незакрытыми роликами?",
        desc: `${count(t.pending_frames, "кадр", "кадра", "кадров")} из роликов с незакрытой разметкой в датасет не уйдут.`,
        ok: "Сдать всё равно", icon: "tick",
      });
      if (!ok) return;
    }
    // Карточка переезжает сразу; ответ сервера её поправит или вернёт
    const now = new Date().toISOString();
    setTasks((prev) => prev && prev.map((x) => (x.id === t.id ? { ...x, status: to, status_at: now, last_at: now } : x)));
    setLanded(t.id);
    try {
      const res = await setTaskStatus(t.id, to);
      if (res.accepted) setNotice(`«${t.name}»: в датасет «${res.dataset}» ушло ${count(res.accepted, "кадр", "кадра", "кадров")}.`);
      else if (to === "closed" && res.removed_images) setNotice(`«${t.name}» закрыта, черновых кадров удалено: ${ru(res.removed_images)}.`);
    } catch (e) {
      setError(`«${t.name}»: ${(e as Error).message}`);
    }
    await load();
  }

  const colProps = (s: TaskStatus) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag || !canMove(drag.from, s)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over !== s) setOver(s);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === s ? null : o));
    },
    onDrop: (e: DragEvent) => { e.preventDefault(); void drop(s); },
  });

  return (
    <div className="page">
      <PageHeader title="Таски" desc={desc} actions={<>
        <Seg label="Чьи таски" value={who} onChange={setWho}
          options={[{ value: "all", label: "Все" }, { value: "mine", label: "Мои" }]} />
        <Input icon="search" type="search" className="tb-q" placeholder="Найти таску" aria-label="Найти таску"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        {canCreate && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Новая таска</Button>}
      </>} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="ok" onClose={() => setNotice(null)}>{notice}</Notice>}

      {tasks !== null && list.length === 0 ? (
        <Empty icon="check" title="Тасок пока нет"
          action={canCreate && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Создать первую</Button>}>
          Таска — пул кадров: изображения и ролики размечаются в ней и уходят в датасет на «Готово».
        </Empty>
      ) : tasks !== null && shown === 0 ? (
        <Empty compact icon="search" title="Ни одна таска не подошла"
          action={<Button size="sm" onClick={() => { setQuery(""); setWho("all"); }}>Сбросить</Button>} />
      ) : (
        <div className={cx("tb", drag && "dragging")}>
          {BOARD.map((s) => {
            const items = s === "closed" && !allClosed ? cols[s].slice(0, CLOSED_SHOWN) : cols[s];
            const can = drag && s !== drag.from && canMove(drag.from, s);
            return (
              <section key={s} aria-label={STATUS[s].label} {...colProps(s)}
                className={cx("tb-col", drag && (s === drag.from ? "from" : can ? "can" : "no"), over === s && "over")}>
                <div className="tb-col-h">
                  <Dot color={STATUS[s].tone} />{STATUS[s].label}<span className="ui-count">{cols[s].length}</span>
                </div>
                {can && <div className="tb-drop"><Icon name="forward" size={14} />{DROP[s]}</div>}
                {items.map((t) => (
                  <TaskCard key={t.id} t={t} code={code} dragged={drag?.id === t.id} landed={landed === t.id}
                    onDragStart={() => requestAnimationFrame(() => setDrag({ id: t.id, from: t.status }))}
                    onDragEnd={endDrag} />
                ))}
                {s === "closed" && cols[s].length > CLOSED_SHOWN && (
                  <button type="button" className="tb-more" onClick={() => setAllClosed((v) => !v)}>
                    {allClosed ? "Свернуть" : `Ещё ${cols[s].length - CLOSED_SHOWN}`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}

      {confirmNode}
      {creating && (
        <CreateTaskModal isAdmin={isAdmin} onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/projects/${code}/tasks/${id}`)} />
      )}
    </div>
  );
}

function TaskCard({ t, code, dragged, landed, onDragStart, onDragEnd }: {
  t: TaskBoardItem;
  code: string;
  dragged: boolean;
  landed: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const to = `/projects/${code}/tasks/${t.id}`;
  const c = t.counts;
  const movable = t.can_work && t.status !== "closed";
  const dragProps = {
    draggable: movable,
    onDragStart: (e: DragEvent) => {
      if (!movable) { e.preventDefault(); return; }
      e.dataTransfer.setData("text/plain", t.id);
      e.dataTransfer.effectAllowed = "move";
      onDragStart();
    },
    onDragEnd,
  };
  const cls = cx("ui-card tb-card", movable && "movable", dragged && "dragged", landed && "landed");
  if (t.status === "closed") {
    return (
      <Link to={to} className={cx(cls, "closed")} draggable={false}>
        <b className="tb-name">{t.name}</b>
        <span className="t-xs t-muted">
          {c.accepted ? `${count(c.accepted, "кадр", "кадра", "кадров")} в датасете` : "в датасет ничего не ушло"} · {ago(t.status_at)}
        </span>
      </Link>
    );
  }
  const fresh = t.last_box_at && Date.now() - Date.parse(t.last_box_at) < 15 * 60_000;
  return (
    <Link to={to} className={cls} {...dragProps}>
      <div className="tb-card-h">
        <b className="tb-name">{t.name}</b>
        {t.assignee && <Avatar name={t.assignee.display_name} />}
      </div>
      <span className="tb-src t-xs t-muted" title={sourceLine(t.sources)}>
        <Icon name={t.sources.cut || t.sources.annotate ? "film" : "images"} size={14} />
        <span className="t-ell">{sourceLine(t.sources)}</span>
      </span>
      {c.total > 0 ? (
        <>
          <StackBar parts={stateParts(c)} />
          <span className="tb-nums">
            {(["annotated", "empty", "skipped", "new"] as const).filter((k) => c[k]).map((k) => (
              <span key={k} title={STATES.find((x) => x.key === k)!.label}>
                <i style={{ background: STATES.find((x) => x.key === k)!.color }} />{ru(c[k])}
              </span>
            ))}
          </span>
        </>
      ) : <span className="t-xs t-faint">Кадров пока нет</span>}
      {((c.agent || 0) > 0 || t.pending_frames > 0) && (
        <span className="tb-badges">
          {(c.agent || 0) > 0 && <Badge tone="var(--agent-fg)" icon="bot">{ru(c.agent!)} от агента</Badge>}
          {t.pending_frames > 0 && <Badge tone="var(--st-skip)" icon="film">{ru(t.pending_frames)} ждут закрытия</Badge>}
        </span>
      )}
      <span className="tb-foot t-xs t-faint">
        <span className="t-ell">{t.assignee?.display_name ?? "без исполнителя"}</span>
        <span className="t-ell">
          {fresh && <Dot color="var(--st-done)" live />}
          {statusNote(t)}
        </span>
      </span>
    </Link>
  );
}

function statusNote(t: TaskBoardItem): string {
  if (t.status === "done" && t.counts.accepted) return `${ru(t.counts.accepted)} в датасете`;
  if (t.last_box_at) return `разметка ${ago(t.last_box_at)}`;
  return `создана ${ago(t.created_at)}`;
}
