// Дорожки редактора видео: линейка, закреплённые служебные дорожки, треки, меню дорожки.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { VideoTrack } from "../../auth/api";
import { Button, Icon, MenuItem, Swatch, cx, useEscape } from "../../ui";
import type { ScoutLane } from "../agents/scout";
import { hiddenRanges, keyAt, trackEnd } from "../mag/trackMath";
import { extensionFrame, visibleSpans } from "../mag/timelineMath";
import { ru } from "../ru";
import { ClassFilter, shownOf } from "./ClassFilter";
import type { FilterEntry } from "./ClassFilter";
import { classKey } from "./filter";
import { nearestTick } from "./review";
import { clampView, clockText, scoutHeat, timeTicks, zoomAt, zoomText } from "./video";
import type { View } from "./video";
import type { Chunk } from "./chunks";

export interface LaneAction {
  kind: "seek" | "move-key" | "set-start" | "set-end" | "add-key" | "hide" | "menu";
  trackId: string;
  frame: number;
  from?: number;
  at?: { x: number; y: number };
  /** Правый щелчок пришёлся по ромбу: меню ключа, а не дорожки. */
  onKey?: boolean;
}

type Drag = { kind: "key" | "start" | "end" | "hide" | "seek"; trackId: string; from: number; x: number };
type Label = (ci: number) => { name: string; color: string };

