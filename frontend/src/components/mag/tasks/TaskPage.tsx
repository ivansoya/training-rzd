import { CutTransfer } from "./CutTransfer";
// Страница таски: источники слева, паспорт справа; «Запустить агента» и «Размечать» в шапке.

import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  assignTask, clearAgentUnchecked, deleteTaskVideo, getProject,
  getTaskEditorIndex, getTaskEditorWindow, getTaskImages, getTaskNumbers, getVideoPending, setTaskStatus, uploadTaskImages, uploadTaskVideo,
} from "../../../auth/api";
import type {
  AgentClearScope, ProjectMemberInfo, StatusResult, TaskDetail, TaskEditorImage, TaskImage, TaskImageQuery, TaskStatus, TaskVideoItem,
} from "../../../auth/api";
import { useAuth } from "../../auth/AuthGate";
import { pollJob } from "../../../api/jobs";
import type { Job } from "../../../api/jobs";
import { setImageTags, setVideoTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import { taskRuns } from "../../../api/agents";
import type { RunMode, RunView } from "../../../api/agents";
import { Button, Notice, Progress, Sheet, cx, hasLayer } from "../../../ui";
import { count, plural, ru } from "../../ru";
import AgentRunDialog, { AgentRunBar } from "../../agents/AgentRunDialog";
import { CutFramesCard } from "./CutFrames";
import AgentSetupDialog from "../../agents/AgentSetupDialog";
import CpuConfirm, { refusalOf, type CardRefusal } from "../../hardware/CpuConfirm";
import { useAgentTool } from "../../editor/AgentTool";
import Sep from "../../Sep";
import ScoutOverview from "../../agents/ScoutOverview";
import { useScouts } from "../../agents/scout";
import { openByVideo } from "../questions/questions";
import { useQuestions } from "../questions/useQuestions";
import AnnotationEditor, { saveSettled } from "../AnnotationEditor";
import UploadImagesModal from "../UploadImagesModal";
import VideoAnnotator from "../VideoAnnotator";
import VideoCutModal from "../VideoCutModal";
import { useConfirm } from "./Confirm";
import { AddMenu, AnnotateCard, CutCard, DropVeil, FramesCard, TaskEmpty } from "./Sources";
import type { AgentHooks } from "./Sources";
import { droppedFiles, kindOf, parts, useFileDrag, zoneKind } from "./drop";
import { questionGo } from "./taskQuestions";
import type { Zone } from "./drop";
import { EventList, TaskPassport } from "./TaskPassport";
import type { FrameState } from "./tasks";
import { buildSources, busyText, closePlan, closeText, handoverText, lastPersonalEditIndex, lastReviewedIndex } from "./tasks";
import { look } from "./useTaskBoard";
import { openVideos, useTaskPage } from "./useTaskPage";
import { dismissUploadError, enqueueUpload, uploading, useUpload } from "./uploads";
import { useHere } from "../here";
import { EDITOR_PAGE, frameWindows, summarizeFrame } from "./editorImages";

/** Кадров в таске без брака — из лёгкой части, известно сразу. */
const framesTotal = (t: TaskDetail) => Object.values(t.sources || {}).reduce((s, x) => s + (x.frames || 0), 0);

const ACTIVE_RUN = ["queued", "waiting_gpu", "running"];

const imageNames = new Intl.Collator("ru", { numeric: true });

function firstWorkIndex(images: TaskEditorImage[]) {
  const first = images.findIndex((i) => i.task_status === "new");
  return first >= 0 ? first : images.findIndex((i) => i.task_status === "skipped");
}

function editorQuery(params: TaskImageQuery): TaskImageQuery {
  // В редакторе «Все» включает выброшенные кадры на их прежних местах.
  return { ...params, review: params.review === "all" ? undefined : params.review };
}

function byImageName(a: Pick<TaskImage, "file_name">, b: Pick<TaskImage, "file_name">) {
  return imageNames.compare(a.file_name, b.file_name);
}

/** К счётчику вопросов, если место вопроса больше недоступно. */
const toQuestions = () => document.getElementById("task-questions")?.scrollIntoView({ behavior: "smooth", block: "center" });

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("input, textarea, select, button, a, [contenteditable='true'], [role='option']");

const FileDrag = createContext<ReturnType<typeof useFileDrag>>(null);

function FileDragProvider({ children }: { children: ReactNode }) {
  const drag = useFileDrag();
  return <FileDrag.Provider value={drag}>{children}</FileDrag.Provider>;
}

export default function TaskPage() {
  return <FileDragProvider><TaskPageBody /></FileDragProvider>;
}

function TaskPageBody() {
  const { code, taskId } = useParams<{ code: string; taskId: string }>();
  const navigate = useNavigate();
  const { me } = useAuth();
  const page = useTaskPage(taskId || "", me.user.id);
  const { task, numbers, pending, events } = page;
  // Участники проекта: имена соседей в редакторах и выбор исполнителей у админа
  const [members, setMembers] = useState<ProjectMemberInfo[]>([]);
  const workers = members.filter((m) => m.role !== "viewer");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = useUpload(taskId || "");
  const [tags, setTags] = useState<Tag[]>([]);
  const [picked, setPicked] = useState<File[] | null>(null);
  const [history, setHistory] = useState(false);
  const [confirm, confirmNode] = useConfirm();
  // Один список вопросов на страницу и оба редактора
  const qs = useQuestions(taskId, me.user.id);

  // Открытый кадр живёт в адресе (?frame=<id>): «Назад» закрывает редактор
  const [editing, setEditing] = useState<{ list: TaskEditorImage[]; index: number; image: TaskImage; windows: ReturnType<typeof frameWindows> } | null>(null);
  const [search, setSearch] = useSearchParams();
  const frameParam = search.get("frame");
  // Вопрос из уведомления (?q=<id>) открывает обсуждение в редакторе
  const qParam = search.get("q");
  const pushed = useRef(false);
  const setFrame = useCallback((id: string | null, replace: boolean) => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev);
      // Редактор закрыт — вопрос из адреса отыгран
      if (id) next.set("frame", id); else { next.delete("frame"); next.delete("q"); }
      return next;
    }, { replace });
  }, [setSearch]);
  const dropQ = useCallback(() => setSearch((prev) => {
    const next = new URLSearchParams(prev);
    next.delete("q");
    return next;
  }, { replace: true }), [setSearch]);
  const editorLoad = useRef<AbortController | null>(null);
  const windowsRef = useRef<ReturnType<typeof frameWindows> | null>(null);
  const editorJump = useRef(0);
  const [, refreshFilm] = useState(0);
  const releaseEditor = useCallback(() => {
    editorLoad.current?.abort();
    windowsRef.current?.close();
    windowsRef.current = null;
  }, []);
  useEffect(() => releaseEditor, [taskId, releaseEditor]);

  const prepareEditor = useCallback((frames: TaskImage[], image: TaskImage, query: TaskImageQuery, indexed?: TaskEditorImage[]) => {
    if (!taskId) return;
    releaseEditor();
    const windows = frameWindows(taskId, frames, () => refreshFilm((revision) => revision + 1));
    windowsRef.current = windows;
    const initial = indexed ?? frames.map(summarizeFrame);
    const index = initial.findIndex((row) => row.id === image.id);
    setEditing({ list: initial, index, image, windows });
    if (indexed) return;
    void getTaskEditorIndex(taskId, query, windows.signal).then(({ rows: list, videoOrder }) => {
      if (windows.signal.aborted) return;
      if (!videoOrder) list.sort(byImageName);
      const positions = new Map(list.map((row, i) => [row.id, i]));
      setEditing((current) => {
        if (!current || current.windows !== windows) return current;
        const at = positions.get(current.image.id);
        const next = [...list];
        if (at === undefined) {
          next.splice(current.index, 0, summarizeFrame(current.image));
          if (!videoOrder) next.sort(byImageName);
        } else next[at] = summarizeFrame(current.image);
        return { ...current, list: next, index: at ?? next.findIndex((row) => row.id === current.image.id) };
      });
    }).catch((e: Error) => { if (!windows.signal.aborted) setError(e.message); });
  }, [taskId, releaseEditor]);

  const openEditor = useCallback((frames: TaskImage[], image: TaskImage, query: TaskImageQuery, indexed?: TaskEditorImage[]) => {
    prepareEditor(frames, image, query, indexed);
    setFrame(image.id, false);
    pushed.current = true;
  }, [prepareEditor, setFrame]);
  const closeEditor = useCallback(() => {
    releaseEditor();
    setEditing(null);
    if (pushed.current) { pushed.current = false; navigate(-1); } else setFrame(null, true);
  }, [navigate, releaseEditor, setFrame]);

  const openEditorFrame = async (position: number) => {
    if (!editing) return false;
    const { list, windows } = editing;
    const id = list[position]?.id;
    if (!id) return false;
    const ticket = ++editorJump.current;
    const first = Math.floor(position / EDITOR_PAGE) * EDITOR_PAGE;
    try {
      if (!windows.get(id)) await windows.load(list.slice(first, first + EDITOR_PAGE).map((row) => row.id));
      const frame = windows.get(id);
      if (windows.signal.aborted || ticket !== editorJump.current) return false;
      if (!frame) throw new Error("Кадр больше недоступен.");
      setEditing((current) => {
        if (!current || current.windows !== windows) return current;
        const at = current.list[position]?.id === id ? position : current.list.findIndex((row) => row.id === id);
        return at < 0 ? current : { ...current, image: frame, index: at };
      });
      setFrame(id, true);
      return true;
    } catch (e) {
      if (!windows.signal.aborted && ticket === editorJump.current) throw e;
      return false;
    }
  };

  const patchEditorFrame = (id: string, patch: Partial<TaskImage>) => {
    const windows = windowsRef.current;
    const known = windows?.get(id);
    if (known) windows?.store({ ...known, ...patch });
    setEditing((current) => {
      if (!current) return current;
      const frame = current.image.id === id ? { ...current.image, ...patch } : known && { ...known, ...patch };
      if (!frame) return current;
      return { ...current, list: current.list.map((row) => row.id === id ? summarizeFrame(frame) : row),
        image: current.image.id === id ? frame : current.image };
    });
  };

  const [cutting, setCutting] = useState<TaskVideoItem | null>(null);
  const [cutFramesOpen, setCutFramesOpen] = useState(false);
  const showCutFrames = useCallback(() => {
    setCutFramesOpen(true);
    requestAnimationFrame(() => document.getElementById("task-cut-frames")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, []);
  useEffect(() => setCutFramesOpen(false), [taskId]);
  const [annotating, setAnnotating] = useState<TaskVideoItem | null>(null);
  // Ролик открыт ради проверки агента — редактор встаёт на первый непроверенный кадр
  const [reviewing, setReviewing] = useState(false);
  // Полное окно запуска — «по всей таске сразу», из окна «Агент таски»
  const [agentOpen, setAgentOpen] = useState(false);
  // С чем открыто окно запуска: из блока — настроенным на блок, из «Агента таски» — пустым
  const [agentAsk, setAgentAsk] = useState<Parameters<AgentHooks["dialog"]>[0] | undefined>(undefined);
  // «Агент таски»: агент по умолчанию и сопоставление классов
  const [setupOpen, setSetupOpen] = useState(false);
  const agentTool = useAgentTool(taskId || "");
  const [agentRun, setAgentRun] = useState<RunView | null>(null);
  const [runError, setRunError] = useState(false);
  const [runRetry, setRunRetry] = useState(0);
  const here = useHere();
  // Быстрый запуск из меню блока упёрся в карту — окно «на процессоре или отменить».
  const [cpuAsk, setCpuAsk] = useState<{ refusal: CardRefusal; body: Parameters<AgentHooks["start"]>[0] } | null>(null);
  const scouted = Object.keys(useScouts(taskId || "")).length > 0;
  const [overviewOpen, setOverviewOpen] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const cutRef = useRef<HTMLInputElement>(null);
  const annotateRef = useRef<HTMLInputElement>(null);

  // Перечитать всё по очереди: лёгкая часть, счётчики, сводки роликов. Первый заход хук делает сам.
  const pageLoad = page.load;
  const load = useCallback(async () => {
    // Редактор мог только что отправить последнюю правку — читаем после неё
    await saveSettled();
    await pageLoad();
  }, [pageLoad]);
  const taskTags = task?.tags;
  useEffect(() => { if (taskTags) setTags(taskTags); }, [taskTags]);

  // Лёг очередной файл — перечитываем: свои живые события страница пропускает, а загрузка могла начаться до неё
  const landed = upload?.landed ?? 0;
  const seenLanded = useRef(landed);
  useEffect(() => {
    if (landed === seenLanded.current) return;
    seenLanded.current = landed;
    void load().catch(() => undefined);
  }, [landed, load]);

  const projectCode = task?.project.code;
  useEffect(() => {
    if (!projectCode) return;
    getProject(projectCode).then((d) => setMembers(d.members)).catch(() => setMembers([]));
  }, [projectCode]);

  // Кадр в адресе, а редактор закрыт (ссылка, «Вперёд») — открываем на всех кадрах таски
  useEffect(() => {
    if (!taskId) return;
    if (!frameParam) {
      if (editing) { releaseEditor(); pushed.current = false; setEditing(null); }
      return;
    }
    if (editing) return;
    const controller = new AbortController();
    const { signal } = controller;
    getTaskImages(taskId, { image: frameParam, limit: 1 }, signal).then(({ images }) => {
      if (signal.aborted) return;
      if (images.length) {
        prepareEditor(images, images[0], editorQuery({}));
        return;
      }
      pushed.current = false;
      setFrame(null, true);
      // Кадр вопроса сдан или убран — возвращаемся к счётчику в паспорте
      if (qParam) { qs.read(qParam); toQuestions(); }
    }).catch((e: Error) => { if (!signal.aborted) setError(e.message); });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameParam, taskId]);

  // Вопрос в адресе — открываем его место один раз: кадр через ?frame, ролик — редактором ролика
  const doneQ = useRef<string | null>(null);
  const qList = qs.list;
  const taskVideos = task?.videos;
  useEffect(() => {
    if (!qParam) { doneQ.current = null; return; }
    if (!qList || !taskVideos || doneQ.current === qParam) return;
    doneQ.current = qParam;
    const q = qList.find((x) => x.id === qParam);
    const go = questionGo(q, taskVideos);
    if (go && "image" in go) { if (frameParam !== go.image) setFrame(go.image, true); return; }
    if (go) { setReviewing(false); setAnnotating(go.video); return; }
    if (q) qs.read(q.id);
    dropQ();
    toQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam, qList, taskVideos]);

  // Редактор закрылся — перечитываем таску: он уже отправил последнюю правку
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) void load();
    wasEditing.current = !!editing;
  }, [editing, load]);

  // Идущий прогон агента видно и после перезагрузки; остановленный и упавший — тоже, ради «Продолжить», пока не скрыли
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    setAgentRun(null); setRunError(false);
    taskRuns(taskId).then((ctx) => {
      if (!alive) return;
      const last = ctx.runs[0];
      if (last && (ACTIVE_RUN.includes(last.status)
        || ((last.status === "stopped" || last.status === "error") && hiddenRun(taskId) !== last.id))) setAgentRun(last);
    }).catch(() => { if (alive) setRunError(true); });
    return () => { alive = false; };
  }, [taskId, runRetry]);
  const onRun = useCallback((run: RunView | null) => {
    if (!run && agentRun && taskId) hideRun(taskId, agentRun.id);
    setAgentRun(run);
  }, [agentRun, taskId]);

  // Пока ролик готовится на сервере — переспрашиваем таску
  const preparing = (task?.videos || []).some((v) => v.prepare && (v.prepare.busy || (!v.prepare.ready && !v.prepare.error)));
  // Опрос — только лёгкой части: готовность ролика живёт в ней, счётчики не трогаем
  const loadMain = page.loadMain;
  useEffect(() => {
    if (!preparing) return undefined;
    const id = window.setInterval(() => { void loadMain().catch(() => undefined); }, 2500);
    return () => window.clearInterval(id);
  }, [preparing, loadMain]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }, []);

  // Сдача идёт фоном: её работа — в карточке таски, видна всем. Пока идёт — только просмотр.
  // За работой следим до её конца, а не пока она в карточке: перечитка таски (опрос готовности
  // ролика) обнуляет поле раньше, чем опрос работы узнаёт итог, — и строка итога терялась.
  const [handing, setHanding] = useState<Job<StatusResult> | null>(null);
  const [watched, setWatched] = useState<string | null>(null);
  const handJob = task?.handover ?? null;
  useEffect(() => { if (handJob) setWatched(handJob); }, [handJob]);
  useEffect(() => {
    if (!watched) return undefined;
    let alive = true;
    setHanding(null);
    pollJob<StatusResult>(watched, (j) => { if (alive) setHanding(j); })
      .then((r) => { if (alive) setNotice(handoverText(r)); }, (e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) { setHanding(null); setWatched(null); void load(); } });
    return () => { alive = false; };
  }, [watched, load]);
  const handoverActive = !!handJob || !!watched;
  const handoverShare = handing && handing.total > 0 ? Math.min(1, handing.processed / handing.total) : null;

  // Права считает сервер по состоянию таски: работа над кадрами — только «в работе», источники — и на очереди
  const editable = !!task && task.rights.edit && !handJob && !watched;
  const fillable = !!task && task.rights.fill && !handJob && !watched;
  const agentBusy = !!agentRun && ACTIVE_RUN.includes(agentRun.status);
  // Уйдёт при сдаче — когда пришли сводки всех роликов; до того заготовка
  const opened = task ? openVideos(task) : [];
  const pendingFrames = opened.every((v) => v.id in pending)
    ? opened.reduce((s, v) => s + (pending[v.id]?.frames || 0), 0) : null;
  const pendingLook = look(pendingFrames ?? undefined,
    opened.some((v) => page.fresh.videos[v.id] === "load") ? "load" : opened.every((v) => page.fresh.videos[v.id] === "ok") ? "ok" : "wait",
    page.at);
  const numbersLook = look(numbers ?? undefined, page.fresh.numbers, page.at);

  const openFromIndex = useCallback((params: TaskImageQuery, pick: (list: TaskEditorImage[]) => number) => guard(async () => {
    if (!taskId) return;
    editorLoad.current?.abort();
    const controller = new AbortController();
    editorLoad.current = controller;
    const query = editorQuery(params);
    try {
      const { rows: list, videoOrder } = await getTaskEditorIndex(taskId, query, controller.signal);
      if (controller.signal.aborted) return;
      if (!videoOrder) list.sort(byImageName);
      if (!list.length) { setNotice("В этой выборке нет кадров."); return; }
      const index = Math.max(0, pick(list));
      const start = Math.floor(index / EDITOR_PAGE) * EDITOR_PAGE;
      const window = await getTaskEditorWindow(taskId, list.slice(start, start + EDITOR_PAGE).map((row) => row.id), controller.signal);
      if (controller.signal.aborted) return;
      const image = window.find((row) => row.id === list[index].id);
      if (!image) { setNotice("Кадр больше недоступен. Откройте выборку ещё раз."); return; }
      openEditor(window, image, query, list);
    } catch (e) {
      if (!controller.signal.aborted) throw e;
    }
  }), [guard, taskId, openEditor]);

  const openTaskFrames = useCallback(() => {
    if (!task) return;
    const cut = task.videos.filter((v) => v.mode === "cut");
    if (cut.length > 0 && !cut.some((v) => v.frames > 0)) { showCutFrames(); return; }
    return openFromIndex(cut.length ? { source: "videos", review: "all" } : {}, (list) => {
      const personal = lastPersonalEditIndex(list);
      return personal >= 0 ? personal : cut.length || editable ? firstWorkIndex(list) : lastReviewedIndex(list);
    });
  }, [task, openFromIndex, editable, showCutFrames]);

  const openFiltered = (params: TaskImageQuery) => openFromIndex(params, params.review ? () => 0 : firstWorkIndex);
  const openState = (s: FrameState) => openFiltered({ status: s });
  const openCutFrame = (image: TaskImage, query: TaskImageQuery, rows: TaskImage[]) => {
    const list = rows.some((row) => row.source_video_id) ? rows : [...rows].sort(byImageName);
    openEditor(list, image, editorQuery(query));
  };

  // Enter — размечать, G — агент; не мешаем полям, кнопкам и открытым окнам
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || editing || annotating || cutting || hasLayer() || isTyping(e.target)) return;
      if (e.key === "Enter" && !busy && task && (framesTotal(task) > 0 || task.videos.some((v) => v.mode === "cut"))) {
        e.preventDefault(); void openTaskFrames();
      }
      if ((e.key === "g" || e.key === "п") && editable) { e.preventDefault(); setSetupOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, annotating, cutting, task, editable, busy, openTaskFrames]);

  /** Смена состояния. Сдача с роликами идёт фоном: ответ — работа, её ход и итог ведёт эффект выше. */
  const send = (to: TaskStatus) => guard(async () => {
    if (!taskId) return;
    const res = await setTaskStatus(taskId, to);
    if (res.job_id) { page.patchTask((t) => ({ ...t, handover: res.job_id })); return; }
    if (to === "done" || to === "closed") setNotice(handoverText(res));
    await load();
  });

  async function move(to: TaskStatus) {
    if (!taskId || !task) return;
    // Непроверенное агента в датасет не уйдёт — сказать до сдачи, по свежим сводкам, а не по кешу
    const open = to === "done" ? await page.pendingNow().catch(() => []) : [];
    const unchecked = open.reduce((s, v) => s + (v.unchecked || 0), 0);
    if (unchecked) {
      const ok = await confirm({
        title: "Сдать с непроверенным агента?",
        desc: `${count(unchecked, "кадр", "кадра", "кадров")} из роликов с непроверенной разметкой агента в датасет не ${plural(unchecked, "уйдёт", "уйдут", "уйдут")} — ${plural(unchecked, "останется", "останутся", "останутся")} в ролике до проверки.`,
        ok: "Сдать", icon: "tick",
      });
      if (!ok) return;
    }
    await send(to);
  }

  async function closeTask() {
    if (!taskId || !task) return;
    // Числа — свежие: окно обещает, что уйдёт в датасет и что удалится навсегда.
    // Из работы закрытие сперва сдаёт ролики — их кадры тоже уходят в датасет.
    let fresh: Awaited<ReturnType<typeof getTaskNumbers>>;
    let open: Awaited<ReturnType<typeof page.pendingNow>>;
    try {
      [open, fresh] = await Promise.all([page.pendingNow(), getTaskNumbers(taskId)]);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const remaining = fresh.remaining;
    if (remaining?.total || open.some((row) => (row.unchecked ?? 0) > 0)) {
      setError("Закрыть нельзя. Разберите открытые вопросы, отложенные кадры и разметку на проверке.");
      return;
    }
    const fromVideos = open.reduce((s, v) => s + (v.frames || 0), 0);
    const plan = closePlan(fresh.counts, task.videos.length);
    const ok = await confirm({
      title: "Закрыть таску?",
      lines: [
        ...(fromVideos ? [`Из роликов в датасет ${plural(fromVideos, "уйдёт", "уйдут", "уйдут")} ${count(fromVideos, "кадр", "кадра", "кадров")}.`] : []),
        ...closeText(plan, task.target_dataset?.name ?? null),
      ],
      desc: "Закрытую таску нельзя вернуть в работу.", ok: "Закрыть таску", icon: "archive", danger: true,
    });
    if (!ok) return;
    await send("closed");
  }

  const reassign = (ids: string[]) => guard(async () => {
    if (!task) return;
    await assignTask(task.id, ids);
    await load();
  });

  /** Кадры блока на проверке агента — в редактор по одному. */
  const review = (source: string) => openFiltered({ status: "agent", source });
  const openVideo = (v: TaskVideoItem, forReview = false) => { setReviewing(forReview); setAnnotating(v); };

  // Отказ загрузки показывает полоса из очереди — он виден и после ухода со страницы.
  // Каждая часть — своя партия очереди: отказ одной не снимает остальные.
  async function sendFiles(files: File[], perFile: string[][]) {
    if (!taskId) return;
    setPicked(null);
    setError(null);
    const ranges = parts(files);
    const name = ([a, b]: [number, number]) => ranges.length > 1
      ? `изображения ${ru(a + 1)}–${ru(b)} из ${ru(files.length)}`
      : count(files.length, "изображение", "изображения", "изображений");
    const sent = await Promise.allSettled(ranges.map((r) => enqueueUpload(taskId, [{
      name: name(r),
      send: (onPct) => uploadTaskImages(taskId, files.slice(...r), onPct, perFile.slice(...r)).catch((e) => {
        throw ranges.length > 1 ? new Error(`Не легли ${name(r)}: ${(e as Error).message}`) : e;
      }),
    }])));
    const got = sent.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (!got.length) return;
    const added = got.reduce((s, g) => s + g.added, 0);
    const skipped = got.reduce((s, g) => s + g.skipped, 0);
    const why = `${count(skipped, "файл", "файла", "файлов")} — не изображения или не читаются`;
    if (!added && skipped) setError(`Ни один файл не принят: ${why}.`);
    else if (skipped) setNotice(`Принято ${added}, пропущено ${why}.`);
  }

  /** Брошенное в зону: папки развёрнуты, взят только род зоны, остальное названо числом. */
  async function dropFiles(w: Zone, dt: DataTransfer) {
    let all: File[];
    try {
      all = await droppedFiles(dt);
    } catch (e) {
      setError(`Не прочитать брошенное: ${(e as Error).message}`);
      return;
    }
    acceptFiles(w, all);
  }

  function acceptFiles(w: Zone, all: File[]) {
    const kind = zoneKind(w);
    const take = all.filter((f) => kindOf(f) === kind);
    const skipped = `${count(all.length - take.length, "файл", "файла", "файлов")} — ${kind === "images" ? "не изображения" : "не видео"}`;
    if (!take.length) { setError(`Ни один файл не подошёл: ${skipped}.`); return; }
    if (take.length < all.length) {
      setNotice(`Взято ${kind === "images" ? count(take.length, "изображение", "изображения", "изображений")
        : count(take.length, "ролик", "ролика", "роликов")}, пропущено ${skipped}.`);
    }
    if (w === "images") setPicked(take); else void onVideo(take, w);
  }

  /** Ролики встают в очередь вкладки и уходят по одному. */
  async function onVideo(list: File[], mode: "cut" | "annotate") {
    if (!list.length || !taskId) return;
    setError(null);
    const items = list.map((file) => ({
      name: file.name,
      send: (onPct: (pct: number) => void) => uploadTaskVideo(taskId, file, onPct, mode).catch((e) => {
        const raw = (e as Error).message;
        throw new Error(/\[Errno|Invalid data found|\/app\//.test(raw) ? `«${file.name}» не читается как видео.` : raw);
      }),
    }));
    const ok = await enqueueUpload(taskId, items).then(() => true, () => false);
    if (ok && list.length > 1) setNotice(`Загружено ${count(list.length, "ролик", "ролика", "роликов")}.`);
  }

  async function saveVideoTags(video: TaskVideoItem, tagIds: string[]) {
    if (!taskId) return;
    page.patchTask((prev) => ({ ...prev, videos: prev.videos.map((v) => (v.id === video.id ? { ...v, tag_ids: tagIds } : v)) }));
    try { await setVideoTags(taskId, video.id, tagIds); } catch (e) { await load(); setError((e as Error).message); }
  }

  async function saveImageTags(imageId: string, tagIds: string[]) {
    patchEditorFrame(imageId, { tag_ids: tagIds });
    try { await setImageTags(imageId, tagIds); } catch (e) { await load(); setError((e as Error).message); }
  }

  async function removeVideo(video: TaskVideoItem) {
    if (!taskId) return;
    const forms: [string, string, string] = video.mode === "annotate"
      ? ["кадр разметки", "кадра разметки", "кадров разметки"]
      : ["нарезанный кадр", "нарезанных кадра", "нарезанных кадров"];
    const p = video.mode === "annotate" ? await getVideoPending(taskId, video.id).catch(() => null) : null;
    const ok = await confirm({
      title: `Убрать «${video.file_name}»?`,
      desc: [
        video.frames ? `Вместе с ним уйдут ${count(video.frames, ...forms)}. Принятые в проект останутся.` : "",
        p?.frames ? `Разметка ролика (${count(p.frames, "кадр", "кадра", "кадров")}) пропадёт — в датасет она не уйдёт.` : "",
      ].filter(Boolean).join(" ") || undefined,
      ok: "Убрать", icon: "trash", danger: true,
    });
    if (!ok) return;
    await guard(async () => {
      const res = await deleteTaskVideo(taskId, video.id);
      setNotice(res.removed
        ? `Ролик «${res.file_name}» убран вместе с ${count(res.removed, "кадром", "кадрами", "кадрами")}${res.kept_accepted ? `, ${res.kept_accepted} осталось в проекте` : ""}.`
        : `Ролик «${res.file_name}» убран.`);
      await load();
    });
  }

  /** «Очистить непроверенное агентов»: число в окне — с сервера, тем же отбором, что удалит. */
  async function clearAgents(scope: AgentClearScope) {
    if (!taskId) return;
    let plan: { boxes: number; frames: number };
    try {
      plan = await clearAgentUnchecked(taskId, scope, true);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!plan.frames) { setNotice("Непроверенного от агентов здесь нет."); return; }
    const ok = await confirm({
      title: "Очистить непроверенное агентов?",
      desc: `Непроверенные предложения агентов будут убраны с ${count(plan.frames, "кадра", "кадров", "кадров")}. Проверенное человеком останется.`,
      ok: "Очистить", icon: "trash", danger: true,
    });
    if (!ok) return;
    await guard(async () => {
      const res = await clearAgentUnchecked(taskId, scope);
      setNotice(`Непроверенные предложения убраны с ${count(res.frames, "кадра", "кадров", "кадров")}.`);
      await load();
    });
  }

  const onAdd = (w: "images" | "cut" | "annotate") =>
    (w === "images" ? fileRef : w === "cut" ? cutRef : annotateRef).current?.click();

  if ((error || page.error) && !task) {
    return (
      <div className="page">
        <Notice tone="error">{error || page.error}</Notice>
        <Link to={`/projects/${code}/tasks`}>← К таскам</Link>
      </div>
    );
  }
  if (!task) return <div className="page"><span className="t-muted">Загружаем таску…</span></div>;

  const sources = buildSources(task, numbers?.by_source ?? null);
  const cutBlock = sources.find((b) => b.kind === "cut");
  const annotateVideos = task.videos.filter((v) => v.mode === "annotate");
  const asked = openByVideo(qs.list ?? []);
  // Ход агента — в блоке, по которому он идёт
  const live = agentBusy ? agentRun : null;
  const runOn = (frames: string | null, videos: string[], modes: RunMode[]) =>
    live && modes.includes(live.mode) &&
    (live.mode === "frames" ? !!frames && live.sources.includes(frames) : live.videos.some((v) => videos.includes(v)))
      ? live : null;
  const empty = sources.length === 0 && annotateVideos.length === 0;
  // Поверх открытого окна (таги, нарезка, редактор) бросок в таску путает — зон нет
  const dropBlocked = editing || annotating || cutting || picked;
  const refusal = fillable ? null : handJob || watched
    ? "Таска сдаётся в датасет — добавить можно будет после."
    : "Добавлять файлы в эту таску вам сейчас нельзя.";
  const drop = (w: Zone, dt: DataTransfer) => void dropFiles(w, dt);
  // Меню «⋯» блоков: агент таски сразу, без окна
  const agent: AgentHooks = {
    // На таску один прогон: пункты агента погашены с тем, что идёт и сколько ждать (решение 29.10.2026)
    tool: agentTool, busy: live ? busyText(live) : busy && "подождите", onSetup: () => setSetupOpen(true),
    start: (body) => void guard(async () => {
      try {
        setAgentRun(await agentTool.start(body));
      } catch (e) {
        const why = refusalOf(e);
        if (!why) throw e;
        setCpuAsk({ refusal: why, body });
      }
    }),
    dialog: (ask) => { setAgentAsk(ask); setAgentOpen(true); },
    clear: (scope) => void clearAgents(scope),
  };
  const frameActions = editable ? {
    annotate: openFiltered,
    runAgent: (source: string) => agent.dialog({ mode: "frames", sources: [source], modes: ["frames"] }),
    busy,
    agentBusy: agent.busy,
  } : undefined;
  const cards = [
    ...sources.map((b) => ({ key: b.key, born: b.bornAt, node: b.kind === "cut" ? (
      <CutCard key={b.key} block={b} look={numbersLook} taskId={task.id} code={task.project.code} tags={tags} editable={editable} fillable={fillable}
        byVideo={numbers?.by_source ?? null} onFrameOpen={openCutFrame} frameActions={frameActions}
        run={runOn(b.key, (b.videos || []).map((v) => v.id), ["frames", "scout"])} agent={agent} asked={asked}
        onAnnotate={() => openFiltered({ source: b.key })} onReview={() => review(b.key)}
        onCut={setCutting} onDelete={removeVideo} onVideoTags={saveVideoTags}
        onTagCreated={(t) => setTags((p) => [...p, t])} />
    ) : (
      <FramesCard key={b.key} taskId={task.id} tags={tags} revision={numbers?.by_source} onFrameOpen={openCutFrame} block={b} look={numbersLook} editable={editable} onAnnotate={() => openFiltered({ source: b.key })}
        run={runOn(b.key, [], ["frames"])} agent={agent} onReview={() => review(b.key)}
        code={task.project.code} fillable={fillable} />
    ) })),
    ...(annotateVideos.length ? [{ key: "annotate", born: Math.min(...annotateVideos.map((v) => Date.parse(v.created_at))), node: (
      <AnnotateCard key="annotate" videos={annotateVideos} working={opened.length > 0} handing={!!handJob || !!watched} pending={pending} fresh={page.fresh.videos} at={page.at}
        classes={numbers?.classes ?? []}
        taskId={task.id} code={task.project.code} tags={tags} editable={editable} fillable={fillable}
        run={runOn(null, annotateVideos.map((v) => v.id), ["annotate", "scout"])} here={here} people={members} agent={agent} asked={asked}
        onAdd={() => onAdd("annotate")} onOpen={(v) => openVideo(v)} onReview={(v) => openVideo(v, true)}
        onDelete={removeVideo} onVideoTags={saveVideoTags}
        onTagCreated={(t) => setTags((p) => [...p, t])} />
    ) }] : []),
  ].sort((a, b) => a.born - b.born);

  return (
    <div className="page tp">
      <div className="ui-ph">
        <div className="ui-ph-t"><h1>{task.name}</h1></div>
        <div className="ui-ph-a">
          {task.videos.length > 0 && <Button variant={scouted ? "outline" : "ghost"} icon="scan"
            className={cx(scouted && "tp-scout-ready")} title={scouted ? "Разведка готова" : "Открыть разведку"}
            aria-label={scouted ? "Разведка готова" : "Разведка"} onClick={() => setOverviewOpen(true)}>Разведка</Button>}
          {editable && (
            <Button variant="agent" icon="bot" kbd="G" onClick={() => setSetupOpen(true)}
              title="Агент таски: кого звать из меню блоков и кнопкой G, сопоставление классов">
              {agentTool.agent ? <>Агент: {agentTool.agent.name}{agentTool.version && <span className="ui-mono tp-agent-v">v{agentTool.version.version}</span>}</> : "Агент таски"}
            </Button>
          )}
          <Button variant="primary" icon={cutBlock || !editable ? "eye" : "edit"} kbd="Enter" disabled={busy || (!cutBlock && framesTotal(task) === 0)}
            onClick={() => void openTaskFrames()}>{cutBlock || !editable ? "Смотреть кадры" : "Размечать"}</Button>
        </div>
      </div>

      {handoverActive && (
        <div className="tp-upload tp-handover" role="status">
          <div className="tp-handover-line">
            <b className="t-sm">Сдача таски</b>
            <span className="t-sm t-muted">{handoverShare === 1 ? "Завершаю сдачу" : handing?.message || "Подготавливаю сдачу"}</span>
            <span className="t-sm ui-mono tp-handover-count">
              {handing && handing.total > 0 && <>{ru(Math.min(handing.processed, handing.total))} из {ru(handing.total)}<Sep />{Math.round(handoverShare! * 100)} %</>}
            </span>
          </div>
          {handoverShare !== null && <Progress value={handoverShare} label="Сдача таски" />}
          <span className="t-xs t-faint">Кадры переходят в датасет. Можно уйти со страницы — сдача продолжится.</span>
        </div>
      )}
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="ok" onClose={() => setNotice(null)}>{notice}</Notice>}
      {!agentRun && runError && <Notice tone="error" action={<Button size="sm" onClick={() => setRunRetry((n) => n + 1)}>Повторить</Button>}>
        Не удалось загрузить состояние агента
      </Notice>}
      {agentRun && !(agentRun.mode === "scout" && agentRun.status === "done")
        && <AgentRunBar taskId={task.id} run={agentRun} onRun={onRun} onFinished={load} />}
      {upload?.error && <Notice tone="error" onClose={() => dismissUploadError(task.id)}>{upload.error}</Notice>}
      {uploading(upload) && (
        <div className="tp-upload" role="status">
          <span className="t-sm tp-upload-l">
            {!upload.name ? <span>В очереди</span> : <>
              <span>{upload.pct >= 0.999 ? "Обрабатываю на сервере" : "Передаю"}{upload.total > 1 && ` ${upload.done + 1} из ${upload.total}`}<Sep /></span>
              <span className="t-ell">{upload.name}</span>
              {upload.pct < 0.999 && <span><Sep />{Math.round(upload.pct * 100)} %</span>}
            </>}
          </span>
          <Progress value={upload.pct >= 0.999 ? 1 : upload.pct} label="Загрузка" />
        </div>
      )}

      <div className="tp-two">
        <FileDrag.Consumer>{(drag) => {
          const dragOn = drag && !dropBlocked && !hasLayer() ? drag : null;
          return <div className={cx("tp-main", dragOn && "is-drop")}>
          {fillable && <div className="tp-add">
            <Button variant="ghost" onClick={() => folderRef.current?.click()}>Загрузить папку изображений</Button>
            {!empty && <AddMenu onAdd={onAdd} />}
          </div>}
          {cutBlock && <CutFramesCard transferAction={task.status === "queued" && fillable &&
            <CutTransfer key={task.id} task={task} tags={tags} onTransfer={(id) => navigate(`/projects/${task.project.code}/tasks/${id}`)} />}
            taskId={task.id} counts={cutBlock.counts} known={cutBlock.known} videos={cutBlock.videos || []}
            tags={tags} revision={numbers?.by_source} open={cutFramesOpen} onExpand={setCutFramesOpen} onOpen={openCutFrame} actions={frameActions} />}
          {empty ? <TaskEmpty editable={fillable} dataset={task.target_dataset?.name ?? null} drag={dragOn} onAdd={onAdd} onDrop={drop} />
            : cards.map((c) => c.node)}
          {dragOn && (!empty || !fillable) && <DropVeil drag={dragOn} refusal={refusal} onAdd={onAdd} onDrop={drop} />}
          </div>;
        }}</FileDrag.Consumer>
        <TaskPassport task={task} numbers={numbers} numbersLook={numbersLook} pendingFrames={pendingFrames} pendingLook={pendingLook}
          events={events} workers={workers} busy={busy || handoverActive} handing={handoverActive} questions={qs.list}
          onState={openState} onMove={(to) => void move(to)} onClose={() => void closeTask()}
          onAssign={(ids) => void reassign(ids)} onHistory={() => setHistory(true)} />
      </div>

      <input ref={folderRef} type="file" {...{ webkitdirectory: "" }} multiple hidden
        onChange={(e) => { if (e.target.files?.length) acceptFiles("images", Array.from(e.target.files)); e.target.value = ""; }} />
      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { if (e.target.files?.length) setPicked([...e.target.files]); e.target.value = ""; }} />
      <input ref={cutRef} type="file" accept="video/*" multiple hidden
        onChange={(e) => { void onVideo(Array.from(e.target.files ?? []), "cut"); e.target.value = ""; }} />
      <input ref={annotateRef} type="file" accept="video/*" multiple hidden
        onChange={(e) => { void onVideo(Array.from(e.target.files ?? []), "annotate"); e.target.value = ""; }} />

      <Sheet open={history} onOpenChange={setHistory} title="История таски" desc={count(events.length, "событие", "события", "событий")}>
        <EventList events={events} />
      </Sheet>
      {confirmNode}
      {overviewOpen && <ScoutOverview taskId={task.id} onClose={() => setOverviewOpen(false)} />}
      {setupOpen && (
        <AgentSetupDialog taskId={task.id} tool={agentTool} onClose={() => setSetupOpen(false)}
          onRunAll={editable ? () => { setSetupOpen(false); setAgentAsk(undefined); setAgentOpen(true); } : undefined} />
      )}
      {agentOpen && (
        <AgentRunDialog taskId={task.id} initial={agentAsk} onClose={() => { setAgentOpen(false); agentTool.reload(); }}
          onStarted={(run) => { setAgentOpen(false); setAgentRun(run); agentTool.reload(); }} />
      )}
      {cpuAsk && (
        <CpuConfirm refusal={cpuAsk.refusal} busy={busy} onCancel={() => setCpuAsk(null)}
          onCpu={() => void guard(async () => {
            setAgentRun(await agentTool.start({ ...cpuAsk.body, device: "cpu" }));
            setCpuAsk(null);
          })} />
      )}
      {picked && (
        <UploadImagesModal code={task.project.code} tags={tags} files={picked}
          onTagCreated={(tag) => setTags((prev) => [...prev, tag])} onCancel={() => setPicked(null)}
          onSend={(perFile) => void sendFiles(picked, perFile)} />
      )}
      {cutting && (
        <VideoCutModal taskId={task.id} video={cutting} editable={fillable} onClose={() => setCutting(null)} onDone={load} />
      )}
      {annotating && (
        <VideoAnnotator code={code!} taskId={task.id} taskName={task.name} video={annotating} readOnly={!editable} review={reviewing} people={members}
          questions={qs} question={qParam}
          onClose={() => { setAnnotating(null); void load(); if (qParam) dropQ(); }} />
      )}
      {editing && editing.list[editing.index] && (
        <AnnotationEditor code={code!} scope={{ kind: "task", taskId: task.id, taskName: task.name }} images={editing.list} index={editing.index}
          readOnly={!editable} canTag={task.rights.tag_frames} tags={tags} people={members}
          questions={qs} question={qParam}
          onTags={(imageId, ids) => void saveImageTags(imageId, ids)}
          onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
          activeImage={editing.image} frameDetails={editing.windows.get} loadFilm={editing.windows.load}
          onIndex={openEditorFrame} onClose={closeEditor} onChanged={patchEditorFrame} />
      )}
    </div>
  );
}

// «Скрыть» у плашки прогона помнится в браузере: остановленный не всплывает снова при каждом заходе
const HIDDEN_RUN = "mag.run.hidden.";
function hiddenRun(taskId: string): string | null {
  try { return localStorage.getItem(HIDDEN_RUN + taskId); } catch { return null; }
}
function hideRun(taskId: string, runId: string) {
  try { localStorage.setItem(HIDDEN_RUN + taskId, runId); } catch { /* без памяти — всплывёт при следующем заходе */ }
}
