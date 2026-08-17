import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { VideoTrack } from "../../auth/api";
import { hiddenRanges, keyAt, stateAt, trackEnd } from "./trackMath";

/** Дорожки объектов под кадром: жизнь трека, ключи, заслонённые куски.
 *
 * Перенос таймлайна вниз нужен ровно затем, чтобы видеть время всех объектов
 * разом: где они появляются, где пересекаются, где кто заслонён. Дорожка
 * одного объекта такого не показывает.
 *
 * Жесты — основной путь, потому что мышью здесь и работают:
 *   клик по дорожке        — встать на кадр
 *   протяжка ромба         — перенести ключ
 *   протяжка края отрезка  — сдвинуть появление или исчезновение
 *   Alt + протяжка         — вырезать заслонённый участок
 *   правая кнопка          — меню на этом кадре
 * Жест, о котором нельзя догадаться, для нового разметчика не существует —
 * поэтому всё то же есть в контекстном меню.
 */

export interface LaneAction {
  kind: "seek" | "move-key" | "set-start" | "set-end" | "hide" | "menu";
  trackId: string;
  frame: number;
  /** Для переноса ключа — откуда, для заслонения — второй край. */
  from?: number;
  at?: { x: number; y: number };
}

type Drag =
  | { kind: "key"; trackId: string; from: number }
  | { kind: "start"; trackId: string }
  | { kind: "end"; trackId: string }
  | { kind: "hide"; trackId: string; anchor: number };

