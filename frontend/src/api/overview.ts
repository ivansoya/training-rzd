// Сводка проекта для экрана «Обзор»: одна выборка вместо пяти.

import { get } from "./http";

export interface OverviewClass {
  id: string;
  index: number;
  name: string;
  color: string;
  train: number;
  val: number;
  /** Кадры без сплита — пришли из тасок и ещё не поделены. */
  other: number;
}

export interface OverviewEvent {
  at: string;
  kind: string;
  payload: Record<string, unknown>;
  user: string | null;
  task?: { id: string; name: string };
  run?: { id: string; name: string };
}

export interface Overview {
  updated_at: string | null;
  /** Ряды — на конец каждого из последних семи дней, последний — сейчас. */
  frames: { total: number; week: number; series: number[] };
  annotated: { count: number; empty: number; share: number[] };
  boxes: { total: number; series: number[] };
  classes: { declared: number; used: number; rows: OverviewClass[] };
  best: { run_id: string; name: string; epoch: number; map50: number; series: number[] } | null;
  latest_run: {
    id: string;
    name: string;
    model: string;
    imgsz: number | null;
    status: string;
    epoch: number;
    epochs: number;
    map50: (number | null)[];
    map95: (number | null)[];
  } | null;
  activity: OverviewEvent[];
}

export const getOverview = (code: string) =>
  get<Overview>(`projects/${encodeURIComponent(code)}/overview`);
