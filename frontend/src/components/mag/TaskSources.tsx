import { plural } from "./ProjectsPage";
import { fmtBytes, fmtTime } from "./VideoCutModal";
import type {
  PendingVideo,
  TaskDetail,
  TaskVideoItem,
  VideoPrepare,
} from "../../auth/api";
import VideoStrip from "./VideoStrip";

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
  kind: "files" | "cut";
  video?: TaskVideoItem;
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

  for (const video of task.videos) {
    if (video.mode === "annotate") continue;
    const counts = (task.by_source || {})[video.id] || {};
    // Ролик показывается всегда, даже пока из него ничего не нарезано:
    // именно с этого блока в нарезку и заходят. Раньше блок появлялся только
    // с первым кадром, и инструмент считался пропавшим.
    out.push({
      key: video.id,
      title: video.file_name,
      kind: "cut",
      video,
      counts,
      total:
        (counts.new || 0) + (counts.annotated || 0) + (counts.empty || 0) +
        (counts.skipped || 0),
      bornAt: at(video.created_at),
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
  /** Открыть нарезку. Есть только у блока ролика. */
  onCut?: () => void;
  /** Убрать ролик вместе с нарезанными из него кадрами. */
  onDelete?: () => void;
}) {
  const { counts, total, video } = block;
  const share = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  const left = (counts.new || 0) + (counts.skipped || 0);
  const duration = video?.duration_ms || 1;

  return (
    <div className="g-block">
      <div className="g-block-h">
        {video && (
          <VideoStrip className="g-block-poster" taskId={taskId} videoId={video.id} />
        )}
        <h4>{block.title}</h4>
        <span className="g-chip">{video ? "нарезка" : "изображения"}</span>
        <span className="g-sp" />
        {video && <PrepareLine prepare={video.prepare} />}
        {block.counts.first_at && (
          <span className="g-when">
            {new Date(block.counts.first_at).toLocaleString("ru-RU", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            })}
          </span>
        )}
        {video && onCut && (
          <button className="mag-btn mag-btn-inline" type="button" onClick={onCut}>
            {!editable ? "Смотреть" : video.segments.length ? "Нарезать ещё" : "Нарезать"}
          </button>
        )}
        {editable && total > 0 && (
          <button className="mag-btn mag-btn-inline" type="button" onClick={onAnnotate}>
            Размечать
          </button>
        )}
        {video && editable && onDelete && (
          <TrashButton title="Убрать ролик и нарезанные из него кадры"
            onClick={onDelete} />
        )}
      </div>

      {video && (
        <div className="g-block-b g-vcard">
          <div className="g-vcard-nums">
            <div className="g-stat"><b>{video.frames}</b><span>кадров нарезано</span></div>
            <div className="g-stat s">
              <b>{video.segments.length}</b>
              <span>{plural(video.segments.length, "участок", "участка", "участков")}</span>
            </div>
            <div className="g-stat s">
              <b>{fmtTime(video.duration_ms || 0)}</b>
              <span>{fmtBytes(video.size_bytes || 0)}</span>
            </div>
          </div>
          <div className="g-vcard-body">
            {/* Где именно нарезано вдоль ролика. Ради этого ролик и живёт до
                закрытия таски: видно, какой кусок ещё не разобран. */}
            <div className="g-rail">
              <span className="g-rail-line" />
              {video.segments.map((s, i) => (
                <u key={i} style={{
                  left: `${(s.start_ms / duration) * 100}%`,
                  width: `${Math.max(0.6, ((s.end_ms - s.start_ms) / duration) * 100)}%`,
                }} />
              ))}
              {[0, 0.25, 0.5, 0.75, 1].map((m) => (
                <i key={m} className="major" style={{ left: `${m * 100}%` }} />
              ))}
            </div>
            {video.segments.length === 0 && (
              <p className="g-vcard-note">
                Участков пока нет — нажмите «Нарезать» и выберите их на дорожке.
              </p>
            )}
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
              {left ? ` · ${left} в работе` : " · всё пройдено"}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Карточка ролика, компоновка К4: числа слева крупно, под кинолентой —
 *  шкала кадров, где красным закрашено размеченное. Видно не только сколько,
 *  но и где именно: в начале, в конце или кучкой посередине. */
export function VideoCard({
  taskId,
  video,
  pending,
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
            <p className="g-vcard-note">
              Размечено {pending.boxes} {plural(pending.boxes, "объект", "объекта", "объектов")} на{" "}
              {pending.frames} {plural(pending.frames, "кадре", "кадрах", "кадрах")}. Кадры
              появятся в таске, когда закроете разметку.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
