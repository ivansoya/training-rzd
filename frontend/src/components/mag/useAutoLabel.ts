import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoPredict,
  closeAutoSession,
  openAutoSession,
  warmAutoFrame,
} from "../../auth/api";
import type { AutoPoint, AutoRefine, AutoShape } from "../../auth/api";

/** Сессия полуавтоматической разметки на время жизни редактора.
 *
 * Модель поднимается на сервере не мгновенно (первый раз — десятки секунд),
 * поэтому сессия открывается сразу при входе, а инструмент до готовности
 * приглушён. Кодировщик кадра — самая дорогая часть, и он греется заранее:
 * текущий кадр, следом соседний. Клик после прогрева отвечает за миллисекунды.
 */
export type AutoState = "off" | "starting" | "ready" | "error";

// Раз в минуту напоминаем о себе: сессию снимает молчание, а разметчик может
// долго рассматривать кадр, ничего не нажимая. Открытие идемпотентно — на
// живую сессию сервер вернёт её же.
const PING_EVERY = 60_000;

export function useAutoLabel(imageId: string | undefined, nextImageId?: string) {
  const [state, setState] = useState<AutoState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useRef<string | null>(null);
  const warmed = useRef<Set<string>>(new Set());

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

  const warm = useCallback((id: string | undefined) => {
    if (!id || !session.current || warmed.current.has(id)) return;
    warmed.current.add(id);
    warmAutoFrame(session.current, id).catch(() => warmed.current.delete(id));
  }, []);

  useEffect(() => {
    if (state !== "ready") return;
    warm(imageId);
    // Соседний кадр — фоном, чтобы первый клик по нему тоже был мгновенным.
    const t = window.setTimeout(() => warm(nextImageId), 400);
    return () => window.clearTimeout(t);
  }, [state, imageId, nextImageId, warm]);

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
      if (!session.current || !imageId) return null;
      setBusy(true);
      setError(null);
      try {
        let sid = session.current;
        let res;
        try {
          res = await autoPredict(sid, imageId, prompts, refine);
        } catch (e) {
          // Сессия могла умереть по молчанию или вместе с перезапуском
          // сервиса. Молча поднимаем новую и повторяем — разметчик не должен
          // узнавать о внутренностях сервера из сообщения об ошибке.
          if (!/сесси/i.test((e as Error).message)) throw e;
          sid = await reopen();
          await warmAutoFrame(sid, imageId);
          warmed.current.add(imageId);
          res = await autoPredict(sid, imageId, prompts, refine);
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
    [imageId, reopen]
  );

  return { state, error, busy, predict, setError };
}
