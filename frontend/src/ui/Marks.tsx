import type { CSSProperties, ReactNode } from "react";
import { cx, hueOf, initialsOf, stackShares } from "./cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/** Цвет — всегда токен (`var(--c1)`, `var(--st-done)`) или цвет класса из данных. */
export function Badge({ tone, variant, icon, live, children, title }: {
  tone?: string;
  variant?: "outline" | "secondary";
  icon?: IconName;
  live?: boolean;
  children: ReactNode;
  title?: string;
}) {
  const style: Vars | undefined = tone ? { "--t": tone } : undefined;
  return (
    <span className={cx("ui-badge", tone && "ui-badge-tone", variant === "secondary" && "ui-badge-sec")}
      style={style} title={title}>
      {live && <Dot color={tone} live />}
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

export function Dot({ color, live, title }: { color?: string; live?: boolean; title?: string }) {
  const style: Vars | undefined = color ? { "--t": color } : undefined;
  return <i className={cx("ui-dot", live && "ui-dot-live")} style={style} title={title}
    aria-hidden={title ? undefined : true} />;
}

/** Образец цвета класса. Без цвета — пунктирный «фон». */
export function Swatch({ color, title }: { color?: string | null; title?: string }) {
  const style: Vars | undefined = color ? { "--cc": color } : undefined;
  return <span className={cx("ui-swatch", !color && "ui-swatch-bg")} style={style} title={title} />;
}

export function Avatar({ name, size = 24, title }: { name: string; size?: number; title?: string }) {
  const style: Vars = { "--h": hueOf(name), width: size, height: size, fontSize: size * .4 };
  return <span className="ui-av" style={style} title={title ?? name}>{initialsOf(name)}</span>;
}

export function Avatars({ names, max = 5 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  return (
    <span className="ui-avs">
      {shown.map((n, i) => <Avatar key={n + i} name={n} />)}
      {names.length > max && <span className="ui-av ui-av-more">+{names.length - max}</span>}
    </span>
  );
}

export function Chip({ icon, children, onRemove, removeLabel, tone, title }: {
  icon?: IconName;
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  tone?: "neg";
  title?: string;
}) {
  return (
    <span className={cx("ui-chip", onRemove && "ui-chip-x", tone === "neg" && "ui-chip-neg")} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? "Убрать"}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

export function Progress({ value, max = 1, label, color }: {
  value: number; max?: number; label?: string; color?: string;
}) {
  const p = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="ui-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(p)} aria-label={label}>
      <i style={{ width: `${p}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

export interface StackPart { value: number; color: string; label: string }

/** Полоса из долей: состояния кадров, память карты. */
export function StackBar({ parts, height, label }: { parts: StackPart[]; height?: number; label?: string }) {
  const shares = stackShares(parts.map((p) => p.value));
  return (
    <div className="ui-stack" style={height ? { height } : undefined} role="img"
      aria-label={label ?? parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
      {parts.map((p, i) => shares[i] > 0 &&
        <i key={p.label} style={{ width: `${shares[i]}%`, background: p.color }} title={p.label} />)}
    </div>
  );
}

export function Legend({ items }: { items: { label: ReactNode; color: string; kind?: "line" | "dash" }[] }) {
  return (
    <div className="ui-legend">
      {items.map((it, i) => (
        <span key={i}>
          <i className={cx(it.kind === "line" && "ln", it.kind === "dash" && "dash")}
            style={{ "--t": it.color } as Vars} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Кольцо загрузки: прогресс 0–1, «готово» или «ошибка». */
export function Ring({ value = 0, tone, label, size = 140 }: {
  value?: number;
  tone?: "done" | "bad";
  label: string;
  size?: number;
}) {
  const R = 54;
  const C = 2 * Math.PI * R;
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cx("ui-ring", tone)} style={{ width: size, height: size }}
      role={tone ? "img" : "progressbar"} aria-label={label}
      aria-valuemin={tone ? undefined : 0} aria-valuemax={tone ? undefined : 100}
      aria-valuenow={tone ? undefined : pct}>
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle cx="64" cy="64" r={R} className="ui-ring-t" />
        <circle cx="64" cy="64" r={R} className="ui-ring-v"
          style={tone ? undefined : { strokeDasharray: C, strokeDashoffset: C * (1 - pct / 100) }} />
      </svg>
      <div className="ui-ring-c">
        {tone === "done" ? <Icon name="tick" size={40} />
          : tone === "bad" ? <Icon name="x" size={40} />
            : <b>{pct}<small> %</small></b>}
      </div>
    </div>
  );
}

/** Бейдж-сообщение: подсказка, предупреждение, ошибка или успех — вместо сплошной строки. */
export function Pill({ tone = "info", icon, children, title }: {
  tone?: "info" | "warn" | "bad" | "ok";
  icon?: IconName;
  children: ReactNode;
  title?: string;
}) {
  const auto: IconName = tone === "ok" ? "tick" : tone === "info" ? "info" : "alert";
  return (
    <span className={cx("ui-pill", tone)} title={title}>
      <Icon name={icon ?? auto} size={13} />
      {children}
    </span>
  );
}

/** Чип-переключатель: таги, короткие наборы вариантов. */
export function ChipToggle({ pressed, onToggle, children, count, disabled, title }: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
  count?: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" className="ui-chiptg" aria-pressed={pressed} disabled={disabled} title={title}
      onClick={onToggle}>
      {children}
      {count != null && <span className="ui-count">{count}</span>}
    </button>
  );
}
