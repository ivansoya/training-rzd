// Последний ответ экрана в localStorage: показать сразу, пока свежий в пути.
// Ключ — с пользователем: на общей машине чужие числа не всплывут.

const PREFIX = "mag.cache.";

export interface Cached<T> { at: number; v: T }

export function cached<T>(key: string): Cached<T> | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Cached<T>) : null;
  } catch {
    return null;
  }
}

export function remember<T>(key: string, v: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), v }));
  } catch {
    // Хранилище полное или закрыто — живём без кеша
  }
}

/** Выход из учётки: прошлые числа не должны достаться следующему. */
export function forgetAll(): void {
  try {
    Object.keys(window.localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // нечего чистить
  }
}

/** «на 10:42» — когда сняты показанные из кеша числа. */
export const cacheTime = (at: number) => new Date(at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
