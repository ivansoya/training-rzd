// Логика экранов тасок без React: состояния, доли кадров, доска, источники, план закрытия.

import type { StatusResult, TaskCounts, TaskDetail, TaskLight, TaskNumbers, TaskStats, TaskStatus, TaskVideoItem } from "../../../auth/api";
import type { IconName, StackPart } from "../../../ui";
import type { RunView } from "../../../api/agents";
import { ago, count, plural, ru } from "../../ru";

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

/** Я среди исполнителей. Куда можно перевести таску, считает сервер (`moves`). */
export const isMine = (t: Pick<TaskLight, "assignees">, me: string | null) =>
  !!me && t.assignees.some((p) => p.id === me);

/** Исполнители одной строкой; пусто — ничья таска. */
export const teamLine = (people: { display_name: string }[]) =>
  people.length ? people.map((p) => p.display_name).join(", ") : "ничья";

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

/** Сколько кадров таски в датасете: из вкладки «Кадры» и из роликов (их счётчики врозь). */
export const inDataset = (c: Pick<TaskCounts, "accepted" | "video_accepted">) => c.accepted + (c.video_accepted || 0);

/** Последнее, что было с таской: сданная — когда сдана, иначе разметка или создание. */
export function statusNote(t: Pick<TaskLight, "status" | "status_at" | "last_box_at" | "created_at">): string {
  if (t.status === "done") return `сдана ${dayOf(t.status_at)}`;
  if (t.last_box_at) return `разметка ${ago(t.last_box_at)}`;
  return `создана ${ago(t.created_at)}`;
}

/** Сделано — размечено, фон и брак: выброшенный кадр тоже разобран (решение 14.10.2026). */
export const doneOf = (c: Counts) => (c.annotated || 0) + (c.empty || 0) + (c.deleted || 0);

/** Полоса карточки доски: сделанное слева (брак своим цветом), потом отложенное и нетронутое. */
export function boardParts(c: Counts): StackPart[] {
  return (["annotated", "empty", "deleted", "skipped", "new"] as const).map((k) => ({
    value: c[k] || 0, color: color(k), label: STATES.find((s) => s.key === k)!.label,
  }));
}

export interface CardBadge { text: string; title: string; tone?: string; icon?: IconName; live?: boolean }
/** Карточка таски на доске и в обзоре: полоса, строка (числа — отдельными кусками), подсказка с полным
 *  счётом и значки по важности — что не влезет в строку, обрежется с конца. */
export interface CardLook { parts: StackPart[]; line: (string | number)[]; title: string; badges: CardBadge[]; quiet?: boolean }

const plus = (a: Counts, b: Counts): Counts => Object.fromEntries(
  (["new", "skipped", "annotated", "empty", "deleted", "agent"] as const).map((k) => [k, (a[k] || 0) + (b[k] || 0)]));
const NO_VIDEOS: TaskStats["videos"] = { tracks: 0, boxes: 0, agent_done: 0, agent_left: 0 };
const flat = (line: (string | number)[]) => line.map((x) => (typeof x === "number" ? ru(x) : x)).join("");

/** Решения 14.10.2026: изображения — «сделано · осталось», отложенные — значком; ролик — треками и рамками,
 *  с агентом — проверкой по кадрам; сданная — все изображения таски вместе с кадрами роликов. */
