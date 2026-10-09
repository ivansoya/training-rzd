import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LabelClass } from "../../auth/api";
import { Icon, Swatch, useEscape } from "../../ui";
import type { IconName } from "../../ui";
import { ClassPicker } from "../mag/ClassMenu";

export interface MenuAction {
  label: string;
  hint?: string;
  icon?: IconName;
  /** Действие агента — его цветом, как кнопки «Агент». */
  agent?: boolean;
  /** Недоступное остаётся в списке с причиной в `hint`, а не исчезает. */
  disabled?: boolean;
  run: () => void;
}

/** Меню правой кнопки на объекте редактора: класс кнопкой с подменю, ниже действия
 *  группами, удаление последним. Список классов не занимает меню целиком — его
 *  открывают, только когда класс и правда хотят сменить. */
export default function ObjectMenu({
  at, classes, current, classLabel, classHint, onPick, groups, onDelete, deleteLabel, onClose, note,
}: {
  at: { x: number; y: number };
  classes: LabelClass[];
  current: number | null;
  /** Подпись кнопки, когда класса в проекте нет (находка с несопоставленным классом агента). */
  classLabel?: string;
  classHint?: string;
  onPick: (classIndex: number) => void;
  groups: MenuAction[][];
  onDelete?: () => void;
  deleteLabel?: string;
  onClose: () => void;
  /** Откуда объект: «Разметил: агент X vN, уверенность 0,82 · запустил …». */
  note?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const fly = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const [open, setOpen] = useState(false);
  const [flyPos, setFlyPos] = useState<{ left: number; top: number } | null>(null);

  // Слои Escape: сначала закрывается подменю, потом меню
  useEscape(onClose);
  useEscape(() => setOpen(false), open);

  // capture: закрыться нужно раньше, чем холст обработает нажатие мимо меню
  useEffect(() => {
    function away(e: PointerEvent) {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !fly.current?.contains(t)) onClose();
    }
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onClose]);

  // У края окна меню разворачивается внутрь — по настоящему размеру
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      top: at.y + height + 8 <= window.innerHeight ? at.y : Math.max(8, window.innerHeight - height - 8),
    });
  }, [at.x, at.y]);

  // Подменю — справа от меню вровень с кнопкой; не влезает — слева
  useLayoutEffect(() => {
    if (!open) { setFlyPos(null); return; }
    const menu = box.current?.getBoundingClientRect();
    const btn = trigger.current?.getBoundingClientRect();
    const own = fly.current?.getBoundingClientRect();
    if (!menu || !btn || !own) return;
    const right = menu.right + 4;
    const left = right + own.width + 8 <= window.innerWidth ? right : Math.max(8, menu.left - own.width - 4);
    const top = Math.max(8, Math.min(btn.top - 6, window.innerHeight - own.height - 8));
    setFlyPos({ left, top });
  }, [open, pos.left, pos.top]);

  const cls = classes.find((c) => c.class_index === current);
  const actions = groups.filter((g) => g.length);

  return (
    <>
      <div className="ui-pop ed-cmenu ed-omenu" ref={box} style={pos} role="menu"
        onContextMenu={(e) => e.preventDefault()}>
        <button ref={trigger} type="button" className={"ui-opt ed-omenu-cls" + (open ? " on" : "")}
          aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {cls ? <Swatch color={cls.color} /> : <Icon name="tag" size={14} />}
          <span className="ui-opt-t">
            <span className="t-ell">{cls?.name ?? classLabel ?? "Класс"}</span>
            {!cls && classHint && <span className="ui-opt-h">{classHint}</span>}
          </span>
          <Icon name="chevR" size={14} />
        </button>
        {note && <div className="ed-omenu-note">{note}</div>}
        {actions.map((group, g) => (
          <div key={g} className="ed-omenu-g">
            <div className="ui-pop-sep" />
            {group.map((a) => (
              <button key={a.label} type="button" role="menuitem" className={"ui-opt" + (a.agent ? " is-agent" : "")}
                disabled={a.disabled} onClick={a.run}>
                {a.icon && <Icon name={a.icon} size={14} />}
                <span className="ui-opt-t">{a.label}{a.hint && <span className="ui-opt-h">{a.hint}</span>}</span>
              </button>
            ))}
          </div>
        ))}
        {onDelete && (
          <>
            <div className="ui-pop-sep" />
            <button type="button" role="menuitem" className="ui-opt danger" onClick={onDelete}>
              <Icon name="trash" size={14} />
              <span className="ui-opt-t">Удалить {deleteLabel || "объект"}</span>
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="ui-pop ed-cmenu ed-omenu-fly" ref={fly} role="menu"
          style={flyPos ?? { left: -9999, top: 0 }} onContextMenu={(e) => e.preventDefault()}>
          <ClassPicker classes={classes} current={current} onPick={onPick} />
        </div>
      )}
    </>
  );
}
