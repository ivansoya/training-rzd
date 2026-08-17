import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClip } from "../../auth/api";
import type { ClipManifest } from "../../auth/api";
import { ClipReader, webCodecsMissing } from "./clipReader";
import { frameAt, tickClock } from "./playback";
import type { Quality } from "./clipReader";

/** Ролик в редакторе: манифест, разжатие кадра и проигрывание.
 *
 * Кадр не приезжает картинкой — его достаёт `ClipReader` из перегона. Наружу
 * отдаётся `ImageBitmap`, а не сырой кадр декодера: сырые кадры живут в кольце
 * и закрываются, когда курсор уходит, и нарисовать закрытый — это исключение
 * посреди отрисовки. Копия на экран стоит одного кадра и снимает вопрос.
 */

export interface Clip {
  manifest: ClipManifest | null;
  reader: ClipReader | null;
  loading: boolean;
  error: string | null;
}

export function useClip(taskId: string, videoId: string): Clip {
  const [manifest, setManifest] = useState<ClipManifest | null>(null);
  const [reader, setReader] = useState<ClipReader | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    let made: ClipReader | null = null;
    setLoading(true);
    setError(null);

    if (webCodecsMissing()) {
      setError(
        "Этот браузер не умеет разжимать видео покадрово. " +
          "Откройте разметку в Chrome, Edge или Safari посвежее."
      );
      setLoading(false);
      return () => undefined;
    }

    fetchClip(taskId, videoId)
      .then((body) => {
        if (!live) return;
        made = new ClipReader(taskId, videoId, body);
        setManifest(body);
        setReader(made);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      made?.dispose();
    };
  }, [taskId, videoId]);

  return { manifest, reader, loading, error };
}

export interface ShownFrame {
  image: ImageBitmap | null;
  /** Кадр ещё разжимается: показывать предыдущий, а не пустоту. */
  pending: boolean;
  /** На холсте не тот кадр, который просили. Рисовать в это время нельзя:
   *  бокс уехал бы на кадр, которого разметчик не видел. */
  lagging: boolean;
  error: string | null;
}

// Короткие ожидания глаз не читает, а точка, мигающая на каждом шаге, — шум.
// Показываем её, только если ждём заметно.
const PENDING_AFTER = 250;

/** Картинка запрошенного кадра. Предыдущая держится, пока не приедет новая. */
export function useClipFrame(
  reader: ClipReader | null,
  frameNo: number,
  quality: Quality
): ShownFrame {
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [pending, setPending] = useState(false);
  const [shownNo, setShownNo] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Растёт на каждый запрос: ответ на устаревший запрос выбрасывается, иначе
  // при быстрой перемотке на экране осел бы кадр, который просили давно.
  const want = useRef(0);
  const shown = useRef<ImageBitmap | null>(null);

  useEffect(() => {
    if (!reader) return;
    reader.setQuality(quality);
  }, [reader, quality]);

  useEffect(() => {
    if (!reader) return undefined;
    const token = (want.current += 1);
    let live = true;
    let dotTimer = 0;

    const stopDot = () => {
      if (dotTimer) window.clearTimeout(dotTimer);
      dotTimer = 0;
    };

    const show = async (frame: VideoFrame) => {
      const bitmap = await createImageBitmap(frame);
      if (!live || token !== want.current) {
        bitmap.close();
        return;
      }
      stopDot();
      shown.current?.close();
      shown.current = bitmap;
      setImage(bitmap);
      setShownNo(frameNo);
      setPending(false);
      setError(null);
    };

    const ready = reader.peek(frameNo);
    if (ready) {
      void show(ready);
    } else {
      dotTimer = window.setTimeout(() => {
        if (live && token === want.current) setPending(true);
      }, PENDING_AFTER);
      reader
        .frame(frameNo)
        .then((frame) => {
          if (!live || token !== want.current) return;
          if (!frame) {
            // Просьба устарела: курсор ушёл дальше, пока кадр разжимали.
            // При проигрывании такого больше не бывает — время ждёт картинку;
            // остаётся протяжка ползунка, где промежуточные кадры не нужны.
            stopDot();
            setPending(false);
            return;
          }
          return show(frame);
        })
        .catch((err: Error) => {
          if (!live || token !== want.current) return;
          stopDot();
          setPending(false);
          setError(err.message);
        });
    }
    reader.warm(frameNo);

    return () => {
      live = false;
      stopDot();
    };
  }, [reader, frameNo, quality]);

  useEffect(
    () => () => {
      shown.current?.close();
      shown.current = null;
    },
    []
  );

  return { image, pending, lagging: shownNo !== frameNo, error };
}

/** Проигрывание кадрами.
 *
 * Кадр считается из прошедшего времени, а не как «следующий за показанным»:
 * так ролик идёт с постоянной скоростью, а не рывками по мере разжатия.
 *
 * Но **время стоит, пока картинка не догнала**. Сперва было иначе: часы шли
 * ровно, а не успевшие кадры пропускались — считалось, что искать момент
 * важнее, чем увидеть каждый кадр. На деле это выглядело как пропажа куска
 * ролика: полоса бежит, кадр замер, и что было в пропущенном месте, никто не
 * узнает. Для разметки это негодно — мимо может уйти ровно тот объект, ради
 * которого ролик и смотрят.
 *
 * `caughtUp` отвечает, показан ли уже запрошенный кадр. Пока нет — начало
 * отсчёта сдвигается вперёд ровно на длительность ожидания, и прошедшее время
 * не растёт.
 */
export function usePlayback(
  fps: number,
  lastFrame: number,
  onFrame: (frame: number) => void,
  caughtUp?: () => boolean
) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const raf = useRef<number>();
  const started = useRef({ at: 0, frame: 0 });
  const lastTick = useRef(0);
  // Держим в ссылке: иначе цикл пересобирался бы на каждый показанный кадр.
  const ready = useRef(caughtUp);
  ready.current = caughtUp;

  const stop = useCallback(() => {
    setPlaying(false);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = undefined;
  }, []);

  const start = useCallback((from: number) => {
    started.current = { at: performance.now(), frame: from };
    lastTick.current = performance.now();
    setPlaying(true);
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    lastTick.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const clock = tickClock(
        { ...started.current, last: lastTick.current },
        now,
        ready.current ? ready.current() : true
      );
      started.current = { at: clock.at, frame: clock.frame };
      lastTick.current = clock.last;
      const next = frameAt(clock.frame, now - clock.at, fps, speed, lastFrame);
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
  }, [playing, fps, speed, lastFrame, onFrame]);

  // Смена скорости на ходу не должна прыгать по времени: считаем от текущего.
  const changeSpeed = useCallback(
    (value: number, current: number) => {
      setSpeed(value);
      if (playing) {
        started.current = { at: performance.now(), frame: current };
        lastTick.current = performance.now();
      }
    },
    [playing]
  );

  return { playing, speed, start, stop, changeSpeed };
}
