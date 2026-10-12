// Последний ответ экрана в localStorage: показать сразу, пока свежий в пути.
// Ключ — с пользователем: на общей машине чужие числа не всплывут.

const PREFIX = "mag.cache.";
// Форма ответов: сменилась — старый кеш не читаем (12.10.2026: исполнители списком и права таски)
const SHAPE = 2;

export interface Cached<T> { at: number; v: T }

export function cached<T>(key: string): Cached<T> | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    const got = raw ? (JSON.parse(raw) as Cached<T> & { s?: number }) : null;
    return got?.s === SHAPE ? got : null;
  } catch {
    return null;
  }
}

export function remember<T>(key: string, v: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), v, s: SHAPE }));
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
