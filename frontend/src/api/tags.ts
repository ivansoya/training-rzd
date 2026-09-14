// Таги: метки происхождения кадров и роликов.
//
// Таг отвечает не «что на кадре» — на это отвечает класс, — а «в каких
// условиях он снят»: ночь, дождь, тоннель. По ним потом собирают обучающий
// набор, в котором ночные кадры идут через свою цепочку аугментаций.

import { get, post, patch, del, put } from "./http";

export interface Tag {
  id: string;
  name: string;
  /** Сколько кадров носит таг. Приходит только из справочника проекта. */
  images?: number;
}

export interface TagUsage {
  images: number;
  videos: number;
  in_datasets: number;
}

export function listTags(code: string) {
  return get<{ tags: Tag[]; can_edit: boolean }>(
    `projects/${encodeURIComponent(code)}/tags`
  );
}

/** Завести таг. Уже существующий с тем же именем возвращается как есть —
 *  чип-пикер создаёт таги по ходу разметки, и «уже есть» здесь не ошибка. */
export function createTag(code: string, name: string) {
  return post<Tag>(`projects/${encodeURIComponent(code)}/tags`, { name });
}

export function renameTag(code: string, id: string, name: string) {
  return patch<Tag>(
    `projects/${encodeURIComponent(code)}/tags/${id}`, { name }
  );
}

export function tagUsage(code: string, id: string) {
  return get<TagUsage>(`projects/${encodeURIComponent(code)}/tags/${id}/usage`);
}

/** Удаление тага. Без `confirm` сервер отвечает 409 и говорит, с какого числа
 *  кадров таг снимется: набор, собранный по нему, после этого станет пустым. */
export function deleteTag(code: string, id: string, confirm = false) {
  return del<TagUsage & { ok: true }>(
    `projects/${encodeURIComponent(code)}/tags/${id}${confirm ? "?confirm=1" : ""}`
  );
}

/** Таги одного кадра. Только через таску и только этому кадру: массовая
 *  правка после приёмки слишком легко переписывает чужую работу. */
export function setImageTags(imageId: string, tagIds: string[]) {
  return put<{ tags: string[] }>(`images/${imageId}/tags`, { tags: tagIds });
}

/** Таги ролика. Достаются каждому кадру, нарезанному ПОСЛЕ правки: таг кадра
 *  это снимок, а не ссылка на ролик. */
export function setVideoTags(taskId: string, videoId: string, tagIds: string[]) {
  return put<{ tags: string[] }>(
    `tasks/${taskId}/videos/${videoId}/tags`, { tags: tagIds }
  );
}
