// Датасеты проекта и счёт классов в них.
//
// Отдельный модуль, а не auth/api.ts: там и так всё подряд, а у датасетов
// своя жизнь — переименование, удаление с ценой, счёт разметки в своих кадрах.

import { del, get, patch } from "./http";
import type { ClassesInfo } from "../auth/api";

/** Классы проекта со счётом разметки в том множестве кадров, которое смотрят:
 *  `any` — во всех датасетах, id — в одном. Отбор классов в сетке обязан
 *  считать то же, что сетка найдёт, иначе «Человек 87» даёт «Найдено 0». */
export const classesIn = (code: string, dataset: "any" | string) =>
  get<ClassesInfo>(
    `projects/${encodeURIComponent(code)}/classes?dataset=${encodeURIComponent(dataset)}`
  );

export interface DatasetUsage {
  id: string;
  name: string;
  images: number;
  annotations: number;
  /** Незакрытые таски, которые держат датасет: пока они есть, удалить нельзя. */
  tasks: { id: string; name: string; status: string }[];
  /** Несобранные наборы, выбравшие этот датасет. */
  unbuilt_sets: string[];
}

const dsPath = (code: string, id: string) =>
  `projects/${encodeURIComponent(code)}/datasets/${encodeURIComponent(id)}`;

export const renameDataset = (code: string, id: string, name: string) =>
  patch<{ id: string; name: string }>(dsPath(code, id), { name });

export const datasetUsage = (code: string, id: string) =>
  get<DatasetUsage>(`${dsPath(code, id)}/usage`);

export const deleteDataset = (code: string, id: string) =>
  del<{ ok: true; images: number; annotations: number }>(dsPath(code, id));
