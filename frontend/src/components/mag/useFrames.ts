import { useCallback, useEffect, useRef, useState } from "react";
import { prefetchFrames, videoFrameUrl } from "../../auth/api";

/** Кадры ролика: прогрев окна и проигрывание.
 *
 * Просить у сервера кадры по одному дорого: перемотка к произвольному кадру
 * стоит сотни миллисекунд, а подряд идущие декодируются за единицы. Поэтому
 * редактор просит не кадр, а окно вокруг текущего места — сервер распаковывает
 * его одним проходом, — и дальше кадры приезжают обычными запросами, попадая
 * в кэш браузера.
 *
 * Проигрывание держит ровный ход времени и пропускает кадры, которые не
 * успели приехать: искать момент важнее, чем увидеть каждый кадр, и врать про
 * время ради полноты нельзя.
 */

// По пять секунд в обе стороны на 25 к/с. Дальше окно не растим: кадр 1080p
// весит около 200 КБ, и ±300 кадров — это уже больше сотни мегабайт.
const WINDOW = 120;
// Пополняем, когда курсор вошёл в крайнюю треть прогретого окна.
const REFILL_AT = 40;

export function useFrames(taskId: string, videoId: string, lastFrame: number) {
  const [warm, setWarm] = useState<[number, number] | null>(null);
  const asked = useRef<string>("");
  const preloaded = useRef<Set<number>>(new Set());

  /** Прогрев окна вокруг кадра. Повторные просьбы про то же окно молчат. */
  const warmAround = useCallback(
    async (frame: number) => {
      const from = Math.max(0, frame - WINDOW);
      const to = Math.min(lastFrame, frame + WINDOW);
      const key = `${from}:${to}`;
      if (asked.current === key) return;
      asked.current = key;
      try {
        await prefetchFrames(taskId, videoId, from, to);
        setWarm([from, to]);
        // Тянем картинки в кэш браузера, чтобы проигрывание не ждало сети.
        for (let n = from; n <= to; n += 1) {
          if (preloaded.current.has(n)) continue;
          preloaded.current.add(n);
          const img = new Image();
          img.src = videoFrameUrl(taskId, videoId, n);
        }
      } catch {
        // Прогрев — ускорение, а не условие работы: кадр всё равно приедет
        // обычным запросом, просто медленнее.
        asked.current = "";
      }
    },
    [taskId, videoId, lastFrame]
  );

  const ensureWarm = useCallback(
    (frame: number) => {
      if (!warm) {
        warmAround(frame);
        return;
      }
      const [from, to] = warm;
      if (frame - from < REFILL_AT || to - frame < REFILL_AT) warmAround(frame);
    },
    [warm, warmAround]
  );

  return { warm, warmAround, ensureWarm };
}

/** Проигрывание кадрами с ровным ходом времени.
 *
 *  Кадр вычисляется из прошедшего времени, а не «следующий за показанным»:
 *  так пропуск неприехавшего кадра не превращается в замедление ролика.
 */
export function usePlayback(
  fps: number,
  lastFrame: number,
  onFrame: (frame: number) => void
) {
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number>();
  const started = useRef({ at: 0, frame: 0 });

  const stop = useCallback(() => {
    setPlaying(false);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = undefined;
  }, []);

  const start = useCallback(
    (from: number) => {
      started.current = { at: performance.now(), frame: from };
      setPlaying(true);
    },
    []
  );

  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const elapsed = performance.now() - started.current.at;
      const next = started.current.frame + Math.floor((elapsed * fps) / 1000);
      if (next >= lastFrame) {
        onFrame(lastFrame);
        setPlaying(false);
        return;
      }
      onFrame(next);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, fps, lastFrame, onFrame]);

  return { playing, start, stop };
}
