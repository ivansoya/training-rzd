import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Палитра проекта: цвета различимы на фотографии и друг от друга. Остаётся
// быстрым способом взять заведомо годный цвет, не выцеливая его в спектре.
export const PALETTE = [
  "#e21a1a", "#e8590c", "#f08c00", "#2b8a3e",
  "#1a7f4b", "#0c8599", "#0b7285", "#1f6feb",
  "#5c7cfa", "#8957e5", "#862e9c", "#c2255c",
];

const HEX = /^#[0-9a-fA-F]{6}$/;

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(Math.max(v, lo), hi);
}

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const val = v - v * s * Math.max(0, Math.min(k, Math.min(4 - k, 1)));
    return Math.round(255 * val).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = HEX.test(hex) ? hex : "#e21a1a";
  const r = parseInt(m.slice(1, 3), 16) / 255;
  const g = parseInt(m.slice(3, 5), 16) / 255;
  const b = parseInt(m.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// Свой спектр вместо системного input[type=color]: тот рисуется по-разному в
// каждой ОС и в интерфейс не встраивается никак.
export default function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const start = hexToHsv(value);
  const [h, setH] = useState(start.h);
  const [s, setS] = useState(start.s);
  const [v, setV] = useState(start.v);
  const [hex, setHex] = useState(value);
  const slRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  function apply(nh: number, ns: number, nv: number) {
    setH(nh);
    setS(ns);
    setV(nv);
    const next = hsvToHex(nh, ns, nv);
    setHex(next);
    onChange(next);
  }

  // Один обработчик на обе плоскости: нажатие ставит значение сразу, дальше
  // ведём по указателю с захватом, чтобы курсор мог уйти за пределы поля.
  function track(
    e: ReactPointerEvent<HTMLDivElement>,
    el: HTMLDivElement | null,
    handler: (x: number, y: number) => void
  ) {
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent | ReactPointerEvent<HTMLDivElement>) => {
      const r = el.getBoundingClientRect();
      handler(
        clamp((ev.clientX - r.left) / r.width),
        clamp((ev.clientY - r.top) / r.height)
      );
    };
    move(e);
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  function typeHex(raw: string) {
    const next = raw.startsWith("#") || raw === "" ? raw : `#${raw}`;
    setHex(next);
    if (HEX.test(next)) {
      const c = hexToHsv(next);
      setH(c.h);
      setS(c.s);
      setV(c.v);
      onChange(next.toLowerCase());
    }
  }

  const pure = hsvToHex(h, 1, 1);

  return (
    <div className="mag-picker">
      <div
        ref={slRef}
        className="mag-sl"
        style={{
          background:
            `linear-gradient(to top, #000, transparent), ` +
            `linear-gradient(to right, #fff, ${pure})`,
        }}
        role="slider"
        tabIndex={0}
        aria-label="Насыщенность и яркость"
        aria-valuetext={hsvToHex(h, s, v)}
        onPointerDown={(e) =>
          track(e, slRef.current, (x, y) => apply(h, x, 1 - y))
        }
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          if (e.key === "ArrowRight") apply(h, clamp(s + step), v);
          else if (e.key === "ArrowLeft") apply(h, clamp(s - step), v);
          else if (e.key === "ArrowUp") apply(h, s, clamp(v + step));
          else if (e.key === "ArrowDown") apply(h, s, clamp(v - step));
          else return;
          e.preventDefault();
        }}
      >
        <span
          className="mag-sl-dot"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
        />
      </div>

      <div
        ref={hueRef}
        className="mag-hue"
        role="slider"
        tabIndex={0}
        aria-label="Тон"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        onPointerDown={(e) =>
          track(e, hueRef.current, (x) => apply(x * 360, s, v))
        }
        onKeyDown={(e) => {
          const step = e.shiftKey ? 30 : 4;
          if (e.key === "ArrowRight") apply((h + step) % 360, s, v);
          else if (e.key === "ArrowLeft") apply((h - step + 360) % 360, s, v);
          else return;
          e.preventDefault();
        }}
      >
        <span className="mag-hue-knob" style={{ left: `${(h / 360) * 100}%` }} />
      </div>

      <div className="mag-hex">
        <span
          className="mag-hex-eye"
          style={{ background: HEX.test(hex) ? hex : value }}
        />
        <input
          type="text"
          value={hex}
          maxLength={7}
          spellCheck={false}
          aria-label="Код цвета"
          onChange={(e) => typeHex(e.target.value.trim())}
          onBlur={() => {
            if (!HEX.test(hex)) setHex(hsvToHex(h, s, v));
          }}
        />
        {!HEX.test(hex) && hex !== "" && (
          <span className="mag-hex-err">Нужен код вида #1f6feb</span>
        )}
      </div>

      <div className="mag-swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Цвет ${c}`}
            className={
              value.toLowerCase() === c ? "mag-swatch pick on" : "mag-swatch pick"
            }
            style={{ background: c }}
            onClick={() => {
              const p = hexToHsv(c);
              apply(p.h, p.s, p.v);
            }}
          />
        ))}
      </div>
    </div>
  );
}
