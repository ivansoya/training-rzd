import type {
  AugConfig,
  AugScope,
  DatasetKind,
  DatasetStats,
  DatasetSummary,
  DevicesInfo,
  InferenceRun,
  InferenceSummary,
  Job,
  ModelVersion,
  PreviewResult,
  StorageInfo,
  TrainedModel,
  TrainingRun,
  TrainingSummary,
  TransformInstance,
  TransformSchema,
  VideoItem,
} from "./types";

const BASE = "/api";

async function asJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data as T;
}

// Thrown by pollJob when a job ends because the user cancelled it, so callers
// can distinguish a deliberate stop from a real failure.
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}

// --- jobs ---
export async function getJob<R = unknown>(id: string): Promise<Job<R>> {
  return asJson(await fetch(`${BASE}/jobs/${id}`));
}

export async function pollJob<R = unknown>(
  id: string,
  onProgress: (job: Job<R>) => void,
  intervalMs = 400
): Promise<R> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await getJob<R>(id);
    onProgress(job);
    if (job.status === "done") return job.result as R;
    if (job.status === "cancelled") throw new JobCancelledError();
    if (job.status === "error") throw new Error(job.error || "job failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --- datasets ---
export async function listDatasets(): Promise<DatasetSummary[]> {
  return asJson(await fetch(`${BASE}/datasets`));
}

export async function getStorage(): Promise<StorageInfo> {
  return asJson(await fetch(`${BASE}/storage`));
}

export async function getDataset(
  kind: DatasetKind,
  name: string
): Promise<DatasetStats> {
  return asJson(await fetch(`${BASE}/datasets/${kind}/${encodeURIComponent(name)}`));
}

// Upload via XHR so we can report transfer progress; returns a job id to poll
// for unpack progress.
export function uploadDataset(
  file: File,
  name: string,
  onUploadProgress: (pct: number) => void
): Promise<{ job_id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/datasets`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { job_id?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.job_id) {
        resolve({ job_id: data.job_id });
      } else {
        reject(new Error(data.error || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Failed to fetch"));
    const form = new FormData();
    form.append("file", file);
    if (name) form.append("name", name);
    xhr.send(form);
  });
}

export async function deleteDataset(kind: DatasetKind, name: string): Promise<void> {
  await asJson(
    await fetch(`${BASE}/datasets/${kind}/${encodeURIComponent(name)}`, {
      method: "DELETE",
    })
  );
}

export async function renameDataset(
  kind: DatasetKind,
  name: string,
  displayName: string
): Promise<void> {
  await asJson(
    await fetch(`${BASE}/datasets/${kind}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    })
  );
}

export async function createAugmented(
  source: string,
  configIds: string[],
  displayName: string,
  scope: AugScope
): Promise<{ job_id: string }> {
  return asJson(
    await fetch(`${BASE}/aug/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        config_ids: configIds,
        display_name: displayName,
        scope,
      }),
    })
  );
}

export async function cancelAugment(jobId: string): Promise<void> {
  await asJson(
    await fetch(`${BASE}/aug/generate/${jobId}/cancel`, { method: "POST" })
  );
}

export async function clearAugmented(): Promise<{ removed: number }> {
  return asJson(await fetch(`${BASE}/aug/clear`, { method: "POST" }));
}

// --- augmentation configs ---
export async function listTransforms(): Promise<{
  available: boolean;
  transforms: TransformSchema[];
}> {
  return asJson(await fetch(`${BASE}/aug/transforms`));
}

export async function listConfigs(): Promise<AugConfig[]> {
  return asJson(await fetch(`${BASE}/aug/configs`));
}

export async function createConfig(
  name: string,
  transforms: TransformInstance[]
): Promise<AugConfig> {
  return asJson(
    await fetch(`${BASE}/aug/configs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, transforms }),
    })
  );
}

export async function updateConfig(
  id: string,
  name: string,
  transforms: TransformInstance[]
): Promise<AugConfig> {
  return asJson(
    await fetch(`${BASE}/aug/configs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, transforms }),
    })
  );
}

export async function deleteConfig(id: string): Promise<void> {
  await asJson(await fetch(`${BASE}/aug/configs/${id}`, { method: "DELETE" }));
}

export async function previewConfig(
  source: string,
  transforms: TransformInstance[],
  seed?: number
): Promise<PreviewResult> {
  return asJson(
    await fetch(`${BASE}/aug/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, transforms, seed }),
    })
  );
}

// --- models ---
export async function listModels(): Promise<{
  available: boolean;
  models: ModelVersion[];
}> {
  return asJson(await fetch(`${BASE}/models`));
}