export function Lanes({ tracks, numbers, frame, lastFrame, fps, labelOf, selected, editable, hidden, filter,
  covered, marks, plan, singles, agent, scout, scouted, scoutDots, scoutOpen, view, onView, onWidth, chunks, loaded, inFlight, loading,
  onScout, onSelect, onHide, onAction, onSeek }: {
  /** Треки, прошедшие фильтр классов (выбранный — всегда). */
  tracks: VideoTrack[];
  numbers: Map<string, number>;
  frame: number;
  lastFrame: number;
  fps: number;
  labelOf: Label;
  selected: string | null;
  editable: boolean;
  /** Треки, погашенные на кадре глазом. */
  hidden: Set<string>;
  /** Фильтр классов дорожек: что в списке, что снято; `cut` — сколько треков он спрятал. */
  filter: { classes: FilterEntry[]; agent: FilterEntry[]; off: Set<string>; onChange: (next: Set<string>) => void; cut: number };
  covered: [number, number][];
  /** Фоновые кадры; `on` — пометка действует, кадр свободен. */
  marks: { frame: number; on: boolean }[];
  /** Сколько кадров уйдёт в таску — по плану сервера. */
  plan: number | null;
  singles: { frame: number; ci: number }[];
  /** Кадры с непроверенной разметкой агента. */
  agent: number[];
  /** Полосы разведки, прошедшие фильтр. */
  scout: ScoutLane[];
  /** Разведка у ролика есть — строка «Разведка» стоит, даже если фильтр снял все её классы. */
  scouted: boolean;
  /** Проверенные разведкой кадры с находками: все классы и по классу агента. */
  scoutDots?: { all: number[]; by: Map<string, number[]> };
  /** R: разведка по классам вместо треков. */
  scoutOpen: boolean;
  /** Окно масштаба: какие кадры видны на ширине дорожек. */
  view: View;
  onView: (v: View) => void;
  onWidth?: (w: number) => void;
  /** Куски одиночной разметки: незагруженные заштрихованы, кусок в пути — штрихи ползут. */
  chunks: Chunk[];
  loaded: Set<number>;
  inFlight: number | null;
  /** Разметка ещё грузится — «Разметка грузится» в углу шкалы. */
  loading: boolean;
  onScout: () => void;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onAction: (a: LaneAction) => void;
  onSeek: (frame: number) => void;
}) {
  const lane = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{ drag: Drag; frame: number } | null>(null);
  const [width, setWidth] = useState(800);
  const onWidthRef = useRef(onWidth);
  onWidthRef.current = onWidth;

  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); onWidthRef.current?.(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Позиция — доля окна масштаба, а не всего ролика; что за краем окна, срезает полоса (overflow: clip)
  const pct = (n: number) => `${((n - view.from) / view.len) * 100}%`;
  const span = (a: number, b: number): CSSProperties => ({ left: pct(a), width: `max(2px, ${((b - a) / view.len) * 100}%)` });
  const at = (x: number) => {
    const r = lane.current!.getBoundingClientRect();
    return Math.max(0, Math.min(lastFrame, Math.round(view.from + ((x - r.left) / Math.max(1, r.width)) * view.len)));
  };

  // Ctrl+колесо — масштаб вокруг курсора, Shift+колесо (или колесо вбок) — сдвиг по времени.
  // Нативный слушатель: в React колесо пассивное, а странице масштабироваться нельзя.
  const live = useRef({ view, lastFrame, width, onView });
  live.current = { view, lastFrame, width, onView };
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const { view: v, lastFrame: last, width: w, onView: set } = live.current;
      const r = lane.current?.getBoundingClientRect();
      if (!r) return;
      if (e.ctrlKey) {
        e.preventDefault();
        const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
        set(zoomAt(v, e.deltaY < 0 ? 1.25 : 0.8, v.from + (x / Math.max(1, r.width)) * v.len, last, w));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (v.len >= last) return;
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        set(clampView({ from: v.from + (d / Math.max(1, r.width)) * v.len, len: v.len }, last, w));
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  function begin(e: ReactPointerEvent<HTMLElement>, kind: Drag["kind"], trackId = "", from = at(e.clientX)) {
    if (e.button !== 0) return;
    if (trackId) onSelect(trackId);
    if (!editable && kind !== "seek") { onSeek(from); e.stopPropagation(); return; }
    const d = { kind, trackId, from, x: e.clientX };
    drag.current = d;
    setGhost({ drag: d, frame: from });
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
    if (kind === "seek" || kind === "key") onSeek(from);
  }
  const target = (d: Drag, x: number) =>
    d.kind === "start" || d.kind === "end"
      ? extensionFrame(d.from, x - d.x, lane.current!.getBoundingClientRect().width, lastFrame, d.kind, view.len)
      : at(x);
  function move(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const f = target(d, e.clientX);
    setGhost({ drag: d, frame: f });
    if (d.kind === "seek") onSeek(f);
  }
  function cancel() { drag.current = null; setGhost(null); }
  function finish(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const f = target(d, e.clientX);
    cancel();
    if (f === d.from || d.kind === "seek" || !editable) return;
    if (d.kind === "hide") onAction({ kind: "hide", trackId: d.trackId, from: Math.min(f, d.from), frame: Math.max(f, d.from) });
    else onAction({ kind: d.kind === "key" ? "move-key" : d.kind === "start" ? "set-start" : "set-end", trackId: d.trackId, from: d.from, frame: f });
  }
  const pointer = { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel };
  const seekHere = (e: ReactPointerEvent<HTMLElement>) => begin(e, "seek");
  const head = <i className="ve-ph" style={{ left: pct(frame) }} aria-hidden="true" />;
  const ticks = timeTicks(lastFrame, fps, width, 64, view);
  const heat = scoutHeat(scout);
  // Штриховка незагруженных кусков: элементы постоянные (ключ — номер куска) — пришедший гаснет переходом
  const hatch = chunks.map((c, i) => (
    <i key={`h${i}`} className={cx("ve-hatch", loaded.has(i) && "gone", inFlight === i && "now")} style={span(c.from, c.to)} aria-hidden="true" />
  ));
  const tickLane = { frame, view, head, hatch, onSeek, fallback: seekHere, pointer };
  const zoomed = view.len < Math.max(1, lastFrame);
  const flt = shownOf([...filter.classes, ...filter.agent], filter.off);
  const fltOn = flt.shown < flt.total;
  const showAll = <Button variant="ghost" size="sm" onClick={() => filter.onChange(new Set())}>Показать все</Button>;

  return (
    <div className="ve-tl" aria-label="Дорожки" ref={root}>
      <div className="ve-pin">
        <div className="ve-r ve-ruler">
          {loading
            ? <div className="ve-n ve-loading"><i className="ui-spin" aria-hidden="true" />Разметка грузится</div>
            : (
              <div className="ve-n">
                <ClassFilter title="Классы на дорожках" classes={filter.classes} agent={filter.agent}
                  unit="треков и одиночных на дорожках" agentUnit="кадров с находками разведки"
                  off={filter.off} onChange={filter.onChange}
                  trigger={
                    <button type="button" className={cx("ve-n-b", "ve-flt", fltOn && "on")} title="Какие классы показывать на дорожках">
                      <Icon name="filter" size={14} />
                      {fltOn
                        ? <>Классы<span className="fr-fcount">{flt.shown}</span><span className="ui-mono t-faint">из {flt.total}</span></>
                        : <>Дорожки<span className="ui-mono t-faint">{tracks.length}</span></>}
                      <Icon name="chevD" size={13} />
                    </button>
                  } />
              </div>
            )}
          <div className="ve-l" ref={lane} role="slider" tabIndex={0} aria-label="Кадр" aria-valuemin={0}
            aria-valuemax={lastFrame} aria-valuenow={frame} onPointerDown={seekHere} {...pointer}
            onKeyDown={(e) => {
              const d = e.shiftKey ? 10 : 1;
              const next = e.key === "Home" ? 0 : e.key === "End" ? lastFrame
                : e.key === "ArrowRight" ? Math.min(lastFrame, frame + d) : e.key === "ArrowLeft" ? Math.max(0, frame - d) : null;
              if (next !== null) { e.preventDefault(); e.stopPropagation(); onSeek(next); }
            }}>
            {ticks.map((k) => (
              <span key={k.frame} className={cx("ve-tick", k.frame === 0 && view.from === 0 && "first")} style={{ left: pct(k.frame) }}>{clockText(k.t)}</span>
            ))}
            <i className="ve-ph head" style={{ left: pct(frame) }} aria-hidden="true" />
          </div>
        </div>

        <Row name={<><Icon name="check" size={14} />Размечено{plan !== null && <span className="ui-mono t-faint">{ru(plan)}</span>}</>}
          title="Что уйдёт в таску при закрытии разметки; риски — фоновые кадры">
          <div className="ve-l" onPointerDown={seekHere} {...pointer}>
            {hatch}
            {covered.map(([a, b]) => <i key={a} className="ve-cov" style={span(a, b + 1)} />)}
            {marks.map((m) => (
              <i key={m.frame} className={cx("ve-empty", !m.on && "off")} style={{ left: pct(m.frame) }}
                title={m.on ? `Кадр ${m.frame}: фоновый` : `Кадр ${m.frame}: помечен фоновым, но на нём есть объект`} />
            ))}
            {head}
          </div>
        </Row>

        {agent.length > 0 && (
          <Row name={<><Icon name="bot" size={14} className="ve-agent-ic" />Агент<span className="ui-mono t-faint">{agent.length}</span></>}
            title="Кадры с непроверенной разметкой агента; щелчок — к кадру, Shift+[ и Shift+] — к соседнему">
            <TickLane {...tickLane} hatched frames={agent} kind="agent" label={(f) => `Кадр ${f}: разметка агента на проверке`} />
          </Row>
        )}

        {scouted && (
          <Row on={scoutOpen} title={scoutOpen ? "Разведка по классам — R вернёт треки" : "Где агент что-то нашёл; R — по классам"}
            name={<button type="button" className="ve-n-b" aria-pressed={scoutOpen} onClick={onScout}>
              <Icon name="scan" size={14} />Разведка<span className="ve-k">R</span>
            </button>}>
            <TickLane {...tickLane} frames={scoutDots?.all ?? []} kind="dot" label={(f) => `Кадр ${f}: находки разведки`}>
              {heat.map(([a, b, o], i) => <i key={i} className="ve-heat" style={{ ...span(a, b + 1), opacity: o }} />)}
            </TickLane>
          </Row>
        )}

        <Row name={<><Icon name="bbox" size={14} />Одиночные<span className="ui-mono t-faint">{singles.length}</span></>}
          title="Рамки и контуры одного кадра; щелчок по риске — к кадру">
          <TickLane {...tickLane} hatched frames={singles.map((x) => x.frame)} kind="single"
            color={(k) => labelOf(singles[k].ci).color}
            label={(f, k) => `${labelOf(singles[k].ci).name || "объект"} · кадр ${f}`} />
        </Row>
      </div>

      {scoutOpen && scout.map((l) => (
        <Row key={`s:${l.name}`} name={<><Swatch color={l.color} /><span className="t-ell">{l.name}</span></>} title={`Разведка агента: ${l.name}`}>
          <TickLane {...tickLane} frames={scoutDots?.by.get(l.name) ?? []} kind="dot" color={() => l.color}
            label={(f) => `${l.name}: кадр ${f}`}>
            {l.spans.map(([a, b, n]) => (
              <i key={a} className="ve-span" style={{ ...span(a, b + 1), ["--cc" as string]: l.color }}
                title={`${l.name}: кадры ${a}–${b}, попаданий ${n}`} />
            ))}
          </TickLane>
        </Row>
      ))}

      {!scoutOpen && tracks.map((t) => {
        const c = labelOf(t.class_index ?? -1);
        const end = trackEnd(t);
        const on = t.id === selected;
        const off = hidden.has(t.id);
        const zones = hiddenRanges(t);
        const starts = new Set(zones.map(([a]) => a));
        const g = ghost?.drag.trackId === t.id ? ghost : null;
        const name = t.label || c.name || "Объект";
        return (
          <div key={t.id} className={cx("ve-r", on && "on", off && "off")} data-track-id={t.id} style={{ ["--cc" as string]: c.color }}>
            <div className="ve-n">
              <button type="button" className="ve-n-b" aria-pressed={on} title={name} onClick={() => onSelect(t.id)}>
                <Swatch color={c.color} /><span className="t-ell">{name}</span>
                <span className="ui-mono t-faint">#{numbers.get(t.id)}</span>
                {filter.off.has(classKey(t.class_index)) && (
                  <span title="Класс снят фильтром — трек виден, пока выбран"><Icon name="funnelx" size={13} className="flt-x" /></span>
                )}
              </button>
              <Button variant="ghost" size="sm" icon={off ? "eyeoff" : "eye"}
                aria-label={off ? `Показать «${name}» на кадре` : `Скрыть «${name}» на кадре`} onClick={() => onHide(t.id)} />
            </div>
            <div className="ve-l" {...pointer}
              onPointerDown={(e) => begin(e, e.altKey && editable ? "hide" : "seek", t.id)}
              onDoubleClick={(e) => {
                if (editable && !(e.target as HTMLElement).closest(".ve-kf,.ve-grip")) onAction({ kind: "add-key", trackId: t.id, frame: at(e.clientX) });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onSelect(t.id);
                onAction({ kind: "menu", trackId: t.id, frame: at(e.clientX), at: { x: e.clientX, y: e.clientY } });
              }}>
              {visibleSpans(t.start_frame, end, zones).map(([a, b], i) => <i key={i} className="ve-span" style={span(a, b)} />)}
              {zones.map(([a, b], i) => <i key={`h${i}`} className="ve-hid" style={span(a, b)} />)}
              {t.keys.map((k) => {
                const gone = starts.has(k.frame_no);
                return (
                  <button key={k.frame_no} type="button" className={cx("ve-kf", gone && "gone", k.frame_no === frame && "now")}
                    style={{ left: pct(k.frame_no) }} aria-label={`${gone ? "Ключ исчезновения" : "Ключ"} ${k.frame_no}`}
                    title={`Кадр ${k.frame_no}${gone ? " — отсюда объекта не видно" : ""}. Тяните — перенести, правая кнопка — меню`}
                    onPointerDown={(e) => begin(e, "key", t.id, k.frame_no)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(t.id);
                      onAction({ kind: "menu", trackId: t.id, frame: k.frame_no, onKey: true, at: { x: e.clientX, y: e.clientY } });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelect(t.id); onSeek(k.frame_no); }
                    }} />
                );
              })}
              {editable && on && t.start_frame > 0 && (
                <button type="button" className="ve-grip start" style={{ left: pct(t.start_frame) }} aria-label="Продлить трек влево"
                  title="Тяните влево: новый ключ на границе" onPointerDown={(e) => begin(e, "start", t.id, t.start_frame)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft") return;
                    e.preventDefault(); e.stopPropagation();
                    onAction({ kind: "set-start", trackId: t.id, frame: Math.max(0, t.start_frame - (e.shiftKey ? 10 : 1)) });
                  }} />
              )}
              {editable && on && end < lastFrame && (
                <button type="button" className="ve-grip end" style={{ left: pct(end) }} aria-label="Продлить трек вправо"
                  title="Тяните вправо: новый ключ на границе" onPointerDown={(e) => begin(e, "end", t.id, end)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowRight") return;
                    e.preventDefault(); e.stopPropagation();
                    onAction({ kind: "set-end", trackId: t.id, frame: Math.min(lastFrame, end + (e.shiftKey ? 10 : 1)) });
                  }} />
              )}
              {g && g.drag.kind !== "seek" && (g.drag.kind === "hide"
                ? <i className="ve-hid ghost" style={span(Math.min(g.frame, g.drag.from), Math.max(g.frame, g.drag.from))} />
                : <i className="ve-ghost" style={{ left: pct(g.frame) }} />)}
              {head}
            </div>
          </div>
        );
      })}
      {!scoutOpen && !tracks.length && (filter.cut > 0
        ? <p className="ve-none"><Icon name="filter" size={14} />Треки скрыты фильтром{showAll}</p>
        : <p className="ve-none"><Icon name="route" size={14} />Нажмите T и обведите объект — он поедет по ролику дорожкой здесь.</p>)}
      {scoutOpen && !scout.length && <p className="ve-none"><Icon name="filter" size={14} />Классы разведки скрыты фильтром{showAll}</p>}
      {zoomed && <Scrollbar view={view} last={lastFrame} onView={(v) => onView(clampView(v, lastFrame, width))} />}
    </div>
  );
}

