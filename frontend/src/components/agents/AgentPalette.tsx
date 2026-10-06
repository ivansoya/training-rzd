// Палитра узлов агента: колонка справа от холста — щелчок добавляет, перетаскивание ставит в нужное место.

import { useMemo, useState, type CSSProperties } from "react";
import { Icon, Input, cx } from "../../ui";
import { PALETTE, iconOf, type Addable } from "./look";

export const AGENT_MIME = "application/mag-agent-node";

export default function AgentPalette({ onPick, disabled }: { onPick: (kind: Addable) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PALETTE.map((g) => ({ ...g, items: g.items.filter((i) => !needle || i.label.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length);
  }, [query]);

  return (
    <aside className="ge-pal" aria-label="Узлы">
      <div className="ge-pal-h">
        <span>Узлы</span>
        <span className="t-xs t-faint">щелчок или перетаскивание</span>
      </div>
      <Input icon="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти узел" aria-label="Найти узел" />
      {shown.length === 0 && <p className="t-xs t-faint ge-pal-none">Такого узла нет</p>}
      {shown.map((group) => (
        <div key={group.key} className="ge-pal-g" style={{ "--gc": group.tone } as CSSProperties}>
          <h4><i aria-hidden="true" />{group.title}</h4>
          {group.items.map((item) => (
            <div key={item.kind} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
              className={cx("ge-pal-i", disabled && "off")} draggable={!disabled}
              title={disabled ? "Агент открыт только для чтения" : "Щелчок — добавить, перетаскивание — поставить в нужное место"}
              onDragStart={(e) => {
                e.dataTransfer.setData(AGENT_MIME, item.kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => !disabled && onPick(item.kind)}
              onKeyDown={(e) => {
                if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(item.kind); }
              }}>
              <Icon name={iconOf(item.kind)} />
              <span className="t-ell">{item.label}</span>
              <span className="ge-pal-plus"><Icon name="plus" size={14} /></span>
            </div>
          ))}
        </div>
      ))}
      <p className="t-xs t-faint ae-pal-note">«Кадр» и «Выход» в агенте по одному — они уже на холсте.</p>
    </aside>
  );
}
