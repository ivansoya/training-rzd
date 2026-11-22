import { getTaskEditorWindow } from "../../../auth/api";
import type { TaskEditorImage, TaskImage } from "../../../auth/api";

export const EDITOR_PAGE = 100;
const CACHE_SIZE = EDITOR_PAGE * 3;

export function summarizeFrame(image: TaskImage): TaskEditorImage {
  const { id, file_name, task_status, agent_empty, agent_question, human_edited, my_edited_at, annotations, tag_ids, boxes } = image;
  return { id, file_name, task_status, agent_empty, agent_question, human_edited, my_edited_at,
    annotations, tag_ids, class_indices: [...new Set(boxes.map((box) => box.class_index))],
    has_pending: boxes.some((box) => box.pending) };
}

export function frameWindows(taskId: string, seed: TaskImage[], changed: () => void) {
  const rows = new Map(seed.map((image) => [image.id, image]));
  const session = new AbortController();
  const pending = new Map<string, { signal: AbortSignal; request: Promise<void> }>();
  let scrollRequest: AbortController | undefined;

  function store(image: TaskImage) {
    rows.delete(image.id);
    rows.set(image.id, image);
    while (rows.size > CACHE_SIZE) rows.delete(rows.keys().next().value!);
  }

  function load(ids: string[], scroll = false): Promise<void> {
    if (session.signal.aborted) return Promise.resolve();
    const missing = ids.filter((id) => !rows.has(id));
    if (!missing.length) {
      if (scroll) scrollRequest?.abort();
      return Promise.resolve();
    }
    const controller = scroll ? new AbortController() : session;
    const key = `${scroll ? 'scroll' : 'jump'}:${missing.join(',')}`;
    const existing = pending.get(key);
    if (existing && !existing.signal.aborted) return existing.request;
    if (scroll) {
      scrollRequest?.abort();
      scrollRequest = controller;
    }
    const request = getTaskEditorWindow(taskId, missing, controller.signal).then((images) => {
      if (controller.signal.aborted || session.signal.aborted) return;
      for (const image of images) if (!rows.has(image.id)) store(image);
      changed();
    }).catch((error) => {
      if (!controller.signal.aborted && !session.signal.aborted) throw error;
    }).finally(() => { if (pending.get(key)?.request === request) pending.delete(key); });
    pending.set(key, { signal: controller.signal, request });
    return request;
  }

  return { signal: session.signal, load, store, get: (id: string) => rows.get(id), close: () => {
    session.abort();
    scrollRequest?.abort();
  } };
}
