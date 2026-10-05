import { forwardRef } from "react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LinkProps } from "react-router-dom";
import { cx } from "./cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export type ButtonVariant = "primary" | "agent" | "outline" | "ghost" | "danger";

interface Look {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconName;
  /** Иконка справа от подписи — для «Дальше →» и раскрывашек. */
  iconEnd?: IconName;
  kbd?: string;
}

export function buttonClass({ variant = "outline", size = "md", iconOnly = false }: {
  variant?: ButtonVariant; size?: "md" | "sm"; iconOnly?: boolean;
}): string {
  return cx("ui-btn", `ui-btn-${variant}`, size === "sm" && "ui-btn-sm", iconOnly && "ui-btn-icon");
}

function Inner({ icon, iconEnd, kbd, children }: Look & { children?: ReactNode }) {
  return (
    <>
      {icon && <Icon name={icon} />}
      {children != null && children !== false && <span className="ui-btn-l">{children}</span>}
      {iconEnd && <Icon name={iconEnd} />}
      {kbd && <Kbd>{kbd}</Kbd>}
    </>
  );
}

export type ButtonProps = Look & ButtonHTMLAttributes<HTMLButtonElement>;

/** Кнопка без подписи обязана иметь aria-label — он же всплывает подсказкой. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, iconEnd, kbd, className, children, type = "button", title, ...rest }, ref,
) {
  const iconOnly = children == null && !kbd;
  return (
    <button ref={ref} type={type} title={title ?? (iconOnly ? rest["aria-label"] : undefined)}
      className={cx(buttonClass({ variant, size, iconOnly }), className)} {...rest}>
      <Inner icon={icon} iconEnd={iconEnd} kbd={kbd}>{children}</Inner>
    </button>
  );
});

/** Переход, который выглядит кнопкой. */
export function LinkButton({ variant, size, icon, iconEnd, kbd, className, children, ...rest }:
  Look & LinkProps) {
  const iconOnly = children == null;
  return (
    <Link className={cx(buttonClass({ variant, size, iconOnly }), className)}
      title={iconOnly ? rest["aria-label"] : undefined} {...rest}>
      <Inner icon={icon} iconEnd={iconEnd} kbd={kbd}>{children}</Inner>
    </Link>
  );
}

/** Внешняя ссылка или скачивание файла кнопкой. */
export function AnchorButton({ variant, size, icon, iconEnd, className, children, ...rest }:
  Look & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cx(buttonClass({ variant, size, iconOnly: children == null }), className)} {...rest}>
      <Inner icon={icon} iconEnd={iconEnd}>{children}</Inner>
    </a>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}
