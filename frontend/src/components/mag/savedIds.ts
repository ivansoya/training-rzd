/** Ответ записи разметки: id и автор каждой присланной фигуры по порядку;
 *  null — фигуру сервер отбросил (промах, контур целиком за кадром). */
export type SavedShape = { id: string; source: "human" | "model" } | null;

/** Приклеить серверные id и авторство к тем же объектам фигур.
 *
 *  Сравнение по ссылке: фигура, которую поправили, пока шла запись, — уже
 *  другой объект, она остаётся без id и уйдёт следующей записью как новая.
 *  Без id сервер каждую запись считал бы рамку новой, и авторство терялось. */
export function withSavedIds<T extends { id?: string; source?: string }>(
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
    if (!s || (b.id === s.id && b.source === s.source)) return b;
    changed = true;
    return { ...b, id: s.id, source: s.source };
  });
  return changed ? out : (current as T[]);
}
