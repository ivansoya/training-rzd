// Разведка ролика на шкалах: полосы по классам агента и план нарезки из них.
//
// Решения владельца (24.09.2026): разведка — информация, а не разметка. В
// нарезке полосы лежат над планом, и кнопка «Участки из разведки» лишь
// добавляет участки выбранных классов в план — дальше их правят и сохраняют
// как обычные. В редакторе размечаемого ролика те же полосы — строками сетки
// TrackLanes, только для чтения.

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import { PALETTE } from "./agentDoc";
import Sep from "../Sep";

export interface ScoutLane {
  name: string;
  color: string;
  /** Кадры включительно и сколько проверенных кадров дали попадание. */
  spans: [number, number, number][];
}

/** Полосы разведки одного ролика, классы по алфавиту — цвет не прыгает. */
export function scoutLanes(scout: api.Scout | undefined): ScoutLane[] {
  if (!scout) return [];
  return Object.keys(scout.segments)
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((name, i) => ({ name, color: PALETTE[i % PALETTE.length], spans: scout.segments[name] }));
}

/** Сводка числами: «Человек · 5 участков · 42 с». */
export function scoutSummary(scout: api.Scout): string[] {
  const fps = scout.fps || 25;
  return scoutLanes(scout).map((l) => {
    const seconds = l.spans.reduce((s, [a, b]) => s + (b - a + 1), 0) / fps;
    return `${l.name} · ${l.spans.length} уч. · ${Math.round(seconds)} с`;
  });
}

/** Разведка роликов таски: {ролик: разведка}. Пусто, пока агент не смотрел. */
export function useScouts(taskId: string, bump = 0) {
  const [scouts, setScouts] = useState<Record<string, api.Scout>>({});
  useEffect(() => {
    api.taskScouts(taskId).then((r) => setScouts(r.scouts)).catch(() => setScouts({}));
  }, [taskId, bump]);
  return scouts;
}

const msOf = (frame: number, fps: number) => Math.round((frame * 1000) / fps);

/** Полосы над планом нарезки. `pct` — та же шкала, что у ленты: окно в мс. */
export function ScoutBars({
  scout,
  pct,
  span,
  editable,
  onSeek,
  onPlan,
}: {
  scout: api.Scout;
  pct: (ms: number) => number;
  /** Ширина окна ленты в мс — ширина полосы считается от неё. */
  span: number;
  editable: boolean;
  onSeek: (ms: number) => void;
  onPlan: (ranges: [number, number][]) => void;
}) {
  const fps = scout.fps || 25;
  const lanes = scoutLanes(scout);
  const [picking, setPicking] = useState(false);
  const [take, setTake] = useState<Set<string>>(() => new Set(lanes.map((l) => l.name)));
  if (!lanes.length) {
    return <p className="ag-scout-none">Разведка «{scout.agent ?? "агент"}»: ничего не найдено.</p>;
  }
  return (
    <div className="ag-scout">
      <div className="ag-scout-head">
        <span>Разведка «{scout.agent ?? "агент"}» <Sep /> каждый {scout.step}-й кадр</span>
        {editable && (
          <button type="button" className="mag-ghost mag-ghost-inline" onClick={() => setPicking((v) => !v)}>
            Участки из разведки
          </button>
        )}
      </div>
      {picking && (
        <div className="ag-scout-pick">
          {lanes.map((l) => (
            <label key={l.name}>
              <input type="checkbox" checked={take.has(l.name)} onChange={(e) => {
                const next = new Set(take);
                if (e.target.checked) next.add(l.name);
                else next.delete(l.name);
                setTake(next);
              }} />
              <i style={{ background: l.color }} /> {l.name} <small>{l.spans.length}</small>
            </label>
          ))}
          <button type="button" className="mag-btn mag-btn-inline" disabled={!take.size} onClick={() => {
            onPlan(lanes.filter((l) => take.has(l.name))
              .flatMap((l) => l.spans.map(([a, b]) => [msOf(a, fps), msOf(b + 1, fps)] as [number, number])));
            setPicking(false);
          }}>
            Добавить в план
          </button>
        </div>
      )}
      {lanes.map((l) => (
        <div key={l.name} className="ag-scout-row" title={l.name}>
          <span className="ag-scout-name"><i style={{ background: l.color }} />{l.name}</span>
          <span className="ag-scout-lane">
            {l.spans.map(([a, b, n]) => (
              <i key={a} style={{
                left: `${pct(msOf(a, fps))}%`,
                width: `${Math.max(0.3, ((msOf(b + 1, fps) - msOf(a, fps)) / span) * 100)}%`,
                background: l.color,
              }} title={`${l.name}: кадры ${a}–${b}, попаданий ${n}`}
                onPointerDown={(e) => { e.stopPropagation(); onSeek(msOf(a, fps)); }} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Сводка разведки числами под именем ролика. Нет разведки — ничего. */
export function ScoutLine({ scout }: { scout?: api.Scout }) {
  if (!scout) return null;
  const parts = scoutSummary(scout);
  return (
    <span className="ag-scout-sum" title={`Разведка «${scout.agent ?? "агент"}», каждый ${scout.step}-й кадр`}>
      разведка: {parts.length ? parts.join("; ") : "ничего не найдено"}
    </span>
  );
}
