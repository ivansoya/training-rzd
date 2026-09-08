// Обучающие наборы: предпросмотр по шагам мастера и сама сборка.

import { del, get, post } from "./http";

export type SplitMode = "manual" | "random" | "balanced" | "smart";
export type AnnKind = "bbox" | "polygon";

export interface SetSpec {
  datasets: string[];
  classes: string[];
  ann_type: AnnKind;
  split_mode: SplitMode;
  val_ratio: number;
  seed?: number;
  min_visibility?: number;
  graph_version_id?: string | null;
  val_graph_version_id?: string | null;
}

export interface ClassRow {
  export_id: number;
  name: string;
  train: number;
  val: number;
  annotations: number;
}

export interface Preview {
  images: number;
  train: number;
  val: number;
  val_ratio: number;
  /** Разметка выбранных классов есть, но не того рода — в набор не идут. */
  dropped: number;
  /** Кадры без разметки: идут в набор фоном, с пустым файлом. */
  background: number;
  no_size: number;
  wrong_kind: number;
  classes: ClassRow[];
  groups: number | null;
  /** Куда легли кадры-фон: они делятся вместе со всеми, и это тоже итог. */
  background_split: { train: number; val: number };
  /** Сколько миллисекунд считалось деление — для подписи, пока ждём. */
  split_ms: number;
  embeddings: {
    ready: number;
    total: number;
    missing: number;
    job: JobRow | null;
    // Последний отказ счёта, пока признаков всё ещё не хватает.
    failure: { error: string | null; at: string | null } | null;
  } | null;
  warnings: string[];
}

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  processed: number;
  total: number;
  stage: string | null;
  stage_text: string | null;
  target_id?: string;
}

export interface TrainSet {
  id: string;
  name: string;
  kind: AnnKind;
  /** «deleting» ставится сервером до начала уборки: строка честно висит в
   *  списке, пока воркер убирает файлы, и пропадает вместе с записью. */
  status: "draft" | "queued" | "building" | "ready" | "error" | "deleting";
  split_mode: SplitMode;
  val_ratio: number;
  seed: number;
  counts: {
    samples: number;
    train: number;
    val: number;
    annotations: number;
    /** Кадров-фона (без разметки). У наборов до 08.09.2026 поля нет. */
    background?: number;
    source_images: number;
    classes: number;
    warnings: number;
  } | null;
  size_bytes: number;
  hardlinked_bytes: number;
  graph: { id: string; name: string; version: number; version_id: string } | null;
  built_at: string | null;
  created_at: string;
  error: string | null;
  job: JobRow | null;
}

export const preview = (code: string, spec: Partial<SetSpec>) =>
  post<Preview>(`projects/${code}/trainsets/preview`, spec);

// Признаки считает видеокарта, а заказывает их подготовка данных. Мастер
// показывает полосу и не даёт собирать, пока счёт не кончился.
export const startEmbed = (
  code: string,
  spec: Partial<SetSpec> & { force?: boolean }
) =>
  post<{ ok: boolean; missing: number; job_id?: string }>(
    `projects/${code}/trainsets/embed`,
    spec
  );

export const listSets = (code: string) =>
  get<{ sets: TrainSet[]; role: string }>(`projects/${code}/trainsets`);

export const createSet = (
  code: string,
  spec: Partial<SetSpec> & { name: string }
) => post<TrainSet>(`projects/${code}/trainsets`, spec);

export const getSet = (code: string, id: string) =>
  get<TrainSet>(`projects/${code}/trainsets/${id}`);

// Ответ — тот же набор, уже в состоянии «deleting»: удаление идёт на
// сервере, строка пропадёт из списка, когда уборка закончится.
export const deleteSet = (code: string, id: string) =>
  del<TrainSet>(`projects/${code}/trainsets/${id}`);

export const listJobs = (code: string) =>
  get<{ jobs: JobRow[] }>(`projects/${code}/dataprep/jobs`);


// --------------------------------------------------------------------------- #
// Просмотр собранного набора
// --------------------------------------------------------------------------- #
export interface SetClass {
  export_id: number;
  name: string;
  color: string;
  train: number;
  val: number;
  annotations: number;
}

export interface Sample {
  file: string;
  name: string;
  split: string;
  objects: number;
  image_id: string;
  /** Размер образца в пикселях. `null` — файл не прочитался. */
  width: number | null;
  height: number | null;
  hardlink: boolean;
  /** Путь образца по графу: пусто у кадра, прошедшего мимо аугментаций. */
  sid: string;
  ops: string[];
  boxes: import("../auth/api").Box[];
}

export interface SamplesPage {
  set: TrainSet;
  classes: SetClass[];
  warnings: string[];
  total: number;
  matched: number;
  samples: Sample[];
  role: string;
}

export interface SamplesQuery {
  split?: string;
  classes?: number[];
  empty?: boolean;
  limit?: number;
  offset?: number;
}

export const samples = (code: string, setId: string, q: SamplesQuery = {}) => {
  const p = new URLSearchParams();
  if (q.split) p.set("split", q.split);
  if (q.classes?.length) p.set("classes", q.classes.join(","));
  if (q.empty) p.set("empty", "1");
  if (q.limit) p.set("limit", String(q.limit));
  if (q.offset) p.set("offset", String(q.offset));
  const suffix = p.toString();
  return get<SamplesPage>(
    `projects/${code}/trainsets/${setId}/samples${suffix ? `?${suffix}` : ""}`
  );
};

/** Файл из папки набора. Путь тот же, что в манифесте. */
export const sampleUrl = (code: string, setId: string, path: string) =>
  `/api/projects/${encodeURIComponent(code)}/trainsets/${setId}/file?path=${encodeURIComponent(path)}`;
