// Вопросы в разметке (решения 29.10.2026): чистая часть — счёт, места, отбор для экранов.
import type { Question } from "../../../api/questions";
import { count } from "../../ru";

export const open = (list: Question[]) => list.filter((q) => q.status === "open");

/** «3 вопроса» — значок доски и строк роликов. */
export const questionsWord = (n: number) => count(n, "вопрос", "вопроса", "вопросов");

/** Ключ места: изображение или кадр ролика. Два вопроса на одном кадре держат один кадр. */
export const placeKey = (q: Pick<Question, "image_id" | "video_id" | "frame_no">) =>
  q.image_id ? `i:${q.image_id}` : `v:${q.video_id}:${q.frame_no}`;

/** Сколько кадров держат открытые вопросы — строка под «Готово». */
export const heldPlaces = (list: Question[]) => new Set(open(list).map(placeKey)).size;

/** Открытые вопросы по роликам — значок у строки ролика. */
export function openByVideo(list: Question[]): Map<string, number> {
  const by = new Map<string, number>();
  for (const q of open(list)) if (q.video_id) by.set(q.video_id, (by.get(q.video_id) ?? 0) + 1);
  return by;
}

/** Вопросы одного изображения или кадра ролика: открытые сверху, внутри — по времени. */
export function atPlace(list: Question[], where: { image_id: string } | { video_id: string; frame_no: number }) {
  const hit = "image_id" in where
    ? list.filter((q) => q.image_id === where.image_id)
    : list.filter((q) => q.video_id === where.video_id && q.frame_no === where.frame_no);
  return hit.sort((a, b) => (a.status === b.status ? a.created_at.localeCompare(b.created_at) : a.status === "open" ? -1 : 1));
}

/** Объекты с открытым вопросом на месте — пузырёк на холсте. */
export const askedObjects = (list: Question[]) =>
  new Set(open(list).flatMap((q) => (q.object_id && !q.object_gone ? [q.object_id] : [])));

/** Соседнее место с открытым вопросом по порядку ленты — Alt+[ и Alt+]. `order` — ключи мест в порядке ленты. */
export function nextAsked(list: Question[], order: string[], current: string, dir: 1 | -1): string | null {
  const asked = new Set(open(list).map(placeKey));
  const at = order.indexOf(current);
  for (let i = at + dir; i >= 0 && i < order.length; i += dir) if (asked.has(order[i])) return order[i];
  return null;
}

/** 0:23, 1:02:05 — время кадра ролика, как на шкале. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** Первая строка вопроса — строка списка на странице таски. */
export const firstLine = (q: Question) => (q.messages[0]?.text ?? "").split("\n")[0];
