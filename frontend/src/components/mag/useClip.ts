import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClip } from "../../auth/api";
import type { ClipManifest, ClipPreparing, ClipProgress } from "../../auth/api";
import { ClipPending, ClipReader, ClipStalled, webCodecsMissing } from "./clipReader";
import { clipLog } from "./clipLog";
import { frameAt, tickClock } from "./playback";
import type { Quality } from "./clipReader";

/** Ролик в редакторе: манифест, разжатие кадра и проигрывание.
 *
 * Кадр не приезжает картинкой — его достаёт `ClipReader` из перегона. Наружу
 * отдаётся `ImageBitmap`: копию снимает читатель сразу на выходе декодера и
 * тут же отпускает сам кадр. Держать `VideoFrame` открытым значит держать
 * занятым буфер декодера, а их у него считанные единицы.
 */

export interface Clip {
  manifest: ClipManifest | null;
  reader: ClipReader | null;
  loading: boolean;
  error: string | null;
  /** Ролик ещё готовится: таблица кадров, копия ступени, перегоны. Это не
   *  ошибка — тяжёлую работу делает воркер, и у неё есть ход. */
  preparing: ClipPreparing | null;
  /** Что именно сейчас делается и насколько — для полосы, а не для точки. */
  progress: ClipProgress | null;
  /** Повторить. Нужна на случай, когда бэкенд перезапустили под рукой:
   *  раньше единственным выходом была перезагрузка страницы. */
  retry: () => void;
}

