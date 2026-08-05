import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getTask,
  getTaskEvents,
  getTaskImages,
  imageThumbUrl,
  setTaskStatus,
  uploadTaskImages,
  uploadTaskVideo,
  videoStripUrl,
} from "../../auth/api";
import type {
  ImageTaskStatus,
  TaskDetail,
  TaskEventItem,
  TaskImage,
  TaskStatus,
  TaskVideoItem,
} from "../../auth/api";
import AnnotationEditor from "./AnnotationEditor";
import { TaskState } from "./ProjectTasks";
import { plural } from "./ProjectsPage";
import VideoCutModal, { fmtBytes, fmtTime } from "./VideoCutModal";

const NEXT: Record<TaskStatus, { to: TaskStatus; label: string; hint: string }[]> = {
  queued: [{ to: "in_progress", label: "Взять в работу", hint: "" }],
  in_progress: [{ to: "done", label: "Готово", hint: "размеченные кадры уйдут в проект" }],
  done: [{ to: "updating", label: "Вернуться к разметке", hint: "" }],
  updating: [{ to: "done", label: "Готово", hint: "" }],
  closed: [],
};

const SEG_COLORS = ["#e21a1a", "#1f6feb", "#1a7f4b", "#8957e5", "#e8590c"];
// У размеченного кадра на метке число объектов, у остальных — словом.
const MARK: Partial<Record<ImageTaskStatus, string>> = {
  new: "—",
  skipped: "отложен",
  empty: "фон",
  deleted: "брак",
};

