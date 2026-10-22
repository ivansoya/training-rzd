/** Арифметика отрезков по Range: где лежит кадр в файле, какие байты чьи, что тянуть первым.
 *
 * Отрезок приезжает сырыми байтами файла — без контейнера. Кадры из него
 * вырезаются по таблице пакетов сервера: размер каждого и зазор перед ним
 * (у камер H.264 там лежит звук). Ошибка на байт здесь — это не испорченная
 * картинка, а кадр, ушедший в декодер чужим. Поэтому проверяется числами.
 */
import type { ClipSegment } from "../../auth/api";

/** Кадр отрезка: байты для декодера и его номер в ролике. */
export interface SegmentFrame {
  data: Uint8Array;
  key: boolean;
  /** Место внутри отрезка. */
  pres: number;
  /** Номер кадра в ролике целиком. */
  no: number;
}

/** Смещение каждого кадра в файле: зазор, потом сам кадр, и так подряд. */
export function packetPositions(sizes: number[], gaps: number[]): Float64Array {
  const pos = new Float64Array(sizes.length);
  let at = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    at += gaps[i];
    pos[i] = at;
    at += sizes[i];
  }
  return pos;
}

/** Вырезать кадры отрезка из его байтов. Байты не копируются — декодер копирует сам. */
export function sliceSegment(
  bytes: ArrayBuffer,
  seg: ClipSegment,
  pos: Float64Array,
  sizes: number[],
  keys: Set<number>
): SegmentFrame[] {
  if (bytes.byteLength !== seg.end - seg.start + 1) {
    throw new Error(`Отрезок ${seg.n}: пришло ${bytes.byteLength} байт вместо ${seg.end - seg.start + 1}.`);
  }
  const out: SegmentFrame[] = [];
  for (let i = 0; i < seg.count; i += 1) {
    const no = seg.first + i;
    const offset = pos[no] - seg.start;
    if (offset < 0 || offset + sizes[no] > bytes.byteLength) {
      throw new Error(`Кадр ${no} не лежит в отрезке ${seg.n}.`);
    }
    out.push({ data: new Uint8Array(bytes, offset, sizes[no]), key: keys.has(no), pres: i, no });
  }
  return out;
}

/** Что тянуть и в каком порядке: текущий первым, потом вперёд, потом назад (решение 12, 22.10.2026).
 *  Пять разом делили канал, и текущий приезжал за 3-5 с вместо 1. */
export function warmOrder(here: number, total: number, ahead: number, behind: number): number[] {
  const out = [here];
  for (let i = 1; i <= ahead; i += 1) out.push(here + i);
  for (let i = 1; i <= behind; i += 1) out.push(here - i);
  return out.filter((n) => n >= 0 && n < total);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
