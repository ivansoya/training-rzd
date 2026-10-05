// Логика экранов тасок без React: состояния, доли кадров, доска, источники, план закрытия.

import type { TaskBoardItem, TaskCounts, TaskDetail, TaskStatus, TaskVideoItem } from "../../../auth/api";
import type { StackPart } from "../../../ui";
import { count, plural } from "../../ru";

export const STATUS: Record<TaskStatus, { label: string; tone: string }> = {
  queued: { label: "На очереди", tone: "var(--faint)" },
  in_progress: { label: "В работе", tone: "var(--c1)" },
  done: { label: "Готово", tone: "var(--st-done)" },
  updating: { label: "Изменение", tone: "var(--st-skip)" },
  closed: { label: "Закрыто", tone: "var(--faint)" },
};
export const BOARD: TaskStatus[] = ["queued", "in_progress", "done", "updating", "closed"];

/** Куда таску можно перевести со страницы, кроме закрытия. */
export const NEXT: Record<TaskStatus, { to: TaskStatus; label: string } | null> = {
  queued: { to: "in_progress", label: "Взять в работу" },
  in_progress: { to: "done", label: "Готово" },
  done: { to: "updating", label: "Вернуться к разметке" },
  updating: { to: "done", label: "Готово" },
  closed: null,
};

/** Разрешённые переходы — копия ALLOWED в task_routes.py. */
export const MOVES: Record<TaskStatus, TaskStatus[]> = {
  queued: ["in_progress", "closed"],
  in_progress: ["done", "queued", "closed"],
  done: ["updating", "closed"],
  updating: ["done", "closed"],
  closed: [],
};
export const canMove = (from: TaskStatus, to: TaskStatus) => MOVES[from].includes(to);

export type FrameState = "new" | "agent" | "skipped" | "annotated" | "empty" | "deleted";
export const STATES: { key: FrameState; label: string; color: string }[] = [
  { key: "new", label: "Не тронуто", color: "var(--st-new)" },
  { key: "agent", label: "от агента, не проверено", color: "var(--agent)" },
  { key: "skipped", label: "Отложено", color: "var(--st-skip)" },
  { key: "annotated", label: "Размечено", color: "var(--st-done)" },
  { key: "empty", label: "Фон", color: "var(--st-empty)" },
  { key: "deleted", label: "Брак", color: "var(--st-del)" },
];
const color = (k: FrameState) => STATES.find((s) => s.key === k)!.color;

type Counts = Partial<Pick<TaskCounts, "new" | "skipped" | "annotated" | "empty" | "deleted" | "agent">>;

/** Полоса состояний: решённое слева, нетронутое справа; брак в долю не входит. */
export function stateParts(c: Counts): StackPart[] {
  return (["annotated", "empty", "skipped", "new"] as const).map((k) => ({
    value: c[k] || 0, color: color(k), label: STATES.find((s) => s.key === k)!.label,
  }));
}

