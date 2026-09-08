// Фоновая задача на сервере и ожидание её конца.
//
// Всё, что осталось от api.ts старого приложения: им живут мастер импорта,
// окно выгрузки, страница таски и нарезка ролика. Остальное уехало вместе
// с /tools.

const BASE = "/api";

export interface Job<R = unknown> {
  id: string;
  type: string;
  status: "running" | "done" | "error" | "cancelled";
  processed: number;
  total: number;
  message: string;
  phase?: string;
  result: R | null;
  error: string | null;
}

export async function asJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data as T;
}

// Бросается, когда задача кончилась потому, что её сняли: вызывающий отличает
// осознанную остановку от настоящего сбоя.
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}

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
