import { useEffect, useMemo, useRef, useState } from "react";
import type { LabelClass } from "../../auth/api";

/** Меню смены класса у выбранного бокса: правая кнопка на разметке.
 *
 * С поиском, потому что классов в проекте десятки: пролистывать список правой
 * кнопкой дольше, чем набрать две буквы.
 */
export default function ClassMenu({
  classes,
  at,
  current,
  onPick,
  onDelete,
  onClose,
}: {
  classes: LabelClass[];
  at: { x: number; y: number };
  current: number | null;
  onPick: (classIndex: number) => void;
  /** Есть только когда меню открыто на детекции, а не на плашке класса. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    function away(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) onClose();
    }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    }
    // capture: закрыться нужно раньше, чем холст обработает нажатие.
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return classes;
    return classes.filter(
      (c) => c.name.toLowerCase().includes(q) || String(c.class_index) === q
    );
  }, [classes, query]);

  // У края окна меню разворачивается внутрь, а не уезжает за границу.
  const left = Math.min(at.x, window.innerWidth - 236);
  const top = Math.min(at.y, window.innerHeight - 300);

  return (
    <div className="mag-cmenu" ref={box} style={{ left, top }} role="menu">
      <input
        ref={input}
        className="mag-ed-search"
        type="text"
        value={query}
        placeholder="Класс…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && visible[0]) onPick(visible[0].class_index);
        }}
      />
      <div className="mag-cmenu-list">
        {visible.length === 0 ? (
          <p className="mag-ed-hint">Ничего не нашлось.</p>
        ) : (
          visible.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.class_index === current ? "mag-ed-cls on" : "mag-ed-cls"}
              onClick={() => onPick(c.class_index)}
            >
              <i style={{ background: c.color }} />
              <span className="mag-ed-cls-name">{c.name}</span>
            </button>
          ))
        )}
      </div>
      {onDelete && (
        <button type="button" className="mag-cmenu-del" onClick={onDelete}>
          Удалить детекцию
        </button>
      )}
    </div>
  );
}
