// Оболочка редакторов кадров и видео: шапка, плавающие панели, зум, запись, окно «Клавиши».

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

const SAVE_TEXT: Record<SaveState, string> = {
  saved: "Сохранено", saving: "Сохраняю…", failed: "Не сохранено — повторяю",
  refused: "Не сохранено", stale: "Кадр изменил другой человек",
};

/** Состояние записи. Отказ и чужая правка предлагают выход: показать записанное. */
export function SaveNote({ state, error, onDiscard }: {
  state: SaveState; error?: string | null; onDiscard?: () => void;
}) {
  const bad = state === "failed" || state === "refused" || state === "stale";
  return (
    <span className={cx("ed-save", state)} role={bad ? "alert" : "status"} title={error || undefined}>
      <i className="ed-save-dot" />
      {SAVE_TEXT[state]}{state === "refused" && error ? `: ${error}` : ""}
      {onDiscard && (state === "refused" || state === "stale") && (
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          {state === "stale" ? "Показать его версию" : "Отбросить правку"}
        </Button>
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
