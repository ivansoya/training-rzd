// Разметка поверх вписанной картинки (object-fit: contain) в стиле холста редактора:
// тёмная подложка и линия цвета класса, ярлык над левым углом; у мелких — по наведению.

import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "../../ui";

export interface Mark {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Кольца контура в пикселях кадра; без них — рамка. */
  parts?: [number, number][][];
  color: string;
  label?: ReactNode;
  dashed?: boolean;
}

// Ярлык виден всегда, если меньшая сторона на экране не меньше этого — как на холсте
const LABEL_AT = 40;

const ringPath = (parts: [number, number][][]) =>
  parts.filter((r) => r.length > 2).map((r) => "M" + r.map(([x, y]) => `${x} ${y}`).join("L") + "Z").join("");

export default function Marks({ width, height, items }: { width: number; height: number; items: Mark[] }) {
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [hot, setHot] = useState<string | null>(null);
  const watch = useRef<ResizeObserver | null>(null);
  const box = useCallback((el: HTMLDivElement | null) => {
    watch.current?.disconnect();
    if (!el) return;
    watch.current = new ResizeObserver(([e]) => setRoom({ w: e.contentRect.width, h: e.contentRect.height }));
    watch.current.observe(el);
  }, []);
  // Где кадр лёг внутри места: вписан целиком, по центру — как картинка под слоем
  const k = room.w && width && height ? Math.min(room.w / width, room.h / height) : 0;
  const ox = (room.w - width * k) / 2;
  const oy = (room.h - height * k) / 2;

  return (
    <>
      <svg className="mk" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {items.map((m) => {
          const d = m.parts?.length ? ringPath(m.parts) : `M${m.x} ${m.y}h${m.w}v${m.h}h${-m.w}Z`;
          return (
            <g key={m.key} className={cx("mag-cv-sh", m.dashed && "occluded", hot === m.key && "hot")}
              style={{ ["--bc" as string]: m.color }}
              onPointerEnter={() => setHot(m.key)} onPointerLeave={() => setHot((h) => (h === m.key ? null : h))}>
              <path className="mag-cv-hit" d={d} />
              <path className="mag-cv-hull" d={d} />
              <path className="mag-cv-line" d={d} />
            </g>
          );
        })}
      </svg>
      <div className="mk-labels" ref={box}>
        {k > 0 && items.map((m) => {
          if (m.label == null) return null;
          const off = Math.min(m.w, m.h) * k < LABEL_AT && hot !== m.key;
          return (
            <span key={m.key} aria-hidden={off || undefined} className={cx("mag-cv-lb", off && "off", hot === m.key && "hot")}
              style={{ left: ox + m.x * k, top: oy + m.y * k, ["--bc" as string]: m.color }}
              onPointerEnter={() => setHot(m.key)} onPointerLeave={() => setHot((h) => (h === m.key ? null : h))}>
              {m.label}
            </span>
          );
        })}
      </div>
    </>
  );
}
