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
