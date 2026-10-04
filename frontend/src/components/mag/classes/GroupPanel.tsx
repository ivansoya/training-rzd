import { useState } from "react";
import { createSuperclass, deleteSuperclass, updateSuperclass } from "../../../auth/api";
import type { SuperclassItem } from "../../../auth/api";
import { Button, CLASS_COLORS, Card, ColorPicker, Field, Input, Notice } from "../../../ui";
import { count, plural } from "../../ru";
import { useAction } from "./useAction";

/** Правка группы классов в той же панели, что и класс. sc = null — новая группа. */
export function GroupPanel({ code, sc, onClose, onSaved, onDeleted }: {
  code: string;
  sc: SuperclassItem | null;
  onClose: () => void;
  onSaved: (saved: SuperclassItem) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(sc?.name ?? "");
  const [color, setColor] = useState(sc?.color ?? CLASS_COLORS[9]);
  const [deleting, setDeleting] = useState(false);
  const { busy, error, run } = useAction();
  const dirty = !sc || name.trim() !== sc.name || color !== sc.color;

  const save = () => {
    if (!name.trim() || !dirty || busy) return;
    const body = { name: name.trim(), color };
    void run(async () => onSaved(sc ? await updateSuperclass(code, sc.id, body) : await createSuperclass(code, body)));
  };

  return (
    <Card className="cls-panel" title={sc ? "Изменить группу" : "Новая группа"}
      desc={sc ? `${count(sc.classes, "класс", "класса", "классов")} в группе` : "Группа объединяет классы в списках и редакторе"}
      actions={<Button variant="ghost" size="sm" icon="x" aria-label="Закрыть" onClick={onClose} />}>
      <form className="cls-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Название">
          {(id) => <Input id={id} value={name} maxLength={128} autoFocus={!sc} disabled={deleting}
            onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Цвет">{() => <ColorPicker value={color} onChange={setColor} label="Цвет группы" />}</Field>
        {deleting && sc && (
          <Notice tone="warn">
            {sc.classes
              ? `${count(sc.classes, "класс", "класса", "классов")} ${plural(sc.classes, "останется", "останутся", "останутся")} без группы — разметка не пострадает.`
              : "В группе нет классов."}
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="cls-foot">
          {deleting && sc ? (
            <>
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={() => setDeleting(false)}>Не удалять</Button>
              <Button variant="danger" size="sm" disabled={busy}
                onClick={() => void run(async () => { await deleteSuperclass(code, sc.id); await onDeleted(); })}>
                Удалить группу
              </Button>
            </>
          ) : (
            <>
              {sc && <Button variant="danger" size="sm" icon="trash" onClick={() => setDeleting(true)}>Удалить группу</Button>}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
              <Button variant="primary" size="sm" type="submit" disabled={!name.trim() || !dirty || busy}>
                {sc ? "Сохранить" : "Создать группу"}
              </Button>
            </>
          )}
        </div>
      </form>
    </Card>
  );
}
