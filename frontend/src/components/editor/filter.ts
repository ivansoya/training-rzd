// Фильтр классов в редакторах: что проходит — здесь, вид и память — ClassFilter.tsx.
// Храним снятые ключи, а не отмеченные: новый класс в таске виден сразу, без похода в фильтр.

export const classKey = (ci: number | null | undefined) => `c:${ci ?? -1}`;
/** Класс разведки, не сопоставленный с классом проекта, — у фильтра своей строкой. */
export const agentKey = (name: string) => `a:${name}`;

/** Кадр «Фокуса» проходит: фильтра нет или на кадре есть объект неснятого класса (рамки агента тоже).
 *  Кадр без объектов при включённом фильтре выпадает. */
export const frameShown = (boxes: { class_index: number }[] | undefined, off: Set<string>) =>
  off.size === 0 || (boxes ?? []).some((b) => !off.has(classKey(b.class_index)));

/** Кадр ролика с непроверенным агента: виден, если не снят хоть один его класс.
 *  Сводка без классов (старый сервер) — видна всегда. */
export const agentShown = (classes: number[] | undefined, off: Set<string>) =>
  off.size === 0 || !classes || classes.some((ci) => !off.has(classKey(ci)));

/** Сколько раз встретился каждый класс. */
export function countClasses(list: number[]): Map<number, number> {
  const m = new Map<number, number>();
  list.forEach((ci) => m.set(ci, (m.get(ci) ?? 0) + 1));
  return m;
}
