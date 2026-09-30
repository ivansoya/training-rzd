// Разведка ролика на шкалах: полоса в нарезке, строки в редакторе ролика,
// кнопка у ролика.
//
// Решения владельца (24.09.2026): разведка — информация, а не разметка. В
// нарезке — одна полоса ровно под лентой, у каждого класса в ней своя
// дорожка; чипы под ней гасят классы, «Участки в план» добавляет участки
// горящих классов в план, дальше их правят как обычные. В редакторе
// размечаемого ролика — строки сетки TrackLanes, только для чтения.

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import * as api from "../../api/agents";
import { useLive } from "../../live/LiveProvider";
import FramePeek from "./FramePeek";
import { nearest, scoutColors } from "./scoutMath";

export interface ScoutLane {
  name: string;
  color: string;
  /** Кадры включительно и сколько проверенных кадров дали попадание. */
  spans: [number, number, number][];
}

/** Цвета классов на всю таску — по всем её разведкам. */
export function taskColors(scouts: Record<string, api.Scout>): Map<string, string> {
  return scoutColors(Object.values(scouts).flatMap((s) => Object.keys(s.segments)));
}

/** Полосы разведки одного ролика, классы по алфавиту. */
export function scoutLanes(scout: api.Scout | undefined, colors: Map<string, string>): ScoutLane[] {
  if (!scout) return [];
  return Object.keys(scout.segments)
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((name) => ({ name, color: colors.get(name) ?? "#9aa4ae", spans: scout.segments[name] }));
}

/** Разведка роликов таски: {ролик: разведка}. Пусто, пока агент не смотрел.
 *  Прогон кончился — перечитываем: кнопка у ролика не должна ждать
 *  перезагрузки страницы. */
// Метка «ещё не пришло»: пустой ответ сервера — другой объект, и по нему
// окно общей статистики отличает «разведок нет» от «загружаю».
const PENDING: Record<string, api.Scout> = {};
export const scoutsPending = (scouts: Record<string, api.Scout>) => scouts === PENDING;

export function useScouts(taskId: string) {
  const [scouts, setScouts] = useState<Record<string, api.Scout>>(PENDING);
  const [tick, setTick] = useState(0);
  useLive("agent", (event) => {
    if (event.s === "done") setTick((t) => t + 1);
  });
  useEffect(() => {
    api.taskScouts(taskId).then((r) => setScouts(r.scouts)).catch(() => setScouts({}));
  }, [taskId, tick]);
  return scouts;
}

const msOf = (frame: number, fps: number) => Math.round((frame * 1000) / fps);
// Дорожка класса в полосе нарезки: 4 px и зазор в 1 px.
const LANE = 4;
const GAP = 1;

