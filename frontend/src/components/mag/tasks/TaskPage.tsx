// Страница таски: источники слева, паспорт справа; «Запустить агента» и «Размечать» в шапке.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  assignTask, closeVideoAnnotation, deleteTaskVideo, dropVideoFrames, getProject, getTask,
  getTaskEvents, getTaskImages, reopenVideoAnnotation, setTaskStatus, uploadTaskImages, uploadTaskVideo,
} from "../../../auth/api";
import type { ProjectMemberInfo, TaskDetail, TaskEventItem, TaskImage, TaskStatus, TaskVideoItem } from "../../../auth/api";
import { pollJob } from "../../../api/jobs";
import { setImageTags, setVideoTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import { runContext } from "../../../api/agents";
import type { RunMode, RunView } from "../../../api/agents";
import { Button, Notice, Progress, Sheet, hasLayer } from "../../../ui";
import { count, plural } from "../../ru";
import AgentRunDialog, { AgentRunBar } from "../../agents/AgentRunDialog";
import AgentSetupDialog from "../../agents/AgentSetupDialog";
import { useAgentTool } from "../../editor/AgentTool";
import ScoutOverview from "../../agents/ScoutOverview";
import { useScouts } from "../../agents/scout";
import AnnotationEditor, { saveSettled } from "../AnnotationEditor";
import UploadImagesModal from "../UploadImagesModal";
import VideoAnnotator from "../VideoAnnotator";
import VideoCutModal from "../VideoCutModal";
import { useConfirm } from "./Confirm";
import { AddMenu, AnnotateCard, CutCard, FramesCard, TaskEmpty } from "./Sources";
import type { AgentHooks } from "./Sources";
import { EventList, TaskPassport } from "./TaskPassport";
import type { FrameState } from "./tasks";
import { buildSources, closePlan, closeText } from "./tasks";

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
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [workers, setWorkers] = useState<ProjectMemberInfo[]>([]);
  const [events, setEvents] = useState<TaskEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
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
  const scouted = Object.keys(useScouts(taskId || "")).length > 0;
  const [overviewOpen, setOverviewOpen] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const cutRef = useRef<HTMLInputElement>(null);
  const annotateRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      // Редактор мог только что отправить последнюю правку — читаем после неё
      await saveSettled();
      const [t, ev] = await Promise.all([getTask(taskId), getTaskEvents(taskId)]);
      setTask(t);
      setTags(t.tags);
      setEvents(ev);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [taskId]);
  useEffect(() => { void load(); }, [load]);

  const adminOf = task?.is_admin ? task.project.code : null;
  useEffect(() => {
    if (!adminOf) return;
    getProject(adminOf).then((d) => setWorkers(d.members.filter((m) => m.role !== "viewer"))).catch(() => setWorkers([]));
  }, [adminOf]);

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

  // Идущий прогон агента видно и после перезагрузки
  useEffect(() => {
    if (!taskId) return;
    runContext(taskId).then((ctx) => {
      const last = ctx.runs[0];
      if (last && ACTIVE_RUN.includes(last.status)) setAgentRun(last);
    }).catch(() => undefined);
  }, [taskId]);

  // Пока ролик готовится на сервере — переспрашиваем таску
  const preparing = (task?.videos || []).some((v) => v.prepare && (v.prepare.busy || (!v.prepare.ready && !v.prepare.error)));
  useEffect(() => {
    if (!preparing) return undefined;
    const id = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(id);
  }, [preparing, load]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);

  const editable = !!task && task.can_work && task.status !== "closed";
  const agentBusy = !!agentRun && ACTIVE_RUN.includes(agentRun.status);
  const pendingFrames = (task?.pending_videos || []).reduce((s, v) => s + v.frames, 0);

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
      if (e.key === "Enter" && task && task.counts.total > 0) { e.preventDefault(); void annotateAll(); }
      if ((e.key === "g" || e.key === "п") && editable) { e.preventDefault(); setSetupOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, annotating, cutting, task, editable, agentBusy, annotateAll]);

  async function move(to: TaskStatus) {
    if (!taskId || !task) return;
    if (to === "done" && task.pending_videos.length) {
      const ok = await confirm({
        title: "Сдать с незакрытыми роликами?",
        desc: `У ${count(task.pending_videos.length, "ролика", "роликов", "роликов")} разметка не закрыта — их кадры в датасет не уйдут.`,
        lines: task.pending_videos.map((v) => `«${v.file_name}» — ${count(v.frames, "кадр", "кадра", "кадров")}`),
        ok: "Сдать всё равно", icon: "tick",
      });
      if (!ok) return;
    }
    await guard(async () => {
      const res = await setTaskStatus(taskId, to);
      if (res.accepted) setNotice(`В датасет «${res.dataset}» ушло ${count(res.accepted, "кадр", "кадра", "кадров")}.`);
      else if (to === "done") setNotice("Размеченных кадров пока нет — принимать нечего.");
      await load();
    });
  }

  async function closeTask() {
    if (!taskId || !task) return;
    // Тот же отбор, что у сервера: незакрытая разметка ролика при закрытии таски пропала бы.
    const open = task.pending_videos.filter((v) => !v.frames_in_task && (v.frames || v.error));
    if (open.length) {
      setError(`Разметка роликов не закрыта — при закрытии таски она пропадёт: ${open.map((v) => `«${v.file_name}»`).join(", ")}. Закройте их разметку или уберите ролики.`);
      return;
    }
    const plan = closePlan(task.counts, task.videos.length);
    const ok = await confirm({
      title: "Закрыть таску?", lines: closeText(plan, task.target_dataset?.name ?? null),
      desc: "Закрытую таску нельзя вернуть в работу.", ok: "Закрыть таску", icon: "archive", danger: true,
    });
    if (!ok) return;
    await guard(async () => {
      const res = await setTaskStatus(taskId, "closed");
      const said = [
        res.accepted ? `В датасет «${res.dataset}» ушло ${count(res.accepted, "кадр", "кадра", "кадров")}.` : "",
        res.removed_images ? `${plural(res.removed_images, "Удалён", "Удалено", "Удалено")} ${count(res.removed_images, "черновой кадр", "черновых кадра", "черновых кадров")}.` : "",
      ].filter(Boolean);
      if (said.length) setNotice(said.join(" "));
      await load();
    });
  }

  const reassign = (id: string | null) => guard(async () => {
    if (!task) return;
    await assignTask(task.id, id);
    await load();
  });

  /** Кадры блока на проверке агента — в редактор по одному. */
  const review = (source: string) => openFiltered({ status: "agent", source });
  const openVideo = (v: TaskVideoItem, forReview = false) => { setReviewing(forReview); setAnnotating(v); };

  async function sendFiles(files: File[], perFile: string[][]) {
    if (!taskId) return;
    setPicked(null);
    setUploadPct(0);
    setError(null);
    try {
      const got = await uploadTaskImages(taskId, files, setUploadPct, perFile);
      await load();
      const skipped = `${count(got.skipped, "файл", "файла", "файлов")} — не изображения или не читаются`;
      if (!got.added && got.skipped) setError(`Ни один файл не принят: ${skipped}.`);
      else if (got.skipped) setNotice(`Принято ${got.added}, пропущено ${skipped}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadPct(null);
    }
  }

  /** Ролики по одному и по очереди: канал и так занят целиком. */
  async function onVideo(files: FileList | null, mode: "cut" | "annotate") {
    const list = Array.from(files || []);
    if (!list.length || !taskId) return;
    setUploadPct(0);
    setError(null);
    let current = list[0];
    try {
      for (const [i, file] of list.entries()) {
        current = file;
        await uploadTaskVideo(taskId, file, (pct) => setUploadPct((i + pct) / list.length), mode);
      }
      if (list.length > 1) setNotice(`Загружено ${count(list.length, "ролик", "ролика", "роликов")}.`);
      await load();
    } catch (e) {
      await load().catch(() => {});
      const raw = (e as Error).message;
      setError(/\[Errno|Invalid data found|\/app\//.test(raw) ? `«${current.name}» не читается как видео.` : raw);
    } finally {
      setUploadPct(null);
    }
  }

  async function saveVideoTags(video: TaskVideoItem, tagIds: string[]) {
    if (!taskId) return;
    setTask((prev) => prev && { ...prev, videos: prev.videos.map((v) => (v.id === video.id ? { ...v, tag_ids: tagIds } : v)) });
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
    const open = task?.pending_videos.find((v) => v.video_id === video.id && !v.frames_in_task && v.frames);
    const ok = await confirm({
      title: `Убрать «${video.file_name}»?`,
      desc: [
        video.frames ? `Вместе с ним уйдут ${count(video.frames, ...forms)}. Принятые в проект останутся.` : "",
        open ? `Незакрытая разметка ролика (${count(open.frames, "кадр", "кадра", "кадров")}) пропадёт — в таску она не попадёт.` : "",
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

  async function dropFrames(video: TaskVideoItem) {
    if (!taskId) return;
    const ok = await confirm({
      title: `Убрать кадры «${video.file_name}» из таски?`, desc: "Принятые в проект останутся.",
      ok: "Убрать кадры", icon: "trash", danger: true,
    });
    if (!ok) return;
    await guard(async () => {
      const res = await dropVideoFrames(taskId, video.id);
      setNotice(`Убрано ${count(res.removed, "кадр", "кадра", "кадров")}${res.kept_accepted ? `, ${res.kept_accepted} осталось в проекте` : ""}.`);
      await load();
    });
  }

  const closeVideo = (video: TaskVideoItem) => guard(async () => {
    if (!taskId) return;
    const { job_id } = await closeVideoAnnotation(taskId, video.id);
    setNotice(`Достаю кадры из «${video.file_name}»…`);
    const made = await pollJob<{ created: number; boxes: number; empty: number }>(job_id, () => {});
    setNotice(`Разметка «${video.file_name}» закрыта: ${count(made.created, "кадр", "кадра", "кадров")} в таске` +
      (made.empty ? `, из них ${made.empty} ${plural(made.empty, "фоновый", "фоновых", "фоновых")}.` : "."));
    await load();
  });

  const onAdd = (w: "images" | "cut" | "annotate") =>
    (w === "images" ? fileRef : w === "cut" ? cutRef : annotateRef).current?.click();

  if (error && !task) {
    return (
      <div className="page">
        <Notice tone="error">{error}</Notice>
        <Link to={`/projects/${code}/tasks`}>← К таскам</Link>
      </div>
    );
  }
  if (!task) return <div className="page"><span className="t-muted">Загружаем таску…</span></div>;

  const sources = buildSources(task);
  const annotateVideos = task.videos.filter((v) => v.mode === "annotate");
  // Ход агента — в блоке, по которому он идёт
  const live = agentBusy ? agentRun : null;
  const runOn = (frames: string | null, videos: string[], modes: RunMode[]) =>
    live && modes.includes(live.mode) &&
    (live.mode === "frames" ? !!frames && live.sources.includes(frames) : live.videos.some((v) => videos.includes(v)))
      ? live : null;
  const empty = sources.length === 0 && annotateVideos.length === 0;
  // Меню «⋯» блоков: агент таски сразу, без окна
  const agent: AgentHooks = {
    tool: agentTool, busy: busy || agentBusy, onSetup: () => setSetupOpen(true),
    start: (body) => void guard(async () => {
      const run = await agentTool.start(body);
      setAgentRun(run);
    }),
    dialog: (ask) => { setAgentAsk(ask); setAgentOpen(true); },
  };
  const cards = [
    ...sources.filter((b) => b.kind !== "annotate").map((b) => ({ key: b.key, born: b.bornAt, node: b.kind === "cut" ? (
      <CutCard key={b.key} block={b} taskId={task.id} code={task.project.code} tags={tags} editable={editable}
        run={runOn(b.key, (b.videos || []).map((v) => v.id), ["frames", "scout"])} agent={agent}
        onAnnotate={() => openFiltered({ source: b.key })} onReview={() => review(b.key)}
        onCut={setCutting} onDelete={removeVideo} onVideoTags={saveVideoTags}
        onTagCreated={(t) => setTags((p) => [...p, t])} />
    ) : (
      <FramesCard key={b.key} block={b} editable={editable} onAnnotate={() => openFiltered({ source: b.key })}
        run={runOn(b.key, [], ["frames"])} agent={agent} onReview={() => review(b.key)} />
    ) })),
    ...(annotateVideos.length ? [{ key: "annotate", born: Math.min(...annotateVideos.map((v) => Date.parse(v.created_at))), node: (
      <AnnotateCard key="annotate" videos={annotateVideos} pending={task.pending_videos} classes={task.classes}
        taskId={task.id} code={task.project.code} tags={tags} editable={editable} busy={busy}
        run={runOn(null, annotateVideos.map((v) => v.id), ["annotate", "scout"])} agent={agent}
        onAdd={() => onAdd("annotate")} onOpen={(v) => openVideo(v)} onReview={(v) => openVideo(v, true)} onClose={closeVideo}
        onReopen={(v) => guard(async () => { await reopenVideoAnnotation(task.id, v.id); await load(); })}
        onDropFrames={dropFrames} onDelete={removeVideo} onVideoTags={saveVideoTags}
        onTagCreated={(t) => setTags((p) => [...p, t])} />
    ) }] : []),
    ...sources.filter((b) => b.kind === "annotate").map((b) => ({ key: b.key, born: Infinity, node: (
      <FramesCard key={b.key} block={b} editable={editable} onAnnotate={() => openFiltered({ source: b.key })}
        run={runOn(b.key, [], ["frames"])} agent={agent} onReview={() => review(b.key)} />
    ) })),
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
          <Button variant="primary" icon={editable ? "edit" : "eye"} kbd="Enter" disabled={busy || task.counts.total === 0}
            onClick={() => void annotateAll()}>{editable ? "Размечать" : "Смотреть кадры"}</Button>
        </div>
      </div>

      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {notice && <Notice tone="ok" onClose={() => setNotice(null)}>{notice}</Notice>}
      {agentRun && <AgentRunBar taskId={task.id} run={agentRun} onRun={setAgentRun} onFinished={load} />}
      {uploadPct !== null && (
        <div className="tp-upload" role="status">
          <span className="t-sm">{uploadPct >= 0.999 ? "Обрабатываю на сервере…" : `Передаю файлы · ${Math.round(uploadPct * 100)} %`}</span>
          <Progress value={uploadPct >= 0.999 ? 1 : uploadPct} label="Загрузка" />
        </div>
      )}

      <div className="tp-two">
        <div className="tp-main">
          {editable && !empty && <div className="tp-add"><AddMenu onAdd={onAdd} /></div>}
          {empty ? <TaskEmpty editable={editable} dataset={task.target_dataset?.name ?? null} onAdd={onAdd} />
            : cards.map((c) => c.node)}
        </div>
        <TaskPassport task={task} events={events} workers={workers} pendingFrames={pendingFrames} busy={busy}
          onState={openState} onMove={(to) => void move(to)} onClose={() => void closeTask()}
          onAssign={(id) => void reassign(id)} onHistory={() => setHistory(true)} />
      </div>

      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { if (e.target.files?.length) setPicked([...e.target.files]); e.target.value = ""; }} />
      <input ref={cutRef} type="file" accept="video/*" multiple hidden
        onChange={(e) => { void onVideo(e.target.files, "cut"); e.target.value = ""; }} />
      <input ref={annotateRef} type="file" accept="video/*" multiple hidden
        onChange={(e) => { void onVideo(e.target.files, "annotate"); e.target.value = ""; }} />

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
      {picked && (
        <UploadImagesModal code={task.project.code} tags={tags} files={picked}
          onTagCreated={(tag) => setTags((prev) => [...prev, tag])} onCancel={() => setPicked(null)}
          onSend={(perFile) => void sendFiles(picked, perFile)} />
      )}
      {cutting && (
        <VideoCutModal taskId={task.id} video={cutting} editable={editable} onClose={() => setCutting(null)} onDone={load} />
      )}
      {annotating && (
        <VideoAnnotator code={code!} taskId={task.id} taskName={task.name} video={annotating} readOnly={!editable} review={reviewing}
          onClose={() => { setAnnotating(null); void load(); }} onChanged={() => void load()} />
      )}
      {editing && editing.list[editing.index] && (
        <AnnotationEditor code={code!} taskId={task.id} taskName={task.name} images={editing.list} index={editing.index}
          readOnly={!editable} canTag={task.can_work} tags={tags}
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