type Tab = "sources" | "frames" | "log";

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
  const [editing, setEditing] = useState<number | null>(null);
  const [cutting, setCutting] = useState<{ video: TaskVideoItem; at?: number } | null>(null);
  const [tab, setTab] = useState<Tab>("frames");
  const [filter, setFilter] = useState("");

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
      // Пустая таска открывается на источниках: там единственное, что можно
      // сделать. Дальше вкладку выбирает человек.
      if (firstLoad.current) {
        firstLoad.current = false;
        if (t.counts.total === 0) setTab("sources");
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "log" && taskId) getTaskEvents(taskId).then(setEvents).catch(() => {});
  }, [tab, taskId]);

  async function move(to: TaskStatus) {
    if (!taskId || !task) return;
    if (to === "closed") {
      // Стирается всё, у чего нет датасета: и неразмеченное, и забракованное.
      const drafts =
        task.counts.total - task.counts.accepted + task.counts.deleted;
      const msg = drafts
        ? `Закрыть таску? Будет удалено ${drafts} ${plural(drafts, "черновой кадр", "черновых кадра", "черновых кадров")} и исходное видео. Действие необратимо.`
        : "Закрыть таску?";
      if (!window.confirm(msg)) return;
    }
    setBusy(true);
    setNotice(null);
    try {
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
  const shown = filter ? images.filter((i) => i.task_status === filter) : images;
  const total = Math.max(1, task.counts.total);
  const maxCls = Math.max(1, ...task.classes.map((c) => c.annotations));
  const videoById = new Map(task.videos.map((v) => [v.id, v]));

  return (
    <div className="mag-content">
      <div className="mag-crumbs">
        <Link to="/">Проекты</Link> / <Link to={`/projects/${code}`}>{code}</Link> /{" "}
        <Link to={`/projects/${code}/tasks`}>Таски</Link> / <b>{task.name}</b>
      </div>

      {error && <div className="mag-error">{error}</div>}
      {notice && <div className="mag-ok-banner">{notice}</div>}

      {/* Шапка держит прогресс и сдачу на виду, на какой бы вкладке ни был */}
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
          {task.counts.empty > 0 && (
            <div><b>{task.counts.empty}</b><span>фон</span></div>
          )}
          <div><b>{task.counts.skipped}</b><span>отложено</span></div>
          <div><b>{task.counts.new}</b><span>не тронуто</span></div>
          {task.counts.accepted > 0 && (
            <div><b>{task.counts.accepted}</b><span>в проекте</span></div>
          )}
          {task.counts.deleted > 0 && (
            <div><b>{task.counts.deleted}</b><span>забраковано</span></div>
          )}
        </div>

        <div className="mag-task-submit">
          {NEXT[task.status].map((s) => (
            <button
              key={s.to}
              className="mag-btn mag-btn-inline"
              type="button"
              disabled={busy || !task.can_work}
              title={s.hint}
              onClick={() => move(s.to)}
            >
              {s.label}
            </button>
          ))}
          {task.status !== "closed" && (
            <button
              className="mag-ghost mag-ghost-inline"
              type="button"
              disabled={busy || !task.can_work}
              onClick={() => move("closed")}
            >
              Закрыть
            </button>
          )}
        </div>

        {/* Фон идёт рядом с размеченным: в датасет уходит и то, и другое */}
        <div className="mag-tprog mag-task-bar">
          <i className="done" style={{ width: `${(task.counts.annotated / total) * 100}%` }} />
          <i className="nul" style={{ width: `${(task.counts.empty / total) * 100}%` }} />
          <i className="skip" style={{ width: `${(task.counts.skipped / total) * 100}%` }} />
        </div>
      </div>

      <nav className="mag-tabs">
        <button type="button" className={tab === "sources" ? "mag-tab on" : "mag-tab"}
          onClick={() => setTab("sources")}>
          Источники <span>{task.videos.length + (task.from_files ? 1 : 0)}</span>
        </button>
        <button type="button" className={tab === "frames" ? "mag-tab on" : "mag-tab"}
          onClick={() => setTab("frames")}>
          Кадры <span>{task.counts.total}</span>
        </button>
        <button type="button" className={tab === "log" ? "mag-tab on" : "mag-tab"}
          onClick={() => setTab("log")}>
          Что происходило
        </button>
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

      {tab === "sources" && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Откуда кадры</h4>
            {editable && (
              <div className="mag-head-actions">
                <input ref={fileRef} type="file" accept="image/*" multiple hidden
                  onChange={(e) => onFiles(e.target.files)} />
                <input ref={videoRef} type="file" accept="video/*" hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f && taskId) {
                      setUploadPct(0);
                      uploadTaskVideo(taskId, f, setUploadPct)
                        .then(() => load())
                        .catch((err) => setError((err as Error).message))
                        .finally(() => setUploadPct(null));
                    }
                  }} />
                <button className="mag-ghost mag-ghost-inline" type="button"
                  onClick={() => fileRef.current?.click()}>
                  Загрузить изображения
                </button>
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => videoRef.current?.click()}>
                  Добавить видео
                </button>
              </div>
            )}
          </div>

          {task.from_files > 0 && (
            <div className="mag-src-files">
              <b>{task.from_files}</b>
              <span>
                {plural(task.from_files, "изображение", "изображения", "изображений")} загружено
                файлами
              </span>
              <button className="mag-ghost mag-ghost-inline" type="button"
                onClick={() => { setFilter(""); setTab("frames"); }}>
                Показать кадры
              </button>
            </div>
          )}

          {task.videos.map((v) => (
            <VideoRow key={v.id} taskId={task.id} video={v} editable={editable}
              onOpen={(at) => setCutting({ video: v, at })} />
          ))}

          {task.videos.length === 0 && task.from_files === 0 && (
            <div className="mag-empty">
              Источников пока нет. Загрузите изображения или добавьте видео — из
              него нарежем кадры участками.
            </div>
          )}
        </div>
      )}

      {tab === "frames" && (
        <>
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
              {task.classes.map((c) => (
                <div key={c.class_index} className="mag-cls">
                  <span className="mag-swatch" style={{ background: c.color }} />
                  <span className="mag-cls-id">{c.class_index}</span>
                  <span className="mag-cls-name"><b>{c.name}</b></span>
                  <span className="mag-cls-bar">
                    <i style={{ width: `${(c.annotations / maxCls) * 100}%`, background: c.color }} />
                  </span>
                  <span className="mag-cls-n">{c.annotations}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mag-card">
            <div className="mag-card-h">
              <h4>Кадры · {shown.length}</h4>
              <div className="mag-head-actions">
                <select value={filter} aria-label="Фильтр"
                  onChange={(e) => setFilter(e.target.value)}>
                  <option value="">Все</option>
                  <option value="new">Не тронутые</option>
                  <option value="annotated">Размеченные</option>
                  <option value="empty">Фоновые</option>
                  <option value="skipped">Отложенные</option>
                  <option value="deleted">Забракованные</option>
                </select>
                {editable && images.length > 0 && (
                  <button className="mag-btn mag-btn-inline" type="button"
                    onClick={() => {
                      // Встаём на первый кадр, по которому решения ещё нет.
                      const first = images.findIndex(
                        (i) => i.task_status === "new" || i.task_status === "skipped"
                      );
                      setEditing(first >= 0 ? first : 0);
                    }}>
                    {task.counts.annotated > 0 ? "Продолжить разметку →" : "Начать разметку →"}
                  </button>
                )}
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="mag-empty">
                {images.length === 0
                  ? "Кадров пока нет — загрузите их во вкладке «Источники»."
                  : "Под фильтр ничего не подошло."}
              </div>
            ) : (
              <div className="mag-tiles m">
                {shown.map((im) => {
                  const src = im.source_video_id ? videoById.get(im.source_video_id) : undefined;
                  return (
                    <div key={im.id} className="mag-tile-wrap">
                      <button className="mag-tile" type="button"
                        onClick={() => setEditing(images.findIndex((x) => x.id === im.id))}
                        title={im.file_name}>
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
                      {/* Кадр ссылается на источник: по одному кадру объект
                          часто не опознать, а соседние секунды объясняют. */}
                      {src && im.source_time_ms !== null ? (
                        <button className="mag-from" type="button"
                          onClick={() => setCutting({ video: src, at: im.source_time_ms! })}>
                          ▶ {fmtTime(im.source_time_ms)}
                        </button>
                      ) : (
                        <span className="mag-from file">файл</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

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

      {cutting && (
        <VideoCutModal taskId={task.id} video={cutting.video} editable={editable}
          startAtMs={cutting.at} onClose={() => setCutting(null)} onDone={load} />
      )}

      {editing !== null && images[editing] && (
        <AnnotationEditor
          code={code!}
          taskName={task.name}
          images={images}
          index={editing}
          readOnly={!editable}
          onIndex={setEditing}
          onClose={() => { setEditing(null); load(); }}
          onChanged={(updated) =>
            setImages((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
          }
        />
      )}
    </div>
  );
}

// --- строка видео: компоновка И2, всё развёрнуто сразу ---

function VideoRow({
  taskId,
  video,
  editable,
  onOpen,
}: {
  taskId: string;
  video: TaskVideoItem;
  editable: boolean;
  onOpen: (at?: number) => void;
}) {
  const duration = video.duration_ms || 1;
  return (
    <div className="mag-src-video">
      <button className="mag-poster" type="button" onClick={() => onOpen()}>
        <img src={videoStripUrl(taskId, video.id)} alt="" />
        <span className="mag-poster-play">▶</span>
        <span className="mag-poster-dur">{fmtTime(duration)}</span>
      </button>

      <div className="mag-src-main">
        <div className="mag-src-name">{video.file_name}</div>
        <div className="mag-src-facts">
          <div><b>{video.frames}</b>кадров нарезано</div>
          <div>
            <b>{video.segments.length}</b>
            {plural(video.segments.length, "участок", "участка", "участков")}
          </div>
          <div><b>{fmtTime(duration)}</b>· {video.fps} к/с · {video.width}×{video.height}</div>
          <div><b>{fmtBytes(video.size_bytes)}</b></div>
        </div>

        <div className="mag-mini">
          {video.segments.map((s, i) => (
            <span key={i} className="mag-mini-seg" style={{
              left: `${(s.start_ms / duration) * 100}%`,
              width: `${((s.end_ms - s.start_ms) / duration) * 100}%`,
              background: `${SEG_COLORS[i % SEG_COLORS.length]}55`,
              borderColor: SEG_COLORS[i % SEG_COLORS.length],
            }} />
          ))}
        </div>

        {video.segments.length > 0 ? (
          <div className="mag-seglist">
            {video.segments.map((s, i) => {
              // Участок в миллисекунду — это одиночный кадр, а не диапазон.
              const single = s.end_ms - s.start_ms <= 1;
              const frames = single
                ? 1
                : Math.max(0, Math.ceil((s.end_ms - s.start_ms) / Math.max(1, s.step_ms)));
              return (
                <div key={i} className="mag-segline">
                  <i style={{ background: SEG_COLORS[i % SEG_COLORS.length] }} />
                  {single ? (
                    <>кадр в {fmtTime(s.start_ms)}</>
                  ) : (
                    <>
                      {fmtTime(s.start_ms)} — {fmtTime(s.end_ms)}, шаг{" "}
                      {s.step_ms >= 1000 ? `${s.step_ms / 1000} с` : `${s.step_ms} мс`}
                    </>
                  )}
                  <span className="sp">
                    {frames} {plural(frames, "кадр", "кадра", "кадров")} ·{" "}
                    <button type="button" onClick={() => onOpen(s.start_ms)}>показать</button>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mag-hint" style={{ margin: "8px 0 0" }}>
            Участков пока нет — нажмите «Нарезать» и выберите их на дорожке.
          </p>
        )}
      </div>

      <div className="mag-src-act">
        <button className="mag-btn mag-btn-inline" type="button" onClick={() => onOpen()}>
          {editable ? (video.segments.length ? "Нарезать ещё" : "Нарезать") : "Смотреть"}
        </button>
      </div>
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
      return <>Добавлено видео <b>{p.file}</b></>;
    case "video_cut":
      return <>Нарезано <b>{p.frames}</b> кадров из {p.file}, участков: {p.segments}</>;
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