/** Полоса разведки ровно под лентой нарезки, в её же окне `view` (мс). */
export function ScoutBand({ taskId, videoId, scout, colors, view, at, editable, onSeek, onPlan, onWheel, children }: {
  taskId: string;
  videoId: string;
  scout: api.Scout;
  colors: Map<string, string>;
  view: { start: number; span: number };
  /** Где сейчас плеер, мс. */
  at: number;
  editable: boolean;
  onSeek: (ms: number) => void;
  onPlan: (ranges: [number, number][]) => void;
  /** Колесо над полосой — то же приближение, что над лентой. */
  onWheel: (ratio: number, deltaY: number, shift: boolean) => void;
  /** Шкала времени ленты: встаёт между полосой и чипами. */
  children?: ReactNode;
}) {
  const fps = scout.fps || 25;
  const lanes = scoutLanes(scout, colors);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<api.ScoutStats | null>(null);
  const [hover, setHover] = useState<{ frame: number; x: number; y: number } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const wheel = useRef(onWheel);
  wheel.current = onWheel;

  // Счёт по кадрам нужен только карточке при наведении — полоса рисуется по
  // участкам и ждать его не должна.
  useEffect(() => {
    let alive = true;
    api.scoutStats(taskId, videoId).then((s) => alive && setStats(s)).catch(() => {});
    return () => { alive = false; };
  }, [taskId, videoId, scout.created_at]);

  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const listen = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      wheel.current(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), e.deltaY, e.shiftKey);
    };
    el.addEventListener("wheel", listen, { passive: false });
    return () => el.removeEventListener("wheel", listen);
  }, []);

  const shown = lanes.filter((l) => !off.has(l.name));
  if (!lanes.length) return <>{children}</>;

  const a = (view.start / 1000) * fps;
  const span = Math.max(1, (view.span / 1000) * fps);
  const height = Math.max(1, shown.length) * (LANE + GAP) + 3;
  const frameAt = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return a + ((e.clientX - r.left) / Math.max(1, r.width)) * span;
  };
  const i = stats && hover ? nearest(stats.checked, hover.frame) : null;

  return (
    <div className="ag-band">
      <div className="ag-band-bar" ref={bar} style={{ height }}
        onPointerDown={(e) => { if (e.button === 0) onSeek(msOf(frameAt(e), fps)); }}
        onPointerMove={(e) => setHover({ frame: frameAt(e), x: e.clientX, y: e.clientY })}
        onPointerLeave={() => setHover(null)}>
        <svg viewBox={`${a} 0 ${span} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
          {shown.map((l, k) => l.spans.map(([s, e]) => (
            <rect key={`${l.name}:${s}`} x={s} y={2 + k * (LANE + GAP)} width={e - s + 1} height={LANE} style={{ fill: l.color }} />
          )))}
        </svg>
        <i className="ag-band-head" style={{ left: `${((at - view.start) / Math.max(1, view.span)) * 100}%` }} />
      </div>
      {children}
      <div className="ag-band-legend">
        <span className="ag-band-title" title={`«${scout.agent ?? "агент"}», каждый ${scout.step}-й кадр`}>Разведка</span>
        {lanes.map((l) => (
          <button key={l.name} type="button" className="ag-band-chip" aria-pressed={!off.has(l.name)}
            title={`${l.spans.length} уч. — нажмите, чтобы ${off.has(l.name) ? "показать" : "скрыть"}`}
            onClick={() => setOff((prev) => {
              const next = new Set(prev);
              if (next.has(l.name)) next.delete(l.name);
              else next.add(l.name);
              return next;
            })}>
            <i style={{ background: l.color }} />{l.name}<small>{l.spans.length}</small>
          </button>
        ))}
        <span className="ag-band-sp" />
        {editable && (
          <button type="button" className="mag-ghost mag-ghost-inline" disabled={!shown.length}
            onClick={() => onPlan(shown.flatMap((l) =>
              l.spans.map(([s, e]) => [msOf(s, fps), msOf(e + 1, fps)] as [number, number])))}>
            Участки в план
          </button>
        )}
      </div>
      {hover && stats && i !== null && (
        <FramePeek taskId={taskId} videoId={videoId} frame={stats.checked[i]} fps={fps} x={hover.x} y={hover.y}
          rows={stats.classes.filter((c) => c.counts[i] && !off.has(c.name)).map((c) => ({
            name: c.name, color: colors.get(c.name) ?? "#9aa4ae", count: c.counts[i],
          }))} />
      )}
    </div>
  );
}

/** Кнопка «Разведка» у ролика — окно его статистики. Что нашлось, здесь не
 *  перечисляется: строка сводки читалась как подпись, а не как вход. */
export function ScoutButton({ scout, onOpen }: { scout?: api.Scout; onOpen: () => void }) {
  if (!scout) return null;
  return (
    <button className="ag-scout-btn" type="button" onClick={onOpen}
      title={`Разведка «${scout.agent ?? "агент"}», каждый ${scout.step}-й кадр — статистика`}>
      Разведка
    </button>
  );
}
