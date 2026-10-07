import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LabelClass } from "../../auth/api";
import { Icon, Input, Swatch, useEscape } from "../../ui";
import { filterClasses } from "../editor/look";

/** Меню правой кнопки на разметке: смена класса с поиском, действия, удаление.
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
  deleteLabel,
  actions,
  onClose,
}: {
  classes: LabelClass[];
  at: { x: number; y: number };
  current: number | null;
  onPick: (classIndex: number) => void;
  /** Есть только когда меню открыто на объекте, а не на плашке класса. */
  onDelete?: () => void;
  /** Подпись у удаления: «объект», «трек целиком» — что именно уйдёт. */
  deleteLabel?: string;
  /** Действия поверх смены класса. Недоступное остаётся в списке с причиной, а не исчезает. */
  actions?: {
    label: string;
    hint?: string;
    disabled?: boolean;
    run: () => void;
  }[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  useEscape(onClose);

  // capture: закрыться нужно раньше, чем холст обработает нажатие мимо меню
  useEffect(() => {
    function away(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) onClose();
    }
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  // У края окна меню разворачивается внутрь — по настоящему размеру, а не по догадке
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      top: at.y + height + 8 <= window.innerHeight ? at.y : Math.max(8, window.innerHeight - height - 8),
    });
  }, [at.x, at.y]);

  return (
    <div className="ui-pop ed-cmenu" ref={box} style={pos} role="menu"
      onContextMenu={(e) => e.preventDefault()}>
      <ClassPicker classes={classes} current={current} onPick={onPick} />
      {(actions?.length || onDelete) && <div className="ui-pop-sep" />}
      {actions?.map((a) => (
        <button key={a.label} type="button" role="menuitem" className="ui-opt" disabled={a.disabled} onClick={a.run}>
          <span className="ui-opt-t">{a.label}{a.hint && <span className="ui-opt-h">{a.hint}</span>}</span>
        </button>
      ))}
      {onDelete && (
        <button type="button" role="menuitem" className="ui-opt danger" onClick={onDelete}>
          <Icon name="trash" size={14} />
          <span className="ui-opt-t">Удалить {deleteLabel || "объект"}</span>
        </button>
      )}
    </div>
  );
}

/** Поиск и список классов — общие у этого меню и у подменю класса в меню объекта. */
export function ClassPicker({ classes, current, onPick }: {
  classes: LabelClass[];
  current: number | null;
  onPick: (classIndex: number) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterClasses(classes, query), [classes, query]);
  return (
    <>
      <Input icon="search" autoFocus placeholder="Класс…" value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && visible[0]) onPick(visible[0].class_index);
        }} />
      <div className="ed-cmenu-list">
        {visible.length === 0 ? (
          <p className="ed-clsp-none">Ничего не нашлось.</p>
        ) : (
          visible.map((c) => (
            <button key={c.id} type="button" role="menuitemradio" aria-checked={c.class_index === current}
              className="ui-opt" aria-current={c.class_index === current || undefined}
              onClick={() => onPick(c.class_index)}>
              <Swatch color={c.color} />
              <span className="ui-opt-t t-ell">{c.name}</span>
              {c.class_index === current && <Icon name="tick" size={14} />}
            </button>
          ))
        )}
      </div>
    </>
  );
}