/** Полоса прокрутки окна масштаба: тянуть ползунок — сдвиг, щелчок по жёлобу — окно туда. */
function Scrollbar({ view, last, onView }: { view: View; last: number; onView: (v: View) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const full = Math.max(1, last);
  const grab = useRef<{ x: number; from: number } | null>(null);
  const frameAt = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return ((x - r.left) / Math.max(1, r.width)) * full;
  };
  return (
    <div className="ve-hbar" ref={track} role="scrollbar" aria-orientation="horizontal" aria-label="Окно дорожек"
      aria-valuemin={0} aria-valuemax={full} aria-valuenow={Math.round(view.from)}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onView({ from: frameAt(e.clientX) - view.len / 2, len: view.len }); }}>
      <i className="ve-hbar-t" style={{ left: `${(view.from / full) * 100}%`, width: `${(view.len / full) * 100}%` }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); grab.current = { x: e.clientX, from: view.from }; e.stopPropagation(); }}
        onPointerMove={(e) => {
          const g = grab.current;
          if (!g) return;
          const r = track.current!.getBoundingClientRect();
          onView({ from: g.from + ((e.clientX - g.x) / Math.max(1, r.width)) * full, len: view.len });
        }}
        onPointerUp={() => { grab.current = null; }} onPointerCancel={() => { grab.current = null; }} />
    </div>
  );
}

