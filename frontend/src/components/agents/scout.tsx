// Разведка ролика на шкалах: полоса в нарезке, строки в редакторе ролика,
// кнопка у ролика.
//
// В нарезке начала участков отмечены одной полосой; фильтр и переходы — внизу окна.

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import * as api from "../../api/agents";
import { useLive } from "../../live/LiveProvider";
import { Button, Check, Popover, cx } from "../../ui";
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
export function ScoutBand({ starts, fps, view, at, onSeek, onPick, onWheel }: {
  starts: readonly number[];
  fps: number;
  view: { start: number; span: number };
  at: number;
  onSeek: (ms: number) => void;
  onPick: (frame: number) => void;
  onWheel: (ratio: number, deltaY: number, shift: boolean) => void;
}) {
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
  }, []);

  const a = (view.start / 1000) * fps;
  const span = Math.max(1, (view.span / 1000) * fps);
  const dots = starts.filter((f) => f >= a && f <= a + span);
  const xs = (w: number) => dots.map((f) => ((f - a) / span) * w);
  const nearAt = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearestTick(xs(r.width), e.clientX - r.left);
  };
  return (
    <div className="ag-band-bar" ref={bar}
      title={near !== null && dots[near] !== undefined ? `Начало участка: кадр ${dots[near]}` : "Обнаружения разведки"}
      onPointerMove={(e) => setNear(nearAt(e))} onPointerLeave={() => setNear(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const k = nearAt(e);
        if (k !== null) { onPick(dots[k]); return; }
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(msOf(a + ((e.clientX - r.left) / Math.max(1, r.width)) * span, fps));
      }}>
      {!starts.length && <span className="ag-band-empty">Нет обнаружений для выбранных классов</span>}
      <div className="ag-band-dots" aria-hidden="true">
        {dots.map((f, k) => (
          <i key={f} className={cx(k === near && "near", Math.floor(at * fps / 1000) === f && "current")}
            style={{ left: `${((f - a) / span) * 100}%` }} />
        ))}
      </div>
      <i className="ag-band-head" style={{ left: `${((at - view.start) / Math.max(1, view.span)) * 100}%` }} />
    </div>
  );
}

export function ScoutControls({ scout, stats, colors, starts, fps, at, shown, onShown, off, onOff, onNavigate, disabled }: {
  scout: api.Scout;
  stats: api.ScoutStats | null;
  colors: Map<string, string>;
  starts: readonly number[];
  fps: number;
  at: number;
  shown: boolean;
  onShown: (shown: boolean) => void;
  off: ReadonlySet<string>;
  onOff: (off: Set<string>) => void;
  onNavigate: (dir: 1 | -1) => void;
  disabled: boolean;
}) {
  const lanes = scoutLanes(scout, colors);
  const frame = Math.floor(at * fps / 1000);
  const count = starts.filter((f) => f <= frame).length;
  const selected = lanes.filter((l) => !off.has(l.name)).length;
  return (
    <div className="ag-band-controls">
      <Button size="sm" className="ag-band-toggle" icon="scan" kbd="R" aria-pressed={shown} disabled={disabled}
        onClick={() => onShown(!shown)} title={shown ? "Спрятать разведку (R)" : "Показать разведку (R)"}>Разведка</Button>
      {shown && <>
        <span className="ag-band-nav-label">Обнаружения</span>
        <div className="ag-band-nav">
          <Button size="sm" icon="skipb" aria-label="Предыдущее обнаружение" aria-keyshortcuts="Control+ArrowLeft"
            title="Предыдущее обнаружение (Ctrl+←)" disabled={disabled || !starts.length} onClick={() => onNavigate(-1)} />
          <span className="ag-band-count ui-mono" role="status" aria-live="polite">{count || (starts.length ? "—" : 0)} / {starts.length}</span>
          <Button size="sm" icon="skipf" aria-label="Следующее обнаружение" aria-keyshortcuts="Control+ArrowRight"
            title="Следующее обнаружение (Ctrl+→)" disabled={disabled || !starts.length} onClick={() => onNavigate(1)} />
        </div>
        <Popover side="top" width={290} className="ag-band-filter" trigger={
          <Button size="sm" icon="filter" iconEnd="chevD" disabled={disabled}>Классы <span className="ui-mono">{selected} / {lanes.length}</span></Button>
        }>
          {(close) => <>
            <div className="ui-pop-h"><span>Классы разведки</span><Button size="sm" variant="ghost" icon="x" aria-label="Закрыть классы" onClick={close} /></div>
            <div className="ag-band-filter-all"><span>Выбрано {selected} из {lanes.length}</span><Button size="sm" variant="ghost" onClick={() => onOff(new Set())}>Выбрать все</Button></div>
            <div className="ag-band-filter-list">
              {lanes.map((l) => <Check key={l.name} checked={!off.has(l.name)} onChange={(checked) => {
                const next = new Set(off);
                if (checked) next.delete(l.name); else next.add(l.name);
                onOff(next);
              }}>
                <i className="ag-band-swatch" style={{ background: stats?.mapped[l.name]?.color ?? l.color }} />
                <span>{stats?.mapped[l.name]?.name ?? l.name}</span><small className="ui-mono">{l.spans.length}</small>
              </Check>)}
            </div>
          </>}
        </Popover>
      </>}
    </div>
  );
}
