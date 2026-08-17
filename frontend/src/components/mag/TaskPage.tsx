import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  closeVideoAnnotation,
  dropVideoFrames,
  getTask,
  getTaskEvents,
  getTaskImages,
  imageThumbUrl,
  reopenVideoAnnotation,
  setTaskStatus,
  uploadTaskImages,
  uploadTaskVideo,
} from "../../auth/api";
import type {
  ImageTaskStatus,
  TaskDetail,
  TaskEventItem,
  TaskImage,
  TaskStatus,
  TaskVideoItem,
} from "../../auth/api";
import { pollJob } from "../../api";
import AnnotationEditor from "./AnnotationEditor";
import { TaskState } from "./ProjectTasks";
import { plural } from "./ProjectsPage";
import { SourceCard, VideoCard, buildSources } from "./TaskSources";
import VideoAnnotator from "./VideoAnnotator";
import VideoCutModal from "./VideoCutModal";
import VideoModeModal from "./VideoModeModal";

const NEXT: Record<TaskStatus, { to: TaskStatus; label: string; hint: string }[]> = {
  queued: [{ to: "in_progress", label: "Взять в работу", hint: "" }],
  in_progress: [{ to: "done", label: "Готово", hint: "размеченные кадры уйдут в проект" }],
  done: [{ to: "updating", label: "Вернуться к разметке", hint: "" }],
  updating: [{ to: "done", label: "Готово", hint: "" }],
  closed: [],
};

// У размеченного кадра на метке число объектов, у остальных — словом.
const MARK: Partial<Record<ImageTaskStatus, string>> = {
  new: "—",
  skipped: "отложен",
  empty: "фон",
  deleted: "брак",
};

/** Четыре вкладки, четыре разных вопроса.
 *
 *  «Кадры» — откуда они взялись и сколько ещё осталось. «Видео» — что с
 *  роликами сделано. «Прогресс» — что уже размечено. «История» — что тут
 *  вообще происходило. Раньше первые две жили в одной куче под названием
 *  «Источники», и ни на один из вопросов список не отвечал внятно.
 */
type Tab = "frames" | "videos" | "progress" | "log";

const TABS: { id: Tab; label: string }[] = [
  { id: "frames", label: "Кадры" },
  { id: "videos", label: "Видео" },
  { id: "progress", label: "Прогресс разметки" },
  { id: "log", label: "История" },
];

