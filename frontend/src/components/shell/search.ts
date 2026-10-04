import type { IconName } from "../../ui";

export interface SearchItem {
  group: string;
  label: string;
  hint?: string;
  to: string;
  icon: IconName;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").trim();

/** Подходящие строки по группам: начало названия, начало слова, вхождение; не больше `per` на группу. */
export function searchItems(query: string, items: SearchItem[], per = 6): SearchItem[] {
  const q = norm(query);
  if (!q) return [];
  const scored: [number, SearchItem][] = [];
  for (const it of items) {
    const hay = norm(`${it.label} ${it.hint ?? ""}`);
    const at = hay.indexOf(q);
    if (at < 0) continue;
    const wordStart = /[\s«"(\-_.,]/.test(hay[at - 1] ?? "");
    scored.push([at === 0 ? 0 : wordStart ? 1 : 2, it]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  const seen = new Map<string, number>();
  const out: SearchItem[] = [];
  for (const [, it] of scored) {
    const n = seen.get(it.group) ?? 0;
    if (n >= per) continue;
    seen.set(it.group, n + 1);
    out.push(it);
  }
  // Группы — в порядке первого появления в исходном списке
  const order = [...new Set(items.map((i) => i.group))];
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}
