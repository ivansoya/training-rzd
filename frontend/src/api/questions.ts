// Вопросы в разметке (решения 29.10.2026): обсуждение спорного места таски.
// Место — изображение таски или кадр ролика, объект на нём — по желанию.

import { get, post, patch, del } from "./http";

export interface QuestionMessage {
  id: string;
  text: string;
  author: string | null;
  author_id: string | null;
  at: string;
  edited: boolean;
  can_edit: boolean;
}

export type ObjectKind = "ann" | "track" | "box";

export interface Question {
  id: string;
  status: "open" | "resolved";
  /** Место текстом: имя изображения или «ролик.mp4, 0:23» — помнится и после удаления ролика. */
  place: string;
  image_id: string | null;
  video_id: string | null;
  frame_no: number | null;
  time_ms: number | null;
  object_id: string | null;
  object_kind: ObjectKind | null;
  object_gone: boolean;
  class: { id: string; name: string; color: string | null } | null;
  author: string | null;
  author_id: string | null;
  created_at: string;
  last_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  can_settle: boolean;
  /** Первое — сам вопрос. */
  messages: QuestionMessage[];
}

export interface QuestionList { questions: Question[]; can_ask: boolean }

/** Куда вопрос: изображение или кадр ролика; объект — по желанию. */
export type QuestionPlace =
  | { image_id: string; object_id?: string; object_kind?: "ann" }
  | { video_id: string; frame_no: number; object_id?: string; object_kind?: "track" | "box" };

export interface InboxItem {
  question_id: string;
  kind: "new" | "reply";
  at: string;
  task: { id: string; name: string; project_code: string };
  place: string;
  image_id: string | null;
  video_id: string | null;
  frame_no: number | null;
  text: string | null;
  author: string | null;
}

const base = (taskId: string) => `tasks/${taskId}/questions`;

export const listQuestions = (taskId: string) => get<QuestionList>(base(taskId));
export const askQuestion = (taskId: string, where: QuestionPlace, text: string) =>
  post<Question>(base(taskId), { ...where, text });
export const replyQuestion = (taskId: string, id: string, text: string) =>
  post<Question>(`${base(taskId)}/${id}/messages`, { text });
export const editMessage = (taskId: string, id: string, mid: string, text: string) =>
  patch<Question>(`${base(taskId)}/${id}/messages/${mid}`, { text });
export const deleteMessage = (taskId: string, id: string, mid: string) =>
  del<Question>(`${base(taskId)}/${id}/messages/${mid}`);
export const resolveQuestion = (taskId: string, id: string) => post<Question>(`${base(taskId)}/${id}/resolve`);
export const reopenQuestion = (taskId: string, id: string) => post<Question>(`${base(taskId)}/${id}/reopen`);
export const dropQuestion = (taskId: string, id: string) => del<{ ok: true }>(`${base(taskId)}/${id}`);
/** Обсуждение открыли — из колокольчика уходит. */
export const readQuestion = (taskId: string, id: string) => post<{ ok: true }>(`${base(taskId)}/${id}/read`);
export const questionInbox = () => get<{ items: InboxItem[]; total: number }>("tasks/questions-inbox");
