import type { VideoTrack } from "../../auth/api";

/** Где объект находится на кадре, которого никто не размечал.
 *
 * Тот же расчёт, что и на сервере (`datasets_svc/video_tracks.py`): редактор
 * обязан показывать ровно то, что уйдёт в датасет. Держать это в двух местах
 * неприятно, но альтернатива — запрос на сервер при каждом сдвиге на кадр,
 * а редактор листают кадрами непрерывно.
 */

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolate(a: Geometry, b: Geometry, t: number): Geometry {
  return {
    x: round2(lerp(a.x, b.x, t)),
    y: round2(lerp(a.y, b.y, t)),
    w: round2(lerp(a.w, b.w, t)),
    h: round2(lerp(a.h, b.h, t)),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Последний кадр, на котором трек ещё существует. */
export function trackEnd(track: VideoTrack): number {
  if (track.end_frame !== null) return track.end_frame;
  const keys = track.keys;
  return keys.length ? keys[keys.length - 1].frame_no : track.start_frame;
}

/**
 * Бокс трека на кадре или `null`, если объекта там нет.
 *
 * Объекта нет в трёх случаях: кадр вне жизни трека, кадр раньше первого
 * ключевого и участок, объявленный невидимым. Последнее — не пробел в
 * разметке, а «здесь его заслонило»: такие кадры в датасет не идут.
 */
export function boxAt(track: VideoTrack, frameNo: number): Geometry | null {
  const keys = [...track.keys].sort((a, b) => a.frame_no - b.frame_no);
  if (!keys.length) return null;
  if (frameNo < track.start_frame || frameNo > trackEnd(track)) return null;

  let prev: (typeof keys)[number] | null = null;
  let next: (typeof keys)[number] | null = null;
  for (const key of keys) {
    if (key.frame_no <= frameNo) prev = key;
    else {
      next = key;
      break;
    }
  }
  if (!prev || !prev.visible) return null;
  if (!next || !track.interpolate) return { ...prev.geometry };
  const span = next.frame_no - prev.frame_no;
  if (span <= 0) return { ...prev.geometry };
  return interpolate(prev.geometry, next.geometry, (frameNo - prev.frame_no) / span);
}

/** Есть ли на этом кадре ключ — то есть положение, заданное рукой. */
export function keyAt(track: VideoTrack, frameNo: number) {
  return track.keys.find((k) => k.frame_no === frameNo) || null;
}

/** Заслонённые отрезки трека: `[от, до)` в номерах кадров.
 *  Рисуются на дорожке штриховкой, чтобы дыра в разметке была видна. */
export function hiddenRanges(track: VideoTrack): [number, number][] {
  const keys = [...track.keys].sort((a, b) => a.frame_no - b.frame_no);
  const end = trackEnd(track);
  const out: [number, number][] = [];
  keys.forEach((key, i) => {
    if (key.visible) return;
    const to = i + 1 < keys.length ? keys[i + 1].frame_no : end + 1;
    out.push([key.frame_no, to]);
  });
  return out;
}

/** Сколько кадров этот трек отдаст в проект при текущем шаге.
 *  Показывается рядом с шагом: цифра «240 кадров» объясняет шаг лучше слов. */
export function exportCount(track: VideoTrack): number {
  const step = Math.max(1, track.export_step || 1);
  const end = trackEnd(track);
  const frames = new Set<number>();
  for (const key of track.keys) {
    if (key.frame_no >= track.start_frame && key.frame_no <= end) frames.add(key.frame_no);
  }
  for (let f = track.start_frame; f <= end; f += step) frames.add(f);
  let count = 0;
  frames.forEach((f) => {
    if (boxAt(track, f) !== null) count += 1;
  });
  return count;
}

/** Время кадра. Считаем из номера, а не наоборот: обратный пересчёт на
 *  дробной частоте уводит на соседний кадр. */
export function frameToMs(frameNo: number, fps: number | null): number {
  if (!fps || fps <= 0) return 0;
  return Math.round((frameNo * 1000) / fps);
}

export function msToFrame(ms: number, fps: number | null): number {
  if (!fps || fps <= 0) return 0;
  return Math.round((ms * fps) / 1000);
}

/** «00:41.500» — минуты, секунды и миллисекунды. Часы появляются, когда есть. */
export function fmtFrameTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const rest = ms % 1000;
  const head = h > 0 ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0");
  return `${head}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}
