/** Склейка классов: ложные значения выпадают. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Доля заливки ползунка до бегунка, 0–100. */
export function rangePercent(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** Инициалы для аватара: две первые буквы слов, иначе первые две буквы. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const two = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return two.toUpperCase();
}

/** Устойчивый оттенок по строке — один человек всегда одного цвета. */
export function hueOf(s: string): number {
  return [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
}

/** Доли полосы-стопки: отрицательное и пустое выбрасывается, сумма — 100. */
export function stackShares(values: number[]): number[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  return sum > 0 ? clean.map((v) => (v / sum) * 100) : clean.map(() => 0);
}
