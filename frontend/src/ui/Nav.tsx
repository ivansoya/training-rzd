import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cx } from "./cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName;
  title?: string;
  disabled?: boolean;
}

/** Сегментный переключатель: одно значение из нескольких. */
export function Seg<T extends string>({ value, onChange, options, label, size }: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  label: string;
  size?: "sm";
}) {
  return (
    <div className={cx("ui-seg", size === "sm" && "ui-seg-sm")} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title}
          disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Вид сегмента, но каждая кнопка включается сама по себе: что показывать поверх кадров. */
export function ToggleGroup<T extends string>({ value, onToggle, options, label }: {
  value: Record<T, boolean>;
  onToggle: (key: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
}) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value[o.value]} title={o.title}
          onClick={() => onToggle(o.value)}>
          <Icon name={value[o.value] ? "eye" : "eyeoff"} size={14} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface TabItem {
  /** Переход по адресу — вкладка становится ссылкой. */
  to?: string;
  /** Или значение — тогда вкладками управляет onChange. */
  value?: string;
  label: ReactNode;
  count?: ReactNode;
  end?: boolean;
}

/** Вкладки с подчёркиванием: разделы внутри одной страницы. */
export function Tabs({ items, value, onChange, label }: {
  items: TabItem[];
  value?: string;
  onChange?: (v: string) => void;
  label: string;
}) {
  return (
    <nav className="ui-tabs" aria-label={label}>
      {items.map((it, i) => {
        const inner = <>{it.label}{it.count != null && <span className="ui-count">{it.count}</span>}</>;
        if (it.to) {
          return (
            <NavLink key={it.to} to={it.to} end={it.end}
              className={({ isActive }) => cx("ui-tab", isActive && "on")}>
              {inner}
            </NavLink>
          );
        }
        const on = it.value === value;
        return (
          <button key={it.value ?? i} type="button" className={cx("ui-tab", on && "on")}
            aria-current={on ? "page" : undefined} onClick={() => it.value && onChange?.(it.value)}>
            {inner}
          </button>
        );
      })}
    </nav>
  );
}