export async function addModel(file: File, name: string): Promise<ModelVersion> {
  const form = new FormData();
  form.append("file", file);
  if (name) form.append("name", name);
  return asJson(await fetch(`${BASE}/models`, { method: "POST", body: form }));
}

export async function deleteModel(id: string): Promise<void> {
  await asJson(await fetch(`${BASE}/models/${id}`, { method: "DELETE" }));
}

// --- trainings ---
export async function listDevices(): Promise<DevicesInfo> {
  return asJson(await fetch(`${BASE}/devices`));
}

export async function listTrainings(): Promise<TrainingSummary[]> {
  return asJson(await fetch(`${BASE}/trainings`));
}

export async function getTraining(id: string): Promise<TrainingRun> {
  return asJson(await fetch(`${BASE}/trainings/${id}`));
}

export async function startTraining(body: {
  dataset_kind: DatasetKind;
  dataset_name: string;
  model_id: string;
  device: string;
  params: Record<string, number | string | boolean>;
}): Promise<{ id: string }> {
  return asJson(
    await fetch(`${BASE}/trainings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// Subscribe to live training updates over Server-Sent Events. The server pushes
// state (epoch + per-batch progress) as soon as it changes — no polling. Returns
// a function that closes the stream.
export function streamTraining(
  id: string,
  onState: (run: TrainingRun) => void,
  onEnd?: () => void
): () => void {
  const es = new EventSource(`${BASE}/trainings/${id}/stream`);
  es.addEventListener("state", (e) => {
    try {
      onState(JSON.parse((e as MessageEvent).data) as TrainingRun);
    } catch {
      /* ignore malformed frame */
    }
  });
  es.addEventListener("end", () => {
    es.close();
    onEnd?.();
  });
  return () => es.close();
}

export async function renameTraining(
  id: string,
  displayName: string
): Promise<void> {
  await asJson(
    await fetch(`${BASE}/trainings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    })
  );
}

export async function stopTraining(id: string): Promise<void> {
  await asJson(await fetch(`${BASE}/trainings/${id}/stop`, { method: "POST" }));
}

export async function deleteTraining(id: string): Promise<void> {
  await asJson(await fetch(`${BASE}/trainings/${id}`, { method: "DELETE" }));
}

export async function deleteTrainingWeights(id: string): Promise<void> {
  await asJson(
    await fetch(`${BASE}/trainings/${id}/weights`, { method: "DELETE" })
  );
}

export function weightsUrl(id: string): string {
  return `${BASE}/trainings/${id}/weights`;
}

// --- video library ---
export async function listVideos(): Promise<VideoItem[]> {
  return asJson(await fetch(`${BASE}/videos`));
}

export async function listCatalogs(): Promise<string[]> {
  return asJson(await fetch(`${BASE}/videos/catalogs`));
}

// Upload a video into a catalog. Works regardless of whether any model exists.
export function uploadVideo(
  file: File,
  catalog: string,
  onUploadProgress: (pct: number) => void
): Promise<VideoItem> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/videos`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: VideoItem & { error?: string } = {} as VideoItem;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.id) {
        resolve(data);
      } else {
        reject(new Error(data.error || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Failed to fetch"));
    const form = new FormData();
    form.append("file", file);
    if (catalog) form.append("catalog", catalog);
    xhr.send(form);
  });
}

export async function deleteVideo(id: string): Promise<void> {
  await asJson(await fetch(`${BASE}/videos/${id}`, { method: "DELETE" }));
}

export function videoFileUrl(id: string): string {
  return `${BASE}/videos/${id}/file`;
}

export function videoThumbUrl(id: string): string {
  return `${BASE}/videos/${id}/thumb`;
}

// --- inference ---
export async function listInferenceModels(): Promise<{
  available: boolean;
  models: TrainedModel[];
}> {
  return asJson(await fetch(`${BASE}/inference/models`));
}

export async function listInferences(
  videoId?: string
): Promise<InferenceSummary[]> {
  const q = videoId ? `?video_id=${encodeURIComponent(videoId)}` : "";
  return asJson(await fetch(`${BASE}/inference${q}`));
}

export async function getInference(id: string): Promise<InferenceRun> {
  return asJson(await fetch(`${BASE}/inference/${id}`));
}

// Run a model over a library video (the video is already on the server).
export async function startInference(body: {
  video_id: string;
  model_run_id: string;
}): Promise<{ id: string }> {
  return asJson(
    await fetch(`${BASE}/inference`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

export async function deleteInference(id: string): Promise<void> {
  await asJson(await fetch(`${BASE}/inference/${id}`, { method: "DELETE" }));
}

export function inferenceVideoUrl(id: string): string {
  return `${BASE}/inference/${id}/video`;
}
