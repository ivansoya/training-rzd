import { forwardRef, useId } from "react";
import type { CSSProperties, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cx, rangePercent } from "./cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Kbd } from "./Button";

/** Подпись, поле и подсказка/ошибка под ним. Поле получает id через render-функцию. */
export function Field({ label, hint, error, warn, aside, children, className }: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  warn?: boolean;
  /** Справа от подписи: текущее значение ползунка, счётчик символов. */
  aside?: ReactNode;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("ui-field", Boolean(error) && "invalid", className)}>
      {(label || aside) && (
        <div className="ui-field-l">
          {label && <label htmlFor={id}>{label}</label>}
          {aside && <span className="ui-field-aside">{aside}</span>}
        </div>
      )}
      {children(id)}
      {error ? <p className="ui-hint err" role="alert">{error}</p>
        : hint ? <p className={cx("ui-hint", warn && "warn")}>{hint}</p> : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  icon?: IconName;
  kbd?: string;
  size?: never;
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, kbd, className, invalid, ...rest }, ref,
) {
  const input = (
    <input ref={ref} aria-invalid={invalid || undefined}
      className={cx("ui-input ui-ctl", !(icon || kbd) && className)} {...rest} />
  );
  if (!icon && !kbd) return input;
  return (
    <span className={cx("ui-inp", icon && "has-ic", kbd && "has-kbd", className)}>
      {icon && <Icon name={icon} />}
      {input}
      {kbd && <Kbd>{kbd}</Kbd>}
    </span>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea(
  { className, invalid, ...rest }, ref,
) {
  return <textarea ref={ref} aria-invalid={invalid || undefined}
    className={cx("ui-input ui-textarea ui-ctl", className)} {...rest} />;
});

/** Ползунок: один вид на весь сайт, заливка до бегунка. */
export const Range = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  function Range({ className, style, min = 0, max = 100, value, ...rest }, ref) {
    const p = rangePercent(Number(value ?? min), Number(min), Number(max));
    return (
      <input ref={ref} type="range" min={min} max={max} value={value}
        className={cx("ui-range ui-ctl", className)}
        style={{ ...style, "--p": `${p}%` } as CSSProperties} {...rest} />
    );
  });

export function Switch({ checked, onChange, label, disabled, id }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label}
      disabled={disabled} className={cx("ui-switch", checked && "on")}
      onClick={() => onChange(!checked)} />
  );
}

/** Флажок с подписью. Нативный input — работают формы, клавиатура и чтецы. */
export function Check({ checked, onChange, children, disabled, indeterminate, title }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  title?: string;
}) {
  return (
    <label className={cx("ui-check-l", disabled && "disabled")} title={title}>
      <input type="checkbox" className="ui-check ui-ctl" checked={checked} disabled={disabled}
        ref={(el) => { if (el) el.indeterminate = Boolean(indeterminate); }}
        onChange={(e) => onChange(e.target.checked)} />
      {children != null && <span>{children}</span>}
    </label>
  );
}

export type Tri = "in" | "ex" | null;

/** Три состояния: нужен, исключить, неважно. Щелчок идёт по кругу. */
export function nextTri(v: Tri): Tri {
  return v === null ? "in" : v === "in" ? "ex" : null;
}

export function TriCheck({ value, onChange, children }: {
  value: Tri;
  onChange: (v: Tri) => void;
  children: ReactNode;
}) {
  const state = value === "in" ? "нужен" : value === "ex" ? "исключить" : "неважно";
  return (
    <button type="button" className="ui-opt" onClick={() => onChange(nextTri(value))}
      aria-label={`${typeof children === "string" ? children : ""}: ${state}`}>
      <span className={cx("ui-tri", value)} aria-hidden="true">
        {value === "in" && <Icon name="tick" size={12} />}
        {value === "ex" && <Icon name="minus" size={12} />}
      </span>
      <span className="ui-opt-t">{children}</span>
    </button>
  );
}
