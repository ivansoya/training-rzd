// Кадры всего проекта разом — с пометкой, из какого они датасета.

import { get, post } from "./http";
import type { ImageTaskStatus, TaskBox, TaskImage } from "../auth/api";

/** Таска, держащая живую копию кадра: исходник только для чтения (решения 14.10.2026). */
export interface HeldBy {
  task_id: string;
  name: string;
}

export interface ProjectImage {
  id: string;
  file_name: string;
  split: string;
  task_status: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  annotations: number;
  /** В виде редактора: автор, агент, проверка — «Фокус» датасета их подписывает. */
  boxes: TaskBox[];
  dataset_id: string;
  dataset_name: string;
  /** Имена тагов — подпись; id — для правки в «Фокусе». */
  tags: string[];
  tag_ids?: string[];
  rev?: number;
  held?: HeldBy | null;
  /** Таска, из которой кадр пришёл; у кадров архива её нет. */
  origin_task?: { id: string; name: string; status: string } | null;
}

/** Сводка отбора: кадры по группам и рамки по классам. */
export interface ImagesSummary {
  by_dataset: Record<string, number>;
  by_split: Record<string, number>;
  /** Ключ — номер класса. */
  boxes_by_class: Record<string, number>;
}

export interface ProjectImages {
  datasets: { id: string; name: string; identifier: string; images: number }[];
  splits: Record<string, number>;
  total: number;
  matched: number;
  summary: ImagesSummary | null;
  my_role: string;
  images: ProjectImage[];
}

export interface ImagesQuery {
  datasets?: string[];
  classes?: number[];
  split?: string;
  empty?: boolean;
  sort?: "name" | "objects";
  /** Подстрока имени файла. */
  q?: string;
  /** id тагов: нужен каждый. */
  tags?: string[];
  /** id тагов: ни одного. */
  notags?: string[];
  /** Один кадр по id — ссылка на кадр. */
  image?: string;
  /** «На проверке»: непроверенное агента, позванного в датасете. */
  pending?: boolean;
  summary?: boolean;
  limit?: number;
  offset?: number;
}

export function imagesQuery(q: ImagesQuery): string {
  const p = new URLSearchParams();
  if (q.datasets?.length) p.set("datasets", q.datasets.join(","));
  if (q.classes?.length) p.set("classes", q.classes.join(","));
  if (q.split) p.set("split", q.split);
  if (q.empty) p.set("empty", "1");
  if (q.sort) p.set("sort", q.sort);
  if (q.q?.trim()) p.set("q", q.q.trim());
  if (q.tags?.length) p.set("tags", q.tags.join(","));
  if (q.notags?.length) p.set("notags", q.notags.join(","));
  if (q.image) p.set("image", q.image);
  if (q.pending) p.set("pending", "1");
  if (q.summary) p.set("summary", "1");
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  if (q.offset) p.set("offset", String(q.offset));
  return p.toString();
}

export const projectImages = (code: string, q: ImagesQuery = {}) => {
  const suffix = imagesQuery(q);
  return get<ProjectImages>(
    `projects/${encodeURIComponent(code)}/images${suffix ? `?${suffix}` : ""}`
  );
};

/** Только id кадров отбора — выбрать группу целиком или отдать весь отбор в таску. */
export const projectImageIds = (code: string, q: ImagesQuery = {}, free = false) => {
  const suffix = imagesQuery({ ...q, limit: undefined, offset: undefined, summary: false });
  // free — без кадров с живой копией в таске: выбрать их нельзя
  return get<{ ids: string[]; matched: number }>(
    `projects/${encodeURIComponent(code)}/images?ids_only=1${free ? "&free=1" : ""}${suffix ? `&${suffix}` : ""}`
  );
};

/** Что уйдёт в таску копиями: по датасетам и сколько пропустим из-за живых копий. */
export interface TakePreview {
  take: number;
  by_dataset: { id: string; name: string; n: number }[];
  busy: { task_id: string; name: string; n: number }[];
}

export const takePreview = (code: string, ids: string[]) =>
  post<TakePreview>(`projects/${encodeURIComponent(code)}/images/take`, { image_ids: ids });

/** Пополнить открытую таску копиями кадров датасета. */
export const takeIntoTask = (taskId: string, ids: string[]) =>
  post<{ added: number; busy: TakePreview["busy"] }>(`tasks/${taskId}/from-dataset`, { image_ids: ids });

/** Кадр галереи в виде кадра редактора: «Фокус» датасета работает с тем же, что в таске. */
export function asFrame(p: ProjectImage): TaskImage {
  return {
    ...p,
    task_status: p.task_status as ImageTaskStatus,
    accepted: true,
    source_video_id: null,
    source_time_ms: null,
    tag_ids: p.tag_ids ?? [],
  };
}
