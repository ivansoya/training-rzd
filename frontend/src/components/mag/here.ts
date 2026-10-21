// «Размечает Имя» на строке ролика (решение 21.10.2026): редактор ролика шлёт пульс,
// страница таски держит человека минуту после последнего. На сервере не хранится.
import { useEffect, useState } from "react";
import { useLive } from "../../live/LiveProvider";

export const BEAT_MS = 20_000;
export const IDLE_MS = 5 * 60_000;
export const STALE_MS = 60_000;

/** ролик → человек → когда слышали */
export type Here = Record<string, Record<string, number>>;

export function hereOn(here: Here, e: { id: string; u?: string; s?: string }, now: number): Here {
  if (!e.u) return here;
  const people = { ...here[e.id] };
  if (e.s === "off") delete people[e.u];
  else people[e.u] = now;
  const out = { ...here, [e.id]: people };
  if (!Object.keys(people).length) delete out[e.id];
  return out;
}

/** Без пульса минуту — ушёл: вкладку закрыли без «off» или пропала сеть. Ничего не ушло — тот же объект. */
export function hereSweep(here: Here, now: number): Here {
  let gone = false;
  const out: Here = {};
  for (const [video, people] of Object.entries(here)) {
    const kept = Object.entries(people).filter(([, at]) => now - at < STALE_MS);
    gone ||= kept.length !== Object.keys(people).length;
    if (kept.length) out[video] = Object.fromEntries(kept);
  }
  return gone ? out : here;
}

/** Имена по участникам проекта: в событии их нет — потолок уведомления 200 байт. */
export function hereNames(here: Here, video: string, people: { id: string; display_name: string }[]): string[] {
  return Object.keys(here[video] || {})
    .map((u) => people.find((p) => p.id === u)?.display_name || "—")
    .sort((a, b) => a.localeCompare(b, "ru"));
}

/** Страница таски: кто сейчас в каком ролике (чужие ролики сюда тоже попадают — их строк на странице нет). */
export function useHere(): Here {
  const [here, setHere] = useState<Here>({});
  useLive("here", (e) => setHere((h) => hereOn(h, e, Date.now())));
  const anyone = Object.keys(here).length > 0;
  useEffect(() => {
    if (!anyone) return;
    const timer = window.setInterval(() => setHere((h) => hereSweep(h, Date.now())), 10_000);
    return () => window.clearInterval(timer);
  }, [anyone]);
  return here;
}

/** Редактор ролика: пульс, пока вкладку видно и человек что-то делал за 5 минут; иначе — «ушёл». */
export function useHereBeat(taskId: string, videoId: string, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const url = `/api/tasks/${taskId}/videos/${videoId}/here`;
    let last = Date.now();
    let sent = false;
    const send = (off: boolean) => {
      sent = !off;
      // keepalive — «ушёл» доходит и из закрываемой вкладки
      void fetch(off ? `${url}?off=1` : url, { method: "POST", keepalive: off }).catch(() => undefined);
    };
    const tick = () => {
      if (document.visibilityState === "visible" && Date.now() - last < IDLE_MS) send(false);
      else if (sent) send(true);
    };
    const touch = () => {
      last = Date.now();
      if (!sent && document.visibilityState === "visible") send(false);
    };
    const leave = () => { if (sent) send(true); };
    tick();
    const timer = window.setInterval(tick, BEAT_MS);
    const acts = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
    for (const a of acts) window.addEventListener(a, touch, { capture: true, passive: true });
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("pagehide", leave);
    return () => {
      window.clearInterval(timer);
      for (const a of acts) window.removeEventListener(a, touch, { capture: true });
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [taskId, videoId, on]);
}
