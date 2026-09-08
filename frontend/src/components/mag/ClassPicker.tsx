// Отбор по классам — сразу нескольким.
//
// Раскрывающийся список с галочками, а не `<select multiple>`: у последнего
// выбор нескольких значений требует зажатого Ctrl, о чём никто не догадывается,
// а список на тридцать классов занимает пол-экрана.
//
// Кнопка всегда говорит, что выбрано: «Все классы», имя одного или «выбрано 4».
// Молчащий фильтр — источник вопроса «почему кадров так мало».

import { useEffect, useRef, useState } from "react";

export interface PickableClass {
  class_index: number;
  name: string;
  color: string;
  count?: number;
}

export default function ClassPicker({
  classes,
  picked,
  onChange,
  label = "классы",
}: {
  classes: PickableClass[];
  picked: number[];
  onChange: (next: number[]) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const chosen = new Set(picked);
  const toggle = (index: number) => {
    const next = new Set(chosen);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onChange([...next].sort((a, b) => a - b));
  };

  const title =
    picked.length === 0
      ? `Все ${label}`
      : picked.length === 1
      ? classes.find((c) => c.class_index === picked[0])?.name ?? `Класс ${picked[0]}`
      : `Выбрано ${picked.length}`;

  return (
    <div className="mag-pick" ref={box}>
      <button
        type="button"
        className={picked.length ? "mag-pick-btn on" : "mag-pick-btn"}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {picked.length > 0 && (
          <span className="mag-pick-dots">
            {picked.slice(0, 4).map((i) => (
              <i
                key={i}
                style={{
                  background:
                    classes.find((c) => c.class_index === i)?.color ?? "#8a8f94",
                }}
              />
            ))}
          </span>
        )}
        {title}
        <span className="mag-pick-arr">▾</span>
      </button>

      {open && (
        <div className="mag-pick-menu">
          <div className="mag-pick-head">
            <button type="button" onClick={() => onChange([])} disabled={!picked.length}>
              Сбросить
            </button>
            <button
              type="button"
              onClick={() => onChange(classes.map((c) => c.class_index))}
              disabled={picked.length === classes.length}
            >
              Выбрать все
            </button>
          </div>
          <div className="mag-pick-list">
            {classes.length === 0 && <div className="mag-empty">Классов нет.</div>}
            {classes.map((c) => (
              <label key={c.class_index} className="mag-pick-row">
                <input
                  type="checkbox"
                  checked={chosen.has(c.class_index)}
                  onChange={() => toggle(c.class_index)}
                />
                <i style={{ background: c.color }} />
                <span className="nm">{c.name}</span>
                {c.count !== undefined && (
                  <span className="ct">{c.count.toLocaleString("ru-RU")}</span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
