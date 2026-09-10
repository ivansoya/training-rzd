import { useState } from "react";
import { plural } from "./ProjectsPage";
import { fmtBytes, fmtStep, fmtTime, framesIn } from "./VideoCutModal";
import type {
  PendingObject,
  PendingVideo,
  TaskDetail,
  TaskVideoItem,
  VideoPrepare,
} from "../../auth/api";

/** Классы таски: нужны карточкам, чтобы назвать объект по имени и цвету. */
type TaskClass = TaskDetail["classes"][number];
import VideoStrip from "./VideoStrip";
import Sep from "../Sep";

/** Блоки вкладки «Кадры» и карточки вкладки «Видео».
 *
 * Две компоновки, потому что вопросы разные. В «Кадрах» человек спрашивает
 * «сколько ещё осталось» — это доля целого, и полоса отвечает раньше любой
 * цифры. Во «Видео» вопрос другой: «что с роликом сделано и где» — тут
 * выигрывает шкала кадров, потому что у разметки видео есть место во времени.
 */

/** Что делают с роликом прямо сейчас.
 *
 * Подготовка идёт на сервере и снаружи невидима: пока её не показывали,
 * свежезагруженный ролик выглядел просто сломанным — открывается и ничего не
 * показывает. Доля считается по той работе, что идёт, а не по ролику целиком:
 * работ несколько, и общего знаменателя у них нет.
 */
export function PrepareLine({ prepare }: { prepare?: VideoPrepare }) {
  if (!prepare) return null;
  if (prepare.error) {
    return <span className="g-prep bad">не удалось: {prepare.error}</span>;
  }
  if (!prepare.busy) {
    return prepare.ready ? null : <span className="g-prep">готовится…</span>;
  }
  const pct =
    prepare.total > 0
      ? Math.min(100, Math.round((prepare.processed / prepare.total) * 100))
      : null;
  return (
    <span className="g-prep">
      <i />
      {prepare.stage_text || "готовлю"}
      {pct !== null && <b>{pct}%</b>}
    </span>
  );
}

/** Корзина. Действие редкое и с последствиями — ему хватает значка, а место
 *  в шапке блока дороже отдать тому, чем пользуются каждый день. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.5 1a1 1 0 0 0-1 1v.5H2.75a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H10.5V2a1 1 0 0 0-1-1h-3ZM7 2.5V2h2v.5H7Z"
      />
      <path
        fill="currentColor"
        d="M3.6 5.5h8.8l-.6 8.1a1.5 1.5 0 0 1-1.5 1.4H5.7a1.5 1.5 0 0 1-1.5-1.4l-.6-8.1Zm2.65 1.75a.6.6 0 0 0-.6.63l.25 5a.6.6 0 0 0 1.2-.06l-.25-5a.6.6 0 0 0-.6-.57Zm3.5 0a.6.6 0 0 0-.6.57l-.25 5a.6.6 0 0 0 1.2.06l.25-5a.6.6 0 0 0-.6-.63Z"
      />
    </svg>
  );
}

/** Кнопка «убрать»: значок вместо слова, объяснение — в подсказке. */
function TrashButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button className="g-trash" type="button" title={title} aria-label={title}
      onClick={onClick}>
      <TrashIcon />
    </button>
  );
}

export interface SourceCounts {
  new?: number;
  annotated?: number;
  empty?: number;
  skipped?: number;
  deleted?: number;
  accepted?: number;
  first_at?: string;
}

export interface SourceBlock {
  key: string;
  title: string;
  /** Число рядом с заголовком. Отдельным полем, а не внутри строки: между
   *  ними стоит разделитель, нарисованный CSS. */
  count?: number;
  kind: "files" | "cut";
  /** Все нарезаемые ролики таски — блок у них общий. Резать каждый приходится
   *  отдельно (у ролика свой план), а размечают нарезанное со всех разом:
   *  кадр от кадра ничем не отличается, и делить их по происхождению значило
   *  бы гонять разметчика по вкладкам. */
  videos?: TaskVideoItem[];
  counts: SourceCounts;
  total: number;
  /** Когда источник появился. У ролика — когда его загрузили, у файлов —
   *  когда пришёл первый кадр. Именно появление источника, а не первого
   *  кадра: иначе ненарезанный ролик прыгал бы в начало списка, а после
   *  первой нарезки уезжал вниз — под руками у того, кто с ним работает. */
  bornAt: number;
}