export function cardLook(status: TaskStatus, s: Pick<TaskStats, "counts" | "sources" | "handover"> & { videos?: TaskStats["videos"] }): CardLook {
  const c = s.counts;
  const v = s.videos ?? NO_VIDEOS;
  const badges: CardBadge[] = [];
  if (s.handover) badges.push({ text: "сдаётся", title: "Идёт сдача: кадры роликов достаются фоном", tone: "var(--c1)", live: true });
  const waiting = (n: number) => n > 0 && badges.push({
    text: `${ru(n)} ждут проверки`, title: `${count(n, "кадр ждёт", "кадра ждут", "кадров ждут")} проверки агента`,
    tone: "var(--agent-fg)", icon: "bot",
  });

  if (status === "done" || status === "closed") {
    const images = c.total + (c.video?.total || 0);
    const ds = inDataset(c);
    const word = plural(images, "изображение", "изображения", "изображений");
    const line = !images ? ["изображений нет"]
      : ds === images ? [images, ` ${word} в датасете`] : [images, ` ${word} · `, ds, " в датасете"];
    waiting((c.agent || 0) + (c.video?.agent || 0));
    return { parts: boardParts(plus(c, c.video ?? {})), line, title: flat(line), badges, quiet: !images };
  }

  const rolls = s.sources.annotate;
  const checking = v.agent_done + v.agent_left > 0;
  const made = `${count(v.tracks, "трек", "трека", "треков")}, ${count(v.boxes, "рамка", "рамки", "рамок")}`;
  const checkTitle = `Агент: проверено ${count(v.agent_done, "кадр", "кадра", "кадров")}, осталось проверить ${ru(v.agent_left)}`;
  if (framesOf(c) + (c.deleted || 0) > 0) {
    waiting(c.agent || 0);
    if (c.skipped) badges.push({ text: `${ru(c.skipped)} отложено`, title: count(c.skipped, "кадр отложен", "кадра отложены", "кадров отложено"), tone: "var(--st-skip)" });
    if (rolls) {
      const head = rolls > 1 ? count(rolls, "ролик", "ролика", "роликов") : "ролик";
      badges.push(checking
        ? { text: `${head}: осталось проверить ${ru(v.agent_left)}`, title: `${head}: ${checkTitle}`, tone: "var(--agent-fg)", icon: "film" }
        : { text: `${head}: ${made}`, title: `${head}: ${made}`, icon: "film" });
    }
    const line = ["сделано ", doneOf(c), " · осталось ", c.new || 0];
    const title = `Сделано ${ru(doneOf(c))}: размечено ${ru(c.annotated)}, фон ${ru(c.empty)}, брак ${ru(c.deleted || 0)}`
      + `${c.skipped ? ` · отложено ${ru(c.skipped)}` : ""} · осталось ${ru(c.new)}${c.agent ? `, из них ${ru(c.agent)} ждут проверки агента` : ""}`;
    return { parts: boardParts(c), line, title, badges };
  }
  if (rolls && checking) {
    badges.push({ text: made, title: made, icon: "film" });
    return {
      parts: [{ value: v.agent_done, color: "var(--agent-hi)", label: "Проверено" }, { value: v.agent_left, color: "var(--st-new)", label: "Ждёт проверки" }],
      line: ["проверено ", v.agent_done, " · осталось ", v.agent_left], title: checkTitle, badges,
    };
  }
  if (rolls) {
    const line = [v.tracks, ` ${plural(v.tracks, "трек", "трека", "треков")} · `, v.boxes, ` ${plural(v.boxes, "рамка", "рамки", "рамок")}`];
    return { parts: [], line, title: made, badges };
  }
  return { parts: [], line: ["кадров пока нет"], title: "Кадров пока нет", badges, quiet: true };
}

/** Размечали меньше 15 минут назад — у таски живая точка. */
export const boxedRecently = (t: TaskLight) => !!t.last_box_at && Date.now() - Date.parse(t.last_box_at) < 15 * 60_000;

