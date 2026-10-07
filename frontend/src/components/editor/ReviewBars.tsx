// Плашки над нижней панелью редакторов: проверка разметки агента и находки разведки.

import { Button, Icon } from "../../ui";
import { plural } from "../ru";
import { Float } from "./Chrome";

/** На кадре непроверенное агента: подтвердить оставшееся или отклонить всё. */
export function ReviewBar({ count, disabled, onConfirm, onReject }: {
  count: number;
  disabled?: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <Float className="ed-bot ed-review" role="toolbar" label="Проверка разметки агента">
      <span className="ed-review-t">
        <Icon name="bot" size={14} />
        Агент: <b>{count}</b> {plural(count, "рамка", "рамки", "рамок")} на проверке
      </span>
      <i className="ed-vsep" />
      <Button variant="ghost" size="sm" disabled={disabled} onClick={onReject}
        title="Убрать с кадра всё непроверенное агента">Отклонить все</Button>
      <Button variant="agent" size="sm" kbd="⏎" disabled={disabled} onClick={onConfirm}
        title="Оставшиеся рамки агента верны">Подтвердить кадр</Button>
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
