import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { imageThumbUrl } from "../../auth/api";
import ShapeMini from "./ShapeMini";
import type { MiniShape } from "./ShapeMini";

/** Кинолента: превью с разметкой, обводка несёт состояние.
 *
 * Горизонтальная под кадром (лайтбокс) тянется за верхнюю кромку, вертикальная
 * слева от кадра (редактор) — за правую. Размер запоминается: сколько ленты
 * нужно, зависит от работы.
 */

/** Фигура на превью — ровно то, что нужно слою разметки. */
export type FilmBox = MiniShape;

export interface FilmItem {
  id: string;
  width: number | null;
  height: number | null;
  boxes?: FilmBox[];
  /** Класс обводки: состояние кадра. */
  ring?: string;
  title?: string;
}

const SIZE = {
  horizontal: { min: 96, max: 360, def: 186, key: "mag-film-h" },
  vertical: { min: 84, max: 240, def: 120, key: "mag-film-w" },
};
// Отступы ленты, отступ до полосы прокрутки и сама полоса.
const PAD = 38;
const PAD_V = 30;

function stored(key: string, s: { min: number; max: number; def: number }): number {
  try {
    const raw = Number(window.localStorage.getItem(key));
    return raw >= s.min && raw <= s.max ? raw : s.def;
  } catch {
    return s.def;
  }
}

export default function FilmStrip({
  items,
  index,
  onPick,
  vertical = false,
  storageKey,
  onHeight,
  onSize,
}: {
  items: FilmItem[];
  index: number;
  onPick: (i: number) => void;
  vertical?: boolean;
  storageKey?: string;
  onHeight?: (h: number) => void;
  /** Размер поперёк ленты: высота горизонтальной, ширина вертикальной. */
  onSize?: (px: number) => void;
}) {
  const lim = SIZE[vertical ? "vertical" : "horizontal"];
  const key = storageKey ?? lim.key;
  const [size, setSize] = useState(() => stored(key, lim));
  const railRef = useRef<HTMLDivElement>(null);
  const resize = useRef<{ at: number; size: number } | null>(null);

  useEffect(() => { onHeight?.(size); onSize?.(size); }, [size, onHeight, onSize]);

  useEffect(() => {
    const el = railRef.current;
    const active = el?.children[index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: vertical ? "center" : "nearest", inline: "center", behavior: "smooth" });
  }, [index, vertical]);

  // Колесо над горизонтальной лентой катит её вдоль: вертикальной прокрутки у неё нет.
  useEffect(() => {
    const el = railRef.current;
    if (!el || vertical) return;
    function onWheel(e: WheelEvent) {
      const delta = e.deltaY || e.deltaX;
      if (!delta) return;
      e.preventDefault();
      el!.scrollLeft += delta;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [vertical]);

  function onGrabDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { at: vertical ? e.clientX : e.clientY, size };
  }

  function onGrabMove(e: ReactPointerEvent<HTMLDivElement>) {
    const r = resize.current;
    if (!r) return;
    // Горизонтальная растёт вверх, вертикальная — вправо.
    const delta = vertical ? e.clientX - r.at : r.at - e.clientY;
    setSize(Math.max(lim.min, Math.min(r.size + delta, lim.max)));
  }

  function onGrabUp() {
    if (!resize.current) return;
    resize.current = null;
    try { window.localStorage.setItem(key, String(size)); } catch { /* не запомнится */ }
  }

  const cellW = vertical ? size - PAD_V : (size - PAD) * (4 / 3);
  const cellH = vertical ? (size - PAD_V) * (3 / 4) : size - PAD;

  return (
    <div className={vertical ? "mag-fs v" : "mag-fs"} style={vertical ? { width: size } : { height: size }}>
      <div
        className="mag-fs-grab"
        onPointerDown={onGrabDown}
        onPointerMove={onGrabMove}
        onPointerUp={onGrabUp}
        onDoubleClick={() => {
          setSize(lim.def);
          try { window.localStorage.setItem(key, String(lim.def)); } catch { /* не запомнится */ }
        }}
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        title={vertical ? "Потяните — ширина ленты; двойной щелчок — как было" : "Потяните — высота ленты"}
      />
      <div className="mag-fs-rail" ref={railRef}>
        {items.map((im, i) => (
          <button
            key={im.id}
            type="button"
            className={`mag-fs-cell ${im.ring || ""}${i === index ? " cur" : ""}`}
            style={{ width: cellW, height: cellH }}
            // Щелчок мышью фокус не забирает: иначе Пробел редактора «нажимал» бы эту миниатюру
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(i)}
            title={im.title}
          >
            <img src={imageThumbUrl(im.id)} alt="" loading="lazy" decoding="async" />
            <ShapeMini boxes={im.boxes || []} width={im.width} height={im.height} />
            <span className="mag-fs-n">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