export default function TaskPage() {
  const { code, taskId } = useParams<{ code: string; taskId: string }>();
  const navigate = useNavigate();

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [images, setImages] = useState<TaskImage[]>([]);
  const [events, setEvents] = useState<TaskEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("frames");

  // Редактор кадров открывается с подмножеством: «Размечать» у блока ведёт
  // только к кадрам этой загрузки, а не ко всей таске.
  const [editing, setEditing] = useState<{ list: TaskImage[]; index: number } | null>(null);
  const [cutting, setCutting] = useState<{ video: TaskVideoItem; at?: number } | null>(null);
  const [annotating, setAnnotating] = useState<TaskVideoItem | null>(null);
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const [t, imgs] = await Promise.all([
        getTask(taskId),
        getTaskImages(taskId, { limit: 200 }),
      ]);
      setTask(t);
      setImages(imgs.images);
      // Пустая таска открывается на видео: загрузить ролик — единственное
      // осмысленное действие, когда кадров ещё нет.
      if (firstLoad.current) {
        firstLoad.current = false;
        if (t.counts.total === 0) setTab(t.videos.length ? "videos" : "frames");
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === "log" && taskId) getTaskEvents(taskId).then(setEvents).catch(() => {});
  }, [tab, taskId]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  async function move(to: TaskStatus) {
    if (!taskId || !task) return;
    // Незакрытый ролик — это работа, которой ещё нет в кадрах. Молча сдать
    // таску мимо неё значило бы потерять разметку целого видео.
    if (to === "done" && task.pending_videos.length) {
      const list = task.pending_videos
        .map((v) => `«${v.file_name}» — ${v.frames} ${plural(v.frames, "кадр", "кадра", "кадров")}`)
        .join(", ");
      if (!window.confirm(
        `Разметка не закрыта у ${task.pending_videos.length} ` +
        `${plural(task.pending_videos.length, "ролика", "роликов", "роликов")}: ${list}. ` +
        "Эти кадры в проект не уйдут. Сдать всё равно?"
      )) return;
    }
    if (to === "closed") {
      const drafts = task.counts.total - task.counts.accepted + task.counts.deleted;
      const msg = drafts
        ? `Закрыть таску? Будет удалено ${drafts} ${plural(drafts, "черновой кадр", "черновых кадра", "черновых кадров")} и исходное видео. Действие необратимо.`
        : "Закрыть таску?";
      if (!window.confirm(msg)) return;
    }
    await guard(async () => {
      const res = await setTaskStatus(taskId, to);
      if (res.accepted) {
        setNotice(
          `В проект ушло ${res.accepted} ${plural(res.accepted, "кадр", "кадра", "кадров")} — датасет «${res.dataset}».`
        );
      } else if (to === "done") {
        setNotice("Размеченных кадров пока нет — принимать нечего.");
      } else if (res.removed_images !== undefined) {
        setNotice(`Удалено ${res.removed_images} черновых кадров.`);
      }
      await load();
    });
  }

  async function onFiles(files: FileList | null) {
    if (!files || !files.length || !taskId) return;
    setUploadPct(0);
    setError(null);
    try {
      await uploadTaskImages(taskId, [...files], setUploadPct);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadPct(null);
    }
  }

  /** «Размечать» у блока: берём кадры именно этого источника. */
  async function openSource(sourceKey: string) {
    if (!taskId) return;
    await guard(async () => {
      const res = await getTaskImages(taskId, { limit: 200, source: sourceKey });
      if (!res.images.length) return;
      const first = res.images.findIndex(
        (i) => i.task_status === "new" || i.task_status === "skipped"
      );
      setEditing({ list: res.images, index: first >= 0 ? first : 0 });
    });
  }

  /** Закрытие разметки ролика: фоновая задача, ждём её и обновляем таску. */
  async function closeVideo(video: TaskVideoItem) {
    if (!taskId) return;
    await guard(async () => {
      const { job_id } = await closeVideoAnnotation(taskId, video.id);
      setNotice(`Достаю кадры из «${video.file_name}»…`);
      const made = await pollJob<{ created: number; boxes: number }>(job_id, () => {});
      setNotice(
        `Разметка «${video.file_name}» закрыта: ${made.created} ` +
        `${plural(made.created, "кадр", "кадра", "кадров")} в таске.`
      );
      await load();
    });
  }

  if (error && !task) {
    return (
      <div className="mag-content">
        <div className="mag-error">{error}</div>
        <Link to={`/projects/${code}/tasks`} className="mag-link">← К таскам</Link>
      </div>
    );
  }
  if (!task) return <div className="mag-content mag-empty">Загружаем таску…</div>;

  const editable = task.can_work && task.status !== "closed";
  const sources = buildSources(task);
  const annotated = images.filter((i) => i.annotations > 0);
  const total = Math.max(1, task.counts.total);
  const percent = Math.round((task.counts.annotated / total) * 100);
  const counts: Record<Tab, string> = {
    frames: String(task.counts.total),
    videos: String(task.videos.length),
    progress: `${percent} %`,
    log: "",
  };

  return (
    <div className="mag-content">
      <div className="mag-crumbs">
        <Link to={`/projects/${code}/tasks`}>Таски</Link> / <b>{task.name}</b>
      </div>

      {error && <div className="mag-error">{error}</div>}
      {notice && <div className="mag-ok-banner">{notice}</div>}

      <div className="mag-task-strip">
        <div className="mag-task-id">
          <div className="mag-pass-title">
            <h1>{task.name}</h1>
            <TaskState status={task.status} label={task.status_label} />
          </div>
          <p>
            {task.assignee ? task.assignee.display_name : "без исполнителя"}
            {task.target_dataset ? ` · в датасет «${task.target_dataset.name}»` : ""}
          </p>
        </div>

        <div className="mag-task-nums">
          <div><b>{task.counts.annotated}</b><span>размечено</span></div>
          {task.counts.empty > 0 && <div><b>{task.counts.empty}</b><span>фон</span></div>}
          <div><b>{task.counts.skipped}</b><span>отложено</span></div>
          <div><b>{task.counts.new}</b><span>не тронуто</span></div>
          {task.counts.accepted > 0 && (
            <div><b>{task.counts.accepted}</b><span>в проекте</span></div>
          )}
        </div>

        <div className="mag-task-submit">
          {NEXT[task.status].map((s) => (
            <button key={s.to} className="mag-btn mag-btn-inline" type="button"
              disabled={busy || !task.can_work} title={s.hint} onClick={() => move(s.to)}>
              {s.label}
            </button>
          ))}
          {task.status !== "closed" && (
            <button className="mag-ghost mag-ghost-inline" type="button"
              disabled={busy || !task.can_work} onClick={() => move("closed")}>
              Закрыть
            </button>
          )}
        </div>

        <div className="mag-tprog mag-task-bar">
          <i className="done" style={{ width: `${(task.counts.annotated / total) * 100}%` }} />
          <i className="nul" style={{ width: `${(task.counts.empty / total) * 100}%` }} />
          <i className="skip" style={{ width: `${(task.counts.skipped / total) * 100}%` }} />
        </div>
      </div>

      <nav className="mag-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button"
            className={tab === t.id ? "mag-tab on" : "mag-tab"}
            onClick={() => setTab(t.id)}>
            {t.label} {counts[t.id] && <span>{counts[t.id]}</span>}
          </button>
        ))}
      </nav>

      {uploadPct !== null && (
        <div className="mag-card">
          <div className="mag-progress" style={{ marginTop: 0 }}>
            <div className="mag-progress-track">
              <i className={uploadPct >= 0.999 ? "indeterminate" : ""}
                style={uploadPct >= 0.999 ? undefined : { width: `${uploadPct * 100}%` }} />
            </div>
            <div className="mag-progress-lbl">
              <span>{uploadPct >= 0.999 ? "Обрабатываю на сервере…" : "Передаю файлы"}</span>
              <span>{uploadPct >= 0.999 ? "" : `${Math.round(uploadPct * 100)} %`}</span>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Кадры ---------------- */}
      {tab === "frames" && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Откуда кадры</h4>
            {editable && (
              <div className="mag-head-actions">
                <input ref={fileRef} type="file" accept="image/*" multiple hidden
                  onChange={(e) => onFiles(e.target.files)} />
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => fileRef.current?.click()}>
                  Загрузить изображения
                </button>
              </div>
            )}
          </div>

          {sources.length === 0 ? (
            <div className="g-empty">
              <b>Кадров пока нет</b>
              Загрузите изображения или добавьте ролик во вкладке «Видео».
            </div>
          ) : (
            <div className="g-blocks">
              {sources.map((block) => (
                <SourceCard key={block.key} taskId={task.id} block={block}
                  editable={editable} onAnnotate={() => openSource(block.key)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Видео ---------------- */}
      {tab === "videos" && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Ролики · {task.videos.length}</h4>
            {editable && (
              <div className="mag-head-actions">
                <input ref={videoRef} type="file" accept="video/*" hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Режим спрашиваем до отправки: он навсегда, а файл может
                    // быть на гигабайты — переливать его заново обидно.
                    if (f) setPendingVideo(f);
                    e.target.value = "";
                  }} />
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => videoRef.current?.click()}>
                  Добавить видео
                </button>
              </div>
            )}
          </div>

          {task.videos.length === 0 ? (
            <div className="g-empty">
              <b>Роликов пока нет</b>
              Добавьте видео — его можно нарезать на кадры или размечать целиком.
            </div>
          ) : (
            <div className="g-blocks">
              {task.videos.map((v) =>
                v.mode === "annotate" ? (
                  <VideoCard
                    key={v.id}
                    taskId={task.id}
                    video={v}
                    pending={task.pending_videos.find((p) => p.video_id === v.id)}
                    editable={editable}
                    busy={busy}
                    onOpen={() => setAnnotating(v)}
                    onClose={() => closeVideo(v)}
                    onReopen={() => guard(async () => {
                      await reopenVideoAnnotation(task.id, v.id);
                      await load();
                    })}
                    onDropFrames={() => {
                      if (!window.confirm(
                        `Убрать кадры «${v.file_name}» из таски? Принятые в проект останутся.`
                      )) return;
                      guard(async () => {
                        const res = await dropVideoFrames(task.id, v.id);
                        setNotice(
                          `Убрано ${res.removed} ${plural(res.removed, "кадр", "кадра", "кадров")}` +
                          (res.kept_accepted ? `, ${res.kept_accepted} осталось в проекте.` : ".")
                        );
                        await load();
                      });
                    }}
                  />
                ) : (
                  <CutVideoCard key={v.id} taskId={task.id} video={v} editable={editable}
                    onOpen={() => setCutting({ video: v })} />
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Прогресс разметки ---------------- */}
      {tab === "progress" && (
        <>
          {task.pending_videos.length > 0 && (
            <div className="mag-card g-warn">
              <b>Набор не окончательный.</b> У{" "}
              {task.pending_videos.length}{" "}
              {plural(task.pending_videos.length, "ролика", "роликов", "роликов")} разметка
              ещё не закрыта, и их кадров здесь нет:{" "}
              {task.pending_videos.map((v) => `«${v.file_name}» (${v.frames})`).join(", ")}.{" "}
              <button className="mag-link" type="button" onClick={() => setTab("videos")}>
                Закрыть разметку
              </button>
            </div>
          )}

          {task.classes.length > 0 && (
            <div className="mag-card">
              <div className="mag-card-h">
                <h4>Чем размечено</h4>
                <span className="mag-online-n">
                  {task.classes.reduce((s, c) => s + c.annotations, 0)} объектов в{" "}
                  {task.classes.length}{" "}
                  {plural(task.classes.length, "классе", "классах", "классах")}
                </span>
              </div>
              {task.classes.map((c) => {
                const maxCls = Math.max(1, ...task.classes.map((x) => x.annotations));
                return (
                  <div key={c.class_index} className="mag-cls">
                    <span className="mag-swatch" style={{ background: c.color }} />
                    <span className="mag-cls-id">{c.class_index}</span>
                    <span className="mag-cls-name"><b>{c.name}</b></span>
                    <span className="mag-cls-bar">
                      <i style={{ width: `${(c.annotations / maxCls) * 100}%`, background: c.color }} />
                    </span>
                    <span className="mag-cls-n">{c.annotations}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mag-card">
            <div className="mag-card-h">
              <h4>Размеченные кадры · {annotated.length}</h4>
              {editable && annotated.length > 0 && (
                <button className="mag-ghost mag-ghost-inline" type="button"
                  onClick={() => setEditing({ list: annotated, index: 0 })}>
                  Просмотреть
                </button>
              )}
            </div>
            {annotated.length === 0 ? (
              <div className="g-empty">
                <b>Размеченных кадров пока нет</b>
                Откройте кадры во вкладке «Кадры» и обведите объекты.
              </div>
            ) : (
              <div className="mag-tiles m">
                {annotated.map((im, i) => (
                  <div key={im.id} className="mag-tile-wrap">
                    <button className="mag-tile" type="button" title={im.file_name}
                      onClick={() => setEditing({ list: annotated, index: i })}>
                      <img src={imageThumbUrl(im.id)} alt="" loading="lazy" decoding="async" />
                      {im.boxes.map((b, k) => (
                        <span key={k} className="mag-tile-box" style={{
                          left: `${(b.x / (im.width || 1)) * 100}%`,
                          top: `${(b.y / (im.height || 1)) * 100}%`,
                          width: `${(b.w / (im.width || 1)) * 100}%`,
                          height: `${(b.h / (im.height || 1)) * 100}%`,
                          borderColor: b.color,
                        }} />
                      ))}
                      <span className={`mag-tile-mark ${im.task_status}`}>
                        {MARK[im.task_status] ?? im.annotations}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------------- История ---------------- */}
      {tab === "log" && (
        <div className="mag-card">
          <div className="mag-log">
            {events.length === 0 ? (
              <div className="mag-empty">Событий пока нет.</div>
            ) : (
              events.map((e) => (
                <div key={e.id} className="mag-log-row">
                  <span className="mag-log-when">
                    {new Date(e.created_at).toLocaleString("ru-RU", {
                      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                  <span className="mag-log-who">{e.user || "—"}</span>
                  <span className="mag-log-what">{describe(e)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {task.status === "closed" && (
        <p className="mag-hint" style={{ marginTop: 14 }}>
          Таска закрыта: черновики удалены, разметка заморожена. Принятые кадры
          остались в проекте —{" "}
          <button className="mag-link" type="button"
            onClick={() => navigate(`/projects/${code}/datasets`)}>
            смотреть датасеты
          </button>.
        </p>
      )}

      {pendingVideo && (
        <VideoModeModal
          fileName={pendingVideo.name}
          onClose={() => setPendingVideo(null)}
          onPick={(mode) => {
            const file = pendingVideo;
            setPendingVideo(null);
            if (!taskId) return;
            setUploadPct(0);
            uploadTaskVideo(taskId, file, setUploadPct, mode)
              .then(() => load())
              .catch((err) => setError((err as Error).message))
              .finally(() => setUploadPct(null));
          }}
        />
      )}

      {cutting && (
        <VideoCutModal taskId={task.id} video={cutting.video} editable={editable}
          startAtMs={cutting.at} onClose={() => setCutting(null)} onDone={load} />
      )}

      {annotating && (
        <VideoAnnotator code={code!} taskId={task.id} taskName={task.name}
          video={annotating} readOnly={!editable}
          onClose={() => { setAnnotating(null); load(); }} />
      )}

      {editing && editing.list[editing.index] && (
        <AnnotationEditor
          code={code!}
          taskName={task.name}
          images={editing.list}
          index={editing.index}
          readOnly={!editable}
          onIndex={(i) => setEditing((prev) => (prev ? { ...prev, index: i } : prev))}
          onClose={() => { setEditing(null); load(); }}
          onChanged={(updated) =>
            setEditing((prev) =>
              prev
                ? { ...prev, list: prev.list.map((x) => (x.id === updated.id ? updated : x)) }
                : prev
            )
          }
        />
      )}
    </div>
  );
}

/** Нарезаемый ролик: у него вопрос не «что размечено», а «что нарезано». */
function CutVideoCard({
  taskId, video, editable, onOpen,
}: {
  taskId: string;
  video: TaskVideoItem;
  editable: boolean;
  onOpen: () => void;
}) {
  const duration = video.duration_ms || 1;
  return (
    <div className="g-block">
      <div className="g-block-h">
        <h4>{video.file_name}</h4>
        <span className="g-chip">нарезка</span>
        <span className="g-sp" />
        <button className="mag-btn mag-btn-inline" type="button" onClick={onOpen}>
          {editable ? (video.segments.length ? "Нарезать ещё" : "Нарезать") : "Смотреть"}
        </button>
      </div>
      <div className="g-block-b g-vcard">
        <div className="g-vcard-nums">
          <div className="g-stat"><b>{video.frames}</b><span>кадров нарезано</span></div>
          <div className="g-stat s">
            <b>{video.segments.length}</b>
            <span>{plural(video.segments.length, "участок", "участка", "участков")}</span>
          </div>
        </div>
        <div className="g-vcard-body">
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
      <img src={`/api/tasks/${taskId}/videos/${video.id}/strip`} alt="" hidden />
    </div>
  );
}

function describe(e: TaskEventItem): JSX.Element {
  const p = e.payload as Record<string, string | number>;
  switch (e.kind) {
    case "created":
      return <>Таска создана{p.assignee ? <>, исполнитель — <b>{p.assignee}</b></> : null}</>;
    case "assigned":
      return <>Исполнитель — <b>{p.assignee ?? "снят"}</b></>;
    case "images_added":
      return <>Загружено <b>{p.added}</b> изображений{p.skipped ? `, пропущено ${p.skipped}` : ""}</>;
    case "video_added":
      return <>Добавлено видео <b>{p.file}</b>{p.mode === "annotate" ? " для разметки" : " для нарезки"}</>;
    case "video_cut":
      return <>Нарезано <b>{p.frames}</b> кадров из {p.file}, участков: {p.segments}</>;
    case "video_annotation_closed":
      return <>Разметка <b>{p.file}</b> закрыта: {p.frames} кадров, {p.boxes} объектов</>;
    case "video_annotation_reopened":
      return <>Разметка <b>{p.file}</b> открыта заново</>;
    case "video_frames_dropped":
      return <>Убрано <b>{p.removed}</b> кадров ролика {p.file}{p.kept ? `, оставлено принятых: ${p.kept}` : ""}</>;
    case "accepted":
      return <>Принято <b>{p.accepted}</b> кадров в датасет «{p.dataset}»</>;
    case "done":
      return <>Переведена в готово, принимать было нечего</>;
    case "closed":
      return <>Закрыта: удалено <b>{p.removed_images}</b> кадров и {p.removed_videos} видео</>;
    case "image_deleted":
      return <>Забракован кадр {p.file}</>;
    case "image_restored":
      return <>Кадр {p.file} вернули в работу</>;
    case "status":
      return <>Состояние: <b>{p.status}</b></>;
    default:
      return <>{e.kind}</>;
  }
}
