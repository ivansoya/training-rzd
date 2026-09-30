// Датасеты проекта и счёт классов в них.
//
// Отдельный модуль, а не auth/api.ts: там и так всё подряд, а у датасетов
// своя жизнь — переименование, удаление с ценой, счёт разметки в своих кадрах.

import { get } from "./http";
import type { ClassesInfo } from "../auth/api";

/** Классы проекта со счётом разметки в том множестве кадров, которое смотрят:
 *  `any` — во всех датасетах, id — в одном. Отбор классов в сетке обязан
 *  считать то же, что сетка найдёт, иначе «Человек 87» даёт «Найдено 0». */
export const classesIn = (code: string, dataset: "any" | string) =>
  get<ClassesInfo>(
    `projects/${encodeURIComponent(code)}/classes?dataset=${encodeURIComponent(dataset)}`
  );
