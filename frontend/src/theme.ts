/** Тема оформления: светлая, тёмная или как в системе.
 *
 * Состояния три, а не два. «Как в системе» ничего не ставит на корень —
 * тогда работает медиа-запрос `prefers-color-scheme`. Явный выбор ставит
 * `data-theme` и перебивает систему в обе стороны.
 *
 * Выбор хранится локально у человека, а не в профиле: это свойство рабочего
 * места (монитор, освещение, ночная смена), а не учётной записи.
 */
export type Theme = "system" | "light" | "dark";

const KEY = "magistral-theme";

export function readTheme(): Theme {
  const raw = localStorage.getItem(KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
    localStorage.removeItem(KEY);
  } else {
    root.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }
}

/** Ставится до первой отрисовки — иначе тёмная тема моргнёт светлым. */
export function applyStoredTheme(): void {
  const theme = readTheme();
  if (theme !== "system") document.documentElement.setAttribute("data-theme", theme);
}

/** Что показывать на экране сейчас — с учётом системной настройки. */
export function effectiveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
