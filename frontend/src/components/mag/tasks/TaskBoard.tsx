// Таски: доска по состояниям; карточку тащат в соседнюю колонку — это смена состояния.

import { useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getTaskStats, setTaskStatus } from "../../../auth/api";
import type { TaskLight, TaskStats, TaskStatus } from "../../../auth/api";
import { cacheTime } from "../../../api/cache";
import { pollJob } from "../../../api/jobs";
import type { StatusResult } from "../../../auth/api";
import { Avatars, Badge, Button, Dot, Empty, Icon, Input, Notice, PageHeader, Seg, StackBar, cx } from "../../../ui";
import { useAuth } from "../../auth/AuthGate";
import { ago, count, ru } from "../../ru";
import { useProject } from "../ProjectShell";
import { useConfirm } from "./Confirm";
import { CreateTaskModal } from "./CreateTaskModal";
import {
  BOARD, STATUS, boardColumns, boxedRecently, cardLook, closePlan, closeText, handoverText, sourceLine, statusNote,
  teamLine, waitingOf,
} from "./tasks";
import { look, useTaskBoard } from "./useTaskBoard";
import type { Fresh } from "./useTaskBoard";

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
  const board = useTaskBoard(code, me.user.id);
  const { list: tasks, canCreate, isAdmin, stats, fresh, at } = board;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [who, setWho] = useState<"all" | "mine">("all");
  const [allClosed, setAllClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  // Куда тащить можно — переходы этой карточки, их считает сервер
  const [drag, setDrag] = useState<{ id: string; from: TaskStatus; moves: TaskStatus[] } | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();

  const list = tasks ?? [];
  const { cols, shown } = boardColumns(list, query, who === "mine" ? me.user.id : null);
  const working = list.filter((t) => t.status === "in_progress").length;
  // Ждут решения — по пришедшим счётчикам; пока идут, рядом «обновляется»
  const busy = board.listing || list.some((t) => fresh[t.id] !== "ok");
  const desc = tasks === null ? <Updating>Загружаем…</Updating> : <>
    {[
      count(list.length, "таска", "таски", "тасок"),
      working ? `${ru(working)} в работе` : null,
      `${count(waitingOf(list, stats), "кадр ждёт", "кадра ждут", "кадров ждут")} решения`,
    ].filter(Boolean).join(" · ")}
    {at !== null && busy && <span className="tb-cache">на {cacheTime(at)}</span>}
    {busy && <Updating>обновляется</Updating>}
  </>;

  const endDrag = () => { setDrag(null); setOver(null); };

  async function drop(to: TaskStatus) {
    const d = drag;
    endDrag();
    const t = d && list.find((x) => x.id === d.id);
    if (!d || !t || d.from === to || !d.moves.includes(to)) return;
    // Окнам нужны числа таски — свежие, а не из кеша
    let s: TaskStats | undefined = stats[t.id];
    if (to === "closed" || to === "done") {
      try { s = await getTaskStats(t.id); } catch (e) { setError(`«${t.name}»: ${(e as Error).message}`); return; }
    }
    if (to === "closed" && s) {
      const ok = await confirm({
        title: `Закрыть «${t.name}»?`, desc: "Закрытую таску нельзя вернуть в работу.",
        lines: closeText(closePlan(s.counts, s.sources.cut + s.sources.annotate), t.target_dataset?.name ?? null),
        ok: "Закрыть таску", icon: "archive", danger: true,
      });
      if (!ok) return;
    }
    if (to === "done" && s?.videos?.agent_left) {
      const ok = await confirm({
        title: "Сдать с непроверенным агента?",
        desc: `${count(s.videos.agent_left, "кадр", "кадра", "кадров")} из роликов с непроверенной разметкой агента в датасет не уйдут — останутся в ролике до проверки.`,
        ok: "Сдать", icon: "tick",
      });
      if (!ok) return;
    }
    // Карточка переезжает сразу; ответ сервера её поправит или вернёт
    const now = new Date().toISOString();
    board.patch(t.id, { status: to, status_at: now, last_at: now });
    setLanded(t.id);
    try {
      const res = await setTaskStatus(t.id, to);
      if (res.job_id) {
        // Сдача с роликами идёт фоном: карточка стоит «сдаётся», пока работа не кончится.
        // Своё живое событие доска не слушает — конец ловим опросом.
        setNotice(`«${t.name}» сдаётся — кадры роликов уходят в датасет.`);
        void pollJob<StatusResult>(res.job_id, () => {})
          .then((r) => setNotice(`«${t.name}»: ${handoverText(r)}`), (e) => setError(`«${t.name}»: ${(e as Error).message}`))
          .finally(() => void board.refresh([t.id]));
      } else if (to === "done" || to === "closed") {
        setNotice(`«${t.name}»: ${handoverText(res)}`);
      }
    } catch (e) {
      setError(`«${t.name}»: ${(e as Error).message}`);
    }
    await board.refresh([t.id]);
  }

  const colProps = (s: TaskStatus) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag || !drag.moves.includes(s)) return;
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
      {(error || board.error) && <Notice tone="error" onClose={() => setError(null)}>{error || board.error}</Notice>}
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
            const can = drag && s !== drag.from && drag.moves.includes(s);
            return (
              <section key={s} aria-label={STATUS[s].label} {...colProps(s)}
                className={cx("tb-col", drag && (s === drag.from ? "from" : can ? "can" : "no"), over === s && "over")}>
                <div className="tb-col-h">
                  <Dot color={STATUS[s].tone} />{STATUS[s].label}<span className="ui-count">{cols[s].length}</span>
                </div>
                {can && <div className="tb-drop"><Icon name="forward" size={14} />{DROP[s]}</div>}
                {items.map((t) => (
                  <TaskCard key={t.id} t={t} s={stats[t.id]} fresh={fresh[t.id]} at={at} code={code}
                    dragged={drag?.id === t.id} landed={landed === t.id}
                    onDragStart={() => requestAnimationFrame(() => setDrag({ id: t.id, from: t.status, moves: t.moves }))}
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

function TaskCard({ t, s, fresh, at, code, dragged, landed, onDragStart, onDragEnd }: {
  t: TaskLight;
  s: TaskStats | undefined;
  fresh: Fresh | undefined;
  at: number | null;
  code: string;
  dragged: boolean;
  landed: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const to = `/projects/${code}/tasks/${t.id}`;
  const movable = t.moves.length > 0;
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
  const v = look(s, fresh, at);
  // Переливается только карточка, чей запрос в пути; ждущие — неподвижная заготовка
  const zone = cx("tb-zone", v.stale && "stale", v.loading && "ui-shim", !v.has && !v.loading && "wait");
  const cls = cx("ui-card tb-card", movable && "movable", dragged && "dragged", landed && "landed");
  const face = s ? cardLook(t.status, s) : null;
  if (t.status === "closed") {
    return (
      <Link to={to} className={cx(cls, "closed")} draggable={false}>
        <b className="tb-name">{t.name}</b>
        <span className={cx(zone, "one")}>
          {face ? (
            <span className="tb-line" title={face.title}><CardLine line={face.line} /> · {ago(t.status_at)}</span>
          ) : <i className="ui-sk pill" style={{ width: 150 }} />}
        </span>
      </Link>
    );
  }
  return (
    <Link to={to} className={cls} {...dragProps}>
      <div className="tb-card-h">
        <b className="tb-name">{t.name}</b>
        {t.assignees.length > 0 && <Avatars names={t.assignees.map((p) => p.display_name)} max={3} />}
      </div>
      <span className="tb-src t-xs t-muted" title={s ? sourceLine(s.sources) : undefined}>
        <Icon name={s && (s.sources.cut || s.sources.annotate) ? "film" : "images"} size={14} />
        {s ? <span className="t-ell">{sourceLine(s.sources)}</span> : <i className="ui-sk pill" style={{ width: 120 }} />}
      </span>
      {/* Три строки всегда — полоса, числа, значки: после загрузки высота карточки не меняется.
          Каждая — в одну строку с многоточием: перенос ложился на соседнюю строку */}
      <span className={zone}>
        {!face ? (
          <>
            <i className="ui-sk bar" />
            <span className="tb-nums"><i className="ui-sk pill" /><i className="ui-sk pill" style={{ width: 30 }} /><i className="ui-sk pill" style={{ width: 36 }} /></span>
            <span className="tb-badges"><i className="ui-sk pill badge" /></span>
          </>
        ) : (
          <>
            {face.parts.some((p) => p.value) ? <StackBar parts={face.parts} /> : <i className="ui-stack" />}
            <span className={cx("tb-line", face.quiet && "quiet")} title={face.title}><CardLine line={face.line} /></span>
            <span className="tb-badges">
              {face.badges.map((b) => (
                <Badge key={b.text} tone={b.tone} icon={b.icon} live={b.live} title={b.title}><span className="t-ell">{b.text}</span></Badge>
              ))}
            </span>
          </>
        )}
      </span>
      <span className="tb-foot t-xs t-faint">
        <span className="t-ell">{teamLine(t.assignees)}</span>
        <span className="tb-when">
          {boxedRecently(t) && <Dot color="var(--st-done)" live />}
          <span className="t-ell">{statusNote(t)}</span>
        </span>
      </span>
    </Link>
  );
}

/** Строка чисел карточки: числа выделены, слова тише. Общая у доски и обзора. */
export function CardLine({ line }: { line: (string | number)[] }) {
  return <>{line.map((x, i) => (typeof x === "number" ? <b key={i}>{ru(x)}</b> : x))}</>;
}

/** «обновляется» со спиннером — пока идут запросы. */
function Updating({ children }: { children: ReactNode }) {
  return <span className="ui-upd"><i className="ui-spin" aria-hidden="true" />{children}</span>;
}
