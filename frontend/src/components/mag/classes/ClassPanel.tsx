import { useEffect, useState } from "react";
import { createClass, deleteClass, getClassUsage, moveClass, updateClass } from "../../../auth/api";
import type { ClassUsage, LabelClass, SuperclassItem } from "../../../auth/api";
import {
  Button, CLASS_COLORS, Card, Check, ColorPicker, Field, Input, Kbd, Meta, Notice, Pill, Radio, Select, Swatch,
} from "../../../ui";
import { count, plural } from "../../ru";
import { hotkey, indexLabel } from "./classes";
import { useAction } from "./useAction";

/** Свободный цвет палитры — чтобы новый класс не слился с соседями. */
function freeColor(classes: LabelClass[]): string {
  const used = new Set(classes.map((c) => c.color.toLowerCase()));
  return CLASS_COLORS.find((c) => !used.has(c)) ?? CLASS_COLORS[classes.length % CLASS_COLORS.length];
}

/** Правка класса справа от таблицы. cls = null — новый класс. */
export function ClassPanel({ code, cls, classes, superclasses, initialGroup, canEdit, canManage, onClose, onSaved, onDeleted }: {
  code: string;
  cls: LabelClass | null;
  classes: LabelClass[];
  superclasses: SuperclassItem[];
  initialGroup: string | null;
  canEdit: boolean;
  canManage: boolean;
  onClose: () => void;
  onSaved: (saved: LabelClass) => Promise<void>;
  onDeleted: (keptClass: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(cls?.name ?? "");
  const [color, setColor] = useState(cls?.color ?? freeColor(classes));
  const [group, setGroup] = useState(cls ? cls.superclass_id ?? "none" : initialGroup ?? "none");
  const [deleting, setDeleting] = useState(false);
  const { busy, error, run } = useAction();

  const key = cls ? hotkey(classes, cls.id) : classes.length < 9 ? classes.length + 1 : null;
  const dirty = !cls || name.trim() !== cls.name || color !== cls.color || group !== (cls.superclass_id ?? "none");

  const save = () => {
    if (!name.trim() || !dirty || busy) return;
    const body = { name: name.trim(), color, superclass_id: group === "none" ? null : group };
    void run(async () => onSaved(cls ? await updateClass(code, cls.id, body) : await createClass(code, body)));
  };

  const desc = cls
    ? `${indexLabel(cls.class_index)} · ${count(cls.annotations, "бокс", "бокса", "боксов")}${cls.images ? ` на ${count(cls.images, "кадре", "кадрах", "кадрах")}` : ""}`
    : "Номер выдаст сервер — следующий свободный";

  return (
    <Card className="cls-panel" title={cls ? (canEdit ? "Изменить класс" : cls.name) : "Новый класс"} desc={desc}
      actions={<Button variant="ghost" size="sm" icon="x" aria-label="Закрыть" onClick={onClose} />}>
      {!canEdit && cls ? (
        <Meta items={[
          ["Цвет", <span className="row"><Swatch color={cls.color} /><span className="ui-mono">{cls.color}</span></span>],
          ["Группа", cls.superclass_name ?? "Без группы"],
          ["Клавиша", key ? <Kbd>{key}</Kbd> : "нет"],
        ]} />
      ) : (
        <form className="cls-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <Field label="Название">
            {(id) => <Input id={id} value={name} maxLength={128} autoFocus={!cls} disabled={deleting}
              onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Цвет">{() => <ColorPicker value={color} onChange={setColor} label="Цвет класса" />}</Field>
          <Field label="Группа">
            {(id) => <Select id={id} full value={group} onChange={setGroup} disabled={deleting}
              options={[{ value: "none", label: "Без группы" }, ...superclasses.map((s) => ({ value: s.id, label: s.name }))]} />}
          </Field>
          <Field label="Горячая клавиша в редакторе">
            {() => key ? (
              <div className="row"><Kbd>{key}</Kbd><span className="ui-hint">Номер по порядку в списке редактора</span></div>
            ) : (
              <p className="ui-hint">Нет: клавиши 1–9 у первых девяти классов, этот выбирается поиском</p>
            )}
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          {!deleting && (
            <div className="cls-foot">
              {cls && canManage && (
                <Button variant="danger" size="sm" icon="trash" onClick={() => setDeleting(true)}>Удалить класс</Button>
              )}
              <span className="grow" />
              <Button variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
              <Button variant="primary" size="sm" type="submit" disabled={!name.trim() || !dirty || busy}>
                {cls ? "Сохранить" : "Создать класс"}
              </Button>
            </div>
          )}
        </form>
      )}
      {deleting && cls && (
        <Fate code={code} cls={cls} others={classes.filter((c) => c.id !== cls.id)}
          onCancel={() => setDeleting(false)} onDone={onDeleted} />
      )}
    </Card>
  );
}

/** Что сделать с разметкой при удалении: перенести (класс можно оставить) или удалить вместе с ним. */
function Fate({ code, cls, others, onCancel, onDone }: {
  code: string;
  cls: LabelClass;
  others: LabelClass[];
  onCancel: () => void;
  onDone: (keptClass: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<"move" | "delete">(others.length ? "move" : "delete");
  // Перенос необратим — цель выбирается явно, без подстановки
  const [target, setTarget] = useState("");
  const [keep, setKeep] = useState(false);
  const [usage, setUsage] = useState<ClassUsage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const moving = mode === "move";
  const to = others.find((c) => c.id === target);

  // Цель удалили в другой вкладке — выбор сбрасывается
  useEffect(() => {
    if (target && !to) setTarget("");
  }, [target, to]);

  useEffect(() => {
    let alive = true;
    getClassUsage(code, cls.id, moving && target ? target : undefined)
      .then((u) => { if (alive) { setUsage(u); setFailed(null); } })
      .catch((e) => { if (alive) setFailed((e as Error).message); });
    return () => { alive = false; };
  }, [code, cls.id, moving, target]);

  const total = usage ? usage.annotations + usage.video_tracks + usage.video_keys + usage.video_singles : 0;
  const empty = usage !== null && total === 0;
  const ready = usage !== null && !busy && (empty || !moving || Boolean(to));

  const video = usage && usage.video_tracks + usage.video_singles > 0
    ? ` и ${count(usage.video_tracks + usage.video_singles, "объект", "объекта", "объектов")} в роликах` : "";

  const act = () => {
    if (!ready) return;
    void run(async () => {
      if (empty || !moving) await deleteClass(code, cls.id, true);
      else await moveClass(code, cls.id, target, !keep);
      await onDone(moving && keep && !empty);
    });
  };

  const label = empty || !moving ? "Удалить класс" : keep ? "Перенести разметку" : "Перенести и удалить";

  return (
    <div className="cls-fate">
      <hr className="cls-sep" />
      <div className="ui-field-l"><label>Что сделать с разметкой при удалении</label></div>
      {usage === null ? (
        <p className="ui-hint">{failed ?? "Считаем, чем занят класс…"}</p>
      ) : empty ? (
        <p className="ui-hint">На классе нет разметки — удалится только сам класс.</p>
      ) : (
        <>
          <Radio name="fate" checked={moving} onChange={() => setMode("move")} disabled={!others.length}
            title="Перенести в другой класс"
            hint={to ? `${count(usage.annotations, "бокс станет", "бокса станут", "боксов станут")} «${to.name}»${video}`
              : others.length ? "Выберите, куда перенести" : "В проекте нет другого класса"}>
            <Select full value={target || undefined} onChange={setTarget} placeholder="Выберите класс"
              label="Куда перенести"
              options={others.map((c) => ({ value: c.id, label: c.name, hint: `${indexLabel(c.class_index)} · ${c.superclass_name ?? "без группы"}` }))} />
            <Check checked={keep} onChange={setKeep}>Класс оставить пустым</Check>
            {usage.overlap_images ? (
              <Pill tone="warn">
                На {count(usage.overlap_images, "кадре", "кадрах", "кадрах")} есть разметка обоих классов — там появятся дубли
              </Pill>
            ) : null}
          </Radio>
          <Radio name="fate" checked={!moving} onChange={() => setMode("delete")} title="Удалить вместе с классом"
            hint={`${plural(usage.annotations, "Пропадёт", "Пропадут", "Пропадут")} ${count(usage.annotations, "бокс", "бокса", "боксов")}${cls.images ? ` на ${count(cls.images, "кадре", "кадрах", "кадрах")}` : ""}${video}`} />
          {usage.tasks.length > 0 && (
            <p className="ui-hint">Затронуты таски: {usage.tasks.map((t) => t.name).join(", ")}.</p>
          )}
          {usage.unbuilt_sets.length > 0 && !(moving && keep) && (
            <p className="ui-hint warn">
              Класс в отборе несобранных наборов: {usage.unbuilt_sets.join(", ")}.
              {!moving && " После удаления они не соберутся."}
            </p>
          )}
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="cls-foot">
        <span className="grow" />
        <Button variant="ghost" size="sm" onClick={onCancel}>Не удалять</Button>
        <Button variant={moving && keep && !empty ? "primary" : "danger"} size="sm" disabled={!ready} onClick={act}>
          {label}
        </Button>
      </div>
    </div>
  );
}
