// Логика экрана «Классы» без React: отбор, доля val, клавиша редактора.

import type { LabelClass } from "../../../auth/api";

/** Отбор по группе: все, без группы или id группы. */
export type GroupFilter = "all" | "none" | string;

/** Меньше этой доли боксов в val класс почти не проверяется на валидации. */
export const VAL_LOW = 0.12;

/** Доля боксов класса в val среди train и val; null — класса нет ни там, ни там. */
export function valShare(c: LabelClass): number | null {
  if (!c.split) return null;
  const n = c.split.train + c.split.val;
  return n ? c.split.val / n : null;
}

/** Клавиша класса в редакторе: 1–9 по порядку номеров, десятый и дальше — только поиском. */
export function hotkey(classes: LabelClass[], id: string): number | null {
  const i = [...classes].sort((a, b) => a.class_index - b.class_index).findIndex((c) => c.id === id);
  return i >= 0 && i < 9 ? i + 1 : null;
}

export const indexLabel = (i: number) => `#${String(i).padStart(2, "0")}`;

/** Поиск по имени, номеру и группе плюс отбор по группе. */
export function matchClasses(classes: LabelClass[], query: string, group: GroupFilter): LabelClass[] {
  const q = query.trim().toLocaleLowerCase("ru");
  return classes.filter((c) => {
    if (group === "none" ? c.superclass_id : group !== "all" && c.superclass_id !== group) return false;
    if (!q) return true;
    const hay = [c.name, String(c.class_index), indexLabel(c.class_index), c.superclass_name ?? "без группы"];
    return hay.join(" ").toLocaleLowerCase("ru").includes(q);
  });
}