/** Откуда кадры одной строкой для карточки доски. */
export function sourceLine(s: TaskStats["sources"]): string {
  const parts = [
    s.files ? count(s.files, "изображение", "изображения", "изображений") : "",
    s.dataset ? `${count(s.dataset, "кадр", "кадра", "кадров")} из датасета` : "",
    s.cut ? `${count(s.cut, "ролик", "ролика", "роликов")} на нарезку${s.uncut ? ` (${s.uncut} не ${plural(s.uncut, "нарезан", "нарезаны", "нарезаны")})` : ""}` : "",
    s.annotate ? `${count(s.annotate, "ролик", "ролика", "роликов")} на разметку` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "пустая";
}

/** Колонки доски: свежее сверху; закрытые — по времени закрытия. */
export function boardColumns(tasks: TaskLight[], query: string, mine: string | null) {
  const q = query.trim().toLowerCase();
  const shown = tasks.filter((t) =>
    (!q || t.name.toLowerCase().includes(q)) && (!mine || isMine(t, mine)));
  const cols = Object.fromEntries(BOARD.map((s) => [s, [] as TaskLight[]])) as Record<TaskStatus, TaskLight[]>;
  for (const t of shown) cols[t.status].push(t);
  for (const s of BOARD) {
    cols[s].sort((a, b) => (s === "closed" ? b.status_at.localeCompare(a.status_at) : b.last_at.localeCompare(a.last_at)));
  }
  return { cols, shown: shown.length };
}

/** Сколько кадров ждёт решения во всех незакрытых тасках — по пришедшим счётчикам. */
export const waitingOf = (tasks: TaskLight[], stats: Record<string, TaskStats | undefined>) =>
  tasks.filter((t) => t.status !== "closed")
    .reduce((s, t) => s + (stats[t.id]?.counts.new ?? 0) + (stats[t.id]?.counts.skipped ?? 0), 0);

/** В каком порядке доска спрашивает счётчики: мои → «В работе» → остальные по доске → закрытые.
 *  Внутри — как карточки стоят в колонках. */
export function requestOrder(tasks: TaskLight[], me: string | null): string[] {
  const { cols } = boardColumns(tasks, "", null);
  const board = BOARD.flatMap((s) => cols[s]);
  const rank = (t: TaskLight) => (t.status === "closed" ? 3 : isMine(t, me) ? 0 : t.status === "in_progress" ? 1 : 2);
  return board.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t.id);
}

/** Что сделает закрытие: что уйдёт в датасет, что удалится навсегда. */
export function closePlan(c: TaskCounts, videos: number) {
  // Решённые копии кадров датасета ложатся на исходники — в «уйдёт в датасет» их нет
  const accept = Math.max(0, c.annotated + c.empty - c.accepted - (c.copies_decided ?? 0));
  const drafts = Math.max(0, c.total + c.deleted - c.accepted - accept);
  return { accept, drafts, videos };
}

/** Итог сдачи и закрытия одной строкой: что ушло, что обновилось, что осталось ждать. */
export function handoverText(r: StatusResult): string {
  const waiting = (r.unchecked || 0) + (r.waiting || 0);
  return [
    r.accepted ? `В датасет${r.dataset ? ` «${r.dataset}»` : ""} ушло ${count(r.accepted, "кадр", "кадра", "кадров")}.` : "",
    r.updated || r.removed ? `Кадры роликов в датасете: обновлено ${ru(r.updated || 0)}${r.removed ? `, убрано ${ru(r.removed)}` : ""}.` : "",
    r.kept_edited ? `${count(r.kept_edited, "кадр правили", "кадра правили", "кадров правили")} в датасете — ${plural(r.kept_edited, "оставлен", "оставлены", "оставлены")} как есть.` : "",
    waiting ? `${count(waiting, "кадр ждёт", "кадра ждут", "кадров ждут")} проверки агента — в датасет не ${plural(waiting, "ушёл", "ушли", "ушли")}.` : "",
    r.removed_images ? `${plural(r.removed_images, "Удалён", "Удалено", "Удалено")} ${count(r.removed_images, "черновой кадр", "черновых кадра", "черновых кадров")}.` : "",
    ...copiesText(r.copies),
  ].filter(Boolean).join(" ") || "Размеченных кадров пока нет — принимать нечего.";
}

