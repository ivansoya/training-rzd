/** Ответ записи разметки: id и автор каждой присланной фигуры по порядку;
 *  null — фигуру сервер отбросил (промах, контур целиком за кадром). */
export type SavedShape = { id: string; source: "human" | "model"; pending?: boolean } | null;

/** Приклеить серверные id и авторство к тем же объектам фигур.
 *
 *  Сравнение по ссылке: фигура, которую поправили, пока шла запись, — уже
 *  другой объект, она остаётся без id и уйдёт следующей записью как новая.
 *  Без id сервер каждую запись считал бы рамку новой, и авторство терялось. */
export function withSavedIds<T extends { id?: string; source?: string; pending?: boolean }>(
  sent: readonly T[],
  saved: readonly SavedShape[] | undefined,
  current: readonly T[]
): T[] {
  if (!saved) return current as T[];
  const got = new Map<T, NonNullable<SavedShape>>();
  sent.forEach((b, i) => {
    const s = saved[i];
    if (s) got.set(b, s);
  });
  let changed = false;
  const out = current.map((b) => {
    const s = got.get(b);
    // Проверку решает сервер: клиент её только снимает, и отказ (откат правки) приходит отсюда.
    const pending = s?.pending ?? b.pending;
    if (!s || (b.id === s.id && b.source === s.source && !!b.pending === !!pending)) return b;
    changed = true;
    return { ...b, id: s.id, source: s.source, pending };
  });
  return changed ? out : (current as T[]);
}
