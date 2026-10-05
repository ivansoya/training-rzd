// Расчёты экранов «Наборы» и «Набор» — отдельно от разметки, чтобы закрыть тестами.

import type { Run } from "../../../api/runs";
import type { BuiltFeed, FeedKind, SetSpec, SplitMode, TrainSet } from "../../../api/trainsets";
import { plural } from "../../ru";

export const SET_STATUS: Record<TrainSet["status"], { label: string; tone: string; live?: boolean }> = {
  draft: { label: "Черновик", tone: "var(--faint)" },
  queued: { label: "В очереди", tone: "var(--faint)" },
  building: { label: "Собирается", tone: "var(--c1)", live: true },
  ready: { label: "Готов", tone: "var(--st-done)" },
  error: { label: "Не собрался", tone: "var(--destructive)" },
  deleting: { label: "Удаляется", tone: "var(--faint)", live: true },
};

/** Наборы, которые ещё меняются сами: список перечитывается, пока такие есть. */
export const BUSY: TrainSet["status"][] = ["queued", "building", "deleting"];

export const SPLIT_MODE: Record<SplitMode, string> = {
  manual: "как размечено",
  random: "случайно",
  balanced: "с учётом классов",
  smart: "умное",
};

export const TRAIN = "var(--c1)";
export const VAL = "var(--c2)";

/** «1,9 ГБ», «640 МБ», «0 Б». */
export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
}

/** Во сколько раз образцов больше, чем кадров проекта: «×2,6». Без копий — пусто. */
export function multiplier(set: Pick<TrainSet, "counts">): string | null {
  const c = set.counts;
  if (!c || !c.source_images || c.samples <= c.source_images) return null;
  return `×${(c.samples / c.source_images).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}`;
}

const MAP50 = "metrics/mAP50(B)";

export interface SetRuns {
  /** Обучения на наборе, новые сверху. */
  runs: Run[];
  best: { number: number; map50: number } | null;
}

/** Обучения по наборам и лучшее по mAP50 у каждого. */
export function runsBySet(runs: Run[]): Map<string, SetRuns> {
  const out = new Map<string, SetRuns>();
  for (const r of runs) {
    if (!r.set) continue;
    const got = out.get(r.set.id) ?? { runs: [], best: null };
    got.runs.push(r);
    const m = r.best_metrics[MAP50];
    if (m != null && (!got.best || m > got.best.map50)) got.best = { number: r.number, map50: m };
    out.set(r.set.id, got);
  }
  for (const v of out.values()) v.runs.sort((a, b) => b.number - a.number);
  return out;
}

export const map50Of = (r: Run): number | null => r.best_metrics[MAP50] ?? null;

/** Одна строка схемы «что кладём → через что → сколько вышло». */
export interface Flow {
  key: string;
  part: "train" | "val";
  feed: FeedKind;
  /** Что кладём словами: «train целиком», «кадры с тагом „ночь“». */
  source: string;
  /** Имя источника графа, если их в графе несколько. */
  sourceName: string | null;
  graph: { id: string; name: string; version: number } | null;
  /** Числа сборки по строке. У наборов, собранных до 06.10.2026, их нет. */
  images: number | null;
  samples: number | null;
}

const sameNode = (a: string | null | undefined, b: string | null | undefined) => (a || "") === (b || "");

export function flowsOf(set: Pick<TrainSet, "feeds">, built: BuiltFeed[] | null,
  tagName: (id: string) => string): Flow[] {
  const out: Flow[] = [];
  for (const row of set.feeds ?? []) {
    row.bindings.forEach((b, i) => {
      const num = built?.find((f) => f.part === row.part && f.position === row.position
        && sameNode(f.source_node, b.source_node));
      const tags = b.tag_ids.map(tagName);
      out.push({
        key: `${row.part}-${row.position}-${i}`,
        part: row.part,
        feed: b.feed,
        source: b.feed === "tags"
          ? (tags.length ? `кадры с ${plural(tags.length, "тагом", "тагами", "тагами")} «${tags.join("», «")}»` : "кадры с тагами")
          : `${b.feed} целиком`,
        sourceName: row.bindings.length > 1 && num?.source_name ? num.source_name : null,
        graph: row.graph ? { id: row.graph.id, name: row.graph.name, version: row.graph.version } : null,
        images: num ? num.images : null,
        samples: num ? num.samples : null,
      });
    });
  }
  return out.sort((a, b) => (a.part === b.part ? 0 : a.part === "train" ? -1 : 1));
}

/** Графы набора без повторов — для чипов в строке списка. */
export function graphsOf(set: Pick<TrainSet, "feeds">): { id: string; name: string; version: number }[] {
  const seen = new Map<string, { id: string; name: string; version: number }>();
  for (const row of set.feeds ?? []) {
    if (row.graph) seen.set(`${row.graph.id}:${row.graph.version}`, row.graph);
  }
  return [...seen.values()];
}

/** Свободное имя для «Собрать похожий»: «Ночь (2)», «Ночь (3)». */
export function similarName(name: string, taken: string[]): string {
  const base = name.replace(/\s\(\d+\)$/, "");
  const busy = new Set(taken);
  for (let i = 2; ; i++) {
    const next = `${base} (${i})`;
    if (!busy.has(next)) return next;
  }
}

/** Настройки мастера из собранного набора. Пропавшие датасеты и классы отпадают — о них скажет мастер. */
export function seedFromSet(set: Pick<TrainSet, "spec" | "feeds" | "split_mode" | "val_ratio" | "seed" | "kind">,
  have: { datasets: string[]; classes: string[] }): {
  spec: Required<Pick<SetSpec, "datasets" | "classes" | "ann_type" | "split_mode" | "val_ratio" | "seed">>
    & Pick<SetSpec, "dataset_parts" | "feeds">;
  lost: { datasets: number; classes: number };
} {
  const spec = set.spec ?? {};
  const ds = (spec.datasets ?? []).filter((id) => have.datasets.includes(id));
  const cls = (spec.classes ?? []).filter((id) => have.classes.includes(id));
  const parts = Object.fromEntries(Object.entries(spec.dataset_parts ?? {}).filter(([id]) => ds.includes(id)));
  return {
    spec: {
      datasets: ds,
      classes: cls,
      dataset_parts: parts,
      ann_type: set.kind,
      split_mode: set.split_mode,
      val_ratio: set.val_ratio,
      seed: set.seed,
      feeds: (set.feeds ?? []).map(({ graph: _g, ...row }) => row),
    },
    lost: {
      datasets: new Set(spec.datasets ?? []).size - ds.length,
      classes: new Set(spec.classes ?? []).size - cls.length,
    },
  };
}
