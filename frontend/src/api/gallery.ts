// Кадры всего проекта разом — с пометкой, из какого они датасета.

import { get } from "./http";
import type { Box } from "../auth/api";

export interface ProjectImage {
  id: string;
  file_name: string;
  split: string;
  task_status: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  annotations: number;
  boxes: Box[];
  dataset_id: string;
  dataset_name: string;
  tags: string[];
  rev?: number;
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
