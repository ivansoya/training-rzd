import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  acceptAgentFrames,
  assignTask,
  getProject,
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
  ProjectMemberInfo,
  PendingVideo,
  TaskDetail,
  TaskEventItem,
  TaskImage,
  TaskStatus,
  TaskVideoItem,
} from "../../auth/api";
import { pollJob } from "../../api/jobs";
import AnnotationEditor, { saveSettled } from "./AnnotationEditor";
import ShapeMini from "./ShapeMini";
import { TaskState } from "./ProjectTasks";
import { count, plural } from "../ru";
import { SourceCard, VideoCard, buildSources } from "./TaskSources";
import UploadImagesModal from "./UploadImagesModal";
import { setImageTags, setVideoTags } from "../../api/tags";
import type { Tag } from "../../api/tags";
import VideoAnnotator from "./VideoAnnotator";
import VideoCutModal from "./VideoCutModal";
import Sep from "../Sep";
import Banner from "../Banner";
import AgentRunDialog, { AgentRunBar } from "../agents/AgentRunDialog";
import ScoutOverview from "../agents/ScoutOverview";
import { useScouts } from "../agents/scout";
import { runContext, type RunView } from "../../api/agents";

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

/** Все кадры выборки. Сервер отдаёт не больше 200 за раз, и прежде всё, что
 *  дальше двухсотого, было недоступно: редактор писал «1 из 200» у таски на
 *  205 кадров. Добираем страницами до `matched`.
 *  ponytail: грузим разом — таски здесь на сотни кадров; на десятках тысяч
 *  понадобится лента, догружающая страницы по мере прокрутки. */
