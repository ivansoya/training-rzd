import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { VideoTrack } from "../../auth/api";
import { hiddenRanges, trackEnd } from "./trackMath";
import { extensionFrame, timelineFrame, timelineTicks, visibleSpans } from "./timelineMath";
import Sep from "../Sep";

export interface LaneAction {
  kind: "seek" | "move-key" | "set-start" | "set-end" | "add-key" | "hide" | "menu" | "drop";
  trackId: string;
  frame: number;
  from?: number;
  at?: { x: number; y: number };
  /** Правый клик пришёлся по ромбу: меню ключа, а не меню дорожки. */
  onKey?: boolean;
}
type Drag = { kind: "key" | "start" | "end" | "hide" | "seek"; trackId: string; from: number; x: number };

/** Отступ указателя сверху: он начинается внутри шкалы, чтобы ромб лёг на неё. */
const RULER = 25;

/** Одна шкала, одно координатное пространство, один указатель.
 * Ручки продления стоят слева и справа от края трека, на линии ключей, и
 * отодвинуты от неё: у трека из одного ключа ручка и ромб не должны делить
 * хитбокс. Пиксели в кадры переводит timelineMath — тот же, что и у шкалы. */
export default function TrackLanes({ tracks, frame, lastFrame, labelOf, selected, editable, onSelect, onAction, onSeek, marks }: {
  tracks: VideoTrack[]; frame: number; lastFrame: number;
  labelOf: (ci: number) => { name: string; color: string };
  selected: string | null; editable: boolean;
  onSelect: (id: string) => void; onAction: (action: LaneAction) => void; onSeek: (frame: number) => void;
  /** Кадры, помеченные фоновыми. `on` — пометка действует: кадр свободен. */
  marks: { frame: number; on: boolean }[];
}) {
  const grid = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ drag: Drag; frame: number } | null>(null);
  const [width, setWidth] = useState(600);
  const [view, setView] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  // Указатель прижат к видимой части, а не к содержимому: он лежит в сетке,
  // которая прокручивается, и без этого при прокрутке уезжал вверх — линия
  // отрывалась от шкалы и лезла над ней.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => { el.removeEventListener("scroll", read); observer.disconnect(); };
  }, []);
  const pct = (n: number) => `${Math.max(0, Math.min(100, n / Math.max(1, lastFrame) * 100))}%`;
  const ticks = timelineTicks(lastFrame, width);
  const at = (x: number) => { const r = grid.current!.getBoundingClientRect(); return timelineFrame(x, r.left, r.width, lastFrame); };
  function begin(e: ReactPointerEvent<HTMLElement>, kind: Drag["kind"], trackId = "", from = at(e.clientX)) {
    if (e.button !== 0) return;
    if (trackId) onSelect(trackId);
    if (!editable && kind !== "seek") { onSeek(from); e.stopPropagation(); return; }
    const d = { kind, trackId, from, x: e.clientX };
    drag.current = d; setPreview({ drag: d, frame: from });
    e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
    if (kind === "seek" || kind === "key") onSeek(from);
  }
  function target(d: Drag, x: number) {
    return d.kind === "start" || d.kind === "end"
      ? extensionFrame(d.from, x - d.x, grid.current!.getBoundingClientRect().width, lastFrame, d.kind)
      : at(x);
  }
  function move(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current; if (!d) return;
    const f = target(d, e.clientX); setPreview({ drag: d, frame: f });
    if (d.kind === "seek") onSeek(f);
  }
  function cancel() { drag.current = null; setPreview(null); }
  function finish(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current; if (!d) return;
    const f = target(d, e.clientX); cancel();
    if (f === d.from || d.kind === "seek" || !editable) return;
    if (d.kind === "hide") onAction({ kind: "hide", trackId: d.trackId, from: Math.min(f,d.from), frame: Math.max(f,d.from) });
    else onAction({ kind: d.kind === "key" ? "move-key" : d.kind === "start" ? "set-start" : "set-end", trackId: d.trackId, from: d.from, frame: f });
  }
  const pointer = { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel };
  return <div className="vt-timeline" ref={scroller} aria-label="Таймлайн видео и объектов">
    <div className="vt-grid" ref={grid}>
      <div className="vt-guides" aria-hidden="true">{ticks.map(t => <i key={t} style={{ left: pct(t) }} />)}</div>
      <div className="vt-ruler" role="slider" tabIndex={0} aria-label="Кадр" aria-valuemin={0} aria-valuemax={lastFrame} aria-valuenow={frame}
        onPointerDown={e => begin(e,"seek")} {...pointer}
        onKeyDown={e => {
          const delta = e.shiftKey ? 10 : 1;
          const next = e.key === "Home" ? 0 : e.key === "End" ? lastFrame : e.key === "ArrowRight" ? Math.min(lastFrame,frame+delta) : e.key === "ArrowLeft" ? Math.max(0,frame-delta) : null;
          if(next !== null) { e.preventDefault();e.stopPropagation();onSeek(next); }
        }}>
        {ticks.map(t => <span key={t} className={t === 0 ? "first" : t === lastFrame ? "last" : ""} style={{ left: pct(t) }}>{t}</span>)}
      </div>
      <div className="vt-video" aria-label="Дорожка видео" title="Перемотка по ролику"
        onPointerDown={e => begin(e,"seek")} {...pointer}>
        <span className="vt-name">Видео</span><i className="vt-video-fill" style={{ width: pct(frame) }} />
        {marks.map(m => <i key={m.frame} className={m.on ? "vt-mark" : "vt-mark off"}
          style={{ left: pct(m.frame) }}
          title={m.on ? `Кадр ${m.frame}: фоновый` : `Кадр ${m.frame}: помечен фоновым, но на нём есть объект`} />)}
      </div>
      {tracks.map(track => {
        const label = labelOf(track.class_index ?? -1), end = trackEnd(track), on = track.id === selected;
        const ghost = preview?.drag.trackId === track.id ? preview : null;
        const zones = hiddenRanges(track), starts = new Set(zones.map(([a]) => a));
        return <div key={track.id} className={`vt-row${on ? " on" : ""}`} data-track-id={track.id}>
          <button className="vt-name" type="button" title={track.label || label.name} onClick={() => onSelect(track.id)}><i style={{background:label.color}} /><span>{track.label || label.name || "Объект"}</span></button>
          <div className="vt-lane" {...pointer} onPointerDown={e => begin(e,e.altKey && editable ? "hide" : "seek",track.id)}
            onDoubleClick={e => { if(editable && !(e.target as HTMLElement).closest('.vt-key,.vt-grip')) onAction({kind:"add-key",trackId:track.id,frame:at(e.clientX)}); }}
            onContextMenu={e => {e.preventDefault(); onSelect(track.id);onAction({kind:"menu",trackId:track.id,frame:at(e.clientX),at:{x:e.clientX,y:e.clientY}});}}>
            {visibleSpans(track.start_frame,end,zones).map(([a,b],i)=>
              <span key={i} className="vt-life" style={{left:pct(a),width:pct(b-a),background:label.color}} />)}
            {zones.map(([a,b],i)=><span key={i} className="vt-hidden" style={{left:pct(a),width:pct(b-a)}} />)}
            {track.keys.map(k=>{
              const gone = starts.has(k.frame_no);
              return <button key={k.frame_no} type="button"
                className={`vt-key${gone ? " gone" : ""}${k.frame_no === frame ? " now" : ""}`}
                style={{left:pct(k.frame_no),color:label.color}}
                aria-label={`${gone ? "Ключ исчезновения" : "Ключ"} ${k.frame_no}`}
                title={`Кадр ${k.frame_no}${gone ? " — отсюда объекта не видно" : ""} — перетащите для переноса, правой кнопкой — меню`}
                onPointerDown={e=>begin(e,"key",track.id,k.frame_no)}
                onContextMenu={e=>{e.preventDefault();e.stopPropagation();onSelect(track.id);
                  onAction({kind:"menu",trackId:track.id,frame:k.frame_no,onKey:true,at:{x:e.clientX,y:e.clientY}});}}
                onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();onSelect(track.id);onSeek(k.frame_no);}}} />;
            })}
            {editable && on && track.start_frame>0 && <button type="button" className="vt-grip start" style={{left:pct(track.start_frame)}} aria-label="Продлить трек влево" title="Потяните влево: новый ключ на границе" onPointerDown={e=>begin(e,"start",track.id,track.start_frame)} onKeyDown={e=>{if(e.key==='ArrowLeft'){e.preventDefault();e.stopPropagation();onAction({kind:'set-start',trackId:track.id,frame:Math.max(0,track.start_frame-(e.shiftKey?10:1))});}}}>‹</button>}
            {editable && on && end<lastFrame && <button type="button" className="vt-grip end" style={{left:pct(end)}} aria-label="Продлить трек вправо" title="Потяните вправо: новый ключ на границе" onPointerDown={e=>begin(e,"end",track.id,end)} onKeyDown={e=>{if(e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();onAction({kind:'set-end',trackId:track.id,frame:Math.min(lastFrame,end+(e.shiftKey?10:1))});}}}>›</button>}
            {ghost && ghost.drag.kind !== "seek" && <span className={ghost.drag.kind==='hide'?'vt-hidden preview':'vt-preview'} style={ghost.drag.kind==='hide'?{left:pct(Math.min(ghost.frame,ghost.drag.from)),width:pct(Math.abs(ghost.frame-ghost.drag.from))}:{left:pct(ghost.frame)}} />}
          </div>
          {editable && <button type="button" className="vt-trash" title="Удалить объект целиком"
            aria-label={`Удалить объект «${track.label || label.name || "Объект"}»`}
            onClick={() => onAction({ kind: "drop", trackId: track.id, frame })}>🗑</button>}
        </div>;
      })}
      {!tracks.length && <p className="vt-empty">T <Sep /> обведите объект на видео, чтобы создать трек</p>}
      <div className="vt-playhead" aria-hidden="true"
        style={{left:pct(frame),top:view.top+RULER,height:Math.max(0,view.height-RULER)}}><i /></div>
    </div>
  </div>;
}
