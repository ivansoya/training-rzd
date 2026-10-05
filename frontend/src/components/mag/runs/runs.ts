// Расчёты экранов «История» и «Прогон» — отдельно от разметки, чтобы закрыть тестами.

import type { KpiMetrics, Run, RunStatus } from "../../../api/runs";

export const STATUS: Record<RunStatus, { label: string; tone: string; live?: boolean }> = {
  queued: { label: "В очереди", tone: "var(--faint)" },
  waiting_gpu: { label: "Ждёт карту", tone: "var(--st-skip)" },
  preparing: { label: "Готовится", tone: "var(--c1)", live: true },
  running: { label: "Идёт", tone: "var(--c1)", live: true },
  stopping: { label: "Останавливается", tone: "var(--st-skip)", live: true },
  done: { label: "Готово", tone: "var(--st-done)" },
  stopped: { label: "Остановлено", tone: "var(--st-skip)" },
  error: { label: "Ошибка", tone: "var(--destructive)" },
};

export const FINISHED: RunStatus[] = ["done", "stopped", "error"];
export const ACTIVE: RunStatus[] = ["preparing", "running", "stopping"];
export const WAITING: RunStatus[] = ["queued", "waiting_gpu"];

export type RunFilter = "all" | "done" | "broken";

export function filterRuns(runs: Run[], f: { status: RunFilter; set: string; model: string }): Run[] {
  return runs.filter((r) =>
    (f.status === "all" || (f.status === "done" ? r.status === "done" : r.status === "stopped" || r.status === "error"))
    && (f.set === "all" || r.set?.id === f.set)
    && (f.model === "all" || r.base_model === f.model));
}

/** «Сегодня», «Вчера», «28 сентября», у прошлых лет — с годом. */
export function dayLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return at.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).replace(/\s*г\.$/, "");
}

