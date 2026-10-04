// Загрузка архива живёт вне окна импорта: свёрнутое окно её не обрывает,
// открытое заново — подхватывает ход. После перезагрузки страницы помогает
// докачка: тот же файл, выбранный снова, продолжится с места обрыва.

import { useEffect, useState } from "react";
import { uploadArchive } from "../../auth/api";

export interface UploadRun {
  name: string;
  size: number;
  pct: number;
  /** Чем кончилось: id задачи разбора или текст ошибки. */
  done?: { job_id: string } | { error: string };
}

const runs = new Map<string, UploadRun>();
const listeners = new Map<string, Set<() => void>>();

function emit(code: string) {
  listeners.get(code)?.forEach((l) => l());
}

export function startUpload(code: string, file: File): Promise<{ job_id: string }> {
  const run: UploadRun = { name: file.name, size: file.size, pct: 0 };
  runs.set(code, run);
  emit(code);
  return uploadArchive(code, file, (pct) => {
    run.pct = pct;
    emit(code);
  }).then(
    (res) => { run.done = res; emit(code); return res; },
    (e) => { run.done = { error: (e as Error).message }; emit(code); throw e; },
  );
}

/** Забыть законченную загрузку: окно её уже отработало. */
export function clearUpload(code: string) {
  runs.delete(code);
  emit(code);
}

export function useUpload(code: string | undefined): UploadRun | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!code) return;
    const l = () => tick((n) => n + 1);
    const set = listeners.get(code) ?? new Set();
    set.add(l);
    listeners.set(code, set);
    return () => { set.delete(l); };
  }, [code]);
  return code ? runs.get(code) : undefined;
}
