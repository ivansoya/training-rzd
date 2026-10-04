/** Числа в подписях. Согласование слова с числом жило в ProjectsPage и
 *  применялось через раз: на экранах стояло «2 тасок», «1 изображений»,
 *  «3 классов». Теперь подпись с числом собирается одним вызовом `count`,
 *  и забыть согласование труднее, чем вставить его. */

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Целое с разрядами по-русски: «29 150», а не «29150». */
export const ru = (n: number) => Math.round(n).toLocaleString("ru-RU");

/** «3 задачи», «21 кадр», «1 180 кадров». */
export const count = (n: number, one: string, few: string, many: string) =>
  `${ru(n)} ${plural(Math.round(n), one, few, many)}`;

/** Давность события: «только что», «12 минут назад», «вчера», «5 авг». */
export function ago(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const secs = Math.max(0, Math.round((now - at.getTime()) / 1000));
  if (secs < 60) return "только что";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${count(mins, "минуту", "минуты", "минут")} назад`;
  const hours = Math.round(mins / 60);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at.getTime() >= today.getTime()) return `${count(hours, "час", "часа", "часов")} назад`;
  if (at.getTime() >= today.getTime() - 86_400_000) return "вчера";
  const sameYear = at.getFullYear() === today.getFullYear();
  return at.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })
    .replace(".", "");
}
