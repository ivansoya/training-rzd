import { useEffect, useState } from "react";
import * as api from "../../api/gpu";
import type { Device, GpuState } from "../../api/gpu";

// Один опрос на вкладку: сайдбар и карточка обзора смотрят одно и то же.
let state: GpuState | null = null;
const listeners = new Set<(s: GpuState) => void>();
let timer = 0;

async function tick() {
  if (document.hidden) return;
  try {
    state = await api.gpuState();
    listeners.forEach((l) => l(state as GpuState));
  } catch { /* подробности — на странице «Оборудование» */ }
}

function loop() {
  void tick();
  timer = window.setTimeout(loop, 10_000);
}

const onVisible = () => { if (!document.hidden) void tick(); };

export function useGpuState(): GpuState | null {
  const [s, setS] = useState<GpuState | null>(state);
  useEffect(() => {
    listeners.add(setS);
    if (listeners.size === 1) {
      loop();
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      listeners.delete(setS);
      if (listeners.size === 0) {
        window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);
  return s;
}

const gb = (mb: number) => (mb / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

const KIND: Record<string, [string, string]> = {
  train: ["Обучение", "var(--c1)"],
  embed: ["Признаки", "var(--c2)"],
  infer: ["Проверка", "var(--c3)"],
};
export const FREE_COLOR = "color-mix(in srgb, var(--muted-fg) 22%, var(--card))";

/** Доли памяти карты: SAM2, держатели по видам, неприкосновенный запас, свободное. */
export function deviceParts(d: Device, detailed = false) {
  const byKind = new Map<string, { mb: number; titles: string[] }>();
  for (const h of d.holders) {
    const row = byKind.get(h.kind) ?? { mb: 0, titles: [] };
    row.mb += h.granted_mb;
    if (h.title) row.titles.push(h.title);
    byKind.set(h.kind, row);
  }
  return [
    ...(d.sam2_reserve_mb > 0
      ? [{ label: `SAM2 ${gb(d.sam2_reserve_mb)}${detailed ? " ГБ" : ""}`, value: d.sam2_reserve_mb, color: "var(--c4)" }]
      : []),
    ...[...byKind].map(([k, r]) => ({
      label: `${detailed && r.titles.length === 1 ? r.titles[0] : KIND[k]?.[0] ?? k} ${gb(r.mb)}${detailed ? " ГБ" : ""}`,
      value: r.mb,
      color: KIND[k]?.[1] ?? "var(--c5)",
    })),
    ...(d.reserved_mb > 0
      ? [{ label: `Запас ${gb(d.reserved_mb)}${detailed ? " ГБ" : ""}`, value: d.reserved_mb, color: "var(--input)" }]
      : []),
    { label: `Свободно ${gb(d.free_mb)}${detailed ? " ГБ" : ""}`, value: d.free_mb, color: FREE_COLOR },
  ];
}

export { gb };
