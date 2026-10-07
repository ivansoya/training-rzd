// Панели «Фокуса»: справа — кадр и объекты, снизу — решения по кадру.

import type { ReactNode } from "react";
import type { LabelClass, TaskBox } from "../../auth/api";
import { Button, Dot, Icon, Select, Swatch, cx } from "../../ui";
import { fmtConf } from "../mag/BoxCanvas";
import type { CanvasShape } from "../mag/BoxCanvas";
import type { FrameAction } from "../mag/frameActions";
import { statusLook } from "./look";

type Label = (ci: number) => { name: string; color: string };

/** Кто поставил рамку: человек, агент или человек после агента. */
export function Who({ box }: { box?: TaskBox }) {
  if (!box?.author && !box?.agent) return null;
  const agent = box.agent ? `«${box.agent.name}» v${box.agent.version}` : "";
  return (
    <span className="fe-who">
      {box.author}
      {box.agent && box.source === "model" && <> — <span className="agent">агент {agent}</span></>}
      {box.agent && box.source !== "model" && <> — <span className="fix">поправлено после {agent}</span></>}
    </span>
  );
}

export function FrameSide({ status, tags, boxes, labelOf, meta, classes, selected, hidden, frozen,
  onSelect, onHide, onClass, onDelete, onAddContour, onConfirm }: {
  status: string;
  tags: ReactNode;
  boxes: CanvasShape[];
  labelOf: Label;
  meta: Map<string, TaskBox>;
  classes: LabelClass[];
  selected: number | null;
  hidden: Set<number>;
  frozen: boolean;
  onSelect: (i: number | null) => void;
  onHide: (i: number) => void;
  onClass: (i: number, ci: number) => void;
  onDelete: (i: number) => void;
  onAddContour: (i: number) => void;
  /** Подтвердить одну рамку агента — то же, что в меню правой кнопки. */
  onConfirm: (i: number) => void;
}) {
  const st = statusLook(status);
  const options = classes.map((c) => ({
    value: String(c.class_index),
    label: <span className="row"><Swatch color={c.color} />{c.name}</span>,
  }));
  // Непроверенное агента — своей группой сверху: его надо пройти глазами первым.
  const agent = boxes.map((_, i) => i).filter((i) => boxes[i].pending);
  const own = boxes.map((_, i) => i).filter((i) => !boxes[i].pending);
  const row = (i: number) => {
    const b = boxes[i];
    const c = labelOf(b.class_index);
    const on = i === selected;
    const off = hidden.has(i);
    return (
      <div key={b.id ?? `n${i}`} className={cx("fe-obj", on && "on", off && "off", b.pending && "pending")}>
        <div className="fe-obj-r" role="button" tabIndex={0} aria-pressed={on}
          onClick={() => onSelect(on ? null : i)}
          onKeyDown={(e) => { if (e.key === "Enter") onSelect(on ? null : i); }}>
          <Swatch color={c.color} />
          <span className="t-ell grow">{c.name || `класс ${b.class_index}`}</span>
          {b.parts && b.parts.length > 1 && <span className="t-xs t-faint">×{b.parts.length}</span>}
          {b.pending && b.conf != null
            ? <span className="ui-mono t-xs fe-conf">{fmtConf(b.conf)}</span>
            : <span className="ui-mono t-xs t-faint">{Math.round(b.w)}×{Math.round(b.h)}</span>}
          <Button variant="ghost" size="sm" icon={off ? "eyeoff" : "eye"}
            aria-label={off ? "Показать на кадре" : "Скрыть на кадре"}
            onClick={(e) => { e.stopPropagation(); onHide(i); }} />
        </div>
        {on && (
          <div className="fe-obj-b">
            <Select full size="sm" label="Класс объекта" value={String(b.class_index)} options={options}
              disabled={frozen} onChange={(v) => onClass(i, Number(v))} />
            <dl className="fe-xywh">
              {([["x", b.x], ["y", b.y], ["w", b.w], ["h", b.h]] as const).map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{Math.round(v)}</dd></div>
              ))}
            </dl>
            <Who box={meta.get(b.id ?? "")} />
            {b.pending && !frozen && (
              <div className="row fe-confirm">
                <span className="t-xs t-faint grow">Правка рамки — тоже проверка.</span>
                <Button size="sm" variant="agent" icon="tick" onClick={() => onConfirm(i)}>Подтвердить</Button>
              </div>
            )}
            {!frozen && (
              <div className="row wrap">
                <Button size="sm" variant="ghost" icon="poly" kbd="⇧P" onClick={() => onAddContour(i)}>
                  Добавить контур
                </Button>
                <span className="grow" />
                <Button size="sm" variant="danger" icon="trash" kbd="Del" onClick={() => onDelete(i)}>Удалить</Button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <section className="fe-sec">
        <div className="fe-sec-t">Кадр <span className="row t-xs"><Dot color={st.color} />{st.label}</span></div>
        {tags}
      </section>
      {agent.length > 0 && (
        <section className="fe-sec fe-objs fe-agent">
          <div className="fe-sec-t">
            <span className="row"><Icon name="bot" size={13} />Агент · на проверке</span>
            <span className="ui-mono">{agent.length}</span>
          </div>
          <div className="fe-list">{agent.map(row)}</div>
        </section>
      )}
      {/* Пустая секция под группой агента — лишняя строка «0» */}
      {(own.length > 0 || agent.length === 0) && (
        <section className="fe-sec fe-objs">
          <div className="fe-sec-t">Объекты <span className="ui-mono">{own.length}</span></div>
          {boxes.length === 0 && (
            <p className="fe-none">
              {status === "empty" ? "Кадр объявлен фоновым — объектов на нём нет." : "На кадре пока ничего не обведено."}
            </p>
          )}
          <div className="fe-list">{own.map(row)}</div>
        </section>
      )}
    </>
  );
}

export function FrameBar({ index, total, canPrev, canNext, actions, status, onPrev, onNext,
  onToggle, onTrash, onGo }: {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  actions: FrameAction[];
  status: string;
  onPrev: () => void;
  onNext: () => void;
  onToggle: (s: "empty" | "skipped") => void;
  onTrash: () => void;
  onGo: () => void;
}) {
  return (
    <>
      <Button variant="ghost" size="sm" icon="chevL" aria-label="Предыдущий кадр (←)" disabled={!canPrev} onClick={onPrev} />
      <span className="ui-mono t-sm fe-pos">{index + 1} / {total}</span>
      <Button variant="ghost" size="sm" icon="chevR" aria-label="Следующий кадр (→)" disabled={!canNext} onClick={onNext} />
      <i className="ed-vsep" />
      {actions.includes("empty") && (
        <Button variant="ghost" size="sm" kbd="E" className="fe-v empty" aria-pressed={status === "empty"}
          onClick={() => onToggle("empty")}>Пусто</Button>
      )}
      {actions.includes("skip") && (
        <Button variant="ghost" size="sm" kbd="S" className="fe-v skipped" aria-pressed={status === "skipped"}
          onClick={() => onToggle("skipped")}>Отложить</Button>
      )}
      {actions.includes("trash") && (
        <Button variant="ghost" size="sm" kbd="X" className="fe-v deleted" onClick={onTrash}>Брак</Button>
      )}
      {actions.includes("restore") && (
        <Button variant="ghost" size="sm" kbd="X" icon="undo" onClick={onTrash}>Вернуть</Button>
      )}
      <Button variant="primary" size="sm" kbd="Пробел" onClick={onGo}>Далее</Button>
    </>
  );
}

/** Показанное полуавтоматом надо принять — панель на месте решений, пока есть что закреплять. */
export function AutoBar({ onCommit, onCancel }: { onCommit: () => void; onCancel: () => void }) {
  return (
    <>
      <span className="t-sm t-muted row"><Icon name="sparkle" size={14} />Найдено моделью</span>
      <i className="ed-vsep" />
      <Button variant="ghost" size="sm" kbd="Esc" onClick={onCancel}>Отменить</Button>
      <Button variant="primary" size="sm" kbd="Пробел" onClick={onCommit}>Закрепить</Button>
    </>
  );
}

