export type DatasetKind = "uploaded" | "augmented";

export interface DatasetSummary {
  name: string;
  kind: DatasetKind;
  images: number;
  num_classes?: number | null;
  display_name?: string;
  source?: string;
  config_names?: string[];
}

export interface SplitStat {
  split: string;
  images: number;
  labeled: number;
  background: number;
  instances: number;
}

export interface ClassStat {
  id: number;
  name: string;
  instances: number;
  images: number;
}

export interface AppliedConfig {
  config_id: string;
  name: string;
  transforms: TransformInstance[];
}

export interface AugMeta {
  display_name: string;
  source: string;
  configs: AppliedConfig[];
  scope?: "all" | "train";
  images?: number;
}

export interface DatasetStats {
  name: string;
  nc: number;
  num_classes: number;
  total_images: number;
  total_label_files: number;
  total_instances: number;
  unknown_class_instances: number;
  splits: SplitStat[];
  classes: ClassStat[];
  warnings?: string[];
  meta?: AugMeta | null;
}

export type ParamType =
  | "bool"
  | "int"
  | "float"
  | "range"
  | "string"
  | "optional"
  | "json";

export interface ParamSchema {
  name: string;
  type: ParamType;
  required: boolean;
  default?: unknown;
  int?: boolean;
}

export interface TransformSchema {
  name: string;
  category: "pixel" | "spatial";
  params: ParamSchema[];
}

export interface TransformInstance {
  name: string;
  params: Record<string, unknown>;
}

export interface AugConfig {
  id: string;
  name: string;
  transforms: TransformInstance[];
  builtin?: boolean;
}

export interface PreviewResult {
  image: string;
  original: string;
  augmented: string;
}

export type AugScope = "all" | "train";

export interface Job<R = unknown> {
  id: string;
  type: string;
  status: "running" | "done" | "error";
  processed: number;
  total: number;
  message: string;
  phase?: string;
  result: R | null;
  error: string | null;
}

export interface Progress {
  label: string;
  pct: number | null; // null = indeterminate bar
  spinner?: boolean; // true = label-only status, no progress bar
}

export interface ModelVersion {
  id: string;
  name: string;
  spec: string;
  builtin: boolean;
}

export interface GpuDevice {
  index: number;
  name: string;
}

export interface DevicesInfo {
  available: boolean;
  cuda_available: boolean;
  gpus: GpuDevice[];
}

export interface EpochMetrics {
  epoch: number;
  [key: string]: number;
}

export interface TrainingSummary {
  id: string;
  status: "preparing" | "running" | "done" | "stopped" | "error";
  model_name: string;
  dataset_name: string;
  dataset_kind: DatasetKind;
  device: string;
  epochs: number;
  current_epoch: number;
  has_weights: boolean;
  created_at: number;
  error: string | null;
}

export interface TrainingRun extends TrainingSummary {
  model_id: string;
  params: Record<string, number | string | boolean>;
  metrics: EpochMetrics[];
  summary?: Record<string, number>;
  message?: string;
  weights_path?: string;
  // live per-iteration progress within the current epoch
  phase?: "train" | "val";
  current_batch?: number;
  total_batches?: number | null;
  batch_metrics?: Record<string, number>;
  batch_rate?: number;
  val_batch?: number;
  val_total?: number | null;
}

export interface TrainedModel {
  run_id: string;
  model_name: string;
  dataset_name: string;
  created_at: number;
}

export interface InferenceClassStat {
  id: number;
  name: string;
  count: number;
  avg_conf: number;
}

export interface InferenceStats {
  total_frames: number;
  processed_frames: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  total_detections: number;
  frames_with_detections: number;
  avg_detections_per_frame: number;
  device: string;
  per_class: InferenceClassStat[];
}

export interface VideoItem {
  id: string;
  name: string;
  ext: string;
  catalog: string;
  size: number;
  created_at: number;
}

export interface InferenceSummary {
  id: string;
  status: "processing" | "done" | "error";
  video_id?: string;
  catalog?: string;
  model_run_id: string;
  model_name: string;
  input_name: string;
  created_at: number;
  has_output: boolean;
  total_detections?: number;
  error: string | null;
}

export interface InferenceRun extends InferenceSummary {
  dataset_name?: string;
  total_frames: number;
  processed_frames: number;
  stats: InferenceStats | null;
  message?: string;
}
