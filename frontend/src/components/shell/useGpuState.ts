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

const gb = (mb: number) => (mb / 1024).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Виды работ на карте — подпись и цвет; одни на «Оборудовании» и на обзоре проекта. */
export const KIND: Record<string, [string, string]> = {
  train: ["обучение", "var(--c1)"],
  agent: ["агент разметки", "var(--agent)"],
  "agent-preview": ["превью агента", "var(--c5)"],
  "agent-examples": ["образцы агента", "var(--c5)"],
  embed: ["признаки кадров", "var(--c2)"],
  infer: ["проверка модели", "var(--c3)"],
};
export const kindOf = (k: string) => KIND[k] ?? [k, "var(--c5)"];
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Резерв под полуавтомат — штриховкой: это не работа, а место, которое держат для разметки. */
export const HATCH = "repeating-linear-gradient(135deg, var(--c4) 0 3px, color-mix(in srgb, var(--c4) 40%, var(--card)) 3px 6px)";
// Запас серый: жёлтым занято «загружена»
export const RESERVE = "repeating-linear-gradient(135deg, var(--faint) 0 3px, var(--hover) 3px 6px)";

/** Состояние карты по свободной доле: от 30 % — свободна, меньше 10 % — занята (решение 13.10.2026). */
export function loadOf(free_mb: number, total_mb: number) {
  const share = total_mb > 0 ? free_mb / total_mb : 0;
  return share >= 0.3 ? { label: "свободна", tone: "var(--st-done)" }
    : share >= 0.1 ? { label: "загружена", tone: "var(--st-skip)" }
      : { label: "занята", tone: "var(--destructive)" };
}
export const freeColor = (tone: string) => `color-mix(in srgb, ${tone} 65%, var(--card))`;

/** Доли памяти всех живых карт одной полосой: разметка, работы по видам, запас, свободное.
 *  Высота карточки обзора не зависит от числа карт (решение 10.10.2026). */
export function serverParts(devices: Device[]) {
  const byKind = new Map<string, number>();
  let sam2 = 0, reserved = 0, free = 0, anonymous = 0, total = 0;
  for (const d of devices) {
    total += d.total_mb;
    sam2 += d.sam2_reserve_mb;
    reserved += d.reserved_mb;
    free += d.free_mb;
    for (const h of d.holders) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + h.granted_mb);
    // Без права на оборудование держателей нет — занятое одной суммой.
    if (d.holders.length === 0) anonymous += d.held_mb;
  }
  const load = loadOf(free, total);
  const parts = [
    ...(sam2 > 0 ? [{ label: "Разметка", value: sam2, color: HATCH }] : []),
    ...[...byKind].map(([k, mb]) => ({ label: upper(kindOf(k)[0]), value: mb, color: kindOf(k)[1] })),
    ...(anonymous > 0 ? [{ label: "Занято", value: anonymous, color: "var(--faint)" }] : []),
    ...(reserved > 0 ? [{ label: "Запас", value: reserved, color: RESERVE }] : []),
    { label: "Свободно", value: free, color: freeColor(load.tone) },
  ];
  return { parts, load, total };
}

/** Карты для сводок: выключенные и пропавшие показывает только «Оборудование». */
export const liveDevices = (s: GpuState) => s.devices.filter((d) => d.enabled && d.fresh);

/** «NVIDIA GeForce RTX 5070 Ti» → «RTX 5070 Ti»: в шапках место дорого. */
export const shortName = (name: string) => name.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");

/** Номера карт задачи: подряд — «0–1», вразбивку — «2, 5». */
export function cardList(list: number[]) {
  const sorted = [...list].sort((a, b) => a - b);
  const solid = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return solid && sorted.length > 1 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
}

export { gb };
