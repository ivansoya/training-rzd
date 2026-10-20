// Загрузки в таски живут вне страницы: уход в другой раздел их не обрывает, вернувшийся снова видит ход.
// Файлы уходят по одному на всю вкладку: канал и так занят целиком, две партии разом только делили бы его.

import { useSyncExternalStore } from "react";

export interface Upload {
  /** Что передаётся сейчас; пусто — серия ждёт загрузку в другую таску. */
  name: string;
  pct: number;
  /** Сколько файлов текущей серии легло и сколько в ней всего. */
  done: number;
  total: number;
  error: string | null;
  /** Сколько файлов легло за жизнь вкладки — страница перечитывает таску на каждый. */
  landed: number;
}

export interface UploadItem<T> {
  name: string;
  send: (onPct: (pct: number) => void) => Promise<T>;
}

const byTask = new Map<string, Upload>();
const subs = new Set<() => void>();
let tail: Promise<unknown> = Promise.resolve();

function put(taskId: string, patch: Partial<Upload>) {
  const cur = byTask.get(taskId) ?? { name: "", pct: 0, done: 0, total: 0, error: null, landed: 0 };
  byTask.set(taskId, { ...cur, ...patch });
  subs.forEach((f) => f());
}

export const uploading = (u: Upload | null): u is Upload => !!u && u.done < u.total;

/** Поставить файлы в очередь. Отказ снимает остаток своей партии; его текст висит до «закрыть». */
export function enqueueUpload<T>(taskId: string, items: UploadItem<T>[]): Promise<T[]> {
  const cur = byTask.get(taskId) ?? null;
  put(taskId, uploading(cur)
    ? { total: cur.total + items.length }
    : { done: 0, total: items.length, error: null, name: "", pct: 0 });
  const run = tail.then(async () => {
    const out: T[] = [];
    try {
      for (const item of items) {
        put(taskId, { name: item.name, pct: 0 });
        out.push(await item.send((pct) => put(taskId, { pct })));
        const u = byTask.get(taskId)!;
        put(taskId, { done: u.done + 1, landed: u.landed + 1 });
      }
    } catch (e) {
      const u = byTask.get(taskId)!;
      put(taskId, { total: u.total - (items.length - out.length), error: (e as Error).message });
      throw e;
    }
    return out;
  });
  tail = run.catch(() => undefined);
  return run;
}

export const dismissUploadError = (taskId: string) => put(taskId, { error: null });

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};

export const uploadOf = (taskId: string): Upload | null => byTask.get(taskId) ?? null;

export function useUpload(taskId: string): Upload | null {
  return useSyncExternalStore(subscribe, () => uploadOf(taskId));
}

// Закрытие вкладки обрывает передачу молча — пока файлы в пути, браузер переспросит.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (![...byTask.values()].some(uploading)) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
