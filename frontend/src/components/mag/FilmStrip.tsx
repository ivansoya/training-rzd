import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { imageThumbUrl } from "../../auth/api";

/** Кинолента под кадром: превью с разметкой, обводка несёт состояние.
 *
 * Высоту тянут за верхнюю границу и она запоминается — сколько ленты нужно,
 * зависит от работы: при сплошной разметке важнее кадр, при выборочной — лента.
 */

export interface FilmBox {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface FilmItem {
  id: string;
  width: number | null;
  height: number | null;
  boxes?: FilmBox[];
  /** Класс обводки: состояние кадра. */
  ring?: string;
  title?: string;
}

const MIN_H = 96;
const MAX_H = 360;
const DEFAULT_H = 186;
// Отступы ленты, отступ до полосы прокрутки и сама полоса.
const PAD = 38;

function stored(key: string): number {
  const raw = Number(window.localStorage.getItem(key));
  return raw >= MIN_H && raw <= MAX_H ? raw : DEFAULT_H;
}

export default function FilmStrip({
  items,
  index,
  onPick,
  storageKey = "mag-film-h",
  onHeight,
}: {
  items: FilmItem[];
  index: number;
  onPick: (i: number) => void;
  storageKey?: string;
  onHeight?: (h: number) => void;
}) {
  const [height, setHeight] = useState(() => stored(storageKey));
  const railRef = useRef<HTMLDivElement>(null);
  const resize = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => { onHeight?.(height); }, [height, onHeight]);

  useEffect(() => {
    const el = railRef.current;
    const active = el?.children[index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [index]);

  // Колесо катит ленту вдоль: вертикальной прокрутки у неё нет, а поворот
  // колеса над лентой означает ровно «покажи соседние кадры».
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      const delta = e.deltaY || e.deltaX;
      if (!delta) return;
      e.preventDefault();
      el!.scrollLeft += delta;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function onGrabDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resize.current = { y: e.clientY, h: height };
  }

  function onGrabMove(e: ReactPointerEvent<HTMLDivElement>) {
    const r = resize.current;
    if (!r) return;
    // Тянем вверх — лента растёт.
    const next = Math.max(MIN_H, Math.min(r.h + (r.y - e.clientY), MAX_H));
    setHeight(next);
  }

  function onGrabUp() {
    if (!resize.current) return;
    resize.current = null;
    window.localStorage.setItem(storageKey, String(height));
  }

  const cell = height - PAD;

  return (
    <div className="mag-fs" style={{ height }}>
      <div
        className="mag-fs-grab"
        onPointerDown={onGrabDown}
        onPointerMove={onGrabMove}
        onPointerUp={onGrabUp}
        title="Потяните, чтобы изменить высоту ленты"
        role="separator"
        aria-orientation="horizontal"
      />
      <div className="mag-fs-rail" ref={railRef}>
        {items.map((im, i) => (
          <button
            key={im.id}
            type="button"
            className={`mag-fs-cell ${im.ring || ""}${i === index ? " cur" : ""}`}
            style={{ width: cell * (4 / 3), height: cell }}
            onClick={() => onPick(i)}
            title={im.title}
          >
            <img src={imageThumbUrl(im.id)} alt="" loading="lazy" decoding="async" />
            {(im.boxes || []).map((b, k) => (
              <i
                key={k}
                style={{
                  left: `${(b.x / (im.width || 1)) * 100}%`,
                  top: `${(b.y / (im.height || 1)) * 100}%`,
                  width: `${(b.w / (im.width || 1)) * 100}%`,
                  height: `${(b.h / (im.height || 1)) * 100}%`,
                  ["--bc" as string]: b.color,
                }}
              />
            ))}
            <span className="mag-fs-n">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
