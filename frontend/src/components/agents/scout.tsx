// Разведка ролика на шкалах: полоса в нарезке, строки в редакторе ролика,
// кнопка у ролика.
//
// Решения владельца: разведка — информация, а не разметка. В нарезке — одна
// полоса ровно под лентой, у каждого класса своя дорожка; её показывают и
// прячут, чипы гасят классы, «Участки в план» добавляет участки горящих
// классов в план. Посмотреть найденное — щелчок по точке проверенного кадра:
// плеер встаёт на кадр, находки — призраками поверх (2026-10-07, вместо
// карточки при наведении). В редакторе ролика — строки дорожек (editor/Lanes).

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import * as api from "../../api/agents";
import { useLive } from "../../live/LiveProvider";
import { cx } from "../../ui";
import { nearestTick } from "../editor/review";
import { scoutColors } from "./scoutMath";

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

/** Находки кадра для показа поверх плеера: имя и цвет — класса проекта, если сопоставлен. */
export type ScoutHit = { name: string; color: string; conf: number; x: number; y: number; w: number; h: number };

/** Находки кадра — имя и цвет класса проекта, если сопоставлен; погашенные классы мимо. */
export function scoutHits(stats: api.ScoutStats | null, frame: number, colors: Map<string, string>,
  off: Set<string> = new Set()): ScoutHit[] {
  return (stats?.frames[String(frame)] || []).filter((d) => !off.has(d[0])).map(([cls, conf, x, y, w, h]) => {
    const m = stats?.mapped[cls];
    return { name: m?.name ?? cls, color: m?.color ?? colors.get(cls) ?? "#9aa4ae", conf, x, y, w, h };
  });
}

/** Полоса разведки ровно под лентой нарезки, в её же окне `view` (мс). */
export function ScoutBand({ scout, stats, colors, view, at, editable, shown: visible, onShown, onSeek, onPick,
  onOff, onPlan, onWheel, children }: {
  scout: api.Scout;
  /** Покадровые находки — точкам полосы и призракам; грузит хозяин, полоса их не ждёт. */
  stats: api.ScoutStats | null;
  colors: Map<string, string>;
  view: { start: number; span: number };
  /** Где сейчас плеер, мс. */
  at: number;
  editable: boolean;
  /** Показана ли полоса: разведку прячут, когда она мешает. */
  shown: boolean;
  onShown: (v: boolean) => void;
  onSeek: (ms: number) => void;
  /** Щелчок по точке проверенного кадра: плеер — на кадр, находки — призраками. */
  onPick: (frame: number) => void;
  /** Погашенные чипами классы — их не показывают и призраками. */
  onOff?: (off: Set<string>) => void;
  onPlan: (ranges: [number, number][]) => void;
  /** Колесо над полосой — то же приближение, что над лентой. */
  onWheel: (ratio: number, deltaY: number, shift: boolean) => void;
  /** Шкала времени ленты: встаёт между полосой и чипами. */
  children?: ReactNode;
}) {
  const fps = scout.fps || 25;
  const lanes = scoutLanes(scout, colors);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [near, setNear] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const wheel = useRef(onWheel);
  wheel.current = onWheel;

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
  }, [visible]);

  const shown = lanes.filter((l) => !off.has(l.name));
  if (!lanes.length) return <>{children}</>;

  const a = (view.start / 1000) * fps;
  const span = Math.max(1, (view.span / 1000) * fps);
  const height = Math.max(1, shown.length) * (LANE + GAP) + 3;
  // Проверенные кадры, где нашлись горящие классы, — точки в окне ленты
  const hitsOf = (f: number) => (stats?.frames[String(f)] || []).filter((d) => !off.has(d[0]));
  const dots = Object.keys(stats?.frames || {}).map(Number)
    .filter((f) => f >= a && f <= a + span && hitsOf(f).length > 0).sort((x, y) => x - y);
  const xs = (w: number) => dots.map((f) => ((f - a) / span) * w);
  const nearAt = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearestTick(xs(r.width), e.clientX - r.left);
  };
  const pick = (f: number) => onPick(f);

  return (
    <div className="ag-band">
      {visible && (
        <div className="ag-band-bar" ref={bar} style={{ height: height + 10 }}
          onPointerMove={(e) => setNear(nearAt(e))}
          onPointerLeave={() => setNear(null)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const k = nearAt(e);
            if (k !== null) { pick(dots[k]); return; }
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(msOf(a + ((e.clientX - r.left) / Math.max(1, r.width)) * span, fps));
          }}>
          <svg viewBox={`${a} 0 ${span} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
            {shown.map((l, k) => l.spans.map(([s, e]) => (
              <rect key={`${l.name}:${s}`} x={s} y={2 + k * (LANE + GAP)} width={e - s + 1} height={LANE} style={{ fill: l.color }} />
            )))}
          </svg>
          <div className="ag-band-dots" aria-hidden="true">
            {dots.map((f, k) => (
              <i key={f} className={cx(k === near && "near")} style={{ left: `${((f - a) / span) * 100}%` }}
                title={`Кадр ${f}: ${hitsOf(f).length} находок`} />
            ))}
          </div>
          <i className="ag-band-head" style={{ left: `${((at - view.start) / Math.max(1, view.span)) * 100}%` }} />
        </div>
      )}
      {children}
      <div className="ag-band-legend">
        <button type="button" className="ag-band-title" aria-pressed={visible} onClick={() => onShown(!visible)}
          title={visible ? "Спрятать разведку (R)" : "Показать разведку (R)"}>
          <span className="ag-band-eye" aria-hidden="true">◎</span>Разведка
        </button>
        {visible && lanes.map((l) => (
          <button key={l.name} type="button" className="ag-band-chip" aria-pressed={!off.has(l.name)}
            title={`${l.spans.length} уч. — нажмите, чтобы ${off.has(l.name) ? "показать" : "скрыть"}`}
            onClick={() => setOff((prev) => {
              const next = new Set(prev);
              if (next.has(l.name)) next.delete(l.name);
              else next.add(l.name);
              onOff?.(next);
              return next;
            })}>
            <i style={{ background: l.color }} />{stats?.mapped[l.name]?.name ?? l.name}<small>{l.spans.length}</small>
          </button>
        ))}
        <span className="ag-band-sp" />
        {editable && visible && (
          <button type="button" className="mag-ghost mag-ghost-inline" disabled={!shown.length}
            onClick={() => onPlan(shown.flatMap((l) =>
              l.spans.map(([s, e]) => [msOf(s, fps), msOf(e + 1, fps)] as [number, number])))}>
            Участки в план
          </button>
        )}
      </div>
    </div>
  );
}
