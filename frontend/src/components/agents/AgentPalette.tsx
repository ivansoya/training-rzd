// Палитра узлов агента справа от холста — щелчок добавляет, перетаскивание ставит в нужное место.
// Окно от 1600 px — полный список с группами и поиском, как у графа; уже — полоса значков,
// лупа открывает тот же список всплывашкой. Какую показать, решает CSS (graphed.css, .ae-top).

import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { Button, Icon, Input, Popover, cx } from "../../ui";
import { PALETTE, iconOf, type Addable } from "./look";

export const AGENT_MIME = "application/mag-agent-node";

const HOW = "Щелчок — добавить, перетаскивание — поставить в нужное место";

export default function AgentPalette({ onPick, disabled }: { onPick: (kind: Addable) => void; disabled?: boolean }) {
  return (
    <>
      <aside className="ge-pal ae-pal-full" aria-label="Узлы">
        <PaletteList inline disabled={disabled} onPick={onPick} />
      </aside>
      <Rail onPick={onPick} disabled={disabled} />
    </>
  );
}

function Rail({ onPick, disabled }: { onPick: (kind: Addable) => void; disabled?: boolean }) {
  return (
    <aside className="ae-rail" aria-label="Узлы">
      <Popover align="end" width={260} trigger={<Button variant="ghost" icon="search" aria-label="Найти узел" title="Найти узел" />}>
        {(close) => <PaletteList disabled={disabled} onPick={(kind) => { close(); onPick(kind); }} />}
      </Popover>
      {PALETTE.map((group) => (
        <Fragment key={group.key}>
          <hr />
          {group.items.map((item) => (
            <button key={item.kind} type="button" className="ae-rail-i" style={{ color: group.tone }} disabled={disabled}
              draggable={!disabled} aria-label={item.label} title={disabled ? "Агент открыт только для чтения" : `${item.label}. ${HOW}`}
              onDragStart={(e) => {
                e.dataTransfer.setData(AGENT_MIME, item.kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onPick(item.kind)}>
              <Icon name={iconOf(item.kind)} />
            </button>
          ))}
        </Fragment>
      ))}
    </aside>
  );
}

/** Список узлов; `inline` — колонкой у холста, без фокуса в поиске при открытии. */
function PaletteList({ onPick, disabled, inline }: { onPick: (kind: Addable) => void; disabled?: boolean; inline?: boolean }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PALETTE.map((g) => ({ ...g, items: g.items.filter((i) => !needle || i.label.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length);
  }, [query]);

  return (
    <div className={inline ? "ae-pal-in" : "ge-pal ae-pal-pop"}>
      {inline && (
        <div className="ge-pal-h">
          <span>Узлы</span>
          <span className="t-xs t-faint">щелчок или перетаскивание</span>
        </div>
      )}
      <Input icon="search" autoFocus={!inline} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти узел" aria-label="Найти узел" />
      {shown.length === 0 && <p className="t-xs t-faint ge-pal-none">Такого узла нет</p>}
      {shown.map((group) => (
        <div key={group.key} className="ge-pal-g" style={{ "--gc": group.tone } as CSSProperties}>
          <h4><i aria-hidden="true" />{group.title}</h4>
          {group.items.map((item) => (
            <div key={item.kind} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
              className={cx("ge-pal-i", disabled && "off")} draggable={!disabled} title={disabled ? "Агент открыт только для чтения" : HOW}
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
    </div>
  );
}