export default function TrackLanes({
  tracks,
  frame,
  lastFrame,
  labelOf,
  selected,
  editable,
  onSelect,
  onAction,
}: {
  tracks: VideoTrack[];
  frame: number;
  lastFrame: number;
  labelOf: (ci: number) => { name: string; color: string };
  selected: string | null;
  editable: boolean;
  onSelect: (trackId: string) => void;
  onAction: (action: LaneAction) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ghost, setGhost] = useState<number | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);

  const span = Math.max(1, lastFrame);
  const pct = (f: number) => `${Math.max(0, Math.min(100, (f / span) * 100))}%`;

  const frameFromEvent = useCallback(
    (e: { clientX: number }, el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
      return Math.max(0, Math.min(lastFrame, Math.round(ratio * span)));
    },
    [lastFrame, span]
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent, track: VideoTrack, kind: Drag["kind"] | "lane", from?: number) => {
      if (e.button === 2) return;
      onSelect(track.id);
      const lane = (e.currentTarget as HTMLElement).closest(".g-lane-track") as HTMLElement;
      if (!lane) return;
      const at = frameFromEvent(e, lane);

      if (!editable || kind === "lane") {
        if (e.altKey && editable) {
          setDrag({ kind: "hide", trackId: track.id, anchor: at });
          setGhost(at);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
        onAction({ kind: "seek", trackId: track.id, frame: at });
        return;
      }

      setDrag(
        kind === "key"
          ? { kind: "key", trackId: track.id, from: from ?? at }
          : kind === "start"
            ? { kind: "start", trackId: track.id }
            : kind === "end"
              ? { kind: "end", trackId: track.id }
              : { kind: "hide", trackId: track.id, anchor: at }
      );
      setGhost(at);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    },
    [editable, frameFromEvent, onAction, onSelect]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!drag) return;
      const lane = (e.currentTarget as HTMLElement).closest(".g-lane-track") as HTMLElement;
      if (!lane) return;
      setGhost(frameFromEvent(e, lane));
    },
    [drag, frameFromEvent]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!drag || ghost === null) {
        setDrag(null);
        setGhost(null);
        return;
      }
      const lane = (e.currentTarget as HTMLElement).closest(".g-lane-track") as HTMLElement;
      const at = lane ? frameFromEvent(e, lane) : ghost;

      if (drag.kind === "key" && at !== drag.from) {
        onAction({ kind: "move-key", trackId: drag.trackId, frame: at, from: drag.from });
      } else if (drag.kind === "start") {
        onAction({ kind: "set-start", trackId: drag.trackId, frame: at });
      } else if (drag.kind === "end") {
        onAction({ kind: "set-end", trackId: drag.trackId, frame: at });
      } else if (drag.kind === "hide" && at !== drag.anchor) {
        onAction({
          kind: "hide",
          trackId: drag.trackId,
          frame: Math.max(at, drag.anchor),
          from: Math.min(at, drag.anchor),
        });
      }
      setDrag(null);
      setGhost(null);
    },
    [drag, ghost, frameFromEvent, onAction]
  );

  if (!tracks.length) {
    return (
      <div className="g-lanes-empty">
        Нажмите <kbd>T</kbd> и обведите объект — он станет треком и будет жить
        от этого кадра до того, где вы его уберёте.
      </div>
    );
  }

  return (
    <div className="g-lanes" ref={laneRef}>
      {tracks.map((track) => {
        const label = labelOf(track.class_index ?? -1);
        const end = trackEnd(track);
        const here = stateAt(track, frame);
        const on = track.id === selected;
        const dragging = drag?.trackId === track.id ? drag : null;

        return (
          <div key={track.id} className={on ? "g-lane on" : "g-lane"}>
            <button className="g-lane-name" type="button" onClick={() => onSelect(track.id)}>
              <i style={{ background: label.color }} />
              <span>{track.label || label.name || "объект"}</span>
              <em>{track.keys.length}</em>
            </button>

            <div
              className="g-lane-track"
              data-help=""
              data-ht="Дорожка объекта: ромб — ключ, края — жизнь трека, Alt + протяжка — заслонить"
              onContextMenu={(e) => {
                e.preventDefault();
                const at = frameFromEvent(e, e.currentTarget as HTMLElement);
                onAction({
                  kind: "menu", trackId: track.id, frame: at,
                  at: { x: e.clientX, y: e.clientY },
                });
              }}
              onPointerDown={(e) => onPointerDown(e, track, "lane")}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {/* Отрезок жизни: от появления до кадра, где объект убрали. */}
              <span
                className="g-lane-life"
                style={{ left: pct(track.start_frame), right: `${100 - (end / span) * 100}%`,
                         background: label.color }}
              />
              {editable && on && (
                <>
                  <span className="g-lane-grip s" style={{ left: pct(track.start_frame) }}
                    onPointerDown={(e) => onPointerDown(e, track, "start")}
                    onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                  <span className="g-lane-grip e" style={{ left: pct(end) }}
                    onPointerDown={(e) => onPointerDown(e, track, "end")}
                    onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                </>
              )}

              {hiddenRanges(track).map(([from, to], i) => (
                <span key={i} className="g-lane-occl"
                  style={{ left: pct(from), width: pct(to - from) }}
 />
              ))}

              {/* Тень будущего действия: пока тянут, видно, куда попадёт. */}
              {dragging && ghost !== null && (
                dragging.kind === "hide" ? (
                  <span className="g-lane-occl ghost" style={{
                    left: pct(Math.min(ghost, dragging.anchor)),
                    width: pct(Math.abs(ghost - dragging.anchor)),
                  }} />
                ) : (
                  <span className="g-lane-key ghost" style={{ left: pct(ghost) }} />
                )
              )}

              {track.keys.map((k) => (
                <span
                  key={k.frame_no}
                  className={k.frame_no === frame ? "g-lane-key now" : "g-lane-key"}
                  style={{ left: pct(k.frame_no), background: label.color }}
                  onPointerDown={(e) => onPointerDown(e, track, "key", k.frame_no)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              ))}

              <span className="g-lane-needle" style={{ left: pct(frame) }} />
            </div>

            <span className="g-lane-state">
              {here ? (here.hidden ? "заслонён" : "виден") : "нет"}
              {here && keyAt(track, frame) ? " · ключ" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
