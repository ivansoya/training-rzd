import { useState } from "react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}

export default function CollapsibleSection({
  title,
  count,
  defaultOpen = true,
  action,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="tile-section">
      <div className="tile-section-bar">
        <button
          className="tile-section-head"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={open ? "chevron open" : "chevron"}>▾</span>
          <span className="tile-section-title">{title}</span>
          {count != null && <span className="count">{count}</span>}
        </button>
        {action}
      </div>
      {open && <div className="tile-grid">{children}</div>}
    </section>
  );
}
