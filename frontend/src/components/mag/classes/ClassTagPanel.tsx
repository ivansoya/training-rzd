import { useState } from "react";
import { deleteClassTag, renameClassTag } from "../../../auth/api";
import type { ClassTagItem } from "../../../auth/api";
import { Button, Card, Field, Input, Notice } from "../../../ui";
import { count } from "../../ru";
import { useAction } from "./useAction";

/** Правка тага классов в той же панели, что и класс. Заводят таги в карточке класса. */
export function ClassTagPanel({ code, tag, taken, onClose, onSaved, onDeleted }: {
  code: string;
  tag: ClassTagItem;
  /** Имена прочих тагов классов: повтор без учёта регистра сервер не примет. */
  taken: string[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(tag.name);
  const [deleting, setDeleting] = useState(false);
  const { busy, error, run } = useAction();
  const next = name.trim();
  const clash = taken.find((n) => n.toLocaleLowerCase("ru") === next.toLocaleLowerCase("ru"));
  const dirty = next !== tag.name;

  const save = () => {
    if (!next || !dirty || clash || busy) return;
    void run(async () => { await renameClassTag(code, tag.id, next); await onSaved(); });
  };

  return (
    <Card className="cls-panel" title="Изменить таг классов"
      desc={tag.classes ? `Стоит у ${count(tag.classes, "класса", "классов", "классов")}` : "Пока ни у одного класса"}
      actions={<Button variant="ghost" size="sm" icon="x" aria-label="Закрыть" onClick={onClose} />}>
      <form className="cls-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Название" hint={clash ? `Таг «${clash}» уже есть` : "Новое имя появится у всех классов с этим тагом"}>
          {(id) => <Input id={id} value={name} maxLength={64} disabled={deleting}
            onChange={(e) => setName(e.target.value)} />}
        </Field>
        {deleting && (
          <Notice tone="warn">
            {tag.classes
              ? `Таг снимется с ${count(tag.classes, "класса", "классов", "классов")}. Классы и разметка останутся как есть.`
              : "Таг не стоит ни у одного класса."}
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="cls-foot">
          {deleting ? (
            <>
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={() => setDeleting(false)}>Не удалять</Button>
              <Button variant="danger" size="sm" disabled={busy}
                onClick={() => void run(async () => { await deleteClassTag(code, tag.id); await onDeleted(); })}>
                Удалить таг
              </Button>
            </>
          ) : (
            <>
              <Button variant="danger" size="sm" icon="trash" onClick={() => setDeleting(true)}>Удалить таг</Button>
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
              <Button variant="primary" size="sm" type="submit" disabled={!next || !dirty || Boolean(clash) || busy}>
                Сохранить
              </Button>
            </>
          )}
        </div>
      </form>
    </Card>
  );
}
