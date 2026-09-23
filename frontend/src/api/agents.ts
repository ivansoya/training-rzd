// Агенты разметки: полка весов, окно запуска в таске и прогоны.
// Сам граф агента ходит через aug.ts — он лежит там же, где графы аугментаций.

import { asJson, get, post, del } from "./http";

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

export const listWeights = () => get<{ weights: Weights[] }>("agents/weights");

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

export interface AgentVersion {
  id: string;
  version: number;
  classes: string[];
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
  sources: Record<"files" | "videos", { new: number; agent: number }>;
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

/** Разведка ролика: участки по классам агента, кадры включительно. */
export interface Scout {
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
}

export interface HumanShape {
  cls: string;
  color: string;
  type: "bbox" | "polygon" | string;
  geometry: { x?: number; y?: number; w?: number; h?: number; parts?: [number, number][][] };
}

export interface AgentPreview {
  image: { id: string; file_name: string; width: number; height: number };
  human: HumanShape[];
  /** Вход и выход каждого узла. */
  nodes: Record<string, { in: PreviewDet[]; out: PreviewDet[] }>;
  device: "cuda" | "cpu";
  /** Почему на процессоре: чем занята карта. */
  note: string | null;
  ms: number;
}

export const previewProjects = () =>
  get<{ projects: { code: string; name: string; images: number }[] }>("agents/preview/projects");

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
