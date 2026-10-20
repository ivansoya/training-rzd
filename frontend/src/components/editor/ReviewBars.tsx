// Плашки над нижней панелью редакторов: проверка разметки агента и находки разведки.

import { Button, Icon, MenuItem, Popover } from "../../ui";
import { plural } from "../ru";
import { Float } from "./Chrome";
import type { AgentKey } from "./review";

/** На кадре непроверенное агента: принять оставшееся или отклонить. Когда агентов на кадре
 *  несколько — ещё «Принять всё от …» и «Отклонить всё от …» по одному агенту.
 *  Стрелки ‹ › — к соседнему кадру с разметкой ([ и ]; только на проверке — с Shift). Плашка видна, пока непроверенное есть
 *  хоть где-то: на кадре без него она сжата до «ещё N кадров на проверке» со стрелками. */
export function ReviewBar({ count, left, disabled, onConfirm, onReject, onPrev, onNext, agents, onConfirmAgent, onRejectAgent }: {
  count: number;
  /** Кадров на проверке во всём ролике или списке — для сжатого вида. */
  left?: number;
  disabled?: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** Агенты кадра с числом их рамок на проверке. */
  agents?: { agent: AgentKey; count: number }[];
  onConfirmAgent?: (key: string) => void;
  onRejectAgent?: (key: string) => void;
}) {
  const prev = onPrev && (
    <Button variant="ghost" size="sm" icon="chevL" className="is-agent ed-review-go" aria-label="Предыдущий кадр с разметкой ([)"
      title="Предыдущий кадр с разметкой · [ · только на проверке — Shift+[" onClick={onPrev} />
  );
  const next = onNext && (
    <Button variant="ghost" size="sm" icon="chevR" className="is-agent ed-review-go" aria-label="Следующий кадр с разметкой (])"
      title="Следующий кадр с разметкой · ] · только на проверке — Shift+]" onClick={onNext} />
  );
  if (count === 0) {
    const n = left ?? 0;
    return (
      <Float className="ed-bot ed-review calm" role="toolbar" label="Проверка разметки агента">
        {prev}
        <span className="ed-review-t">
          <Icon name="bot" size={14} />Агент: ещё <b>{n}</b> {plural(n, "кадр", "кадра", "кадров")} на проверке
        </span>
        {next}
      </Float>
    );
  }
  const many = (agents?.length ?? 0) > 1;
  const pickAgent = (label: string, act?: (key: string) => void, variant?: "agent") => (
    <Popover align="center" width={260} trigger={
      <Button variant={variant ?? "ghost"} size="sm" disabled={disabled}>{label}</Button>}>
      {(close) => agents?.map(({ agent, count: n }) => (
        <MenuItem key={agent.key} icon="bot" hint={`${n} ${plural(n, "рамка", "рамки", "рамок")}`}
          onSelect={() => { close(); act?.(agent.key); }}>
          {agent.name}{agent.version != null ? ` v${agent.version}` : ""}
        </MenuItem>
      ))}
    </Popover>
  );
  return (
    <Float className="ed-bot ed-review" role="toolbar" label="Проверка разметки агента">
      {prev}
      <span className="ed-review-t">
        <Icon name="bot" size={14} />
        {many ? "Агенты" : "Агент"}: <b>{count}</b> {plural(count, "рамка", "рамки", "рамок")} на проверке
      </span>
      {next}
      <i className="ed-vsep" />
      {many ? pickAgent("Отклонить всё от…", onRejectAgent) : (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onReject}
          title="Убрать с кадра всё непроверенное агента">Отклонить все</Button>
      )}
      {many && pickAgent("Принять всё от…", onConfirmAgent)}
      <Button variant="agent" size="sm" kbd="⏎" disabled={disabled} onClick={onConfirm}
        title="Оставшиеся рамки агентов верны">Принять все</Button>
    </Float>
  );
}

/** На кадре находки разведки: взять выбранную или все в разметку. */
export function ScoutBar({ count, picked, disabled, onTake, onTakeAll }: {
  count: number;
  /** Выбрана ли находка щелчком. */
  picked: boolean;
  disabled?: boolean;
  onTake: () => void;
  onTakeAll: () => void;
}) {
  return (
    <Float className="ed-bot ed-review scout" role="toolbar" label="Находки разведки">
      <span className="ed-review-t">
        <i aria-hidden>◎</i>
        Разведка: <b>{count}</b> {plural(count, "находка", "находки", "находок")}
      </span>
      <i className="ed-vsep" />
      {picked ? (
        <Button variant="primary" size="sm" kbd="⏎" disabled={disabled} onClick={onTake}>В разметку</Button>
      ) : (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onTakeAll}
          title="Все находки кадра — рамками разметки">Все в разметку</Button>
      )}
    </Float>
  );
}
