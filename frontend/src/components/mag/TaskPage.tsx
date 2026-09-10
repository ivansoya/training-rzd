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
  deleteTaskVideo,
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
import { pollJob } from "../../api/jobs";
import AnnotationEditor from "./AnnotationEditor";
import ShapeMini from "./ShapeMini";
import { TaskState } from "./ProjectTasks";
import { plural } from "./ProjectsPage";
import { SourceCard, VideoCard, buildSources } from "./TaskSources";
import VideoAnnotator from "./VideoAnnotator";
import VideoCutModal from "./VideoCutModal";
import Sep from "../Sep";

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

  const fileRef = useRef<HTMLInputElement>(null);
  // Два поля выбора файла на две вкладки: режим ролика решает вкладка, а не
  // отдельный вопрос человеку. Из «Кадров» ролик грузится под нарезку, из
  // «Видео» — под разметку.
  const cutRef = useRef<HTMLInputElement>(null);
  const annotateRef = useRef<HTMLInputElement>(null);
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
      // Пустая таска открывается на «Кадрах»: и загрузка изображений, и
      // добавление ролика под нарезку теперь там. Исключение — когда уже есть
      // размечаемый ролик: его работа в своей вкладке.
      if (firstLoad.current) {
        firstLoad.current = false;
        const annotate = t.videos.some((v) => v.mode === "annotate");
        if (t.counts.total === 0 && annotate) setTab("videos");
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

  // Пока с роликом что-то делают, таску переспрашиваем: подготовка идёт на
  // сервере, и сама себя на экране она не обновит. Как только всё готово —
  // опрос прекращается, иначе он шёл бы до закрытия вкладки.
  const preparing = (task?.videos || []).some(
    (v) => v.prepare && (v.prepare.busy || (!v.prepare.ready && !v.prepare.error))
  );
  useEffect(() => {
    if (!preparing) return undefined;
    const id = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(id);
  }, [preparing, load]);

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

  /** Загрузить ролики. Режим не спрашиваем: вкладка уже ответила.
   *
   *  По одному запросу на файл и строго по очереди: ролик на сотни мегабайт
   *  и так занимает канал целиком, а параллельная отправка нескольких только
   *  растянула бы каждый. Полоса показывает общий ход по числу файлов.
   */
  async function onVideo(files: FileList | null, mode: "cut" | "annotate") {
    const list = Array.from(files || []);
    if (!list.length || !taskId) return;
    setUploadPct(0);
    setError(null);
    try {
      for (const [i, file] of list.entries()) {
        await uploadTaskVideo(
          taskId, file,
          (pct) => setUploadPct((i + pct) / list.length),
          mode
        );
      }
      if (list.length > 1) {
        setNotice(`Загружено ${list.length} ${plural(list.length, "ролик", "ролика", "роликов")}.`);
      }
      await load();
    } catch (e) {
      // Уже уехавшие файлы остаются в таске: перезагружаем, чтобы человек
      // видел, что дошло, а что нет.
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setUploadPct(null);
    }
  }

  /** Убрать ролик целиком. Ролик живёт до закрытия таски затем, чтобы к нему
   *  возвращаться, — значит и уходит он вместе со всем, что из него нарезано. */
  async function removeVideo(video: TaskVideoItem) {
    if (!taskId) return;
    const frames = video.frames;
    // У размечаемого ролика кадры появляются только после «Закрыть разметку»,
    // и уходят они вместе с ним — кроме принятых в датасет. Прилагательное
    // склоняется вместе с существительным, поэтому формы заданы целиком.
    const forms: [string, string, string] =
      video.mode === "annotate"
        ? ["кадр разметки", "кадра разметки", "кадров разметки"]
        : ["нарезанный кадр", "нарезанных кадра", "нарезанных кадров"];
    const ask = frames
      ? `Убрать «${video.file_name}» и ${frames} ${plural(frames, ...forms)}? ` +
        "Принятые в проект останутся."
      : `Убрать «${video.file_name}»?`;
    if (!window.confirm(ask)) return;
    await guard(async () => {
      const res = await deleteTaskVideo(taskId, video.id);
      setNotice(
        res.removed
          ? `Ролик «${res.file_name}» убран вместе с ${res.removed} ` +
            `${plural(res.removed, "кадром", "кадрами", "кадрами")}` +
            (res.kept_accepted ? `, ${res.kept_accepted} осталось в проекте.` : ".")
          : `Ролик «${res.file_name}» убран.`
      );
      await load();
    });
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
  // Сумма по незакрытым роликам: столько кадров появится в таске, когда
  // разметку закроют, и столько же уйдёт в датасет.
  const pending = task ? task.pending_videos.reduce(
    (acc, v) => ({
      frames: acc.frames + v.frames,
      boxes: acc.boxes + v.boxes,
      empty: acc.empty + (v.empty || 0),
    }),
    { frames: 0, boxes: 0, empty: 0 }
  ) : { frames: 0, boxes: 0, empty: 0 };

  async function closeVideo(video: TaskVideoItem) {
    if (!taskId) return;
    await guard(async () => {
      const { job_id } = await closeVideoAnnotation(taskId, video.id);
      setNotice(`Достаю кадры из «${video.file_name}»…`);
      const made = await pollJob<{ created: number; boxes: number; empty: number }>(job_id, () => {});
      setNotice(
        `Разметка «${video.file_name}» закрыта: ${made.created} ` +
        `${plural(made.created, "кадр", "кадра", "кадров")} в таске` +
        (made.empty
          ? `, из них ${made.empty} ${plural(made.empty, "фоновый", "фоновых", "фоновых")}.`
          : ".")
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
  // Во вкладке «Видео» только размечаемые: нарезка живёт в «Кадрах» как
  // источник, а здесь — своя работа со своим редактором.
  const annotateVideos = task.videos.filter((v) => v.mode === "annotate");
  const annotated = images.filter((i) => i.annotations > 0);
  const total = Math.max(1, task.counts.total);
  const percent = Math.round((task.counts.annotated / total) * 100);
  const counts: Record<Tab, string> = {
    frames: String(task.counts.total),
    videos: String(annotateVideos.length),
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
            {task.target_dataset ? ` — в датасет «${task.target_dataset.name}»` : ""}
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
          {/* Работа по незакрытому ролику кадрами ещё не стала, и во всех
              счётчиках выше её нет. Без этого числа шапка говорит «размечать
              не начинали» там, где размечен целый ролик. */}
          {pending.frames > 0 && (
            <div className="mag-task-pending" title={
              `В роликах размечено ${pending.boxes} ` +
              plural(pending.boxes, "объект", "объекта", "объектов") +
              (pending.empty ? ` и ${pending.empty} ` +
                plural(pending.empty, "кадр отмечен фоновым", "кадра отмечено фоновыми", "кадров отмечено фоновыми") : "") +
              ". Кадрами таски они станут, когда закроете разметку."
            }>
              <b>{pending.frames}</b><span>ждут закрытия</span>
            </div>
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
        <div className="mag-card mag-upload-card">
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
                <input ref={cutRef} type="file" accept="video/*" multiple hidden
                  onChange={(e) => {
                    void onVideo(e.target.files, "cut");
                    e.target.value = "";
                  }} />
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => fileRef.current?.click()}>
                  Загрузить изображения
                </button>
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => cutRef.current?.click()}>
                  Добавить видео
                </button>
              </div>
            )}
          </div>

          {sources.length === 0 ? (
            <div className="g-empty">
              <b>Кадров пока нет</b>
              Загрузите изображения или добавьте видео — из него нарежутся кадры.
            </div>
          ) : (
            <div className="g-blocks">
              {sources.map((block) => (
                <SourceCard key={block.key} taskId={task.id} block={block}
                  editable={editable}
                  onAnnotate={() => openSource(block.key)}
                  onCut={block.videos ? (video) => setCutting({ video }) : undefined}
                  onDelete={block.videos ? (video) => removeVideo(video) : undefined} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Видео ---------------- */}
      {tab === "videos" && (
        <div className="mag-card">
          <div className="mag-card-h">
            <h4>Ролики <Sep /> {annotateVideos.length}</h4>
            {editable && (
              <div className="mag-head-actions">
                <input ref={annotateRef} type="file" accept="video/*" multiple hidden
                  onChange={(e) => {
                    void onVideo(e.target.files, "annotate");
                    e.target.value = "";
                  }} />
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => annotateRef.current?.click()}>
                  Добавить видео
                </button>
              </div>
            )}
          </div>

          {annotateVideos.length === 0 ? (
            <div className="g-empty">
              <b>Роликов пока нет</b>
              Здесь размечают само видео покадрово. Чтобы нарезать ролик на
              кадры, добавьте его во вкладке «Кадры».
            </div>
          ) : (
            <div className="g-blocks">
              {annotateVideos.map((v) => (
                <VideoCard
                  key={v.id}
                  taskId={task.id}
                  video={v}
                  pending={task.pending_videos.find((p) => p.video_id === v.id)}
                  classes={task.classes}
                  editable={editable}
                  busy={busy}
                  onOpen={() => setAnnotating(v)}
                  onDelete={() => removeVideo(v)}
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
              ))}
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
              Всего {pending.frames} {plural(pending.frames, "кадр", "кадра", "кадров")}
              {pending.empty > 0 && `, из них ${pending.empty} фоновых`}.{" "}
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
              <h4>Размеченные кадры <Sep /> {annotated.length}</h4>
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
                      <ShapeMini boxes={im.boxes} width={im.width} height={im.height} />
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
