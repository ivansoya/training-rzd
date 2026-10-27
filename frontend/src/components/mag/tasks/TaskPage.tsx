// Страница таски: источники слева, паспорт справа; «Запустить агента» и «Размечать» в шапке.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  assignTask, clearAgentUnchecked, deleteTaskVideo, getProject,
  getTaskImages, getTaskNumbers, getVideoPending, setTaskStatus, uploadTaskImages, uploadTaskVideo,
} from "../../../auth/api";
import type {
  AgentClearScope, ProjectMemberInfo, StatusResult, TaskDetail, TaskImage, TaskStatus, TaskVideoItem,
} from "../../../auth/api";
import { useAuth } from "../../auth/AuthGate";
import { pollJob } from "../../../api/jobs";
import { setImageTags, setVideoTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import { runContext } from "../../../api/agents";
import type { RunMode, RunView } from "../../../api/agents";
import { Button, Notice, Progress, Sheet, cx, hasLayer } from "../../../ui";
import { count, plural, ru } from "../../ru";
import AgentRunDialog, { AgentRunBar } from "../../agents/AgentRunDialog";
import AgentSetupDialog from "../../agents/AgentSetupDialog";
import CpuConfirm, { refusalOf, type CardRefusal } from "../../hardware/CpuConfirm";
import { useAgentTool } from "../../editor/AgentTool";
import ScoutOverview from "../../agents/ScoutOverview";
import { useScouts } from "../../agents/scout";
import AnnotationEditor, { saveSettled } from "../AnnotationEditor";
import UploadImagesModal from "../UploadImagesModal";
import VideoAnnotator from "../VideoAnnotator";
import VideoCutModal from "../VideoCutModal";
import { useConfirm } from "./Confirm";
import { AddMenu, AnnotateCard, CutCard, DropVeil, FramesCard, TaskEmpty } from "./Sources";
import type { AgentHooks } from "./Sources";
import { droppedFiles, kindOf, parts, useFileDrag, zoneKind } from "./drop";
import type { Zone } from "./drop";
import { EventList, TaskPassport } from "./TaskPassport";
import type { FrameState } from "./tasks";
import { buildSources, closePlan, closeText, handoverText } from "./tasks";
import { look } from "./useTaskBoard";
import { openVideos, useTaskPage } from "./useTaskPage";
import { dismissUploadError, enqueueUpload, uploading, useUpload } from "./uploads";
import { useHere } from "../here";

/** Кадров в таске без брака — из лёгкой части, известно сразу. */
const framesTotal = (t: TaskDetail) => Object.values(t.sources || {}).reduce((s, x) => s + (x.frames || 0), 0);

const ACTIVE_RUN = ["queued", "waiting_gpu", "running"];



/** Все кадры выборки: сервер отдаёт по 200, добираем до `matched`. */
async function allImages(taskId: string, params: { status?: string; source?: string }): Promise<TaskImage[]> {
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

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && !!t.closest("input, textarea, select, button, a, [contenteditable='true'], [role='option']");

export default function TaskPage() {
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
  const drag = useFileDrag();
  const [tags, setTags] = useState<Tag[]>([]);
  const [picked, setPicked] = useState<File[] | null>(null);
  const [history, setHistory] = useState(false);
  const [confirm, confirmNode] = useConfirm();

  // Открытый кадр живёт в адресе (?frame=<id>): «Назад» закрывает редактор
  const [editing, setEditing] = useState<{ list: TaskImage[]; index: number } | null>(null);
  const [search, setSearch] = useSearchParams();
  const frameParam = search.get("frame");
  const pushed = useRef(false);
  const setFrame = useCallback((id: string | null, replace: boolean) => {
    setSearch((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("frame", id); else next.delete("frame");
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
    if (pushed.current) { pushed.current = false; navigate(-1); } else setFrame(null, true);
  }, [navigate, setFrame]);

  const [cutting, setCutting] = useState<TaskVideoItem | null>(null);
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
  const here = useHere();
  // Быстрый запуск из меню блока упёрся в карту — окно «на процессоре или отменить».
  const [cpuAsk, setCpuAsk] = useState<{ refusal: CardRefusal; body: Parameters<AgentHooks["start"]>[0] } | null>(null);
  const scouted = Object.keys(useScouts(taskId || "")).length > 0;
  const [overviewOpen, setOverviewOpen] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
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
      if (editing) { pushed.current = false; setEditing(null); }
      return;
    }
    if (editing) return;
    let alive = true;
    allImages(taskId, {}).then((list) => {
      if (!alive) return;
      const at = list.findIndex((i) => i.id === frameParam);
      if (at >= 0) setEditing({ list, index: at }); else setFrame(null, true);
    }).catch((e) => setError((e as Error).message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameParam, taskId]);

  // Редактор закрылся — перечитываем таску: он уже отправил последнюю правку
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) void load();
    wasEditing.current = !!editing;
  }, [editing, load]);

  // Идущий прогон агента видно и после перезагрузки; остановленный и упавший — тоже, ради «Продолжить», пока не скрыли
  useEffect(() => {
    if (!taskId) return;
    runContext(taskId).then((ctx) => {
      const last = ctx.runs[0];
      if (last && (ACTIVE_RUN.includes(last.status)
        || ((last.status === "stopped" || last.status === "error") && hiddenRun(taskId) !== last.id))) setAgentRun(last);
    }).catch(() => undefined);
  }, [taskId]);
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
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);

  // Сдача идёт фоном: её работа — в карточке таски, видна всем. Пока идёт — только просмотр.
  // За работой следим до её конца, а не пока она в карточке: перечитка таски (опрос готовности
  // ролика) обнуляет поле раньше, чем опрос работы узнаёт итог, — и строка итога терялась.
  const [handing, setHanding] = useState<number | null>(null);
  const [watched, setWatched] = useState<string | null>(null);
  const handJob = task?.handover ?? null;
  useEffect(() => { if (handJob) setWatched(handJob); }, [handJob]);
  useEffect(() => {
    if (!watched) return undefined;
    let alive = true;
    setHanding(0);
    pollJob<StatusResult>(watched, (j) => { if (alive) setHanding(j.total ? j.processed / j.total : 0); })
      .then((r) => { if (alive) setNotice(handoverText(r)); }, (e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) { setHanding(null); setWatched(null); void load(); } });
    return () => { alive = false; };
  }, [watched, load]);

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

  /** «Размечать»: все кадры таски, с первого нетронутого или отложенного. */
  const annotateAll = useCallback(() => guard(async () => {
    if (!taskId) return;
    const list = await allImages(taskId, {});
    if (!list.length) { setNotice("В таске пока нет кадров — добавьте изображения или ролик."); return; }
    const first = list.findIndex((i) => i.task_status === "new" || i.task_status === "skipped");
    openEditor(list, first >= 0 ? first : 0);
  }), [guard, taskId, openEditor]);

  const openFiltered = (params: { status?: string; source?: string }) => guard(async () => {
    if (!taskId) return;
    const list = await allImages(taskId, params);
    if (!list.length) return;
    const first = list.findIndex((i) => i.task_status === "new" || i.task_status === "skipped");
    openEditor(list, first >= 0 ? first : 0);
  });
  const openState = (s: FrameState) => openFiltered({ status: s });

  // Enter — размечать, G — агент; не мешаем полям, кнопкам и открытым окнам
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || editing || annotating || cutting || hasLayer() || isTyping(e.target)) return;
      if (e.key === "Enter" && task && framesTotal(task) > 0) { e.preventDefault(); void annotateAll(); }
      if ((e.key === "g" || e.key === "п") && editable) { e.preventDefault(); setSetupOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, annotating, cutting, task, editable, agentBusy, annotateAll]);

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
    setEditing((prev) => prev && { ...prev, list: prev.list.map((i) => (i.id === imageId ? { ...i, tag_ids: tagIds } : i)) });
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
    if (!plan.boxes) { setNotice("Непроверенного от агентов здесь нет."); return; }
    const ok = await confirm({
      title: "Очистить непроверенное агентов?",
      desc: `${plural(plan.boxes, "Уйдёт", "Уйдут", "Уйдут")} ${count(plan.boxes, "рамка", "рамки", "рамок")} `
        + `на ${count(plan.frames, "кадре", "кадрах", "кадрах")}. Проверенное человеком останется.`,
      ok: "Очистить", icon: "trash", danger: true,
    });
    if (!ok) return;
    await guard(async () => {
      const res = await clearAgentUnchecked(taskId, scope);
      setNotice(`${plural(res.boxes, "Убрана", "Убраны", "Убрано")} ${count(res.boxes, "рамка", "рамки", "рамок")} `
        + `агентов с ${count(res.frames, "кадра", "кадров", "кадров")}.`);
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
  const annotateVideos = task.videos.filter((v) => v.mode === "annotate");
  // Ход агента — в блоке, по которому он идёт
  const live = agentBusy ? agentRun : null;
  const runOn = (frames: string | null, videos: string[], modes: RunMode[]) =>
    live && modes.includes(live.mode) &&
    (live.mode === "frames" ? !!frames && live.sources.includes(frames) : live.videos.some((v) => videos.includes(v)))
      ? live : null;
  const empty = sources.length === 0 && annotateVideos.length === 0;
  // Поверх открытого окна (таги, нарезка, редактор) бросок в таску путает — зон нет
  const dragOn = drag && !(editing || annotating || cutting || picked || hasLayer()) ? drag : null;
  const refusal = fillable ? null : handJob || watched
    ? "Таска сдаётся в датасет — добавить можно будет после."
    : "Добавлять файлы в эту таску вам сейчас нельзя.";
  const drop = (w: Zone, dt: DataTransfer) => void dropFiles(w, dt);
  // Меню «⋯» блоков: агент таски сразу, без окна
  const agent: AgentHooks = {
    tool: agentTool, busy: busy || agentBusy, onSetup: () => setSetupOpen(true),
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
  const cards = [
    ...sources.map((b) => ({ key: b.key, born: b.bornAt, node: b.kind === "cut" ? (
      <CutCard key={b.key} block={b} look={numbersLook} taskId={task.id} code={task.project.code} tags={tags} editable={editable} fillable={fillable}
        run={runOn(b.key, (b.videos || []).map((v) => v.id), ["frames", "scout"])} agent={agent}
        onAnnotate={() => openFiltered({ source: b.key })} onReview={() => review(b.key)}
        onCut={setCutting} onDelete={removeVideo} onVideoTags={saveVideoTags}
        onTagCreated={(t) => setTags((p) => [...p, t])} />
    ) : (
      <FramesCard key={b.key} block={b} look={numbersLook} editable={editable} onAnnotate={() => openFiltered({ source: b.key })}
        run={runOn(b.key, [], ["frames"])} agent={agent} onReview={() => review(b.key)}
        code={task.project.code} fillable={fillable} />
    ) })),
    ...(annotateVideos.length ? [{ key: "annotate", born: Math.min(...annotateVideos.map((v) => Date.parse(v.created_at))), node: (
      <AnnotateCard key="annotate" videos={annotateVideos} working={opened.length > 0} handing={!!handJob || !!watched} pending={pending} fresh={page.fresh.videos} at={page.at}
        classes={numbers?.classes ?? []}
        taskId={task.id} code={task.project.code} tags={tags} editable={editable} fillable={fillable}
        run={runOn(null, annotateVideos.map((v) => v.id), ["annotate", "scout"])} here={here} people={members} agent={agent}
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
          {scouted && <Button variant="ghost" icon="scan" onClick={() => setOverviewOpen(true)}>Разведка</Button>}
          {editable && (
            <Button variant="agent" icon="bot" kbd="G" onClick={() => setSetupOpen(true)}
              title="Агент таски: кого звать из меню блоков и кнопкой G, сопоставление классов">
              {agentTool.agent ? <>Агент: {agentTool.agent.name}{agentTool.version && <span className="ui-mono tp-agent-v">v{agentTool.version.version}</span>}</> : "Агент таски"}
            </Button>
          )}
          <Button variant="primary" icon={editable ? "edit" : "eye"} kbd="Enter" disabled={busy || framesTotal(task) === 0}
            onClick={() => void annotateAll()}>{editable ? "Размечать" : "Смотреть кадры"}</Button>
        </div>
      </div>

      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="ok" onClose={() => setNotice(null)}>{notice}</Notice>}
      {agentRun && <AgentRunBar taskId={task.id} run={agentRun} onRun={onRun} onFinished={load} />}
      {upload?.error && <Notice tone="error" onClose={() => dismissUploadError(task.id)}>{upload.error}</Notice>}
      {uploading(upload) && (
        <div className="tp-upload" role="status">
          <span className="t-sm tp-upload-l">
            {!upload.name ? <span>В очереди</span> : <>
              <span>{upload.pct >= 0.999 ? "Обрабатываю на сервере" : "Передаю"}{upload.total > 1 && ` ${upload.done + 1} из ${upload.total}`} · </span>
              <span className="t-ell">{upload.name}</span>
              {upload.pct < 0.999 && <span> · {Math.round(upload.pct * 100)} %</span>}
            </>}
          </span>
          <Progress value={upload.pct >= 0.999 ? 1 : upload.pct} label="Загрузка" />
        </div>
      )}

      <div className="tp-two">
        <div className={cx("tp-main", dragOn && "is-drop")}>
          {fillable && !empty && <div className="tp-add"><AddMenu onAdd={onAdd} /></div>}
          {empty ? <TaskEmpty editable={fillable} dataset={task.target_dataset?.name ?? null} drag={dragOn} onAdd={onAdd} onDrop={drop} />
            : cards.map((c) => c.node)}
          {dragOn && (!empty || !fillable) && <DropVeil drag={dragOn} refusal={refusal} onAdd={onAdd} onDrop={drop} />}
        </div>
        <TaskPassport task={task} numbers={numbers} numbersLook={numbersLook} pendingFrames={pendingFrames} pendingLook={pendingLook}
          events={events} workers={workers} busy={busy || !!handJob || !!watched} handing={handing}
          onState={openState} onMove={(to) => void move(to)} onClose={() => void closeTask()}
          onAssign={(ids) => void reassign(ids)} onHistory={() => setHistory(true)} />
      </div>

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
          onClose={() => { setAnnotating(null); void load(); }} />
      )}
      {editing && editing.list[editing.index] && (
        <AnnotationEditor code={code!} scope={{ kind: "task", taskId: task.id, taskName: task.name }} images={editing.list} index={editing.index}
          readOnly={!editable} canTag={task.rights.tag_frames} tags={tags} people={members}
          onTags={(imageId, ids) => void saveImageTags(imageId, ids)}
          onTagCreated={(tag) => setTags((prev) => [...prev, tag])}
          onIndex={(i) => {
            setEditing((prev) => (prev ? { ...prev, index: i } : prev));
            setFrame(editing.list[i]?.id ?? null, true);
          }}
          onClose={closeEditor}
          onChanged={(id, patch) => setEditing((prev) => prev
            ? { ...prev, list: prev.list.map((x) => (x.id === id ? { ...x, ...patch } : x)) } : prev)} />
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