/** Подряд идущие прогоны одного дня — одна группа; порядок списка сохраняется. */
export function groupByDay(runs: Run[], now = new Date()): { label: string; runs: Run[] }[] {
  const out: { label: string; runs: Run[] }[] = [];
  for (const r of runs) {
    const label = dayLabel(r.created_at, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.runs.push(r);
    else out.push({ label, runs: [r] });
  }
  return out;
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** «38 с», «42 мин», «1 ч 05 мин». Ноль — прочерк. */
export function duration(secs: number): string {
  if (!secs || secs < 1) return "—";
  if (secs < 60) return `${Math.round(secs)} с`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, "0")} мин`;
}

/** «осталось ~11 мин» для идущего: среднее время законченной эпохи × сколько осталось. */
export function etaText(run: Pick<Run, "status" | "phase" | "current_epoch" | "epochs" | "train_seconds">): string | null {
  if (run.status !== "running" || run.phase === "final") return null;
  const done = run.current_epoch - 1;
  if (done < 1 || run.current_epoch > run.epochs || !run.train_seconds) return null;
  return `осталось ~${duration((run.train_seconds / done) * (run.epochs - done))}`;
}

/** Дробь по-русски с заданным числом знаков. */
export const dec = (v: number, n = 3) =>
  v.toLocaleString("ru-RU", { minimumFractionDigits: n, maximumFractionDigits: n });

export const KPI: { key: keyof KpiMetrics; label: string }[] = [
  { key: "metrics/mAP50(B)", label: "mAP50" },
  { key: "metrics/mAP50-95(B)", label: "mAP50-95" },
  { key: "metrics/precision(B)", label: "Точность" },
  { key: "metrics/recall(B)", label: "Полнота" },
];

/** Разница с прошлым прогоном; null — сравнивать не с чем. Меньше половины знака — «без изменений». */
export function delta(cur: number | undefined, prev: number | undefined):
  { text: string; dir: "up" | "down" | "same" } | null {
  if (cur == null || prev == null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 0.0005) return { text: "±0,000", dir: "same" };
  return { text: `${d > 0 ? "+" : "−"}${dec(Math.abs(d))}`, dir: d > 0 ? "up" : "down" };
}

export interface ConfusionView {
  /** Подписи строк и столбцов; последняя — фон. */
  names: string[];
  /** Доля от строки: строка — что было на кадре, столбец — что увидела модель. */
  shares: number[][];
  counts: number[][];
  /** Классов скрыто: на них нет ни объекта, ни срабатывания. */
  hidden: number;
}

/** Сервер отдаёт как ultralytics: строка — предсказание, столбец — истина, последняя — фон.
 *  Поворачиваем к «строка — истина» и делим на сумму строки. */
export function confusionView(data: { matrix: number[][]; names: string[] }): ConfusionView {
  const n = Math.min(data.names.length, data.matrix.length);
  const at = (pred: number, truth: number) => data.matrix[pred]?.[truth] ?? 0;
  const bg = n - 1;
  const keep: number[] = [];
  for (let i = 0; i < bg; i++) {
    let any = false;
    for (let j = 0; j < n; j++) if (at(i, j) > 0 || at(j, i) > 0) any = true;
    if (any) keep.push(i);
  }
  keep.push(bg);
  const counts = keep.map((t) => keep.map((p) => at(p, t)));
  const shares = counts.map((row) => {
    const s = row.reduce((a, b) => a + b, 0);
    return row.map((v) => (s ? v / s : 0));
  });
  return { names: keep.map((i) => data.names[i]), shares, counts, hidden: bg - (keep.length - 1) };
}

/** Чаще всего путает: внедиагональные доли от 2 %, по убыванию. Фон×фон не в счёт. */
export function topConfusions(v: ConfusionView, limit: number) {
  const last = v.names.length - 1;
  const out: { truth: number; pred: number; share: number; count: number }[] = [];
  v.shares.forEach((row, i) => row.forEach((p, j) => {
    if (i !== j && !(i === last && j === last) && p >= 0.02) out.push({ truth: i, pred: j, share: p, count: v.counts[i][j] });
  }));
  return out.sort((a, b) => b.share - a.share).slice(0, limit);
}

const PARAM_LABEL: Record<string, string> = {
  epochs: "Эпох", imgsz: "Размер кадра", batch: "Батч", patience: "Стоп без улучшения",
  optimizer: "Оптимизатор", lr0: "lr0", lrf: "lrf", momentum: "Момент", weight_decay: "Затухание весов",
  warmup_epochs: "Разогрев, эпох", cos_lr: "Косинусный график", freeze: "Заморожено слоёв",
  dropout: "Dropout", label_smoothing: "Сглаживание меток", seed: "Зерно", workers: "Загрузчиков",
  hsv_h: "Тон", hsv_s: "Насыщенность", hsv_v: "Яркость", degrees: "Поворот, °", translate: "Сдвиг",
  scale: "Масштаб", shear: "Скос, °", perspective: "Перспектива", flipud: "Отражение ↕",
  fliplr: "Отражение ↔", bgr: "Перестановка каналов", mosaic: "Мозаика", mixup: "Mixup",
  copy_paste: "Copy-paste", close_mosaic: "Без мозаики в конце, эпох",
};
const TRAIN_KEYS = ["epochs", "batch", "patience", "optimizer", "lr0", "lrf", "momentum", "weight_decay",
  "warmup_epochs", "cos_lr", "freeze", "dropout", "label_smoothing", "seed", "workers"];
export const AUG_KEYS = ["mosaic", "close_mosaic", "fliplr", "flipud", "scale", "translate", "degrees",
  "shear", "perspective", "hsv_h", "hsv_s", "hsv_v", "mixup", "copy_paste", "bgr"];
export const AUG_MODE: Record<string, string> = { yolo: "встроенные YOLO", off: "выключены", graph: "из графа набора" };

export function paramText(key: string, value: unknown): string {
  if (key === "augment_mode") return AUG_MODE[String(value)] ?? String(value);
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (key === "patience" && value === 0) return "не останавливать";
  if (typeof value === "number") return value.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
  return String(value);
}

export type ParamRow = [string, string];

/** Параметры прогона группами карточки «Параметры»: модель, обучение, данные, аугментации, железо. */
export function paramGroups(run: Run, classes: number | null):
  { title: string; icon: "cpu" | "activity" | "layers" | "sliders" | "server"; rows: ParamRow[] }[] {
  const p = run.params ?? {};
  const has = (k: string) => p[k] !== undefined && p[k] !== null;
  const model: ParamRow[] = [
    ["Модель", run.base_model],
    ...(has("weights") ? [["Веса", String(p.weights)] as ParamRow] : []),
    ["Предобучена", p.pretrained === false ? "нет, с нуля" : "да"],
    ...(has("imgsz") ? [["Размер кадра", paramText("imgsz", p.imgsz)] as ParamRow] : []),
    ...(classes != null ? [["Классов", String(classes)] as ParamRow] : []),
  ];
  const train: ParamRow[] = TRAIN_KEYS.filter(has).map((k) => [PARAM_LABEL[k] ?? k, paramText(k, p[k])]);
  const c = run.set?.counts;
  const data: ParamRow[] = run.set ? [
    ["Набор", run.set.name],
    ...(c ? [["Обучение / проверка", `${(c.train ?? 0).toLocaleString("ru-RU")} / ${(c.val ?? 0).toLocaleString("ru-RU")}`] as ParamRow] : []),
    ["Разметка", run.set.kind === "polygon" ? "контуры" : "рамки"],
    ["Аугментации", paramText("augment_mode", p.augment_mode ?? "yolo")],
  ] : [["Набор", "удалён"]];
  const aug: ParamRow[] = p.augment_mode === "yolo"
    ? AUG_KEYS.filter(has).map((k) => [PARAM_LABEL[k] ?? k, paramText(k, p[k])]) : [];
  const gb = (mb: number) => `${(mb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ГБ`;
  const hw: ParamRow[] = [
    ["Устройство", run.device == null ? "ещё не выбрано" : run.device === "cpu" ? "процессор" : `карта ${run.device}`],
    ...(run.peak_vram_mb != null ? [["Пик видеопамяти", gb(run.peak_vram_mb)] as ParamRow] : []),
    ["Время эпох", duration(run.train_seconds)],
  ];
  return [
    { title: "Модель", icon: "cpu" as const, rows: model },
    { title: "Обучение", icon: "activity" as const, rows: train },
    { title: "Данные", icon: "layers" as const, rows: data },
    ...(aug.length ? [{ title: "Аугментации YOLO", icon: "sliders" as const, rows: aug }] : []),
    { title: "Железо", icon: "server" as const, rows: hw },
  ];
}

/** Подписи включённых встроенных аугментаций YOLO — для шапки прогона. */
export function yoloAugChips(params: Record<string, unknown> | undefined): string[] {
  const p = params ?? {};
  if (p.augment_mode !== "yolo") return [];
  const on = (k: string) => typeof p[k] === "number" && (p[k] as number) > 0;
  const out: string[] = [];
  if (on("mosaic")) out.push("Мозаика");
  if (on("fliplr") || on("flipud")) out.push("Отражение");
  if (on("hsv_h") || on("hsv_s") || on("hsv_v")) out.push("Цвет");
  if (on("degrees")) out.push("Поворот");
  if (on("scale") || on("translate")) out.push("Масштаб и сдвиг");
  if (on("shear") || on("perspective")) out.push("Перспектива");
  if (on("mixup")) out.push("Mixup");
  if (on("copy_paste")) out.push("Copy-paste");
  return out;
}

/** Кривые по порогу: подпись переключателя. У сегментации — рамки и маски отдельно. */
export function curveLabel(c: { x_label: string; y_label: string; group?: "B" | "M" }, i: number, total: number): string {
  const g = c.group ?? (total === 8 ? (i < 4 ? "B" : "M") : undefined);
  const y = c.y_label === "Precision" && c.x_label === "Recall" ? "PR" : c.y_label.slice(0, 1).toUpperCase() === "F" ? "F1"
    : c.y_label === "Precision" ? "Точность" : c.y_label === "Recall" ? "Полнота" : c.y_label;
  return g === "M" ? `${y}, маски` : y;
}
