// Логика оболочки редакторов кадров и видео: прогресс, место под кадр, клавиши.

export type FrameStatus = "new" | "annotated" | "empty" | "skipped" | "deleted";

/** Состояния кадра в порядке полосы прогресса и их цвета. */
export const STATUS_LOOK: { id: FrameStatus; label: string; color: string }[] = [
  { id: "annotated", label: "Размечен", color: "var(--st-done)" },
  { id: "empty", label: "Пусто", color: "var(--st-empty)" },
  { id: "deleted", label: "Брак", color: "var(--st-del)" },
  { id: "skipped", label: "Отложен", color: "var(--st-skip)" },
  { id: "new", label: "Не тронут", color: "var(--st-new)" },
];

export const statusLook = (s: string) => STATUS_LOOK.find((x) => x.id === s) ?? STATUS_LOOK[4];

export interface Progress {
  counts: Record<FrameStatus, number>;
  total: number;
  /** Решено: размечен, пусто, брак. Отложенный ещё ждёт решения. */
  decided: number;
  pct: number;
}

/** Прогресс по открытому списку кадров — при открытии по фильтру это прогресс выборки. */
export function progressOf(list: { task_status: string }[]): Progress {
  const counts: Record<FrameStatus, number> = { new: 0, annotated: 0, empty: 0, skipped: 0, deleted: 0 };
  for (const im of list) {
    const s = im.task_status as FrameStatus;
    counts[s in counts ? s : "new"] += 1;
  }
  const total = list.length;
  const decided = counts.annotated + counts.empty + counts.deleted;
  return { counts, total, decided, pct: total ? decided / total : 0 };
}

export interface Pad { top: number; right: number; bottom: number; left: number }

/** Поля сцены «Фокуса»: кадр вписывается между плавающими панелями, без панелей — во весь экран. */
export function stagePad(o: { panels: boolean; film: number; side: number }): Pad {
  if (!o.panels) return { top: 16, right: 16, bottom: 16, left: 16 };
  const GAP = 14;
  return { top: 64, right: o.side + GAP * 2, bottom: 66, left: o.film + GAP * 2 };
}

/** Клавиши молчат, пока человек печатает; флажок, кнопка и ползунок — не печать. */
export function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !["checkbox", "radio", "range", "button", "submit"].includes((el as HTMLInputElement).type);
}

/** Стрелки на ползунке и в списке двигают их значение, а не кадр. */
export function ownsArrows(el: EventTarget | null, key: string): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && (el as HTMLInputElement).type === "range" && /^(Arrow|Page|Home|End)/.test(key);
}

export interface KeyGroup { title: string; keys: [string, string][] }

/** Номер класса для клавиши 1–9: по месту в списке классов проекта. */
export function digitClass<T>(list: T[], code: string): T | undefined {
  const m = /^Digit([1-9])$/.exec(code);
  return m ? list[Number(m[1]) - 1] : undefined;
}

/** Текст на плашке цвета класса: тёмный на светлом цвете, светлый на тёмном. */
export function inkOn(hex: string): "dark" | "light" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "light";
  const n = parseInt(m[1], 16);
  const lin = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > 0.22 ? "dark" : "light";
}

export function filterClasses<T extends { name: string; class_index: number }>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || String(c.class_index) === q);
}
