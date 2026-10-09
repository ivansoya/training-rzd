// Логика редактора видео «Дорожки снизу»: служебные дорожки, состояние трека на кадре, высота дока.

import type { VideoSingleBox, VideoTrack } from "../../auth/api";
import { hiddenRanges, keyAt, stateAt, trackEnd } from "../mag/trackMath";
import { visibleSpans } from "../mag/timelineMath";

/** Что стоит за фигурой на кадре: трек или одиночная разметка этого кадра. */
export type Item =
  | { kind: "track"; track: VideoTrack; hidden: boolean }
  | { kind: "single"; box: VideoSingleBox };

/** Ключ для глаза: трек гаснет на всём ролике, одиночная — на своём кадре. */
/** Агент одиночной рамки ролика — для групп на проверке; у трека агента нет. */
export function singleAgent(item?: { kind: string }): { key: string; name: string; version: number | null } | null {
  if (item?.kind !== "single" || !(item as Extract<Item, { kind: "single" }>).box.agent) return null;
  const a = (item as Extract<Item, { kind: "single" }>).box.agent!;
  return { key: a.id ?? a.name, name: a.name, version: a.version };
}

export const itemKey = (it: Item) => (it.kind === "track" ? `t:${it.track.id}` : `s:${it.box.id}`);

/** Склеить отрезки кадров [от, до] включительно; соседние кадры — один отрезок. */
export function mergeSpans(raw: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...raw].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Где на ролике есть разметка, которая уйдёт в таску: жизнь треков без заслонов и кадры одиночных. */
export function coveredSpans(tracks: VideoTrack[], singles: VideoSingleBox[]): [number, number][] {
  const raw: [number, number][] = [];
  for (const t of tracks) {
    if (t.class_index === null) continue;
    raw.push(...visibleSpans(t.start_frame, trackEnd(t), hiddenRanges(t)));
  }
  for (const s of singles) if (s.class_index !== null) raw.push([s.frame_no, s.frame_no]);
  return mergeSpans(raw);
}

/** Риски одиночных на дорожке: кадр и класс, без повторов. */
export function singleTicks(singles: VideoSingleBox[]): { frame: number; ci: number }[] {
  const seen = new Set<string>();
  const out: { frame: number; ci: number }[] = [];
  for (const s of singles) {
    if (s.class_index === null) continue;
    const k = `${s.frame_no}:${s.class_index}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ frame: s.frame_no, ci: s.class_index });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

/** Сводная тепловая разведки: участки всех классов, яркость — по числу попаданий. */
export function scoutHeat(lanes: { spans: [number, number, number][] }[]): [number, number, number][] {
  const all = lanes.flatMap((l) => l.spans);
  const top = Math.max(1, ...all.map((s) => s[2]));
  return all
    .map(([a, b, n]) => [a, b, Math.round((0.25 + 0.75 * (n / top)) * 100) / 100] as [number, number, number])
    .sort((x, y) => x[0] - y[0]);
}

export type Presence = "key" | "between" | "hidden";

export const PRESENCE_TEXT: Record<Presence, string> = { key: "ключ", between: "между", hidden: "заслонён" };

/** Что трек делает на кадре: ключ рукой, расчёт между ключами или заслон; null — его тут нет. */
export function presenceAt(track: VideoTrack, frame: number): Presence | null {
  const s = stateAt(track, frame);
  if (!s) return null;
  if (s.hidden) return "hidden";
  return keyAt(track, frame) ? "key" : "between";
}

/** Номера треков в ролике: по порядку заведения, как их отдаёт сервер. */
export function trackNumbers(tracks: VideoTrack[]): Map<string, number> {
  return new Map(tracks.map((t, i) => [t.id, i + 1]));
}

/** Кадр, куда перейти к треку: текущий, если он там живёт, иначе ближайший край жизни. */
export function seekToTrack(track: VideoTrack, frame: number): number {
  const end = trackEnd(track);
  if (frame >= track.start_frame && frame <= end) return frame;
  return frame < track.start_frame ? track.start_frame : end;
}

export const DOCK_MIN = 150;
export const STAGE_MIN = 220;
export const DOCK_DEFAULT = 300;

/** Высота дока с транспортом и дорожками: кадру остаётся не меньше STAGE_MIN. */
export function clampDock(h: number, room: number): number {
  return Math.round(Math.max(DOCK_MIN, Math.min(room - STAGE_MIN, h)));
}

const TICK_S = [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

/** Засечки линейки: круглые секунды не теснее minPx; кадр — где стоит засечка, t — её подпись в секундах. */
export function timeTicks(lastFrame: number, fps: number, width: number, minPx = 64): { frame: number; t: number }[] {
  if (lastFrame <= 0 || fps <= 0 || width <= 0) return [{ frame: 0, t: 0 }];
  const total = lastFrame / fps;
  const step = TICK_S.find((s) => (s / total) * width >= minPx) ?? TICK_S[TICK_S.length - 1];
  const out: { frame: number; t: number }[] = [];
  for (let i = 0; i * step * fps <= lastFrame + 1e-6; i++) {
    const t = Math.round(i * step * 10) / 10;
    out.push({ frame: Math.round(t * fps), t });
  }
  return out;
}

/** Подпись засечки: «1:05», при долях секунды — «0:01,5». */
export function clockText(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.round((t - m * 60) * 10) / 10;
  const sec = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0").replace(".", ",");
  return `${m}:${sec}`;
}

export const SPEEDS = [0.25, 0.5, 1, 2] as const;
export const speedText = (v: number) => (v === 0.25 ? "¼" : v === 0.5 ? "½" : `${v}×`);
