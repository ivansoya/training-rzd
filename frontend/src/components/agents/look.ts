// Вид узлов агента на холсте, в палитре и шторке: иконка, род, цвет, строка под именем.
// Счёт рамок на проводах и по классам — из ответа превью.

import type { IconName } from "../../ui";
import type { PreviewDet } from "../../api/agents";
import {
  SAM_DEFAULTS, TEXT_IMGSZ, TEXT_MODEL, isExamples, mergeInputs, promptsOf, rowTarget, rowsOf, textConfDefault, textModel,
  tileSide, viewCount,
} from "./agentDoc";

export type AgentKind = "frame" | "net" | "text" | "merge" | "nms" | "filter" | "sam" | "output";
export type Addable = Exclude<AgentKind, "frame" | "output">;

const KIND: Record<AgentKind, [IconName, string]> = {
  frame: ["image", "Начало"],
  net: ["bot", "Поиск"],
  text: ["tags", "Поиск"],
  merge: ["merge", "Обработка рамок"],
  nms: ["layers", "Обработка рамок"],
  filter: ["filter", "Обработка рамок"],
  sam: ["poly", "Уточнение"],
  output: ["target", "Конец"],
};

// Поиск — c1, уточнение — c4, начало и конец — c2, как у графа; обработка рамок их не создаёт — нейтральная.
const TONE: Partial<Record<AgentKind, string>> = {
  frame: "var(--c2)", output: "var(--c2)", net: "var(--c1)", text: "var(--c1)", sam: "var(--c4)",
};
export const NEUTRAL_TONE = "var(--muted-fg)";

export const toneOf = (kind: AgentKind): string => TONE[kind] ?? NEUTRAL_TONE;
export const iconOf = (kind: AgentKind): IconName => KIND[kind]?.[0] ?? "box";
export const roleOf = (kind: AgentKind): string => KIND[kind]?.[1] ?? kind;

export interface PaletteGroup {
  key: string;
  title: string;
  tone: string;
  items: { kind: Addable; label: string }[];
}

// «Кадр» и «Выход» в агенте ровно по одному и не удаляются — в палитре их нет.
export const PALETTE: PaletteGroup[] = [
  { key: "find", title: "Поиск", tone: toneOf("net"), items: [{ kind: "net", label: "Сеть" }, { kind: "text", label: "Сеть по тексту" }] },
  { key: "boxes", title: "Обработка рамок", tone: NEUTRAL_TONE,
    items: [{ kind: "merge", label: "Объединение" }, { kind: "nms", label: "NMS" }, { kind: "filter", label: "Фильтр" }] },
  { key: "refine", title: "Уточнение", tone: toneOf("sam"), items: [{ kind: "sam", label: "Уточнение SAM" }] },
];

/** Параметры нового узла. */
export function defaults(kind: Addable): Record<string, unknown> {
  switch (kind) {
    case "net": return { weights: null, classes: [], conf: 0.25 };
    case "text": return { model: TEXT_MODEL, prompts: [], conf: textConfDefault(TEXT_MODEL), imgsz: TEXT_IMGSZ };
    case "merge": return { inputs: 2 };
    case "nms": return { iou: 0.6, agnostic: false };
    case "filter": return { classes: [], min_side: null, max_side: null };
    case "sam": return { ...SAM_DEFAULTS };
  }
}

/** Гнёзда узла, если их ровно по одному: такой узел встаёт в разрыв провода.
 *  Сеть добавляет свои рамки к пришедшим, поэтому и её можно вставить в цепочку. */
export const onePort = (kind: AgentKind): [string, string] | null =>
  kind === "frame" || kind === "output" || kind === "merge" ? null : ["in", "out"];

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const decimal = (v: number) => String(v).replace(".", ",");
/** Кадр, на котором считаются тайлы: самый частый в проекте превью. */
export type FrameSize = { w: number; h: number };

/** «тайл 640 ×16»: сторона и проходов на кадр; без кадра — только сторона. */
export function tileText(kind: string, p: Record<string, unknown>, netImgsz: number | null | undefined, frame?: FrameSize | null) {
  if (!p.tiles) return null;
  const side = tileSide(kind, p, netImgsz);
  if (!frame) return `тайл ${side}`;
  const v = viewCount(p, frame.w, frame.h, side);
  return `тайл ${side} ×${v.whole + v.tiles}${v.tiles && !v.whole ? ", без целого" : ""}`;
}

/** Строка под именем «Сети». */
export function netLine(p: Record<string, unknown>, w: { name: string; task: string; imgsz: number | null } | undefined,
  frame?: FrameSize | null): string {
  if (!w) return "веса не выбраны";
  return [
    // С подписью имя весов уходит из заголовка сюда: две сети на одних весах иначе не отличить.
    p.label ? w.name.replace(/\.pt$/i, "") : null,
    `${w.task}, ${num(p.imgsz, w.imgsz ?? 640)}, conf ${decimal(num(p.conf, 0.25))}`,
    tileText("net", p, w.imgsz, frame),
  ].filter(Boolean).join(", ");
}

