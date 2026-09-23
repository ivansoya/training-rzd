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
  stats: { boxes?: number; frames?: number };
  error: string | null;
  queue_reason: string | null;
  agent: string | null;
  version: number | null;
  sources: string[];
  created_at: string;
  finished_at: string | null;
}

export interface RunContext {
  agents: { id: string; name: string; head: string; versions: AgentVersion[] }[];
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
    sources: string[];
    mapping: Record<string, string | null>;
  }
) => post<RunView>(`agents/tasks/${taskId}/runs`, body);

export const stopRun = (runId: string) => post<RunView>(`agents/runs/${runId}/stop`);

export const ACTIVE: RunView["status"][] = ["queued", "waiting_gpu", "running"];
