// Исполнители таски: показать и выбрать. Их несколько или ни одного — ничью таску берёт любой редактор.

import { useState } from "react";
import type { TaskPerson as Person } from "../../../auth/api";
import { Avatar, Button, ChipToggle, Icon, Popover } from "../../../ui";
import { teamLine } from "./tasks";

/** Чипы людей: нажатый — исполнитель. Ни одного — таска ничья. */
export function TeamPicker({ people, value, onChange }: {
  people: Person[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="tm-pick" role="group" aria-label="Исполнители">
      {people.map((p) => (
        <ChipToggle key={p.id} pressed={value.includes(p.id)}
          onToggle={() => onChange(value.includes(p.id) ? value.filter((x) => x !== p.id) : [...value, p.id])}>
          {/* Галочка, а не только обводка: обводку даёт и фокус — после щелчка не понять, снят ли человек */}
          {value.includes(p.id) && <Icon name="tick" size={12} />}{p.display_name}
        </ChipToggle>
      ))}
    </div>
  );
}

export function TeamView({ people }: { people: Person[] }) {
  if (!people.length) return <span className="t-faint">{teamLine(people)}</span>;
  return (
    <span className="tm-list">
      {people.map((p) => <span key={p.id} className="tp-who"><Avatar name={p.display_name} size={20} />{p.display_name}</span>)}
    </span>
  );
}

/** Паспорт: админ меняет состав разом — в истории одна строка на правку, а не на каждый щелчок. */
export function TeamEdit({ team, workers, busy, onSave }: {
  team: Person[];
  workers: Person[];
  busy: boolean;
  onSave: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>([]);
  const was = team.map((p) => p.id);
  const same = draft.length === was.length && draft.every((id) => was.includes(id));
  return (
    <Popover align="end" width={300} onOpenChange={(v) => v && setDraft(was)}
      trigger={<button type="button" className="tm-edit" disabled={busy} aria-label="Изменить исполнителей"><TeamView people={team} /></button>}>
      {(close) => (
        <div className="tm-pop">
          <TeamPicker people={workers} value={draft} onChange={setDraft} />
          <Button size="sm" variant="primary" disabled={same} onClick={() => { close(); onSave(draft); }}>Сохранить</Button>
        </div>
      )}
    </Popover>
  );
}