/** Строка под именем «Сети по тексту»; `sam3Missing` — весов SAM 3 нет на сервере. */
export function textLine(p: Record<string, unknown>, sam3Missing: boolean, frame?: FrameSize | null): string {
  if (sam3Missing) return "нет весов SAM 3";
  const model = textModel(p);
  const rows = promptsOf({ params: p }).filter((r) => r.on && rowTarget(r) && r.agent.trim());
  const ex = rows.filter(isExamples).length;
  const yolo = model !== "sam3";
  return [
    yolo ? `YOLOE-26 ${model}` : "SAM 3",
    ex ? `${rows.length - ex ? `${rows.length - ex} сл. + ` : ""}${ex} обр.` : rows.length ? `${rows.length} сл.` : null,
    `conf ${decimal(num(p.conf, textConfDefault(model)))}`,
    tileText("text", p, null, frame),
  ].filter(Boolean).join(", ");
}

/** Строка под именем «Фильтра»: правила только для классов, что приходят на вход. */
export function filterLine(p: Record<string, unknown>, incoming: string[]): string {
  const rules = ((p.classes as { cls: string; on: boolean; conf: number }[] | undefined) ?? [])
    .filter((r) => incoming.includes(r.cls) && (!r.on || r.conf > 0)).length;
  const side = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);
  const lo = side(p.min_side);
  const hi = side(p.max_side);
  const size = lo || hi ? `сторона ${lo ?? "0"}–${hi ?? "∞"} px` : null;
  return [rules ? `правил ${rules}` : null, size].filter(Boolean).join(", ") || "пропускает всё";
}

/** Строка под именем прочих узлов. */
export function plainLine(kind: AgentKind, p: Record<string, unknown>): string {
  switch (kind) {
    case "frame": return "кадр таски";
    case "output": return "в разметку";
    case "merge": {
      const n = mergeInputs(p);
      return `${n} ${n < 5 ? "входа" : "входов"} · подряд`;
    }
    case "nms": return `IoU ${decimal(num(p.iou, 0.6))}, ${p.agnostic ? "между классами" : "внутри класса"}`;
    case "sam": return `SAM2.1 ${String(p.model ?? SAM_DEFAULTS.model).replace("sam2.1_hiera_", "").replace("_plus", "+")} → контур`;
    default: return "";
  }
}

/** Сколько классов сети включено: «12/80». */
export const netBadge = (p: Record<string, unknown>, total: number) => `${rowsOf({ params: p }).filter((r) => r.on).length}/${total}`;

export type Trace = Record<string, { in: PreviewDet[]; out: PreviewDet[] }>;

/** Подпись провода: у «Кадра» — «кадр», дальше — сколько рамок по нему идёт; не посчитано — пусто. */
export function wireText(sourceKind: AgentKind | undefined, trace: Trace | null, source: string): { text: string; amount: number } {
  if (sourceKind === "frame") return { text: "кадр", amount: 0 };
  const out = trace?.[source]?.out;
  return out ? { text: String(out.length), amount: out.length } : { text: "—", amount: 0 };
}

export interface ClassTally {
  cls: string;
  into: number;
  out: number;
}

/** Рамки узла по классам: сколько пришло и сколько ушло. У сети пришедшие — от узлов выше. */
export function tally(node: { in: PreviewDet[]; out: PreviewDet[] } | undefined): ClassTally[] {
  if (!node) return [];
  const rows = new Map<string, ClassTally>();
  const row = (cls: string) => rows.get(cls) ?? rows.set(cls, { cls, into: 0, out: 0 }).get(cls)!;
  node.in.forEach((d) => row(d.cls).into++);
  node.out.forEach((d) => row(d.cls).out++);
  return [...rows.values()].sort((a, b) => b.out - a.out || b.into - a.into || a.cls.localeCompare(b.cls));
}

/** Рамки, что узел отсеял: были на входе, на выходе их нет. */
export function droppedOf(node: { in: PreviewDet[]; out: PreviewDet[] } | undefined): PreviewDet[] {
  if (!node) return [];
  const kept = new Set(node.out.map((d) => d.id));
  return node.in.filter((d) => !kept.has(d.id));
}

/** «Новый агент», а если занято — «Новый агент 2»… */
export function freeName(taken: Iterable<string>, base = "Новый агент"): string {
  const busy = new Set(taken);
  let name = base;
  for (let n = 2; busy.has(name); n++) name = `${base} ${n}`;
  return name;
}
