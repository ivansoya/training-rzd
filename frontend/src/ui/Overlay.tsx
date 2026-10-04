import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import * as RD from "@radix-ui/react-dialog";
import * as RP from "@radix-ui/react-popover";
import * as RS from "@radix-ui/react-select";
import { cx } from "./cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useEscape } from "./useEscape";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

/** Выпадашка вместо нативного select. Значение «пусто» Radix не принимает — используйте «none». */
export function Select<T extends string>({ value, onChange, options, placeholder, label, icon,
  disabled, full, size, id }: {
  value: T | undefined;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  label?: string;
  icon?: IconName;
  disabled?: boolean;
  full?: boolean;
  size?: "sm";
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  useEscape(() => setOpen(false), open);
  return (
    <RS.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}
      open={open} onOpenChange={setOpen}>
      <RS.Trigger id={id} aria-label={label}
        className={cx("ui-select", full && "full", size === "sm" && "sm")}>
        {icon && <Icon name={icon} size={14} />}
        <span className="ui-select-v"><RS.Value placeholder={placeholder} /></span>
        <RS.Icon asChild><Icon name="chevD" size={14} /></RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className="ui-pop ui-select-pop" position="popper" sideOffset={6}
          collisionPadding={8}>
          <RS.Viewport>
            {options.map((o) => (
              <RS.Item key={o.value} value={o.value} disabled={o.disabled} className="ui-opt">
                <span className="ui-opt-t">
                  <RS.ItemText>{o.label}</RS.ItemText>
                  {o.hint && <span className="ui-opt-h">{o.hint}</span>}
                </span>
                <RS.ItemIndicator><Icon name="tick" size={14} /></RS.ItemIndicator>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

/** Всплывающая панель у кнопки. Закрывается Esc, щелчком мимо и прокруткой страницы. */
export function Popover({ trigger, children, align = "start", width, open: openProp, onOpenChange,
  className }: {
  trigger: ReactElement;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "center" | "end";
  width?: number;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  className?: string;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const set = (v: boolean) => { setOwn(v); onOpenChange?.(v); };
  const content = useRef<HTMLDivElement>(null);
  // Верхний слой стопки Esc: закрывается он, а не окно под ним
  useEscape(() => set(false), open);
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (content.current && e.target instanceof Node && content.current.contains(e.target)) return;
      set(false);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open]); // слушатель вешается на открытие, а не на каждый рендер
  return (
    <RP.Root open={open} onOpenChange={set}>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content ref={content} align={align} sideOffset={6} collisionPadding={8}
          className={cx("ui-pop", className)} style={width ? { width } : undefined}>
          {typeof children === "function" ? children(() => set(false)) : children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

/** Строка меню внутри Popover. */
export function MenuItem({ icon, children, onSelect, danger, disabled, hint, selected }: {
  icon?: IconName;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  selected?: boolean;
}) {
  return (
    <button type="button" className={cx("ui-opt", danger && "danger")} disabled={disabled}
      aria-current={selected || undefined} onClick={onSelect}>
      {icon && <Icon name={icon} size={14} />}
      <span className="ui-opt-t">{children}{hint && <span className="ui-opt-h">{hint}</span>}</span>
      {selected && <Icon name="tick" size={14} />}
    </button>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Не закрывать щелчком мимо: в окне идёт работа, которую жалко потерять. */
  modalLock?: boolean;
}

export function Dialog({ open, onOpenChange, title, desc, children, footer, width, modalLock }: DialogProps) {
  useEscape(() => onOpenChange(false), open);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="ui-scrim" />
        <RD.Content className="ui-dialog" style={width ? { width } : undefined}
          onPointerDownOutside={modalLock ? (e) => e.preventDefault() : undefined}>
          <div className="ui-dialog-h">
            <div>
              <RD.Title className="ui-dialog-t">{title}</RD.Title>
              {desc ? <RD.Description className="ui-dialog-d">{desc}</RD.Description>
                : <RD.Description className="ui-sr">{typeof title === "string" ? title : ""}</RD.Description>}
            </div>
            <RD.Close className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon" aria-label="Закрыть">
              <Icon name="x" />
            </RD.Close>
          </div>
          {children != null && <div className="ui-dialog-b">{children}</div>}
          {footer && <div className="ui-dialog-f">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Боковая панель поверх страницы — правка записи без ухода из списка. */
export function Sheet({ open, onOpenChange, title, desc, children, footer, width }: DialogProps) {
  useEscape(() => onOpenChange(false), open);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="ui-scrim" />
        <RD.Content className="ui-sheet" style={width ? { width } : undefined}>
          <div className="ui-dialog-h">
            <div>
              <RD.Title className="ui-dialog-t">{title}</RD.Title>
              {desc ? <RD.Description className="ui-dialog-d">{desc}</RD.Description>
                : <RD.Description className="ui-sr">{typeof title === "string" ? title : ""}</RD.Description>}
            </div>
            <RD.Close className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-icon" aria-label="Закрыть">
              <Icon name="x" />
            </RD.Close>
          </div>
          <div className="ui-sheet-b">{children}</div>
          {footer && <div className="ui-dialog-f">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
