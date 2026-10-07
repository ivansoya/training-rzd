// Агенты разметки: полка весов, окно запуска в таске и прогоны.
// Сам граф агента ходит через aug.ts — он лежит там же, где графы аугментаций.

import { asJson, get, post, put, del } from "./http";

export interface Weights {
  id: string;
  name: string;
  task: string;
  imgsz: number | null;
  /** Имена классов по номерам: names[i] — класс номер i в весах. */
  names: string[];
  size_bytes: number;
  created_at: string;
  run: { id: string; name: string } | null;
  fresh?: boolean;
}

export interface TrainedRun {
  id: string;
  name: string;
  project: string;
  base_model: string;
  task: string;
  weights_bytes: number | null;
  finished_at: string | null;
}

export const listWeights = () => get<{ weights: Weights[]; sam3?: boolean }>("agents/weights");

// Сырым телом, а не формой: сервер пишет его прямо в файл и считает отпечаток
// на лету — промежуточной копии, на которой не доезжал архив импорта, нет.
export async function uploadWeights(file: File): Promise<Weights> {
  const res = await fetch(`/api/agents/weights?name=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    body: file,
  });
  return asJson<Weights>(res);
}

export const trainedRuns = () => get<{ runs: TrainedRun[] }>("agents/train-runs");

export const weightsFromRun = (runId: string) =>
  post<Weights>("agents/weights/from-run", { run_id: runId });

export const deleteWeights = (id: string) => del<{ ok: true }>(`agents/weights/${id}`);

/** Класс версии в окне запуска. `lock` — id класса проекта, с которым ссылка
 *  сопоставлена намертво (класс из этого же проекта). */
export interface VersionClass {
  id: string;
  name: string;
  color?: string;
  ref?: { project: string; cls: string; project_name?: string } | null;
  lock?: string;
}

export interface AgentVersion {
  id: string;
  version: number;
  classes: VersionClass[];
  created_at: string;
}

export interface RunView {
  id: string;
  status: "queued" | "waiting_gpu" | "running" | "done" | "error" | "stopped";
  processed: number;
  total: number | null;
  stats: { boxes?: number; frames?: number; videos?: number };
  error: string | null;
  queue_reason: string | null;
  agent: string | null;
  version: number | null;
  sources: string[];
  mode: RunMode;
  videos: string[];
  created_at: string;
  finished_at: string | null;
}

/** Кадры таски, каждый N-й кадр размечаемого ролика или разведка роликов. */
export type RunMode = "frames" | "annotate" | "scout";

export interface TaskVideoRow {
  id: string;
  file_name: string;
  mode: "cut" | "annotate";
  closed: boolean;
  frames: number | null;
}

export interface RunContext {
  agents: { id: string; name: string; head: string; versions: AgentVersion[] }[];
  videos: TaskVideoRow[];
  classes: { id: string; class_index: number; name: string; color: string }[];
  /** Сопоставление, запомненное на пару «агент + проект». */
  mappings: Record<string, Record<string, string | null>>;
  /** Блоки кадров: «files», «videos» (нарезка) и id закрытых размечаемых роликов. */
  sources: Record<string, { new: number; agent: number }>;
  runs: RunView[];
  can_run: boolean;
}

export const runContext = (taskId: string) => get<RunContext>(`agents/tasks/${taskId}`);

export const startRun = (
  taskId: string,
  body: {
    graph_id: string;
    version_id: string;
    mode: RunMode;
    sources: string[];
    videos: string[];
    step: number;
    gap: number;
    mapping: Record<string, string | null>;
  }
) => post<RunView>(`agents/tasks/${taskId}/runs`, body);

/** Окно «Агент таски»: сопоставление классов без запуска — помнится на пару «агент + проект». */
export const saveMapping = (taskId: string, body: { graph_id: string; mapping: Record<string, string | null> }) =>
  put<{ mapping: Record<string, string | null> }>(`agents/tasks/${taskId}/mapping`, body);

/** Агент на одном кадре из редактора: изображение таски или кадр ролика.
 *  Рамки встают на проверку; для изображения ответ несёт разметку кадра целиком. */
export const applyAgent = (
  taskId: string,
  body: { graph_id: string; version_id: string } & ({ image_id: string } | { video_id: string; frame_no: number })
) => post<{
  put: number;
  found: number;
  boxes?: import("../auth/api").TaskBox[];
  rev?: number;
  task_status?: string;
  ms?: number;
}>(`agents/tasks/${taskId}/apply`, body);

/** Разведка ролика: участки по классам агента, кадры включительно. */
export interface Scout {
  file_name: string;
  agent: string | null;
  step: number;
  gap_s: number;
  last_frame: number;
  fps: number | null;
  segments: Record<string, [number, number, number][]>;
  created_at: string;
}

export const taskScouts = (taskId: string) =>
  get<{ scouts: Record<string, Scout> }>(`agents/tasks/${taskId}/scouts`);

/** Класс в статистике разведки. `counts` — рамок на каждом проверенном кадре. */
export interface ScoutClassStats {
  name: string;
  boxes: number;
  frames: number;
  max: number;
  conf: { median: number; min: number; max: number; hist: number[] };
  size: [number, number];
  counts: number[];
}

/** Разведка одного ролика числами — считает сервер (agent_graph.scout_stats). */
export interface ScoutStats {
  file_name: string;
  fps: number | null;
  agent: string | null;
  version: number | null;
  step: number;
  last_frame: number;
  created_at: string;
  segments: Record<string, [number, number, number][]>;
  checked: number[];
  with_hits: number;
  boxes: number;
  max: number;
  max_at: number | null;
  per_frame: number[];
  classes: ScoutClassStats[];
  /** Находки по кадрам: {кадр: [[класс агента, уверенность, x, y, w, h], ...]}. */
  frames: Record<string, [string, number, number, number, number, number][]>;
  /** Класс агента → класс проекта, если сопоставлен. */
  mapped: Record<string, { class_index: number; name: string; color: string } | null>;
}

export const scoutStats = (taskId: string, videoId: string) =>
  get<ScoutStats>(`agents/tasks/${taskId}/scouts/${videoId}`);

export const stopRun = (runId: string) => post<RunView>(`agents/runs/${runId}/stop`);

export const ACTIVE: RunView["status"][] = ["queued", "waiting_gpu", "running"];

// --- превью агента в редакторе --------------------------------------------

export interface PreviewDet {
  id: string;
  cls: string;
  conf: number;
  box: [number, number, number, number];
  /** После «Уточнения SAM»: обводка кольцами точек и оценка маски. */
  parts?: [number, number][][];
  sam?: number;
  /** У «Сети по тексту»: номер строки узла, что дала рамку («N на кадре» у описания). */
  row?: number;
}

export interface HumanShape {
  cls: string;
  color: string;
  type: "bbox" | "polygon" | string;
  geometry: { x?: number; y?: number; w?: number; h?: number; parts?: [number, number][][] };
}

export interface PreviewImage {
  id: string;
  file_name: string;
  width: number;
  height: number;
  /** Состояние кадра в таске: new, skipped, annotated, empty, deleted. */
  status?: string;
  /** Разметка кадра проверена: он в данных проекта или «размечен»/«пусто» в таске — есть с чем сверять. */
  truth?: boolean;
}

export interface AgentPreview {
  image: PreviewImage;
  human: HumanShape[];
  /** Вход и выход каждого узла; `ms` — сколько узел считал. */
  nodes: Record<string, { in: PreviewDet[]; out: PreviewDet[]; ms?: number }>;
  device: "cuda" | "cpu";
  /** Почему на процессоре: чем занята карта. */
  note: string | null;
  ms: number;
}

/** Кадры проекта для итога тайлинга: самый частый размер, его доля и самый большой. */
export interface FrameSummary {
  w: number;
  h: number;
  share: number;
  largest: [number, number];
}

export interface PreviewProject {
  code: string;
  name: string;
  images: number;
  frame: FrameSummary | null;
}

/** Проект человека с классами — откуда берут ссылки окна «Классы агента». */
export interface ClassSource {
  id: string;
  code: string;
  name: string;
  classes: { id: string; name: string; color: string; class_index: number }[];
}

export const classSources = () => get<{ projects: ClassSource[] }>("agents/class-sources");

export const previewProjects = () => get<{ projects: PreviewProject[] }>("agents/preview/projects");

export const runPreview = (
  body: {
    graph_id: string;
    doc: unknown;
    project: string;
    image_id: string | null;
    step: "same" | "next" | "prev" | "random";
  },
  signal?: AbortSignal
) => post<AgentPreview>("agents/preview", body, signal);

/** «Выход» агента на нескольких случайных кадрах — один прогон моделей на сервере. */
export interface PreviewFrames {
  frames: { image: AgentPreview["image"]; human: HumanShape[]; out: PreviewDet[] }[];
  device: "cuda" | "cpu";
  note: string | null;
  ms: number;
}

export const runPreviewFrames = (
  body: { graph_id: string; doc: unknown; project: string; count: number },
  signal?: AbortSignal
) => post<PreviewFrames>("agents/preview/frames", body, signal);

// --- Наборы образцов «Сети по тексту» (training_svc/examples.py) -----------

export interface ExampleItem {
  uid: string;
  file_name: string;
  /** Меньшая сторона рамки, px. */
  side: number;
  image_id: string;
  box: [number, number, number, number];
}

/** Набор неизменяем: убрать, переставить, добрать — это новый набор. */
export interface ExampleSet {
  id: string;
  status: "queued" | "ready" | "error";
  error: string | null;
  project: string;
  /** Проект и класс, из которых собран набор: с них открывается окно «Образцы класса». */
  project_id: string | null;
  class_id: string | null;
  class_name: string;
  // collage и ctx — у наборов до шага «авто»: SAM 3 их больше не читает.
  params: { datasets: string[] | null; n: number; seed: number; collage?: number; ctx?: number };
  parent_id: string | null;
  items: ExampleItem[];
  frames: number;
  created_at: string;
}

export interface ExampleSources {
  project: { code: string; name: string };
  datasets: { id: string; name: string; frames: number }[];
  classes: {
    id: string;
    name: string;
    color: string;
    /** По датасетам: всего ручных рамок, годных (от 8 px) и кадров с ними. */
    datasets: Record<string, { boxes: number; usable: number; frames: number }>;
  }[];
}

export const exampleSources = (project: string) =>
  get<ExampleSources>(`agents/examples/sources?project=${encodeURIComponent(project)}`);

/** Ручная рамка класса для окна «Образцы класса»; `group` — тот же предмет на соседних кадрах ролика. */
export interface ClassBox {
  uid: string;
  image_id: string;
  file_name: string;
  dataset: string;
  frame: [number, number];
  box: [number, number, number, number];
  video: string | null;
  t: number | null;
  group: number;
}

export const exampleBoxes = (project: string, classId: string) =>
  get<{ boxes: ClassBox[]; frames: number; objects: number }>(
    `agents/examples/boxes?project=${encodeURIComponent(project)}&class_id=${encodeURIComponent(classId)}`);

export const boxCrop = (image: string, box: number[]) =>
  `/api/agents/examples/boxes/crop?image=${image}&box=${box.map((v) => Math.round(v * 10) / 10).join(",")}`;

/** Набор из выбранных рамок по порядку; `from` — прежний набор того же класса, его векторы не пересчитываются. */
export const examplesByHand = (body: {
  project: string;
  class_id: string;
  items: { image_id: string; box: number[] }[];
  from?: string;
}) => post<{ set: ExampleSet }>("agents/examples", body);

/** «Как видит SAM 3»: проход коллажа над кадром превью картинкой и число проходов. */
export async function exampleCollage(body: {
  image_id: string;
  items: { image_id: string; box: number[] }[];
  side: number;
  tile?: number | null;
  pass: number;
}, signal?: AbortSignal): Promise<{ blob: Blob; passes: number }> {
  const res = await fetch("/api/agents/examples/collage", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!res.ok) await asJson(res);
  return { blob: await res.blob(), passes: Number(res.headers.get("X-Passes") || 1) };
}

export const deriveExamples = (id: string, body: { order?: string[]; add?: number }) =>
  post<{ set: ExampleSet }>(`agents/examples/${id}/derive`, body);

export const listExamples = (ids: string[]) =>
  get<{ sets: ExampleSet[] }>(`agents/examples?ids=${ids.join(",")}`);

export const exampleCrop = (id: string, uid: string) => `/api/agents/examples/${id}/crops/${uid}`;
