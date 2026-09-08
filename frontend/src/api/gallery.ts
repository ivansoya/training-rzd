// Кадры всего проекта разом — с пометкой, из какого они датасета.

import { get } from "./http";
import type { Box } from "../auth/api";

export interface ProjectImage {
  id: string;
  file_name: string;
  split: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  annotations: number;
  boxes: Box[];
  dataset_id: string;
  dataset_name: string;
}

export interface ProjectImages {
  datasets: { id: string; name: string; identifier: string; images: number }[];
  splits: Record<string, number>;
  total: number;
  matched: number;
  my_role: string;
  images: ProjectImage[];
}

export interface ImagesQuery {
  datasets?: string[];
  classes?: number[];
  split?: string;
  empty?: boolean;
  sort?: "name" | "objects";
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
  if (q.limit) p.set("limit", String(q.limit));
  if (q.offset) p.set("offset", String(q.offset));
  return p.toString();
}

export const projectImages = (code: string, q: ImagesQuery = {}) => {
  const suffix = imagesQuery(q);
  return get<ProjectImages>(
    `projects/${encodeURIComponent(code)}/images${suffix ? `?${suffix}` : ""}`
  );
};