export const framesOf = (c: Counts) => (c.new || 0) + (c.skipped || 0) + (c.annotated || 0) + (c.empty || 0);
export const decidedOf = (c: Counts) => (c.annotated || 0) + (c.empty || 0);
/** Доля решённого — вниз: 100 % при одном нетронутом кадре было бы неправдой. */
export const percentOf = (c: Counts) => (framesOf(c) ? Math.floor((decidedOf(c) / framesOf(c)) * 100) : 0);

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
/** «28 сен», другой год — «28 сен 2025», сегодня — «сегодня, 10:42». */
export function dayOf(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    return `сегодня, ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  }
  const y = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

/** Откуда кадры одной строкой для карточки доски. */
export function sourceLine(s: TaskBoardItem["sources"]): string {
  const parts = [
    s.files ? count(s.files, "изображение", "изображения", "изображений") : "",
    s.cut ? `${count(s.cut, "ролик", "ролика", "роликов")} на нарезку${s.uncut ? ` (${s.uncut} не ${plural(s.uncut, "нарезан", "нарезаны", "нарезаны")})` : ""}` : "",
    s.annotate ? `${count(s.annotate, "ролик", "ролика", "роликов")} на разметку` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "пустая";
}

/** Колонки доски: свежее сверху; закрытые — по времени закрытия. */
export function boardColumns(tasks: TaskBoardItem[], query: string, mine: string | null) {
  const q = query.trim().toLowerCase();
  const shown = tasks.filter((t) =>
    (!q || t.name.toLowerCase().includes(q)) && (!mine || t.assignee?.id === mine));
  const cols = Object.fromEntries(BOARD.map((s) => [s, [] as TaskBoardItem[]])) as Record<TaskStatus, TaskBoardItem[]>;
  for (const t of shown) cols[t.status].push(t);
  for (const s of BOARD) {
    cols[s].sort((a, b) => (s === "closed" ? b.status_at.localeCompare(a.status_at) : b.last_at.localeCompare(a.last_at)));
  }
  return { cols, shown: shown.length };
}

/** Сколько кадров ждёт решения во всех незакрытых тасках. */
export const waitingOf = (tasks: TaskBoardItem[]) =>
  tasks.filter((t) => t.status !== "closed").reduce((s, t) => s + t.counts.new + t.counts.skipped, 0);

/** Что сделает закрытие: что уйдёт в датасет, что удалится навсегда. */
export function closePlan(c: TaskCounts, videos: number) {
  const accept = Math.max(0, c.annotated + c.empty - c.accepted);
  const drafts = Math.max(0, c.total + c.deleted - c.accepted - accept);
  return { accept, drafts, videos };
}

export function closeText(p: ReturnType<typeof closePlan>, dataset: string | null): string[] {
  const gone = [
    p.drafts ? count(p.drafts, "черновой кадр", "черновых кадра", "черновых кадров") : "",
    p.videos ? (p.videos === 1 ? "исходное видео" : `исходные видео (${p.videos})`) : "",
  ].filter(Boolean).join(" и ");
  return [
    p.accept ? `${count(p.accept, "размеченный кадр уйдёт", "размеченных кадра уйдут", "размеченных кадров уйдут")} в датасет${dataset ? ` «${dataset}»` : ""}.` : "",
    gone ? `Будут удалены ${gone} — это необратимо.` : "Удалять нечего.",
  ].filter(Boolean);
}

// ---------------- источники кадров ----------------

export interface SourceCounts extends Counts {
  accepted?: number;
  first_at?: string;
}

export interface SourceBlock {
  key: string;
  title: string;
  kind: "files" | "cut" | "annotate";
  /** Нарезаемые ролики таски — блок у них общий, план у каждого свой. */
  videos?: TaskVideoItem[];
  counts: SourceCounts;
  total: number;
  /** Когда источник появился: по нему блоки идут во времени. */
  bornAt: number;
}

const SUM_KEYS = ["new", "annotated", "empty", "skipped", "deleted", "accepted", "agent"] as const;

/** Блоки источников: файлы, ролики на нарезку, кадры из закрытой разметки роликов. */
export function buildSources(task: TaskDetail): SourceBlock[] {
  const out: SourceBlock[] = [];
  const at = (value?: string | null) => (value ? Date.parse(value) : 0);
  const by = task.by_source || {};

  const files = by.files || {};
  if (framesOf(files) || files.deleted) {
    out.push({ key: "files", title: "Изображения", kind: "files", counts: files, total: framesOf(files), bornAt: at(files.first_at) });
  }

  // Ролики на нарезку видны всегда: с этого блока в нарезку и заходят
  const videos = task.videos.filter((v) => v.mode === "cut");
  if (videos.length) {
    const counts: SourceCounts = {};
    for (const v of videos) {
      for (const k of SUM_KEYS) counts[k] = (counts[k] || 0) + ((by[v.id] || {})[k] || 0);
    }
    out.push({
      key: "videos", title: "Ролики на нарезку", kind: "cut", videos, counts, total: framesOf(counts),
      bornAt: Math.min(...videos.map((v) => at(v.created_at))),
    });
  }

  for (const v of task.videos.filter((x) => x.mode !== "cut")) {
    const own: SourceCounts = by[v.id] || {};
    if (!framesOf(own) && !own.deleted) continue;
    out.push({ key: v.id, title: `Из разметки «${v.file_name}»`, kind: "annotate", counts: own, total: framesOf(own), bornAt: at(v.created_at) });
  }
  return out.sort((a, b) => a.bornAt - b.bornAt);
}

/** Где на ролике размечено: участки нарезки или отрезки объектов, доли 0–1. */
export function coverage(v: TaskVideoItem, objects?: { start: number; end: number }[]): [number, number][] {
  if (v.mode === "cut") {
    const d = v.duration_ms || 1;
    return v.segments.map((s) => [s.start_ms / d, Math.max(s.end_ms - s.start_ms, d * 0.004) / d + s.start_ms / d]);
  }
  const n = Math.max(1, (v.frame_count || 1) - 1);
  return (objects || []).map((o) => [o.start / n, Math.max(o.end, o.start + n * 0.004) / n]);
}