export function useClip(taskId: string, videoId: string): Clip {
  const [manifest, setManifest] = useState<ClipManifest | null>(null);
  const [reader, setReader] = useState<ClipReader | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState<ClipPreparing | null>(null);
  const [progress, setProgress] = useState<ClipProgress | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    let made: ClipReader | null = null;
    let timer = 0;
    const stop = new AbortController();
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

    /** Спрашиваем, пока ролик готовится. Ждать ответа на одном соединении
     *  нельзя: подготовка длинного ролика — это минуты, и всё это время
     *  висел бы занятый поток на сервере. */
    const ask = () => {
      fetchClip(taskId, videoId, undefined, stop.signal)
        .then((body) => {
          if (!live) return;
          if (body.status === "preparing") {
            setPreparing(body);
            setProgress(
              body.processed === undefined
                ? null
                : {
                    kind: body.stage,
                    quality: null,
                    status: "running",
                    processed: body.processed,
                    total: body.total ?? 0,
                  }
            );
            timer = window.setTimeout(ask, body.retry_after_ms || 700);
            return;
          }
          setPreparing(null);
          setProgress(body.progress);
          setManifest(body);
          if (!made) {
            made = new ClipReader(taskId, videoId, body);
            made.onProgress = (p) => {
              if (live) setProgress(p);
            };
            setReader(made);
          }
          setLoading(false);
          // Ступени доготавливаются уже после того, как ролик открылся.
          // Читатель при этом не пересоздаётся: перечень перегонов и номера
          // кадров у ролика одни, меняется только готовность ступеней —
          // обновляем манифест, чтобы меню качества перестало врать.
          //
          // «Исходное» из условия исключено намеренно: его готовят только по
          // просьбе, само оно готовым не станет никогда, и опрос из-за него
          // не прекращался бы до закрытия вкладки.
          const waiting = body.qualities.some(
            (q) => q.id !== "src" && !q.ready && !q.failed
          );
          if (waiting) timer = window.setTimeout(ask, 3000);
        })
        .catch((err: Error) => {
          if (!live || stop.signal.aborted) return;
          setPreparing(null);
          setError(err.message);
          setLoading(false);
        });
    };
    ask();

    return () => {
      live = false;
      stop.abort();
      if (timer) window.clearTimeout(timer);
      made?.dispose();
    };
  }, [taskId, videoId, attempt]);

  return { manifest, reader, loading, error, preparing, progress, retry };
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
// Кадр вытеснили из кольца, пока он ехал к экрану. Просим заново почти сразу:
// он уже разжат где-то рядом, и второй заход обычно попадает.
const RETRY_LOST = 80;
// Но не вечно. Если кадр пропадает раз за разом, дело не в гонке, и человеку
// честнее сказать, чем крутить колесо до скончания века.
const LOST_LIMIT = 20;
// Сколько ждём, прежде чем счесть показ застрявшим и попросить кадр заново.
// Больше любого честного ожидания внутри читателя и меньше любого терпения.
const WATCHDOG = 12_000;

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
  // Счётчик повторов: перегон мог ещё не приехать, и тогда мы просто
  // заглядываем снова. Ждать внутри читателя нельзя — очередь разжатия одна
  // на редактор, и ожидание заперло бы и те кадры, что уже разжаты.
  const [tick, setTick] = useState(0);
  // Растёт на каждый запрос: ответ на устаревший запрос выбрасывается, иначе
  // при быстрой перемотке на экране осел бы кадр, который просили давно.
  const want = useRef(0);
  // Сколько раз подряд кадр пропадал под руками. Сбрасывается, как только
  // что-то показали: считаем полосу неудач, а не их общее число.
  const lost = useRef(0);

  useEffect(() => {
    // Пустая ступень — это «ещё не выбрали»: на первой отрисовке она приходит
    // раньше манифеста. Ставить её значило бы сбросить читателю всё, что он
    // успел набрать, и тут же сбросить второй раз, когда придёт настоящая.
    if (!reader || !quality) return;
    reader.setQuality(quality);
  }, [reader, quality]);

  useEffect(() => {
    if (!reader) return undefined;
    const token = (want.current += 1);
    let live = true;
    let dotTimer = 0;
    let retry = 0;

    const stopDot = () => {
      if (dotTimer) window.clearTimeout(dotTimer);
      dotTimer = 0;
    };
    clipLog("показ", `кадр ${frameNo}: заход #${token}, попытка ${tick}`);

    /** Наш ли ещё запрос. Всё, что решает про экран, спрашивает это первым. */
    const mine = () => live && token === want.current;

    const again = (afterMs: number) => {
      if (retry) window.clearTimeout(retry);
      retry = window.setTimeout(() => {
        if (live) setTick((n) => n + 1);
      }, afterMs);
    };

    /** Показать кадр. ``false`` — картинки уже нет, надо просить заново.
     *
     * Копию снимает читатель: в кольце лежат уже `ImageBitmap`, а не кадры
     * декодера. Здесь её только показывают и не закрывают — владелец кольцо,
     * оно же и погасит, когда кадр уйдёт из окна.
     */
    const show = (bitmap: ImageBitmap): boolean => {
      if (!mine()) {
        clipLog("показ", `кадр ${frameNo}: заход #${token} устарел, выходим`);
        return true;
      }
      clipLog("показ", `кадр ${frameNo}: на экране`);
      stopDot();
      lost.current = 0;
      setImage(bitmap);
      setShownNo(frameNo);
      setPending(false);
      setError(null);
      return true;
    };

    /** Кадр пропал под руками. Просим заново — но не бесконечно. */
    const missed = () => {
      stopDot();
      lost.current += 1;
      clipLog("показ", `кадр ${frameNo}: потерян, попытка ${lost.current}`);
      if (lost.current > LOST_LIMIT) {
        setPending(false);
        setError("Кадр не удаётся показать. Попробуйте перемотать ещё раз.");
        return;
      }
      again(RETRY_LOST);
    };

    const deliver = async () => {
      const ready = reader.peek(frameNo);
      clipLog("показ", `кадр ${frameNo}: в кольце ${ready ? "есть" : "нет"}`);
      if (ready && show(ready)) return;
      if (!mine()) {
        clipLog("показ", `кадр ${frameNo}: заход #${token} устарел, выходим`);
        return;
      }

      dotTimer = window.setTimeout(() => {
        if (mine()) setPending(true);
      }, PENDING_AFTER);

      let frame: ImageBitmap | null;
      try {
        frame = await reader.frame(frameNo);
      } catch (err) {
        if (!mine()) return;
        if (err instanceof ClipPending) {
          // Перегон ещё едет или готовится на сервере. Это не ошибка:
          // показываем прежний кадр с точкой ожидания и заглядываем снова.
          setPending(true);
          again(err.retryAfterMs);
          return;
        }
        if (err instanceof ClipStalled) {
          // Декодер задумался и не отозвался в срок. Это не поломка кадра —
          // на следующем заходе он заводится заново и обычно отвечает.
          missed();
          return;
        }
        clipLog("показ", `кадр ${frameNo}: ошибка —`, (err as Error).message);
        stopDot();
        setPending(false);
        setError((err as Error).message);
        return;
      }
      if (!mine()) return;
      if (!frame) {
        // Кадра не дали. Обычно это значит «просьба устарела» — но тогда нас
        // уже сменил новый запрос, и до сюда мы не дошли бы. Значит кадр
        // вытеснили из кольца, пока он разжимался, и просить надо снова.
        // Прежде здесь просто сдавались, и редактор оставался в ожидании
        // навсегда: «показанный кадр» так и не догонял запрошенный.
        missed();
        return;
      }
      if (!show(frame) && mine()) missed();
    };

    void deliver().catch(() => {
      if (mine()) missed();
    });
    reader.warm(frameNo);

    return () => {
      live = false;
      stopDot();
      if (retry) window.clearTimeout(retry);
    };
  }, [reader, frameNo, quality, tick]);

  // Сторож. Всё выше уже устроено так, чтобы ожидание не длилось вечно, но
  // цена ошибки здесь особенная: застрявший показ гасит инструменты и
  // останавливает проигрывание, а выглядит как поломка всего редактора.
  // Поэтому есть и последняя проверка: показанный кадр не догнал запрошенный,
  // и за всё это время ничего не происходило — просим заново.
  useEffect(() => {
    if (shownNo === frameNo) return undefined;
    const t = window.setTimeout(() => {
      clipLog("сторож", `показан ${shownNo}, просят ${frameNo} — просим заново`);
      setTick((n) => n + 1);
    }, WATCHDOG);
    return () => window.clearTimeout(t);
  }, [shownNo, frameNo, tick]);

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
