// Вид узла на холсте и в шторке: иконка, род, строка параметров.

import type { IconName } from "../../ui";
import type { CatalogueNode, NodeKind, ParamSpec } from "../../api/aug";

const GROUP_ICON: Record<string, IconName> = { light: "sun", noise: "activity", weather: "snow", geometry: "rotate" };

const KIND: Record<NodeKind, [IconName, string]> = {
  source: ["database", "Начало"],
  input: ["database", "Вход блока"],
  output: ["layers", "Конец"],
  aug: ["sliders", "Аугментация"],
  flow: ["route", "Поток"],
  multiply: ["copy", "Поток"],
  split_share: ["split", "Поток"],
  split_prob: ["shuffle", "Поток"],
  merge: ["merge", "Поток"],
  order: ["list", "Поток"],
  group: ["workflow", "Блок"],
  mosaic: ["grid", "Геометрия"],
};

// Цвет группы: свет, шум, погода, геометрия — ряды c3/c4/c5/c1, начало и конец — c2.
// Поток кадр не меняет, только направляет, — он нейтральный.
const GROUP_TONE: Record<string, string> = { light: "var(--c3)", noise: "var(--c4)", weather: "var(--c5)", geometry: "var(--c1)" };
const KIND_TONE: Partial<Record<NodeKind, string>> = { source: "var(--c2)", input: "var(--c2)", output: "var(--c2)", mosaic: "var(--c1)" };
export const NEUTRAL_TONE = "var(--muted-fg)";

/** Цвет узла: у аугментации — по группе каталога, у прочих — по роду. */
export const toneOf = (kind: NodeKind, group?: string): string =>
  (kind === "aug" ? group && GROUP_TONE[group] : KIND_TONE[kind]) || NEUTRAL_TONE;

/** Иконка узла: у аугментации — по группе каталога. */
export const iconOf = (kind: NodeKind, group?: string): IconName =>
  (kind === "aug" && group && GROUP_ICON[group]) || (KIND[kind]?.[0] ?? "box");

/** Иконка и род узла — строка над именем на карточке. */
export function kindOf(kind: NodeKind, cat?: CatalogueNode): { icon: IconName; label: string } {
  if (kind === "aug" && cat) return { icon: iconOf(kind, cat.group), label: cat.group_title };
  return { icon: iconOf(kind), label: KIND[kind]?.[1] ?? kind };
}

/** Число параметра: целое — целым, дробь — до сотых с запятой. */
export function num(v: number, int?: boolean): string {
  if (int) return String(Math.round(v));
  return (Math.round(v * 100) / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

/** Значение параметра словами: «±8», «0,02–0,08», «зеркало». Пусто — нечего показывать. */
export function argText(spec: ParamSpec, value: unknown): string {
  if (spec.kind === "range" && Array.isArray(value)) {
    const [a, b] = value.map(Number);
    return a === -b && b > 0 ? `±${num(b, spec.int)}` : `${num(a, spec.int)}–${num(b, spec.int)}`;
  }
  if (spec.kind === "number") return num(Number(value), spec.int);
  if (spec.kind === "flag") return value ? spec.label.toLowerCase() : "";
  if (spec.kind === "choice") return value == null ? "" : String(value);
  return "";
}

/** Строка под именем аугментации: два первых параметра и вероятность, если она не единица. */
export function paramSummary(cat: CatalogueNode | undefined, params: Record<string, unknown>): string {
  const args = (params.args as Record<string, unknown> | undefined) ?? {};
  const parts = (cat?.params ?? [])
    .map((s) => {
      const t = argText(s, args[s.key] ?? s.default);
      return !t || s.kind === "flag" ? t : `${s.label.toLowerCase()} ${t}`;
    })
    .filter(Boolean)
    .slice(0, 2);
  const chance = Number(params.chance ?? 1);
  if (chance < 1) parts.push(`p ${num(chance)}`);
  return parts.join(" · ");
}

export const DRAWER_MIN = 140;
export const CANVAS_MIN = 120;
export const DRAWER_DEFAULT = 300;

/** Высота шторки в пределах: холсту остаётся не меньше CANVAS_MIN. */
export function clampDrawer(h: number, room: number): number {
  return Math.round(Math.max(DRAWER_MIN, Math.min(room - CANVAS_MIN, h)));
}

/** «Новый граф», а если занято — «Новый граф 2», «Новый граф 3»… */
export function freeName(taken: Iterable<string>, base = "Новый граф"): string {
  const busy = new Set(taken);
  let name = base;
  for (let n = 2; busy.has(name); n++) name = `${base} ${n}`;
  return name;
}