/** Источники вкладки «Кадры» по времени появления: ранний сверху — так список
 *  читается как история работы, а не как случайный набор.
 *
 * Ролики режима разметки сюда не попадают: у них своя вкладка со своим
 * редактором, и деление у нас по роду работы, а не по тому, откуда взялась
 * картинка. Кадры, которые остаются после закрытия их разметки, видно в
 * «Прогрессе» — материализация ставит им состояние «размечено».
 */
export function buildSources(task: TaskDetail): SourceBlock[] {
  const out: SourceBlock[] = [];
  const at = (value?: string | null) => (value ? Date.parse(value) : 0);

  const files = (task.by_source || {}).files || {};
  const filesTotal =
    (files.new || 0) + (files.annotated || 0) + (files.empty || 0) + (files.skipped || 0);
  if (filesTotal || files.deleted) {
    out.push({
      key: "files",
      title: "Загружено файлами",
      kind: "files",
      counts: files,
      total: filesTotal,
      bornAt: at(files.first_at),
    });
  }

  // Ролики показываются всегда, даже пока из них ничего не нарезано: именно
  // с этого блока в нарезку и заходят. Раньше блок появлялся только с первым
  // кадром, и инструмент считался пропавшим.
  const videos = task.videos.filter((v) => v.mode === "cut");
  if (videos.length) {
    const counts: SourceCounts = {};
    let bornAt = Infinity;
    for (const video of videos) {
      const own = (task.by_source || {})[video.id] || {};
      for (const key of ["new", "annotated", "empty", "skipped", "deleted", "accepted"] as const) {
        counts[key] = (counts[key] || 0) + (own[key] || 0);
      }
      bornAt = Math.min(bornAt, at(video.created_at));
    }
    out.push({
      key: "videos",
      title: "Ролики",
      count: videos.length,
      kind: "cut",
      videos,
      counts,
      total:
        (counts.new || 0) + (counts.annotated || 0) + (counts.empty || 0) +
        (counts.skipped || 0),
      bornAt: Number.isFinite(bornAt) ? bornAt : 0,
    });
  }
  return out.sort((a, b) => a.bornAt - b.bornAt);
}

/** Блок источника: откуда кадры, сколько их и что с ними сделано.
 *
 * Блок один на источник — и у файлов, и у ролика. Прежде ролик показывался
 * двумя карточками в двух вкладках: «сколько нарезано и где» в одной и
 * «сколько размечено» в другой. Один источник — одна строка в списке, иначе
 * на трёх роликах получается шесть блоков с одинаковыми заголовками.
 *
 * Доли читаются полосой раньше, чем цифрами: человек спрашивает «сколько ещё
 * осталось», и полоса отвечает первой.
 */
