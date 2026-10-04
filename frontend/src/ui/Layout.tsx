import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export function Card({ title, desc, actions, children, className, flush, ...rest }: {
  title?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Тело без внутренних полей — для таблиц и списков во всю ширину карточки. */
  flush?: boolean;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <section className={cx("ui-card", className)} {...rest}>
      {(title || actions) && (
        <div className="ui-card-h">
          <div>
            {title && <h3 className="ui-card-t">{title}</h3>}
            {desc && <p className="ui-card-d">{desc}</p>}
          </div>
          {actions && <div className="ui-card-a">{actions}</div>}
        </div>
      )}
      {children != null && <div className={cx("ui-card-b", flush && "flush")}>{children}</div>}
    </section>
  );
}

export function PageHeader({ title, desc, actions, eyebrow }: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="ui-ph">
      <div className="ui-ph-t">
        {eyebrow && <span className="ui-ph-e">{eyebrow}</span>}
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="ui-ph-a">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, children, action, compact }: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx("ui-empty", compact && "compact")}>
      {icon && <Icon name={icon} size={22} />}
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Строка-сообщение: ошибка сервера, предупреждение, подсказка. */
export function Notice({ tone = "info", children, onClose, action }: {
  tone?: "info" | "warn" | "error" | "ok";
  children: ReactNode;
  onClose?: () => void;
  action?: ReactNode;
}) {
  const icon: IconName = tone === "info" ? "info" : tone === "ok" ? "tick" : "alert";
  return (
    <div className={cx("ui-notice", tone)} role={tone === "error" ? "alert" : "status"}>
      <Icon name={icon} />
      <div className="ui-notice-b">{children}</div>
      {action}
      {onClose && (
        <button type="button" className="ui-notice-x" onClick={onClose} aria-label="Закрыть">
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

/** Таблица во всю ширину с горизонтальной прокруткой на узком. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <div className="ui-table-w"><table className={cx("ui-table", className)}>{children}</table></div>;
}

/** Пары «подпись — значение». */
export function Meta({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="ui-meta">
      {items.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}
