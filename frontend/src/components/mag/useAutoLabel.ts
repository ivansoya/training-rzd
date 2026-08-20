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
  // Сколько раз эффект сессии сейчас «жив». В строгом режиме React монтирует
  // дважды, и без этого счётчика уборка первого монтажа закрывала бы сессию,
  // которую уже взял второй.
  const mounted = useRef(0);

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
    mounted.current += 1;
    let alive = true;
    setState("starting");
    openAutoSession()
      .then(({ session_id }) => {
        // Сессия у пользователя одна на модель, и сервер на повторный запрос
        // отдаёт ту же самую. Поэтому закрывать её из устаревшего вызова
        // нельзя — ею уже пользуется следующий монтаж. В строгом режиме React
        // это происходит на каждом входе в редактор: эффект зовут дважды, и
        // «наш вызов устарел» приходит уже после того, как второй монтаж взял
        // ту же сессию себе.
        session.current = session_id;
        if (alive) {
          setState("ready");
        } else if (mounted.current === 0) {
          // А вот если редактор и правда закрыли, пока сессия открывалась —
          // прощаемся: держать кодировщик ради ушедшего незачем.
          closeAutoSession(session_id);
          session.current = null;
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setState("error");
      });
    return () => {
      alive = false;
      mounted.current -= 1;
      // Строгий режим сейчас смонтирует заново — сессия ещё пригодится.
      if (mounted.current > 0) return;
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

  const warm = useCallback(
    async (ref: AutoFrameRef | null, cacheKey: string | null) => {
      if (!ref || !cacheKey || !session.current || warmed.current.has(cacheKey)) return;
      warmed.current.add(cacheKey);
      const sid = session.current;
      try {
        // Кадра видео на сервере может не существовать вовсе: пока разметка
        // не закрыта, кадры — это номера, а не файлы. Просим редактор достать
        // его до прогрева, а не после отказа: раньше `ensureFrame` звался
        // только из `predict`, поэтому для видео прогрев не срабатывал ни
        // разу — каждый первый клик платил полную цену кодировщика, а в
        // консоль сыпались 409.
        if (ensureRef.current) await ensureRef.current(ref);
        await warmAutoFrame(sid, ref);
      } catch (err) {
        const message = (err as Error).message;
        try {
          if ((err as { code?: string }).code === "frame_not_ready") {
            // Кадр вытеснили из кэша между двумя нашими запросами. Достаём и
            // повторяем один раз — дальше это уже не наша забота.
            await ensureRef.current?.(ref);
            await warmAutoFrame(sid, ref);
            return;
          }
          if (/сесси/i.test(message)) {
            // Сессия могла умереть по молчанию или вместе с перезапуском
            // сервиса. Поднимаем новую и греем в неё — ровно как это делает
            // `predict`. Разметчику знать об этом незачем.
            await warmAutoFrame(await reopen(), ref);
            warmed.current.add(cacheKey);
            return;
          }
        } catch {
          // не вышло — пусть попробует следующий заход
        }
        warmed.current.delete(cacheKey);
      }
    },
    [reopen]
  );

  useEffect(() => {
    if (state !== "ready") return;
    // Пауза перед прогревом. Пока разметчик тянет ползунок, кадр меняется
    // десятки раз в секунду, и греть каждый — значит гонять кодировщик по
    // кадрам, которых никто не увидит. Греем тот, на котором остановились.
    const here = window.setTimeout(() => void warm(frameRef.current, key), 250);
    // Соседний кадр — следом, чтобы первый клик по нему тоже был мгновенным.
    const next = window.setTimeout(() => void warm(nextRef.current, nextKey), 650);
    return () => {
      window.clearTimeout(here);
      window.clearTimeout(next);
    };
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
