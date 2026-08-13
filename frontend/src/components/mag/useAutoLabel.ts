import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  autoFrameKey,
  autoPredict,
  closeAutoSession,
  openAutoSession,
  warmAutoFrame,
} from "../../auth/api";
import type { AutoFrameRef, AutoPoint, AutoRefine, AutoShape } from "../../auth/api";

/** Сессия полуавтоматической разметки на время жизни редактора.
 *
 * Модель поднимается на сервере не мгновенно (первый раз — десятки секунд),
 * поэтому сессия открывается сразу при входе, а инструмент до готовности
 * приглушён. Кодировщик кадра — самая дорогая часть, и он греется заранее:
 * текущий кадр, следом соседний. Клик после прогрева отвечает за миллисекунды.
 *
 * Кадром может быть и изображение таски, и кадр размечаемого видео — хук
 * работает со ссылкой на кадр и не знает, что за ней стоит.
 */
export type AutoState = "off" | "starting" | "ready" | "error";

// Раз в минуту напоминаем о себе: сессию снимает молчание, а разметчик может
// долго рассматривать кадр, ничего не нажимая. Открытие идемпотентно — на
// живую сессию сервер вернёт её же.
const PING_EVERY = 60_000;

export function useAutoLabel(
  frame: AutoFrameRef | null,
  nextFrame?: AutoFrameRef | null,
  /** Кадр видео мог быть вытеснен из распакованного кэша. Редактор умеет его
   *  вернуть — запросить картинку кадра, — и передаёт сюда этот способ. */
  ensureFrame?: (ref: AutoFrameRef) => Promise<void>
) {
  const [state, setState] = useState<AutoState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useRef<string | null>(null);
  const warmed = useRef<Set<string>>(new Set());

  const key = useMemo(() => autoFrameKey(frame), [frame]);
  const nextKey = useMemo(() => autoFrameKey(nextFrame ?? null), [nextFrame]);
  // Ссылки живут в ref: они пересобираются на каждый кадр, и без этого
  // predict пересоздавался бы вместе с ними, дёргая всех подписчиков.
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const nextRef = useRef(nextFrame ?? null);
  nextRef.current = nextFrame ?? null;
  const ensureRef = useRef(ensureFrame);
  ensureRef.current = ensureFrame;

  useEffect(() => {
    let alive = true;
    setState("starting");
    openAutoSession()
      .then(({ session_id }) => {
        if (!alive) {
          closeAutoSession(session_id);
          return;
        }
        session.current = session_id;
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setState("error");
      });
    return () => {
      alive = false;
      // Прощаемся явно; закрытую вкладку добьёт TTL на сервере.
      if (session.current) closeAutoSession(session.current);
      session.current = null;
    };
  }, []);

  /** Новая сессия взамен потерянной. Кэш прогретых кадров при этом обнуляется:
   *  эмбеддинги жили в том процессе, которого больше нет. */
  const reopen = useCallback(async () => {
    const { session_id } = await openAutoSession();
    session.current = session_id;
    warmed.current.clear();
    return session_id;
  }, []);

  const warm = useCallback((ref: AutoFrameRef | null, cacheKey: string | null) => {
    if (!ref || !cacheKey || !session.current || warmed.current.has(cacheKey)) return;
    warmed.current.add(cacheKey);
    warmAutoFrame(session.current, ref).catch(() => warmed.current.delete(cacheKey));
  }, []);

  useEffect(() => {
    if (state !== "ready") return;
    warm(frameRef.current, key);
    // Соседний кадр — фоном, чтобы первый клик по нему тоже был мгновенным.
    const t = window.setTimeout(() => warm(nextRef.current, nextKey), 400);
    return () => window.clearTimeout(t);
  }, [state, key, nextKey, warm]);

  useEffect(() => {
    if (state !== "ready") return;
    const id = window.setInterval(() => {
      openAutoSession()
        .then(({ session_id }) => {
          // Сервер перезапустили — сессия новая, прогрев придётся повторить.
          if (session_id !== session.current) {
            session.current = session_id;
            warmed.current.clear();
          }
        })
        .catch(() => {});
    }, PING_EVERY);
    return () => window.clearInterval(id);
  }, [state]);

  const predict = useCallback(
    async (
      prompts: { points?: AutoPoint[]; box?: { x: number; y: number; w: number; h: number } },
      refine: AutoRefine
    ): Promise<AutoShape | null> => {
      const ref = frameRef.current;
      if (!session.current || !ref) return null;
      const cacheKey = autoFrameKey(ref);
      setBusy(true);
      setError(null);
      try {
        let sid = session.current;
        let res;
        try {
          res = await autoPredict(sid, ref, prompts, refine);
        } catch (e) {
          const message = (e as Error).message;
          const code = (e as { code?: string }).code;
          if (code === "frame_not_ready") {
            // Кадр видео вытеснили из распакованного кэша — просим редактор
            // вернуть его и повторяем. Разметчику об этом знать незачем.
            await ensureRef.current?.(ref);
            if (cacheKey) warmed.current.delete(cacheKey);
            await warmAutoFrame(sid, ref);
            if (cacheKey) warmed.current.add(cacheKey);
            res = await autoPredict(sid, ref, prompts, refine);
          } else if (/сесси/i.test(message)) {
            // Сессия могла умереть по молчанию или вместе с перезапуском
            // сервиса. Молча поднимаем новую и повторяем — разметчик не должен
            // узнавать о внутренностях сервера из сообщения об ошибке.
            sid = await reopen();
            await warmAutoFrame(sid, ref);
            if (cacheKey) warmed.current.add(cacheKey);
            res = await autoPredict(sid, ref, prompts, refine);
          } else {
            throw e;
          }
        }
        if (!res.shapes.length) {
          setError(res.reason === "low_score" ? "Модель не уверена — уточните точками." : null);
          return null;
        }
        return res.shapes[0];
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reopen]
  );

  return { state, error, busy, predict, setError };
}