/** Дорожка рисок: ближайшая к курсору растёт, щелчок рядом с ней (12 px) ведёт к её кадру —
 *  целиться в риску в 3 px не нужно. Мимо рисок — обычная перемотка протяжкой. */
function TickLane({ frames, frame, view, kind, color, label, head, hatch, hatched, children, onSeek, fallback, pointer }: {
  frames: number[];
  frame: number;
  view: View;
  kind: "agent" | "single" | "dot";
  color?: (k: number) => string;
  label: (f: number, k: number) => string;
  head: ReactNode;
  /** Штриховка незагруженных кусков — на дорожках, зависящих от одиночной разметки. */
  hatch: ReactNode;
  hatched?: boolean;
  children?: ReactNode;
  onSeek: (f: number) => void;
  fallback: (e: ReactPointerEvent<HTMLElement>) => void;
  pointer: Record<string, (e: ReactPointerEvent<HTMLElement>) => void>;
}) {
  const [near, setNear] = useState<number | null>(null);
  const find = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return nearestTick(frames.map((f) => ((f - view.from) / view.len) * r.width), e.clientX - r.left);
  };
  const pct = (n: number) => `${((n - view.from) / view.len) * 100}%`;
  return (
    <div className="ve-l" {...pointer}
      onPointerMove={(e) => { setNear(find(e)); pointer.onPointerMove?.(e); }}
      onPointerLeave={() => setNear(null)}
      onPointerDown={(e) => {
        const k = e.button === 0 ? find(e) : null;
        if (k === null) { fallback(e); return; }
        e.preventDefault();
        e.stopPropagation();
        onSeek(frames[k]);
      }}>
      {hatched && hatch}
      {children}
      {frames.map((f, k) => (
        <i key={`${f}:${k}`} className={cx("ve-t", kind, k === near && "near", f === frame && "now")}
          style={{ left: pct(f), ...(color ? { color: color(k) } : {}) }} title={label(f, k)} />
      ))}
      {head}
    </div>
  );
}

