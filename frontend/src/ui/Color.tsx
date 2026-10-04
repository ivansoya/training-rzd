import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { Popover } from "./Overlay";

// Цвета классов — шаг 9 шкал Radix, той же гаммы, что токены; различимы на кадре и между собой
export const CLASS_COLORS = [
  "#e5484d", "#f76b15", "#ffc53d", "#ffe629", "#bdee63", "#46a758", "#29a383", "#00a2c7", "#7ce2fe",
  "#0090ff", "#3e63dd", "#6e56cf", "#8e4ec6", "#ab4aba", "#d6409f", "#e93d82", "#ad7f58",
];

const HEX = /^#[0-9a-fA-F]{6}$/;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(Math.max(v, lo), hi);

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    const val = v - v * s * Math.max(0, Math.min(k, Math.min(4 - k, 1)));
    return Math.round(255 * val).toString(16).padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = HEX.test(hex) ? hex : CLASS_COLORS[0];
  const r = parseInt(m.slice(1, 3), 16) / 255;
  const g = parseInt(m.slice(3, 5), 16) / 255;
  const b = parseInt(m.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
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

/** Свой цвет: плоскость насыщенности и яркости, полоса тона и код. */
export function Spectrum({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const start = hexToHsv(value);
  const [hsv, setHsv] = useState(start);
  const [hex, setHex] = useState(value);
  const plane = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  const { h, s, v } = hsv;

  const apply = (nh: number, ns: number, nv: number) => {
    setHsv({ h: nh, s: ns, v: nv });
    const next = hsvToHex(nh, ns, nv);
    setHex(next);
    onChange(next);
  };

  // Нажатие ставит значение сразу, дальше ведём с захватом — курсор может уйти за край
  const track = (e: ReactPointerEvent<HTMLDivElement>, el: HTMLDivElement | null,
    fn: (x: number, y: number) => void) => {
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      fn(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height));
    };
    move(e);
    const onMove = (ev: PointerEvent) => move(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const typeHex = (raw: string) => {
    const next = raw.startsWith("#") || raw === "" ? raw : `#${raw}`;
    setHex(next);
    if (HEX.test(next)) {
      setHsv(hexToHsv(next));
      onChange(next.toLowerCase());
    }
  };

  return (
    <div className="ui-spec">
      <div ref={plane} className="ui-spec-sv" role="slider" tabIndex={0}
        aria-label="Насыщенность и яркость" aria-valuetext={hsvToHex(h, s, v)}
        style={{ "--hue": hsvToHex(h, 1, 1) } as CSSProperties}
        onPointerDown={(e) => track(e, plane.current, (x, y) => apply(h, x, 1 - y))}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          if (e.key === "ArrowRight") apply(h, clamp(s + step), v);
          else if (e.key === "ArrowLeft") apply(h, clamp(s - step), v);
          else if (e.key === "ArrowUp") apply(h, s, clamp(v + step));
          else if (e.key === "ArrowDown") apply(h, s, clamp(v - step));
          else return;
          e.preventDefault();
        }}>
        <span style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
      </div>
      <div ref={hue} className="ui-spec-hue" role="slider" tabIndex={0} aria-label="Тон"
        aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(h)}
        onPointerDown={(e) => track(e, hue.current, (x) => apply(x * 360, s, v))}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 30 : 4;
          if (e.key === "ArrowRight") apply((h + step) % 360, s, v);
          else if (e.key === "ArrowLeft") apply((h - step + 360) % 360, s, v);
          else return;
          e.preventDefault();
        }}>
        <span style={{ left: `${(h / 360) * 100}%` }} />
      </div>
      <div className="ui-spec-hex">
        <i style={{ "--cc": HEX.test(hex) ? hex : value } as CSSProperties} />
        <input className="ui-input ui-ctl" value={hex} maxLength={7} spellCheck={false} aria-label="Код цвета"
          aria-invalid={!HEX.test(hex) || undefined}
          onChange={(e) => typeHex(e.target.value.trim())}
          onBlur={() => { if (!HEX.test(hex)) setHex(hsvToHex(h, s, v)); }} />
      </div>
      {!HEX.test(hex) && hex !== "" && <p className="ui-hint err">Нужен код вида #1f6feb</p>}
    </div>
  );
}

/** Цвет класса: образцы палитры и «свой» — последняя клетка со спектром во всплывашке. */
export function ColorPicker({ value, onChange, label = "Цвет" }: {
  value: string;
  onChange: (c: string) => void;
  label?: string;
}) {
  const cur = value.toLowerCase();
  const own = !CLASS_COLORS.includes(cur);
  return (
    <div className="ui-colors" role="radiogroup" aria-label={label}>
      {CLASS_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={cur === c} aria-label={`Цвет ${c}`}
          className="ui-color" style={{ "--cc": c } as CSSProperties} onClick={() => onChange(c)} />
      ))}
      <Popover width={252} align="end" trigger={
        <button type="button" role="radio" aria-checked={own} aria-label="Свой цвет" title="Свой цвет"
          className={cx("ui-color", "ui-color-own", own && "set")}
          style={own ? { "--cc": value } as CSSProperties : undefined}>
          {!own && <Icon name="plus" size={14} />}
        </button>
      }>
        <Spectrum value={value} onChange={onChange} />
      </Popover>
    </div>
  );
}
