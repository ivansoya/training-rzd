import { useState } from "react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function CollapsibleSection({
  title,
  count,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="tile-section">
      <button
        className="tile-section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={open ? "chevron open" : "chevron"}>▾</span>
        <span className="tile-section-title">{title}</span>
        {count != null && <span className="count">{count}</span>}
      </button>
      {open && <div className="tile-grid">{children}</div>}
    </section>
  );
}