export function SourceCard({
  taskId,
  block,
  editable,
  onAnnotate,
  onCut,
  onDelete,
}: {
  taskId: string;
  block: SourceBlock;
  editable: boolean;
  onAnnotate: () => void;
  /** Открыть нарезку названного ролика. Есть только у блока роликов. */
  onCut?: (video: TaskVideoItem) => void;
  /** Убрать ролик вместе с нарезанными из него кадрами. */
  onDelete?: (video: TaskVideoItem) => void;
}) {
  const { counts, total } = block;
  const videos = block.videos || [];
  // Подробности плана — по требованию: на пяти роликах пять таблиц сразу
  // превращают вкладку в полотно, а нужны они по одному ролику за раз.
  const [open, setOpen] = useState<string | null>(null);
  const share = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  const left = (counts.new || 0) + (counts.skipped || 0);

  return (
    <div className="g-block">
      <div className="g-block-h">
        {videos[0] && (
          <VideoStrip className="g-block-poster" taskId={taskId} videoId={videos[0].id} />
        )}
        <h4>{block.title}{block.count !== undefined && <><Sep />{block.count}</>}</h4>
        <span className="g-chip">{videos.length ? "нарезка" : "изображения"}</span>
        <span className="g-sp" />
        {block.counts.first_at && (
          <span className="g-when">
            {new Date(block.counts.first_at).toLocaleString("ru-RU", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            })}
          </span>
        )}
        {editable && total > 0 && (
          <button className="mag-btn mag-btn-inline" type="button" onClick={onAnnotate}>
            Размечать
          </button>
        )}
      </div>

      {videos.length > 0 && (
        /* По строке на ролик: режут каждый отдельно, своим планом. Общая тут
           только разметка — кнопка на весь блок выше. */
        <div className="g-block-b">
          <div className="g-plan-box g-reels">
            {videos.map((video) => {
              const frames = video.frames || 0;
              const cut = video.segments.length;
              return (
                <div className="g-reel" key={video.id}>
                  <VideoStrip className="g-reel-poster" taskId={taskId} videoId={video.id} />
                  <div className="g-reel-name">
                    <b title={video.file_name}>{video.file_name}</b>
                    <span>
                      {fmtTime(video.duration_ms || 0)} <Sep /> {video.width}×{video.height} <Sep />{" "}
                      {fmtBytes(video.size_bytes)}
                    </span>
                    {/* Где по ролику взяты участки. Одно число «3» не говорит
                        ни где они, ни сколько ролика осталось неразобранным. */}
                    <span className="g-reel-rail" aria-hidden="true">
                      {video.segments.map((seg, i) => (
                        <u key={i} style={{
                          left: `${(seg.start_ms / (video.duration_ms || 1)) * 100}%`,
                          width: `${Math.max(0.8, ((seg.end_ms - seg.start_ms) / (video.duration_ms || 1)) * 100)}%`,
                        }} />
                      ))}
                    </span>
                  </div>
                  <div className="g-reel-nums">
                    <b>{frames.toLocaleString("ru-RU")}</b>
                    <span>{plural(frames, "кадр", "кадра", "кадров")} нарезано</span>
                  </div>
                  {cut ? (
                    <button className="g-reel-segs" type="button"
                      aria-expanded={open === video.id}
                      onClick={() => setOpen((id) => (id === video.id ? null : video.id))}>
                      {cut} {plural(cut, "участок", "участка", "участков")}
                      <i aria-hidden="true">{open === video.id ? "▴" : "▾"}</i>
                    </button>
                  ) : (
                    <span className="g-reel-segs none">не нарезан</span>
                  )}
                  <PrepareLine prepare={video.prepare} />
                  {onCut && (
                    <button className="mag-ghost mag-btn-inline" type="button"
                      onClick={() => onCut(video)}>
                      {!editable ? "Смотреть" : cut ? "Нарезать ещё" : "Нарезать"}
                    </button>
                  )}
                  {editable && onDelete && (
                    <TrashButton title="Убрать ролик и нарезанные из него кадры"
                      onClick={() => onDelete(video)} />
                  )}
                  {open === video.id && (
                    <table className="g-plan g-reel-plan">
                      <thead>
                        <tr><th>участок</th><th>с — по</th><th>длина</th><th>шаг</th><th>кадров</th></tr>
                      </thead>
                      <tbody>
                        {video.segments.map((seg, i) => (
                          <tr key={i}>
                            <td>{seg.end_ms - seg.start_ms <= 1 ? "кадр" : `${i + 1}`}</td>
                            <td>{fmtTime(seg.start_ms)} — {fmtTime(seg.end_ms)}</td>
                            <td>{fmtTime(Math.max(0, seg.end_ms - seg.start_ms))}</td>
                            <td>{seg.end_ms - seg.start_ms <= 1 ? "—" : fmtStep(seg.step_ms)}</td>
                            <td>{framesIn(seg).toLocaleString("ru-RU")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {total > 0 && (
        <div className="g-block-b">
          <div className="g-meter">
            <i className="m-done" style={{ width: share(counts.annotated || 0) }} />
            <i className="m-null" style={{ width: share(counts.empty || 0) }} />
            <i className="m-skip" style={{ width: share(counts.skipped || 0) }} />
          </div>
          <div className="g-legend">
            <div><span className="g-dot" style={{ background: "var(--done)" }} />
              <em>{counts.annotated || 0}</em> размечено</div>
            {(counts.empty || 0) > 0 && (
              <div><span className="g-dot" style={{ background: "var(--null)" }} />
                <em>{counts.empty}</em> фон</div>
            )}
            {(counts.skipped || 0) > 0 && (
              <div><span className="g-dot" style={{ background: "var(--skip)" }} />
                <em>{counts.skipped}</em> отложено</div>
            )}
            <div><span className="g-dot" style={{ background: "var(--hair)" }} />
              <em>{counts.new || 0}</em> не тронуто</div>
            {(counts.deleted || 0) > 0 && (
              <div><em>{counts.deleted}</em> забраковано</div>
            )}
            <span className="g-sp" />
            <div><em>{total}</em> {plural(total, "кадр", "кадра", "кадров")}
              {left ? ` — ${left} в работе` : " — всё пройдено"}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Как назвать объект. Имя и цвет приходят вместе с планом; на классы таски
 *  опираемся только как на запасной вариант — они считаются по уже созданным
 *  аннотациям, которых у незакрытого ролика ещё нет. */
function classOf(
  classes: TaskClass[] | undefined,
  o: PendingObject
): { name: string; color: string } {
  if (o.class_name) return { name: o.class_name, color: o.class_color || "#9aa4ae" };
  const found = (classes || []).find((c) => c.class_index === o.class_index);
  return found
    ? { name: found.name, color: found.color }
    : { name: o.class_index === null ? "класс не задан" : `класс ${o.class_index}`, color: "#9aa4ae" };
}

/** Карточка ролика, компоновка К4: числа слева крупно, под кинолентой —
 *  шкала кадров, где красным закрашено размеченное. Видно не только сколько,
 *  но и где именно: в начале, в конце или кучкой посередине. */
export function VideoCard({
  taskId,
  video,
  pending,
  classes,
  editable,
  busy,
  onOpen,
  onClose,
  onReopen,
  onDropFrames,
  onDelete,
}: {
  taskId: string;
  video: TaskVideoItem;
  pending?: PendingVideo;
  /** Классы таски: карточка называет объект по имени и цвету. */
  classes?: TaskClass[];
  editable: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onReopen: () => void;
  onDropFrames: () => void;
  /** Убрать ролик со всем, что из него вышло и ещё не попало в датасет. */
  onDelete: () => void;
}) {
  const closed = video.annotation_closed_at !== null;
  const lastFrame = Math.max(1, (video.frame_count || 1) - 1);
  const marks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="g-block">
      <div className="g-block-h">
        <h4>{video.file_name}</h4>
        <span className={closed ? "g-chip done" : "g-chip mark"}>
          {closed ? "разметка закрыта" : "размечается"}
        </span>
        <PrepareLine prepare={video.prepare} />
        <span className="g-sp" />
        {editable && !closed && (
          <button className="mag-btn mag-btn-inline" type="button"
            disabled={busy} onClick={onClose}
            title="Превратить разметку в кадры таски">
            Закрыть разметку
          </button>
        )}
        {editable && closed && (
          <button className="mag-ghost mag-ghost-inline" type="button"
            disabled={busy} onClick={onReopen}>
            Открыть заново
          </button>
        )}
        {/* Пока таблица кадров не построена, а перегоны не нарезаны, в
            редакторе показывать нечего. Он бы честно написал «готовится», но
            человек, нажавший кнопку и упёршийся в пустой экран, решит, что
            сломалось. Проще не пускать. */}
        <button className="mag-ghost mag-ghost-inline" type="button"
          disabled={!video.prepare?.ready}
          title={video.prepare?.ready ? undefined : "Ролик ещё готовится"}
          onClick={onOpen}>
          {editable && !closed ? "Размечать" : "Смотреть"}
        </button>
        {editable && (
          <TrashButton
            title="Убрать ролик и всё, что из него вышло и ещё не попало в датасет"
            onClick={onDelete} />
        )}
      </div>

      <div className="g-block-b g-vcard">
        <div className="g-vcard-nums">
          <div className="g-stat">
            <b>{video.frames || pending?.frames || 0}</b>
            <span>{video.frames ? "кадров в таске" : "кадров уйдёт в таску"}</span>
          </div>
          <div className="g-stat s"><b>{video.tracks}</b><span>объектов ведётся</span></div>
          <div className="g-stat s">
            <b>{video.frame_count ?? "—"}</b><span>кадров в ролике</span>
          </div>
        </div>

        <div className="g-vcard-body">
          <VideoStrip className="g-strip" taskId={taskId} videoId={video.id} />
          <div className="g-rail">
            <span className="g-rail-line" />
            {/* Закрашено то, что уже стало кадрами: у нарезки — участки плана,
                у разметки — доля, покрытая треками. */}
            {video.mode === "cut"
              ? video.segments.map((s, i) => (
                  <u key={i} style={{
                    left: `${(s.start_ms / (video.duration_ms || 1)) * 100}%`,
                    width: `${((s.end_ms - s.start_ms) / (video.duration_ms || 1)) * 100}%`,
                  }} />
                ))
              : null}
            {marks.map((m) => (
              <i key={m} className="major" style={{ left: `${m * 100}%` }} />
            ))}
            {marks.map((m) => (
              <b key={`l${m}`} style={{ left: `${m * 100}%` }}>{Math.round(m * lastFrame)}</b>
            ))}
          </div>

          <div className="g-vcard-facts">
            <span className="g-chip">{fmtTime(video.duration_ms || 0)}</span>
            <span className="g-chip">{video.width}×{video.height}</span>
            <span className="g-chip">{video.fps} к/с</span>
            <span className="g-chip">{fmtBytes(video.size_bytes)}</span>
          </div>

          {editable && video.frames > 0 && (
            <p className="g-vcard-note">
              У ролика {video.frames} {plural(video.frames, "кадр", "кадра", "кадров")} в
              таске. Чтобы разметить его заново,{" "}
              <button className="mag-link" type="button" disabled={busy} onClick={onDropFrames}>
                уберите их
              </button>{" "}
              — принятые в проект останутся.
            </p>
          )}
          {!closed && pending && (
            <>
              {/* Ошибка плана раньше молча превращалась в нули, и карточка
                  ролика с тремя треками выглядела как ролик без разметки. */}
              {pending.error && (
                <p className="g-vcard-fail">
                  <b>Разметку не закрыть.</b> {pending.error}
                </p>
              )}
              {(pending.objects || []).length > 0 && (
                <div className="g-plan-box">
                <table className="g-plan">
                  <thead>
                    <tr>
                      <th>объект</th><th>кадры</th><th>ключей</th>
                      <th>шаг</th><th>уйдёт кадров</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(pending.objects || []).map((o, i) => {
                      const cls = classOf(classes, o);
                      return (
                        <tr key={i} className={o.error ? "bad" : undefined}>
                          <td><i style={{ background: cls.color }} />{cls.name}</td>
                          <td>{o.start}—{o.end}</td>
                          <td>
                            {o.keys}
                            {!o.interpolate && " — без интерполяции"}
                            {o.hidden > 0 && ` — ${o.hidden} ${plural(o.hidden, "зона", "зоны", "зон")} невидимости`}
                          </td>
                          <td>{o.step === 1 ? "каждый" : `каждый ${o.step}-й`}</td>
                          <td>{o.error
                            ? <em title={o.error}>не считается</em>
                            : o.frames.toLocaleString("ru-RU")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
              {!pending.error && <p className="g-vcard-note">
                {/* Фоновые кадры несут ноль объектов, и без отдельного числа
                    выходило «7 объектов на 10 кадрах» — три кадра из десяти
                    выглядели бы недоразмеченными. */}
                Размечено {pending.boxes} {plural(pending.boxes, "объект", "объекта", "объектов")} на{" "}
                {pending.frames - pending.empty}{" "}
                {plural(pending.frames - pending.empty, "кадре", "кадрах", "кадрах")}
                {pending.empty > 0 && <>
                  {", ещё "}{pending.empty}{" "}
                  {plural(pending.empty, "кадр отмечен фоновым", "кадра отмечено фоновыми", "кадров отмечено фоновыми")}
                </>}
                {(pending.singles || 0) > 0 && `, одиночных фигур ${pending.singles}`}
                . Все {pending.frames} {plural(pending.frames, "кадр", "кадра", "кадров")}{" "}
                {plural(pending.frames, "появится", "появятся", "появятся")} в таске и уйдут в
                датасет, когда закроете разметку.
              </p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
