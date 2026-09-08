// Живая связь: одно соединение на вкладку, а не на каждое обучение.
//
// Раньше экран обучения открывал поток на каждый ран. Десять ранов на экране —
// десять занятых потоков сервера, и это при том, что событий на девяти из них
// нет. Теперь соединение одно, а кто именно изменился, говорит само событие.
//
// Мест на сервере конечное число: поток занят на всё время висящего ответа.
// Кончились — сервер отвечает 503, и мы честно уходим на опрос И ГОВОРИМ ОБ
// ЭТОМ ЧЕЛОВЕКУ. Молча перейти на опрос значит оставить его гадать, почему
// полоса дёргается.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { nextDelay, pollEvery, shouldFallBack } from "./backoff";

export interface LiveEvent {
  k: string;              // что за сущность: "run", "prep", "set"
  id: string;             // её номер
  p?: string;             // проект
  s?: string;             // новое состояние, если оно уместилось
  e?: number;             // номер эпохи
}

type Listener = (event: LiveEvent) => void;

interface LiveApi {
  // Подписаться на события одного рода. Возвращает отписку.
  on: (kind: string, fn: Listener) => () => void;
  mode: "live" | "poll" | "off";
  note: string | null;
  // Сколько раз связь просили переподключиться — видно в отладке.
  attempts: number;
}

const Ctx = createContext<LiveApi>({
  on: () => () => undefined,
  mode: "off",
  note: null,
  attempts: 0,
});

export function useLiveApi() {
  return useContext(Ctx);
}

/** Подписка на изменения одной сущности. */
export function useLive(kind: string, fn: Listener) {
  const { on } = useLiveApi();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(
    () => on(kind, (event) => ref.current(event)),
    [on, kind]
  );
}

export function LiveProvider({
  code,
  children,
}: {
  code: string | undefined;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<"live" | "poll" | "off">("off");
  const [note, setNote] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const listeners = useRef(new Map<string, Set<Listener>>());

  const on = useCallback((kind: string, fn: Listener) => {
    const set = listeners.current.get(kind) ?? new Set<Listener>();
    set.add(fn);
    listeners.current.set(kind, set);
    return () => {
      set.delete(fn);
    };
  }, []);

  const emit = useCallback((event: LiveEvent) => {
    listeners.current.get(event.k)?.forEach((fn) => fn(event));
    // «Пересчитай всё» приходит без вида сущности: слушают его все.
    if (event.k === "*") {
      listeners.current.forEach((set) => set.forEach((fn) => fn(event)));
    }
  }, []);

  useEffect(() => {
    if (!code) {
      setMode("off");
      return;
    }
    let source: EventSource | null = null;
    let timer: number | undefined;
    let tries = 0;
    let alive = true;

    const toPolling = (why: string) => {
      if (!alive) return;
      setMode("poll");
      setNote(why);
    };

    const connect = () => {
      if (!alive) return;
      source = new EventSource(`/api/projects/${code}/stream`);

      source.addEventListener("hello", () => {
        tries = 0;
        setAttempts(0);
        setMode("live");
        setNote(null);
      });
      source.addEventListener("change", (raw) => {
        try {
          emit(JSON.parse((raw as MessageEvent).data) as LiveEvent);
        } catch {
          /* мусор в потоке — не повод падать */
        }
      });
      source.addEventListener("resync", () => {
        emit({ k: "*", id: "" });
      });
      source.onerror = () => {
        source?.close();
        source = null;
        tries += 1;
        setAttempts(tries);
        if (shouldFallBack(tries)) {
          toPolling(
            "Живая связь занята — обновляю опросом раз в полторы секунды."
          );
          return;
        }
        timer = window.setTimeout(connect, nextDelay(tries));
      };
    };

    connect();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      source?.close();
    };
  }, [code, emit]);

  // Запасной путь: пока живой связи нет, спрашиваем состояние одной ручкой на
  // весь раздел — а не по запросу на каждое обучение.
  useEffect(() => {
    if (mode !== "poll" || !code) return;
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      if (!alive) return;
      let busy = false;
      try {
        const res = await fetch(`/api/projects/${code}/live`);
        if (res.ok) {
          const data = (await res.json()) as {
            runs?: { id: string; status: string }[];
          };
          busy = (data.runs?.length ?? 0) > 0;
          data.runs?.forEach((run) =>
            emit({ k: "run", id: run.id, s: run.status })
          );
        }
      } catch {
        /* сеть моргнула — придём снова */
      }
      const every = pollEvery(busy, document.hidden);
      timer = window.setTimeout(tick, every || 5000);
    };

    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [mode, code, emit]);

  const api = useMemo(
    () => ({ on, mode, note, attempts }),
    [on, mode, note, attempts]
  );

  return (
    <Ctx.Provider value={api}>
      {note && (
        <div className="g-live-note" role="status">
          {note}
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}