function Row({ name, title, on, children }: { name: ReactNode; title?: string; on?: boolean; children: ReactNode }) {
  return (
    <div className={cx("ve-r", "ve-sys", on && "on")}>
      <div className="ve-n" title={title}>{name}</div>
      {children}
    </div>
  );
}

/** Правая кнопка на дорожке: мимо ромба — ключ; по ромбу — заслон и снятие ключа; удалить трек — всегда. */
export function LaneMenu({ action, track, frozen, onClose, onKey, onDropKey, onHide, onShow, onDrop }: {
  action: LaneAction;
  track: VideoTrack | null;
  frozen: boolean;
  onClose: () => void;
  onKey: () => void;
  onDropKey: () => void;
  onHide: (to: number) => void;
  onShow: () => void;
  onDrop: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const x = action.at?.x ?? 0;
  const y = action.at?.y ?? 0;
  const [pos, setPos] = useState({ left: x, top: y });
  useEscape(onClose);

  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  // Дорожки у нижнего края — меню разворачивается вверх по настоящему размеру
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: y + height + 8 <= window.innerHeight ? y : Math.max(8, y - height),
    });
  }, [x, y]);

  if (!track) return null;
  const onDiamond = action.onKey === true;
  const hasKey = keyAt(track, action.frame) !== null;
  const next = track.keys.map((k) => k.frame_no).sort((a, b) => a - b).find((f) => f > action.frame);
  const zone = hiddenRanges(track).find(([from]) => from === action.frame);
  const run = (fn: () => void) => () => { fn(); onClose(); };

  return (
    <div className="ui-pop ed-cmenu ve-menu" ref={box} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      <div className="ui-pop-h">Кадр <span className="ui-mono">{action.frame}</span></div>
      {!onDiamond && (
        <MenuItem icon="diamond" disabled={frozen} hint="двойной щелчок" onSelect={run(onKey)}>
          {hasKey ? "Обновить ключ" : "Поставить ключ"}
        </MenuItem>
      )}
      {onDiamond && (zone ? (
        <MenuItem icon="eye" disabled={frozen} onSelect={run(onShow)}>Снова видно</MenuItem>
      ) : (
        <MenuItem icon="eyeoff" disabled={frozen || next === undefined}
          hint={next === undefined ? "дальше ключей нет" : `до кадра ${next}`} onSelect={run(() => onHide(next as number))}>
          Отсюда не видно
        </MenuItem>
      ))}
      {onDiamond && track.keys.length > 1 && (
        <MenuItem icon="minus" disabled={frozen} onSelect={run(onDropKey)}>Снять ключ</MenuItem>
      )}
      <div className="ui-pop-sep" />
      <MenuItem icon="trash" danger disabled={frozen} onSelect={run(onDrop)}>Удалить трек</MenuItem>
    </div>
  );
}

/** Масштаб дорожек: «− ×4 + Весь». Ctrl+колесо над дорожками делает то же вокруг курсора. */
export function ZoomBar({ view, last, onZoom, onFit }: { view: View; last: number; onZoom: (k: number) => void; onFit: () => void }) {
  const whole = view.len >= Math.max(1, last);
  return (
    <span className="ve-zoom" role="group" aria-label="Масштаб дорожек">
      <Button variant="ghost" size="sm" icon="minus" aria-label="Мельче" title="Мельче · Ctrl+колесо" disabled={whole} onClick={() => onZoom(0.5)} />
      <b className="ui-mono">{zoomText(view, last)}</b>
      <Button variant="ghost" size="sm" icon="plus" aria-label="Крупнее" title="Крупнее · Ctrl+колесо" onClick={() => onZoom(2)} />
      <Button variant="ghost" size="sm" disabled={whole} onClick={onFit} title="Весь ролик на ширину дорожек">Весь</Button>
    </span>
  );
}
