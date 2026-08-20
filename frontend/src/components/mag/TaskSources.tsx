import { plural } from "./ProjectsPage";
import { fmtBytes, fmtTime } from "./VideoCutModal";
import type { PendingVideo, TaskDetail, TaskVideoItem } from "../../auth/api";
import VideoStrip from "./VideoStrip";

/** Блоки вкладки «Кадры» и карточки вкладки «Видео».
 *
 * Две компоновки, потому что вопросы разные. В «Кадрах» человек спрашивает
 * «сколько ещё осталось» — это доля целого, и полоса отвечает раньше любой
 * цифры. Во «Видео» вопрос другой: «что с роликом сделано и где» — тут
 * выигрывает шкала кадров, потому что у разметки видео есть место во времени.
 */

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
  kind: "files" | "cut" | "annotate";
  video?: TaskVideoItem;
  counts: SourceCounts;
  total: number;
  firstAt: number;
}

/** Источники по времени появления: ранний сверху — так список читается как
 *  история работы, а не как случайный набор. */
export function buildSources(task: TaskDetail): SourceBlock[] {
  const out: SourceBlock[] = [];
  const add = (key: string, title: string, kind: SourceBlock["kind"], video?: TaskVideoItem) => {
    const counts = (task.by_source || {})[key] || {};
    const total =
      (counts.new || 0) + (counts.annotated || 0) + (counts.empty || 0) + (counts.skipped || 0);
    if (!total && !counts.deleted) return;
    out.push({
      key,
      title,
      kind,
      video,
      counts,
      total,
      firstAt: counts.first_at ? Date.parse(counts.first_at) : 0,
    });
  };

  add("files", "Загружено файлами", "files");
  for (const video of task.videos) {
    add(video.id, video.file_name, video.mode === "annotate" ? "annotate" : "cut", video);
  }
  return out.sort((a, b) => a.firstAt - b.firstAt);
}

const MARK: Record<SourceBlock["kind"], { label: string; cls: string }> = {
  files: { label: "изображения", cls: "" },
  cut: { label: "нарезка", cls: "" },
  annotate: { label: "из разметки видео", cls: "mark" },
};

/** Блок источника, компоновка К3: доли читаются полосой раньше, чем цифрами. */
export function SourceCard({
  taskId,
  block,
  editable,
  onAnnotate,
}: {
  taskId: string;
  block: SourceBlock;
  editable: boolean;
  onAnnotate: () => void;
}) {
  const { counts, total } = block;
  const share = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  const mark = MARK[block.kind];
  const left = (counts.new || 0) + (counts.skipped || 0);

  return (
    <div className="g-block">
      <div className="g-block-h">
        {block.video && (
          <VideoStrip className="g-block-poster"
            taskId={taskId} videoId={block.video.id} />
        )}
        <h4>{block.title}</h4>
        <span className={`g-chip ${mark.cls}`}>{mark.label}</span>
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
        <button className="mag-ghost mag-ghost-inline" type="button" onClick={onOpen}>
          {editable && !closed ? "Размечать" : "Смотреть"}
        </button>
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
