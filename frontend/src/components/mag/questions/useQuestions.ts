// Вопросы таски для страницы и редакторов: список, живая связь и действия, которые сразу кладут ответ сервера на место.
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../../api/questions";
import type { Question, QuestionPlace } from "../../../api/questions";
import { useLive } from "../../../live/LiveProvider";

export interface QuestionsApi {
  list: Question[] | null;
  canAsk: boolean;
  error: string | null;
  ask: (where: QuestionPlace, text: string) => Promise<Question | null>;
  reply: (id: string, text: string) => Promise<void>;
  edit: (id: string, mid: string, text: string) => Promise<void>;
  remove: (id: string, mid: string) => Promise<void>;
  resolve: (id: string) => Promise<void>;
  reopen: (id: string) => Promise<void>;
  drop: (id: string) => Promise<void>;
  /** Обсуждение открыли — из колокольчика уходит. */
  read: (id: string) => void;
  reload: () => Promise<void>;
}

export function useQuestions(taskId: string | null | undefined, me: string): QuestionsApi {
  const [list, setList] = useState<Question[] | null>(null);
  const [canAsk, setCanAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const round = useRef(0);

  const reload = useCallback(async () => {
    if (!taskId) return;
    const mine = ++round.current;
    try {
      const got = await api.listQuestions(taskId);
      if (mine !== round.current) return;
      setList(got.questions);
      setCanAsk(got.can_ask);
    } catch (e) {
      if (mine === round.current) setError((e as Error).message);
    }
  }, [taskId]);

  useEffect(() => { setList(null); void reload(); }, [reload]);

  // Сосед спросил или ответил — перечитываем; свои правки уже на месте из ответа
  useLive("question", (e) => {
    if (e.id === taskId && e.u !== me) void reload();
  });

  const put = (q: Question) => setList((prev) => {
    const rest = (prev ?? []).filter((x) => x.id !== q.id);
    return [q, ...rest].sort((a, b) => b.last_at.localeCompare(a.last_at));
  });
  const run = async (fn: () => Promise<Question>) => {
    if (!taskId) return;
    setError(null);
    try { put(await fn()); } catch (e) { setError((e as Error).message); }
  };
  const id = taskId ?? "";

  return {
    list, canAsk, error, reload,
    ask: async (where, text) => {
      setError(null);
      try { const q = await api.askQuestion(id, where, text); put(q); return q; }
      catch (e) { setError((e as Error).message); return null; }
    },
    reply: (qid, text) => run(() => api.replyQuestion(id, qid, text)),
    edit: (qid, mid, text) => run(() => api.editMessage(id, qid, mid, text)),
    remove: (qid, mid) => run(() => api.deleteMessage(id, qid, mid)),
    resolve: (qid) => run(() => api.resolveQuestion(id, qid)),
    reopen: (qid) => run(() => api.reopenQuestion(id, qid)),
    drop: async (qid) => {
      setError(null);
      try { await api.dropQuestion(id, qid); setList((prev) => (prev ?? []).filter((x) => x.id !== qid)); }
      catch (e) { setError((e as Error).message); }
    },
    read: (qid) => { void api.readQuestion(id, qid).catch(() => undefined); },
  };
}