/** Копии кадров датасета на сдаче (решения 14.10.2026): что легло на место и что нет. */
function copiesText(c: StatusResult["copies"]): string[] {
  if (!c) return [];
  return [
    c.placed || c.removed ? `Копии из датасета: на место ${ru(c.placed)}${c.removed ? `, убрано из датасета ${ru(c.removed)}` : ""}.` : "",
    c.edited ? `${count(c.edited, "исходник правили", "исходника правили", "исходников правили")} в датасете — ${plural(c.edited, "оставлен", "оставлены", "оставлены")} как есть.` : "",
    c.waiting ? `${count(c.waiting, "копия ждёт", "копии ждут", "копий ждут")} проверки агента.` : "",
  ];
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
  kind: "files" | "cut" | "dataset";
  /** Нарезаемые ролики таски — блок у них общий, план у каждого свой. */
  videos?: TaskVideoItem[];
  counts: SourceCounts;
  /** Разбивка по состояниям пришла (`/counts`); до того на её месте заготовка. */
  known: boolean;
  /** Кадров без брака — из лёгкой части, известно сразу. */
  total: number;
  /** Когда источник появился: по нему блоки идут во времени. */
  bornAt: number;
  /** Копии кадров датасета: из каких датасетов исходники. */
  datasets?: { id: string; name: string; n: number }[];
}

const SUM_KEYS = ["new", "annotated", "empty", "skipped", "deleted", "accepted", "agent"] as const;

/** Блоки источников: файлы и ролики на нарезку. Кадров размечаемых роликов тут нет: они рождаются
 *  сдачей и правятся только в ролике. Какие блоки есть, знает лёгкая часть таски (`sources`),
 *  числа — `by` из `/counts`, когда придут. */
export function buildSources(task: TaskDetail, by: TaskNumbers["by_source"] | null): SourceBlock[] {
  const out: SourceBlock[] = [];
  const at = (value?: string | null) => (value ? Date.parse(value) : 0);
  const has = (key: string) => (task.sources?.[key]?.total || 0) > 0;
  const frames = (key: string) => task.sources?.[key]?.frames || 0;
  // Дата «с …» — из лёгкой части, числа по состояниям — из `/counts`
  const of = (key: string): SourceCounts => ({ ...((by || {})[key] || {}), first_at: task.sources?.[key]?.first_at ?? undefined });
  const known = by !== null;

  if (has("files")) {
    out.push({ key: "files", title: "Изображения", kind: "files", counts: of("files"), known,
      total: frames("files"), bornAt: at(task.sources.files.first_at) });
  }
  // Копии кадров датасета: правки лягут на исходники при сдаче (решения 14.10.2026)
  if (has("dataset")) {
    out.push({ key: "dataset", title: "Из датасета", kind: "dataset", counts: of("dataset"), known,
      total: frames("dataset"), bornAt: at(task.sources.dataset.first_at), datasets: task.sources.dataset.datasets });
  }

  // Ролики на нарезку видны всегда: с этого блока в нарезку и заходят
  const videos = task.videos.filter((v) => v.mode === "cut");
  if (videos.length) {
    const counts: SourceCounts = {};
    for (const v of videos) {
      for (const k of SUM_KEYS) counts[k] = (counts[k] || 0) + (of(v.id)[k] || 0);
    }
    out.push({
      key: "videos", title: "Ролики на нарезку", kind: "cut", videos, counts, known,
      total: videos.reduce((s, v) => s + frames(v.id), 0),
      bornAt: Math.min(...videos.map((v) => at(v.created_at))),
    });
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

/** Ролик, по которому агент идёт сейчас: курсор прогона роликов — [номер в videos, кадр], пройденный ролик сдвигает его на следующий. */
export function agentVideo(run: Pick<RunView, "status" | "mode" | "videos" | "stats"> | null | undefined): string | undefined {
  if (run?.status !== "running" || run.mode === "frames") return undefined;
  return run.videos[Number(run.stats.cursor?.[0] ?? 0)];
}
