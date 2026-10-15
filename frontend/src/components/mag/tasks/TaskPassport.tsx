// Паспорт таски справа: состояние, готовность со ссылками в редактор, смена состояния, кто и куда, классы, события.

import { Link } from "react-router-dom";
import type { ProjectMemberInfo, TaskDetail, TaskEventItem, TaskNumbers, TaskStatus } from "../../../auth/api";
import { Avatar, Badge, Button, Icon, Progress, Ring, Swatch, cx, useTween } from "../../../ui";
import { ago, count, ru } from "../../ru";
import { describeTaskEvent } from "../taskEvents";
import type { FrameState } from "./tasks";
import { NEXT, STATES, STATUS, dayOf, decidedOf, framesOf, inDataset } from "./tasks";
import { TeamEdit, TeamView } from "./Team";
import type { Look } from "./useTaskBoard";
import { openVideos } from "./useTaskPage";

const NO_CLASSES: TaskNumbers["classes"] = [];

export function TaskPassport({ task, numbers, numbersLook, pendingFrames, pendingLook, events, workers, busy, handing,
  onState, onMove, onClose, onAssign, onHistory }: {
  task: TaskDetail;
  /** Счётчики; null — ещё в пути, на их месте заготовка той же высоты. */
  numbers: TaskNumbers | null;
  numbersLook: Look;
  /** Кадров роликов уйдёт при сдаче; null — сводки ещё в пути. */
  pendingFrames: number | null;
  pendingLook: Look;
  events: TaskEventItem[];
  workers: ProjectMemberInfo[];
  busy: boolean;
  /** Доля хода идущей сдачи; null — не сдаётся. */
  handing: number | null;
  onState: (s: FrameState) => void;
  onMove: (to: TaskStatus) => void;
  onClose: () => void;
  onAssign: (ids: string[]) => void;
  onHistory: () => void;
}) {
  const c = numbers?.counts;
  const classes = numbers?.classes ?? NO_CLASSES;
  const frames = c ? framesOf(c) : 0;
  const decided = c ? decidedOf(c) : 0;
  const st = STATUS[task.status];
  const closed = task.status === "closed";
  const moves = task.rights.moves;
  const shownDecided = useTween(decided);
  const share = frames ? decided / frames : 0;
  const shownPct = useTween(Math.floor(share * 100));
  // Уйдёт в датасет: решённое вкладки «Кадры» плюс кадры роликов, когда придут их сводки
  // Копии кадров датасета ложатся на исходники — в «уйдёт в датасет» их нет
  const toAccept = c && pendingFrames !== null ? Math.max(0, decided - c.accepted - (c.copies_decided ?? 0)) + pendingFrames : null;
  const objects = classes.reduce((s, x) => s + x.annotations, 0);
  const maxCls = Math.max(1, ...classes.map((x) => x.annotations));
  // Главный переход страницы — если он мне разрешён; закрытие отдельной кнопкой внизу
  const next = NEXT[task.status] && moves.includes(NEXT[task.status]!.to) ? NEXT[task.status] : null;
  // Кольцо стоит, если в таске есть кадры или открытые ролики — это известно сразу, без чисел
  const hasWork = Object.values(task.sources || {}).some((s) => s.frames > 0) || openVideos(task).length > 0;
  const zone = (l: Look) => cx(l.stale && "tp-stale", l.loading && "ui-shim");

  return (
    <aside className="ui-card tp-pass" aria-label="Паспорт таски">
      <section>
        <h5>Состояние</h5>
        <div className="tp-state">
          <Badge tone={st.tone} live={task.status === "in_progress"}>{st.label}</Badge>
          <span className="t-xs t-faint">с {dayOf(task.status_at)}</span>
        </div>
      </section>

      {hasWork && (
        <section>
          <div className={cx("tp-ring", zone(numbersLook))}>
            {c ? (
              <Ring value={share} size={96} color="var(--st-done)" draw label={`Решено ${Math.floor(share * 100)} %`}>
                <b>{Math.round(shownPct)}<small> %</small></b>
              </Ring>
            ) : <i className="ui-sk tp-ring-sk" />}
            {/* Три строки всегда: решено, подпись, уйдёт из роликов — высота не меняется, когда придут числа */}
            <div className="tp-ring-t">
              {c ? <b><span className="ui-mono">{ru(shownDecided)}</span> из <span className="ui-mono">{ru(frames)}</span></b>
                : <i className="ui-sk pill" style={{ width: 90, height: 14 }} />}
              <span className="t-sm t-muted">кадров решено</span>
              <span className={cx("t-xs t-faint tp-ring-w", zone(pendingLook))}>
                {pendingFrames === null ? <i className="ui-sk pill" style={{ width: 150 }} />
                  : pendingFrames > 0 ? <>+ {count(pendingFrames, "кадр", "кадра", "кадров")} из роликов при сдаче</> : null}
              </span>
            </div>
          </div>
          {/* Все шесть состояний всегда — нули бледные: строки не появляются и не пропадают */}
          <div className={cx("tp-cnts", zone(numbersLook))}>
            {STATES.map((s) => {
              const n = c ? (s.key === "agent" ? c.agent || 0 : c[s.key]) : null;
              return (
                <button key={s.key} type="button" className={cx("tp-cnt", s.key === "agent" && "sub", !n && "zero")}
                  disabled={!n} onClick={() => onState(s.key)} title={n ? "Открыть эти кадры в редакторе" : undefined}>
                  <i style={{ background: s.color }} /><span>{s.label}</span>
                  {n === null ? <span className="ui-sk pill" style={{ width: 28 }} /> : <b className="ui-mono">{ru(n)}</b>}
                  <Icon name="forward" size={14} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      {(closed || next || handing !== null) && <section>
        {closed ? (
          <>
            <span className="t-sm">Таска закрыта{c && inDataset(c) ? `: ${count(inDataset(c), "кадр", "кадра", "кадров")} в датасете` : ""}.</span>
            <Link to={`/projects/${task.project.code}/datasets`} className="t-sm">Смотреть датасеты</Link>
          </>
        ) : handing !== null ? (
          <>
            <span className="t-sm">Сдаётся… {Math.round(handing * 100)} %</span>
            <Progress value={handing} label="Сдача таски" />
          </>
        ) : next?.to === "done" ? (
          <>
            <Button variant="primary" icon="tick" className="tp-wide" disabled={busy} onClick={() => onMove("done")}>Готово</Button>
            <span className="t-xs t-faint">
              {toAccept === null ? <i className="ui-sk pill" style={{ width: 80 }} />
                : toAccept ? `${count(toAccept, "кадр уйдёт", "кадра уйдут", "кадров уйдут")}` : "Новых кадров не уйдёт"} в датасет
              {task.target_dataset ? ` «${task.target_dataset.name}»` : ""}. Нетронутые и отложенные останутся в таске.
            </span>
          </>
        ) : next ? (
          <>
            {task.status === "done" && !!c && inDataset(c) > 0 && (
              <span className="t-sm">{count(inDataset(c), "кадр", "кадра", "кадров")} в датасете{task.target_dataset ? ` «${task.target_dataset.name}»` : ""}.</span>
            )}
            <Button variant={task.status === "queued" ? "primary" : "outline"} icon={task.status === "queued" ? "play" : "undo"}
              className="tp-wide" disabled={busy} onClick={() => onMove(next.to)}>{next.label}</Button>
          </>
        ) : null}
      </section>}

      <section>
        <h5>Паспорт</h5>
        <dl className="tp-kv">
          <dt>Исполнители</dt>
          <dd>
            {task.rights.assign && workers.length
              ? <TeamEdit team={task.assignees} workers={workers} busy={busy} onSave={onAssign} />
              : <TeamView people={task.assignees} />}
          </dd>
          <dt>Датасет</dt>
          <dd className="t-ell">
            {task.target_dataset ? <>«{task.target_dataset.name}»{!task.target_dataset.id && <span className="t-faint"> новый</span>}</> : "—"}
          </dd>
          <dt>Создана</dt>
          <dd>{dayOf(task.created_at)}{task.created_by ? `, ${task.created_by}` : ""}</dd>
        </dl>
      </section>

      {events.length > 0 && (
        <section>
          <div className="tp-sec-h"><h5>Последнее</h5><Button variant="ghost" size="sm" onClick={onHistory}>Вся история</Button></div>
          <EventList events={events.slice(0, 4)} />
        </section>
      )}

      {classes.length > 0 && (
        <section>
          <h5>Чем размечено · {count(objects, "объект", "объекта", "объектов")}</h5>
          <div className="tp-cls-l">
            {classes.map((x) => (
              <div key={x.class_index} className="tp-cbar" title={x.name}>
                <Swatch color={x.color} /><span className="t-ell">{x.name}</span>
                <span className="tp-cbar-t"><i style={{ width: `${(x.annotations / maxCls) * 100}%`, background: x.color }} /></span>
                <b className="ui-mono">{ru(x.annotations)}</b>
              </div>
            ))}
          </div>
        </section>
      )}

      {moves.includes("closed") && (
        <section>
          <Button variant="danger" icon="archive" className="tp-wide" disabled={busy} onClick={onClose}>Закрыть таску…</Button>
        </section>
      )}
    </aside>
  );
}

export function EventList({ events }: { events: TaskEventItem[] }) {
  return (
    <ul className="tp-feed">
      {events.map((e) => (
        <li key={e.id}>
          {e.user ? <Avatar name={e.user} size={22} /> : <span className="tp-sys"><Icon name="settings" size={12} /></span>}
          <span className="tp-ev">{e.user && <b>{e.user}</b>}<span className="t-muted">{describeTaskEvent(e.kind, e.payload)}</span></span>
          <span className="t-xs t-faint" title={new Date(e.created_at).toLocaleString("ru-RU")}>{ago(e.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}
