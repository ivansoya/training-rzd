// Обучения: запуск, состояние, метрики по эпохам, веса.

import { del, get, post } from "./http";

export type RunStatus =
  | "queued"
  | "waiting_gpu"
  | "preparing"
  | "running"
  | "stopping"
  | "done"
  | "error"
  | "stopped";

export interface ModelRow {
  id: string;
  name: string;
  spec?: string;
  /** Описание сети для обучения с нуля; есть только у встроенных. */
  scratch?: string;
  task: "detect" | "segment";
  size?: string;
  note?: string;
  builtin: boolean;
  /** Встроенные и свои — всегда с весами; `cached` — веса уже на томе,
   *  иначе первый запуск начнёт со скачивания. */
  pretrained: boolean;
  cached: boolean;
}

/** Спецификация параметра обучения — та же, по которой сервер проверяет
 *  запрос. Форма не держит своих умолчаний. */
export interface ParamSpec {
  type: "int" | "float" | "str" | "bool";
  min?: number;
  max?: number;
  step?: number;
  default?: number | string | boolean | null;
  choices?: string[];
  group: "main" | "stop" | "optim" | "reg" | "misc" | "aug";
}

export type ParamValue = number | string | boolean;

export interface Run {
  id: string;
  name: string;
  status: RunStatus;
  queue_reason: string | null;
  task: "detect" | "segment";
  base_model: string;
  device: string;
  epochs: number;
  current_epoch: number;
  /** «weights» — качает предобученные веса на том перед первой эпохой. */
  phase: "train" | "val" | "weights" | null;
  current_batch: number;
  total_batches: number | null;
  val_batch: number;
  val_total: number | null;
  batch_metrics: Record<string, number> | null;
  best_epoch: number | null;
  best_fitness: number | null;
  peak_vram_mb: number | null;
  has_weights: boolean;
  weights_bytes: number | null;
  error: string | null;
  author: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  set: {
    id: string;
    name: string;
    kind: string;
    counts: Record<string, number> | null;
  } | null;
  params?: Record<string, unknown>;
  summary?: Record<string, number> | null;
  confusion?: { matrix: number[][]; names: string[] } | null;
  curves?: CurveSeries[] | null;
  per_class?: PerClass | null;
}

/** Метрика одного класса. `null` значит «измерить было нечем». */
export interface ClassMetric {
  class_index: number;
  name: string;
  instances: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  map50: number | null;
  map: number | null;
  measured: boolean;
}

export interface PerClass {
  rows: ClassMetric[];
  totals: {
    classes: number;
    measured: number;
    instances: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    map50: number | null;
    map: number | null;
  } | null;
  /** Номера классов с худшей mAP50 — за них браться первыми. */
  worst?: number[];
  /** Почему таблицы нет. Веса при этом посчитаны и скачиваются. */
  error?: string;
}

export interface CurveSeries {
  x: number[];
  y: number[][];
  x_label: string;
  y_label: string;
}

export interface EpochRow {
  epoch: number;
  metrics: Record<string, number>;
  seconds: number | null;
}

// Модели фильтруются по задаче набора: набор боксов и сегментационная модель —
// несовместимая пара, и выбрать её должно быть невозможно.
export const listModels = (task?: "detect" | "segment") =>
  get<{
    available: boolean;
    models: ModelRow[];
    params: Record<string, ParamSpec>;
    aug_defaults: Record<string, number>;
  }>(`models${task ? `?task=${task}` : ""}`);

export const listRuns = (code: string) =>
  get<{ runs: Run[]; role: string }>(`projects/${code}/runs`);

export const startRun = (
  code: string,
  body: {
    set_id: string;
    model?: string;
    name?: string;
    params?: Record<string, unknown>;
  }
) => post<Run>(`projects/${code}/runs`, body);

export const getRun = (code: string, id: string) =>
  get<Run>(`projects/${code}/runs/${id}`);

export const runEpochs = (code: string, id: string, since = 0) =>
  get<{ epochs: EpochRow[] }>(
    `projects/${code}/runs/${id}/epochs?since=${since}`
  );

export const stopRun = (code: string, id: string) =>
  post<{ ok: true; status: RunStatus }>(`projects/${code}/runs/${id}/stop`);

export const deleteRun = (code: string, id: string) =>
  del<{ ok: true }>(`projects/${code}/runs/${id}`);

export const weightsUrl = (code: string, id: string) =>
  `/api/projects/${code}/runs/${id}/weights`;
