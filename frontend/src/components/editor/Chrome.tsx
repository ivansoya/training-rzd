// Оболочка редакторов кадров и видео: шапка, плавающие панели, зум, запись, окно «Клавиши».

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Button, Dialog, Icon, Kbd, Popover, cx } from "../../ui";
import type { IconName } from "../../ui";
import type { SaveState } from "../mag/useAutosave";
import type { KeyGroup } from "./look";

export function EditorHead({ onBack, backLabel, title, sub, extra, children }: {
  onBack: () => void;
  backLabel: string;
  title: ReactNode;
  sub?: ReactNode;
  /** Сразу за заголовком: прогресс таски. */
  extra?: ReactNode;
  /** Справа: запись, кнопки. */
  children?: ReactNode;
}) {
  return (
    <header className="ed-h">
      <Button variant="ghost" size="sm" icon="chevL" aria-label={backLabel} onClick={onBack} />
      <div className="ed-title">
        <b className="t-ell">{title}</b>
        {sub && <span className="t-ell">{sub}</span>}
      </div>
      {extra}
      <span className="grow" />
      {children}
    </header>
  );
}

/** Плавающая панель поверх кадра. */
export function Float({ className, children, label, role }: {
  className: string; children: ReactNode; label?: string; role?: string;
}) {
  return <div className={cx("ed-float", className)} role={role} aria-label={label}>{children}</div>;
}

/** Кнопка инструмента: значок и клавиша в углу. */
export function ToolButton({ icon, label, k, pressed, disabled, title, warming, locked, onClick }: {
  icon: IconName;
  label: string;
  k: string;
  pressed: boolean;
  disabled?: boolean;
  /** Подсказка вместо подписи: например, почему инструмент недоступен. */
  title?: string;
  /** Модель ещё поднимается — кнопка пульсирует. */
  warming?: boolean;
  /** Залипание: рисовать подряд. */
  locked?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cx("ed-tool", warming && "warming")} aria-pressed={pressed}
      aria-label={label} title={title ?? `${label} (${k})`} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      <span className="ed-tool-k">{k}</span>
      {locked && <i className="ed-tool-lock" aria-label="залипание" />}
    </button>
  );
}

/** Стрелка рядом с инструментом: его настройки во всплывашке. */
export function ToolMenu({ label, width = 280, children, disabled }: {
  label: string; width?: number; children: ReactNode; disabled?: boolean;
}) {
  const trigger: ReactElement = (
    <button type="button" className="ed-tool-more" aria-label={label} title={label} disabled={disabled}>
      <Icon name="chevD" size={12} />
    </button>
  );
  return <Popover trigger={trigger} width={width} align="center" className="ed-set">{children}</Popover>;
}

export function ZoomChip({ scale, onZoom, onFit, grid, onGrid }: {
  scale: number;
  onZoom: (k: number) => void;
  onFit: () => void;
  grid?: boolean;
  onGrid?: () => void;
}) {
  return (
    <div className="ed-zoom" role="group" aria-label="Масштаб">
      <Button variant="ghost" size="sm" icon="zout" aria-label="Отдалить" onClick={() => onZoom(1 / 1.3)} />
      <button type="button" className="ed-zoom-v" title="Вписать (0)" onClick={onFit}>{Math.round(scale * 100)} %</button>
      <Button variant="ghost" size="sm" icon="zin" aria-label="Приблизить" onClick={() => onZoom(1.3)} />
      <Button variant="ghost" size="sm" icon="fit" aria-label="Вписать (0)" onClick={onFit} />
      {onGrid && (
        <Button variant="ghost" size="sm" icon="grid" aria-label="Сетка на фоне" aria-pressed={grid} onClick={onGrid} />
      )}
    </div>
  );
}

/** Граница над нижней панелью: тянется мышью и стрелками, двойной щелчок — как было. */
export function Grip({ label, height, onHeight, onDone, onReset }: {
  label: string;
  height: number;
  /** Высота нижней панели по ходу протяжки. */
  onHeight: (h: number) => void;
  /** Протяжка кончилась — запомнить. */
  onDone: () => void;
  onReset: () => void;
}) {
  const grab = useRef<{ y: number; h: number } | null>(null);
  return (
    <div className="ed-grip" role="separator" aria-orientation="horizontal" aria-label={label} aria-valuenow={height}
      tabIndex={0} title="Тяните, чтобы поменять высоту. Двойной щелчок — как было"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        grab.current = { y: e.clientY, h: height };
      }}
      onPointerMove={(e) => { const g = grab.current; if (g) onHeight(g.h + g.y - e.clientY); }}
      onPointerUp={() => { if (grab.current) onDone(); grab.current = null; }}
      onPointerCancel={() => { grab.current = null; }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        onHeight(height + (e.key === "ArrowUp" ? 24 : -24));
        onDone();
      }}>
      <i />
    </div>
  );
}

const SAVE_TEXT: Record<SaveState, string> = {
  saved: "Сохранено", saving: "Сохраняю…", failed: "Не сохранено — повторяю",
  refused: "Не сохранено", stale: "Кадр изменил другой человек",
};

/** Состояние записи. Отказ предлагает выход — показать записанное; чужую правку редактор ставит сам.
 *  `note` — короткая строка на несколько секунд поверх «Сохранено»: «Изменил Петров». */
export interface EditNote { text: string; warn?: boolean }

/** Строка у записи на несколько секунд: кадр поправил сосед или наша правка не легла. */
export function useEditNote(ms = 4000) {
  const [note, setNote] = useState<EditNote | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const say = useCallback((next: EditNote) => {
    setNote(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [note, say] as const;
}

/** Без рода: «Новая правка: Петров», а не «изменил». */
export const editedBy = (name: string | null) => ({ text: `Новая правка: ${name ?? "другой человек"}` });
export const lostTo = (name: string | null) =>
  ({ text: `Правка не сохранена — кадр поправлен${name ? `: ${name}` : " другим"}`, warn: true });

export function SaveNote({ state, error, onDiscard, note }: {
  state: SaveState; error?: string | null; onDiscard?: () => void; note?: EditNote | null;
}) {
  const shown = note && state === "saved" ? note : null;
  const bad = state === "failed" || state === "refused" || state === "stale" || !!shown?.warn;
  return (
    <span className={cx("ed-save", shown ? (shown.warn ? "warned" : "noted") : state)} role={bad ? "alert" : "status"} title={error || undefined}>
      <i className="ed-save-dot" />
      {shown ? shown.text : SAVE_TEXT[state]}{state === "refused" && error ? `: ${error}` : ""}
      {onDiscard && state === "refused" && (
        <Button variant="ghost" size="sm" onClick={onDiscard}>Отбросить правку</Button>
      )}
    </span>
  );
}

export function KeysDialog({ open, onOpenChange, groups }: {
  open: boolean; onOpenChange: (v: boolean) => void; groups: KeyGroup[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Клавиши" width={720}>
      <div className="ed-keys">
        {groups.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.keys.map(([k, text]) => (
                <div key={k + text}>
                  <dt>{k.split(" / ").map((part) => <Kbd key={part}>{part}</Kbd>)}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
