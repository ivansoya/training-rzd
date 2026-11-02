// Вопросы на странице таски (решения 29.10.2026): строка карточки «Вопросы» и куда ведёт ?q=<id>.
import type { TaskVideoItem } from "../../../auth/api";
import type { Question } from "../../../api/questions";
import { count } from "../../ru";
import { clock } from "../questions/questions";

/** Имя файла и время кадра порознь: сервер шлёт место одной строкой «имя.mp4, 0:23». */
export function placeParts(q: Pick<Question, "place" | "time_ms">): [string, string | null] {
  if (q.time_ms == null) return [q.place, null];
  const at = clock(q.time_ms);
  return [q.place.endsWith(`, ${at}`) ? q.place.slice(0, -at.length - 2) : q.place, at];
}

/** Первое сообщение — сам вопрос, ответы — остальные. */
export function repliesText(q: Pick<Question, "messages">): string {
  const n = Math.max(0, q.messages.length - 1);
  return n ? count(n, "ответ", "ответа", "ответов") : "нет ответов";
}

/** Куда открыть вопрос: кадр таски, готовый ролик на разметку — или некуда (ролик убран, ещё готовится). */
export function questionGo(q: Question | undefined, videos: TaskVideoItem[]): { image: string } | { video: TaskVideoItem } | null {
  if (q?.image_id) return { image: q.image_id };
  const v = q?.video_id ? videos.find((x) => x.id === q.video_id) : undefined;
  return v && v.mode === "annotate" && v.prepare?.ready ? { video: v } : null;
}
