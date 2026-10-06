// Класс для новых объектов: кнопка в верхней панели и всплывашка с поиском.

import { useState } from "react";
import type { LabelClass } from "../../auth/api";
import { Icon, Input, Kbd, Popover, Swatch } from "../../ui";
import { filterClasses } from "./look";

export default function ClassPicker({ classes, active, onPick, onCreate, disabled }: {
  classes: LabelClass[];
  active: number | null;
  onPick: (classIndex: number) => void;
  /** Завести класс, когда поиск ничего не нашёл. */
  onCreate?: (name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = classes.find((c) => c.class_index === active);
  const at = cur ? classes.indexOf(cur) : -1;
  const shown = filterClasses(classes, query);
  const name = query.trim();

  const pick = (ci: number) => { onPick(ci); setOpen(false); setQuery(""); };
  const create = async () => {
    if (!onCreate || !name || busy) return;
    setBusy(true);
    try { await onCreate(name); setOpen(false); setQuery(""); } finally { setBusy(false); }
  };

  const trigger = (
    <button type="button" className="ed-cls" disabled={disabled} aria-label="Класс для новых объектов"
      title="Класс для новых объектов (1–9)">
      <Swatch color={cur?.color} />
      <span className="t-ell">{cur?.name ?? "Класс"}</span>
      {at >= 0 && at < 9 && <Kbd>{at + 1}</Kbd>}
      <Icon name="chevD" size={14} />
    </button>
  );

  return (
    <Popover trigger={trigger} open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}
      width={340} align="center" className="ed-clsp">
      <Input icon="search" autoFocus placeholder="Найти класс" value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (shown[0]) pick(shown[0].class_index); else void create();
        }} />
      <div className="ed-clsp-list" role="listbox" aria-label="Классы">
        {shown.map((c) => {
          const i = classes.indexOf(c);
          return (
            <button key={c.id} type="button" role="option" aria-selected={c.class_index === active}
              className="ui-opt" aria-current={c.class_index === active || undefined} onClick={() => pick(c.class_index)}>
              <Swatch color={c.color} />
              <span className="ui-opt-t t-ell">{c.name}</span>
              {i < 9 && <Kbd>{i + 1}</Kbd>}
            </button>
          );
        })}
        {!shown.length && !onCreate && <p className="ed-clsp-none">Ничего не нашлось.</p>}
      </div>
      {!shown.length && onCreate && name && (
        <button type="button" className="ui-opt" disabled={busy} onClick={() => void create()}>
          <Icon name="plus" size={14} />
          <span className="ui-opt-t">Создать «{name}»<span className="ui-opt-h">Ничего не нашлось</span></span>
        </button>
      )}
    </Popover>
  );
}