async function allImages(
  taskId: string,
  params: { status?: string; source?: string }
): Promise<TaskImage[]> {
  const PAGE = 200;
  const first = await getTaskImages(taskId, { ...params, limit: PAGE });
  const out = [...first.images];
  while (out.length < first.matched) {
    const next = await getTaskImages(taskId, { ...params, limit: PAGE, offset: out.length });
    if (!next.images.length) break;
    out.push(...next.images);
  }
  return out;
}

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
  // Кому админ может отдать таску: зритель размечать не может, его в списке нет.
  const [workers, setWorkers] = useState<ProjectMemberInfo[]>([]);
  const [images, setImages] = useState<TaskImage[]>([]);
  const [events, setEvents] = useState<TaskEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("frames");
  // Справочник тагов приезжает с таской, но пополняется прямо на странице:
  // чип-пикер заводит таг по ходу дела, и ждать перезагрузки таски ради его
  // появления в соседнем списке — не дело.
  const [tags, setTags] = useState<Tag[]>([]);
  // Выбранные файлы ждут ответа на один вопрос — таг. До 13.09.2026 они
  // улетали сразу, и происхождение кадра, известное только тому, кто их
  // принёс, терялось в ту же секунду.
  const [picked, setPicked] = useState<File[] | null>(null);

  // Редактор кадров открывается с подмножеством: «Размечать» у блока ведёт
  // только к кадрам этой загрузки, а не ко всей таске.
  const [editing, setEditing] = useState<{ list: TaskImage[]; index: number } | null>(null);
  // Открытый кадр живёт в адресе (?frame=<id>): «Назад» браузера закрывает
  // редактор, а не уводит со страницы таски, и на кадр можно дать ссылку.
  // Шаг по кадрам адрес заменяет, а не добавляет — иначе «Назад» пришлось бы
  // жать столько раз, сколько кадров пролистали.
  const [search, setSearch] = useSearchParams();
  const frameParam = search.get("frame");
  // Запись в истории, которую добавили мы сами: закрывая редактор, её
  // снимаем шагом назад. Пришли по ссылке — снимать нечего, адрес чистим.
  const pushed = useRef(false);
  const setFrame = useCallback((id: string | null, replace: boolean) => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("frame", id);
      else next.delete("frame");
      return next;
    }, { replace });
  }, [setSearch]);
  const openEditor = useCallback((list: TaskImage[], index: number) => {
    setEditing({ list, index });
    setFrame(list[index].id, false);
    pushed.current = true;
  }, [setFrame]);
  const closeEditor = useCallback(() => {
    setEditing(null);
    if (pushed.current) {
      pushed.current = false;
      navigate(-1);
    } else {
      setFrame(null, true);
    }
  }, [navigate, setFrame]);
  const [cutting, setCutting] = useState<{ video: TaskVideoItem; at?: number } | null>(null);
  const [annotating, setAnnotating] = useState<TaskVideoItem | null>(null);
  // Агент: окно запуска и последний прогон по этой таске.
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentRun, setAgentRun] = useState<RunView | null>(null);
  // Общая статистика разведки: кнопка есть, если разведан хоть один ролик.
  const scouted = Object.keys(useScouts(taskId || "")).length > 0;
  const [overviewOpen, setOverviewOpen] = useState(false);

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
      // Редактор мог только что закрыться, отправив последнюю правку: читаем
      // после неё, иначе перечитанный кадр покажет разметку до правки.
      await saveSettled();
      // Странице нужны только размеченные — их сетка во вкладке «Прогресс».
      // Все кадры подряд уходят в редактор по «Размечать», каждый раз свежими.
      const [t, imgs] = await Promise.all([
        getTask(taskId),
        allImages(taskId, { status: "annotated" }),
      ]);
      setTask(t);
      setImages(imgs);
      setTags(t.tags);
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

  const adminOf = task?.is_admin ? task.project.code : null;
  useEffect(() => {
    if (!adminOf) return;
    getProject(adminOf)
      .then((d) => setWorkers(d.members.filter((m) => m.role !== "viewer")))
      .catch(() => setWorkers([]));
  }, [adminOf]);

  const reassign = useCallback(async (id: string) => {
    if (!task) return;
    try {
      await assignTask(task.id, id || null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [task, load]);

  useEffect(() => { load(); }, [load]);

  // Адрес и редактор сходятся. Кадр из адреса ушёл («Назад») — редактор
  // закрывается; кадр в адресе есть, а редактор закрыт (ссылка, «Вперёд») —
  // открываем его на всех кадрах таски. Не нашли кадр — чистим адрес.
  useEffect(() => {
    if (!taskId) return;
    if (!frameParam) {
      if (editing) { pushed.current = false; setEditing(null); }
      return;
    }
    if (editing) return;
    let alive = true;
    allImages(taskId, {})
      .then((list) => {
        if (!alive) return;
        const at = list.findIndex((i) => i.id === frameParam);
        if (at >= 0) setEditing({ list, index: at });
        else setFrame(null, true);
      })
      .catch((e) => setError((e as Error).message));
    return () => { alive = false; };
    // editing нарочно не в зависимостях: реагируем на смену адреса.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameParam, taskId]);

  // Редактор закрылся — перечитываем таску. Здесь, а не в обработчике
  // закрытия: к этому моменту редактор уже размонтирован и отправил
  // последнюю правку, и load() её дождётся (saveSettled).
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) void load();
    wasEditing.current = !!editing;
  }, [editing, load]);

  // Идущий прогон видно и после перезагрузки страницы: строка хода
  // показывается, пока он не кончится. Законченный старый — нет.
  useEffect(() => {
    if (!taskId) return;
    runContext(taskId)
      .then((ctx) => {
        const last = ctx.runs[0];
        if (last && ["queued", "waiting_gpu", "running"].includes(last.status)) setAgentRun(last);
      })
      .catch(() => undefined);
  }, [taskId]);

  const acceptAgent = useCallback(async (source: string) => {
    if (!taskId) return;
    try {
      const got = await acceptAgentFrames(taskId, { source });
      setNotice(`Принято кадров: ${got.accepted}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId, load]);

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
      const list = task.pending_videos.map(pendingLabel).join(", ");
      if (!window.confirm(
        `Разметка не закрыта у ${task.pending_videos.length} ` +
        `${plural(task.pending_videos.length, "ролика", "роликов", "роликов")}: ${list}. ` +
        "Эти кадры в проект не уйдут. Сдать всё равно?"
      )) return;
    }
    if (to === "closed") {
      // Закрытие сначала принимает размеченные и фоновые кадры, удаляет только черновое.
      const c = task.counts;
      const toAccept = Math.max(0, c.annotated + c.empty - c.accepted);
      const drafts = Math.max(0, c.total + c.deleted - c.accepted - toAccept);
      // Про ролики — только если они есть: «и исходное видео» у таски из
      // одних файлов пугало удалением того, чего не было.
      const videos = task.videos.length;
      const gone = [
        drafts ? count(drafts, "черновой кадр", "черновых кадра", "черновых кадров") : "",
        videos ? (videos === 1 ? "исходное видео" : `исходные видео (${videos})`) : "",
      ].filter(Boolean).join(" и ");
      const parts = [
        toAccept ? `${count(toAccept, "размеченный кадр уйдёт", "размеченных кадра уйдут", "размеченных кадров уйдут")} в датасет.` : "",
        gone ? `Будут удалены ${gone} — это необратимо.` : "",
      ].filter(Boolean);
      if (!window.confirm(["Закрыть таску?", ...parts].join(" "))) return;
    }
    await guard(async () => {
      const res = await setTaskStatus(taskId, to);
      if (to === "closed") {
        const said = [
          res.accepted ? `В проект ушло ${count(res.accepted, "кадр", "кадра", "кадров")} — датасет «${res.dataset}».` : "",
          res.removed_images ? `${plural(res.removed_images, "Удалён", "Удалено", "Удалено")} ${count(res.removed_images, "черновой кадр", "черновых кадра", "черновых кадров")}.` : "",
        ].filter(Boolean);
        if (said.length) setNotice(said.join(" "));
      } else if (res.accepted) {
        setNotice(
          `В проект ушло ${res.accepted} ${plural(res.accepted, "кадр", "кадра", "кадров")} — датасет «${res.dataset}».`
        );
      } else if (to === "done") {
        setNotice("Размеченных кадров пока нет — принимать нечего.");
      }
      await load();
    });
  }

  function onFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setPicked([...files]);
  }

  async function sendFiles(files: File[], perFile: string[][]) {
    if (!taskId) return;
    setPicked(null);
    setUploadPct(0);
    setError(null);
    try {
      const got = await uploadTaskImages(taskId, files, setUploadPct, perFile);
      await load();
      // Пропущенное называем: молча принятые 6 из 8 читались как «всё дошло».
      const skipped = `${count(got.skipped, "файл", "файла", "файлов")} — не изображения или не читаются`;
      if (!got.added && got.skipped) setError(`Ни один файл не принят: ${skipped}.`);
      else if (got.skipped) setNotice(`Принято ${got.added}, пропущено ${skipped}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadPct(null);
    }
  }

  /** Таги ролика. Правка немедленная и без подтверждения: она ничего не
   *  разрушает — уже нарезанные кадры свои таги сохранят. */
  async function saveVideoTags(video: TaskVideoItem, tagIds: string[]) {
    if (!taskId) return;
    // Показываем сразу: ждать ответа сервера, держа палец на чипе, незачем.
    setTask((prev) => prev && {
      ...prev,
      videos: prev.videos.map((v) =>
        v.id === video.id ? { ...v, tag_ids: tagIds } : v
      ),
    });
    try {
      await setVideoTags(taskId, video.id, tagIds);
    } catch (e) {
      // Сперва перечитать, потом показать: load() гасит ошибку на успехе,
      // и в обратном порядке она мелькала на долю секунды.
      await load();
      setError((e as Error).message);
    }
  }

  /** Таг одного кадра. Работает и в закрытой таске: закрытие останавливает
   *  разметку, а таг — не разметка, а паспорт кадра. */
  async function saveImageTags(imageId: string, tagIds: string[]) {
    setImages((prev) =>
      prev.map((i) => (i.id === imageId ? { ...i, tag_ids: tagIds } : i))
    );
    setEditing((prev) => prev && {
      ...prev,
      list: prev.list.map((i) =>
        i.id === imageId ? { ...i, tag_ids: tagIds } : i
      ),
    });
    try {
      await setImageTags(imageId, tagIds);
    } catch (e) {
      await load();
      setError((e as Error).message);
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
    let current = list[0];
    try {
      for (const [i, file] of list.entries()) {
        current = file;
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
      // видел, что дошло, а что нет. Ошибку ставим ПОСЛЕ перечитывания:
      // load() на успехе гасит ошибку, и она мелькала на десятую долю секунды.
      await load().catch(() => {});
      // Отказ декодера сервер пока отдаёт как есть — с номером errno и путём
      // внутри контейнера. Человеку из этого нужно одно: файл не видео.
      const raw = (e as Error).message;
      setError(
        /\[Errno|Invalid data found|\/app\//.test(raw)
          ? `«${current.name}» не читается как видео.`
          : raw
      );
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
      const list = await allImages(taskId, { source: sourceKey });
      if (!list.length) return;
      const first = list.findIndex(
        (i) => i.task_status === "new" || i.task_status === "skipped"
      );
      openEditor(list, first >= 0 ? first : 0);
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
  // Размеченные — ровно те, что «размечено» в шапке: состояние кадра, а не
  // наличие рамок. По рамкам сюда попадали забракованные и кадры агента,
  // которые никто не принял, и вкладка расходилась с шапкой.
  const annotated = images.filter((i) => i.task_status === "annotated");
  const total = Math.max(1, task.counts.total);
  // Готово — размеченные и фоновые: фон тоже решение по кадру, и без него
  // таска, где пройдено всё, показывала 83 %. Вниз, а не к ближайшему:
  // 100 % при одном непройденном кадре из трёхсот было бы неправдой.
  const percent = Math.floor(((task.counts.annotated + task.counts.empty) / total) * 100);
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

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}
      {notice && <Banner className="mag-ok-banner" onClose={() => setNotice(null)}>{notice}</Banner>}

      <div className="mag-task-strip">
        <div className="mag-task-id">
          <div className="mag-pass-title">
            <h1>{task.name}</h1>
            <TaskState status={task.status} label={task.status_label} />
          </div>
          <p>
            {task.is_admin && task.status !== "closed" && workers.length ? (
              <select className="mag-task-assignee" aria-label="Исполнитель"
                value={task.assignee?.id ?? ""} onChange={(e) => void reassign(e.target.value)}>
                <option value="">без исполнителя</option>
                {workers.map((m) => (
                  <option key={m.id} value={m.id}>{`${m.display_name} — ${m.role_label}`}</option>
                ))}
              </select>
            ) : task.assignee ? task.assignee.display_name : "без исполнителя"}
            {task.target_dataset ? ` — в датасет «${task.target_dataset.name}»` : ""}
          </p>
        </div>

        <div className="mag-task-nums">
          <div><b>{task.counts.annotated}</b><span>размечено</span></div>
          {task.counts.empty > 0 && <div><b>{task.counts.empty}</b><span>фон</span></div>}
          <div><b>{task.counts.skipped}</b><span>отложено</span></div>
          <div><b>{task.counts.new}</b><span>не тронуто</span></div>
          {(task.counts.agent || 0) > 0 && (
            <div><b>{task.counts.agent}</b><span>агент, не проверено</span></div>
          )}
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
          {scouted && (
            <button className="ag-scout-btn ag-scout-btn-head" type="button" onClick={() => setOverviewOpen(true)}>
              Статистика разведки
            </button>
          )}
          {task.status !== "closed" && (
            <button className="mag-ghost mag-ghost-inline" type="button"
              disabled={busy || !task.can_work || Boolean(agentRun && ["queued", "waiting_gpu", "running"].includes(agentRun.status))}
              onClick={() => setAgentOpen(true)}>
              Агент
            </button>
          )}
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

        {agentRun && (
          <AgentRunBar taskId={task.id} run={agentRun} onRun={setAgentRun} onFinished={load} />
        )}

        <div className="mag-tprog mag-task-bar">
          <i className="done" style={{ width: `${(task.counts.annotated / total) * 100}%` }} />
          <i className="nul" style={{ width: `${(task.counts.empty / total) * 100}%` }} />
          <i className="skip" style={{ width: `${(task.counts.skipped / total) * 100}%` }} />
        </div>
      </div>

      <nav className="mag-tabs mag-task-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button"
            className={tab === t.id ? "mag-tab on" : "mag-tab"}
            onClick={() => setTab(t.id)}>
            {t.label} {counts[t.id] && <span>{counts[t.id]}</span>}
          </button>
        ))}
      </nav>

      {overviewOpen && <ScoutOverview taskId={task.id} onClose={() => setOverviewOpen(false)} />}
      {agentOpen && (
        <AgentRunDialog
          taskId={task.id}
          onClose={() => setAgentOpen(false)}
          onStarted={(run) => {
            setAgentOpen(false);
            setAgentRun(run);
          }}
        />
      )}

      {picked && task && (
        <UploadImagesModal
          code={task.project.code}
          tags={tags}
          files={picked}
          onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
          onCancel={() => setPicked(null)}
          onSend={(perFile) => void sendFiles(picked, perFile)}
        />
      )}

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
                  onChange={(e) => {
                    onFiles(e.target.files);
                    // Иначе повторный выбор той же пачки не вызовет события.
                    e.target.value = "";
                  }} />
                <input ref={cutRef} type="file" accept="video/*" multiple hidden
                  onChange={(e) => {
                    void onVideo(e.target.files, "cut");
                    e.target.value = "";
                  }} />
                <button className="mag-btn mag-btn-inline" type="button"
                  onClick={() => fileRef.current?.click()}>
                  Загрузить изображения
                </button>
                {/* Режим ролика задаёт вкладка, и потом его не сменить — говорим это до загрузки. */}
                <button className="mag-btn mag-btn-inline" type="button"
                  title="Ролик нарежется на кадры этой вкладки. Режим потом не сменить: для покадровой разметки добавьте ролик во вкладке «Видео»"
                  onClick={() => cutRef.current?.click()}>
                  Видео на нарезку
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
                  code={task.project.code}
                  tags={tags}
                  editable={editable}
                  onAnnotate={() => openSource(block.key)}
                  onCut={block.videos ? (video) => setCutting({ video }) : undefined}
                  onDelete={block.videos ? (video) => removeVideo(video) : undefined}
                  onVideoTags={(video, ids) => void saveVideoTags(video, ids)}
                  onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
                  onAcceptAgent={() => void acceptAgent(block.key)} />
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
                  title="Ролик размечают покадрово, треками. Режим потом не сменить: чтобы нарезать его на кадры, добавьте ролик во вкладке «Кадры»"
                  onClick={() => annotateRef.current?.click()}>
                  Видео на разметку
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
                  code={task.project.code}
                  tags={tags}
                  onVideoTags={(ids) => void saveVideoTags(v, ids)}
                  onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
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
              ещё не закрыта, и {task.pending_videos.length === 1 ? "его" : "их"} кадров здесь нет:{" "}
              {task.pending_videos.map(pendingLabel).join(", ")}.{" "}
              {pending.frames > 0 && (
                <>
                  Всего {count(pending.frames, "кадр", "кадра", "кадров")}
                  {pending.empty > 0 && `, из них ${pending.empty} фоновых`}.{" "}
                </>
              )}
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
                    <span className="mag-cls-name">
                      <b title={c.name}><span>{c.name}</span></b>
                    </span>
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
                  onClick={() => openEditor(annotated, 0)}>
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
                      onClick={() => openEditor(annotated, i)}>
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
          <button className="mag-link" type="button"
            onClick={() => navigate(`/projects/${code}/datasets`)}>
            Смотреть датасеты
          </button>
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
          canTag={task.can_work}
          tags={tags}
          onTags={(imageId, ids) => void saveImageTags(imageId, ids)}
          onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
          onIndex={(i) => {
            setEditing((prev) => (prev ? { ...prev, index: i } : prev));
            setFrame(editing.list[i]?.id ?? null, true);
          }}
          onClose={closeEditor}
          onChanged={(id, patch) =>
            setEditing((prev) =>
              prev
                ? { ...prev, list: prev.list.map((x) => (x.id === id ? { ...x, ...patch } : x)) }
                : prev
            )
          }
        />
      )}
    </div>
  );
}

// Состояние таски в событии лежит сырым значением; на экране — теми же
// словами, что на карточках (STATUS_LABELS на сервере).
const STATUS_WORD: Record<string, string> = {
  queued: "на очереди",
  in_progress: "в работе",
  done: "готово",
  updating: "изменение",
  closed: "закрыто",
};

/** Незакрытый ролик одной строкой. Ролик с ошибкой плана или с прежними
 *  кадрами в таске читался как «x» (0) — будто размечать там нечего. */
function pendingLabel(v: PendingVideo): string {
  if (v.error) return `«${v.file_name}» — не закрыть: ${v.error.replace(/\.$/, "")}`;
  if (v.frames_in_task) return `«${v.file_name}» — прежние кадры ролика ещё в таске (${v.frames_in_task})`;
  return `«${v.file_name}» — ${count(v.frames, "кадр", "кадра", "кадров")}`;
}

/** Глагол прошедшего времени по числу: «принят 1 кадр», «принято 5 кадров». */
const did = (n: number, one: string, many: string) => plural(n, one, many, many);

/** Нарезаемый ролик: у него вопрос не «что размечено», а «что нарезано». */
function describe(e: TaskEventItem): JSX.Element {
  const p = e.payload as Record<string, string | number>;
  const n = (k: string) => Number(p[k]) || 0;
  switch (e.kind) {
    case "created":
      return <>Таска создана{p.assignee ? <>, исполнитель — <b>{p.assignee}</b></> : null}</>;
    case "assigned":
      return <>Исполнитель — <b>{p.assignee ?? "снят"}</b></>;
    case "images_added":
      return (
        <>
          {did(n("added"), "Загружено", "Загружено")}{" "}
          <b>{count(n("added"), "изображение", "изображения", "изображений")}</b>
          {p.skipped ? `, пропущено ${p.skipped}` : ""}
        </>
      );
    case "video_added":
      return <>Добавлено видео <b>{p.file}</b>{p.mode === "annotate" ? " для разметки" : " для нарезки"}</>;
    case "video_cut":
      return (
        <>
          {did(n("frames"), "Нарезан", "Нарезано")}{" "}
          <b>{count(n("frames"), "кадр", "кадра", "кадров")}</b> из {p.file}, участков: {p.segments}
        </>
      );
    case "video_annotation_closed":
      return (
        <>
          Разметка <b>{p.file}</b> закрыта: {count(n("frames"), "кадр", "кадра", "кадров")},{" "}
          {count(n("boxes"), "объект", "объекта", "объектов")}
        </>
      );
    case "video_annotation_reopened":
      return <>Разметка <b>{p.file}</b> открыта заново</>;
    case "video_frames_dropped":
      return (
        <>
          {did(n("removed"), "Убран", "Убрано")}{" "}
          <b>{count(n("removed"), "кадр", "кадра", "кадров")}</b> ролика {p.file}
          {p.kept ? `, оставлено принятых: ${p.kept}` : ""}
        </>
      );
    case "accepted":
      return (
        <>
          {did(n("accepted"), "Принят", "Принято")}{" "}
          <b>{count(n("accepted"), "кадр", "кадра", "кадров")}</b> в датасет «{p.dataset}»
        </>
      );
    case "done":
      return <>Переведена в готово, принимать было нечего</>;
    case "closed":
      return (
        <>
          Закрыта: {did(n("removed_images"), "удалён", "удалено")}{" "}
          <b>{count(n("removed_images"), "кадр", "кадра", "кадров")}</b>
          {n("removed_videos") ? ` и ${n("removed_videos")} видео` : ""}
        </>
      );
    case "image_deleted":
      return <>Забракован кадр {p.file}</>;
    case "image_restored":
      return <>Кадр {p.file} вернули в работу</>;
    case "class_moved":
      return (
        <>
          Класс разметки сменён: <b>{p.from}</b> → <b>{p.to}</b>
          {p.tracks ? <>, треков: {p.tracks}</> : null}
        </>
      );
    case "status":
      return <>Состояние: <b>{STATUS_WORD[String(p.status)] ?? p.status}</b></>;
    default:
      return <>{e.kind}</>;
  }
}
