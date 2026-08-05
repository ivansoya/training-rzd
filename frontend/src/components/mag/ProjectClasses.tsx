import { useCallback, useEffect, useState } from "react";
import {
  createClass,
  createSuperclass,
  deleteClass,
  deleteSuperclass,
  getClasses,
  updateClass,
  updateSuperclass,
} from "../../auth/api";
import type { ClassesInfo, LabelClass, SuperclassItem } from "../../auth/api";
import ColorPicker, { PALETTE } from "./ColorPicker";
import { useProject } from "./ProjectShell";
import { plural } from "./ProjectsPage";
import { useEscape } from "./useEscape";

// Что сейчас редактируется. null — ничего.
type Editing =
  | { kind: "class"; cls: LabelClass }
  | { kind: "new-class"; superclassId: string | null }
  | { kind: "superclass"; sc: SuperclassItem }
  | { kind: "new-superclass" }
  | null;

export default function ProjectClasses() {
  const { detail, refresh: refreshProject } = useProject();
  const code = detail.project.code;

  const [info, setInfo] = useState<ClassesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await getClasses(code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
        await load();
        await refreshProject();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [load, refreshProject]
  );

  if (error && !info) return <div className="mag-error">{error}</div>;
  if (!info) return <div className="mag-empty">Загружаем классы…</div>;

  const canEdit = info.can_edit;
  const ungrouped = info.classes.filter((c) => !c.superclass_id);

  return (
    <>
      {error && <div className="mag-error">{error}</div>}

      <div className="mag-card">
        <div className="mag-card-h">
          <h4>Классы проекта · {info.classes.length}</h4>
        </div>
        <p className="mag-hint">
          Идентификатор класса присваивается сам и не меняется: это его номер в
          выгруженном data.yaml, и смена рассогласует проект с уже обученными
          моделями. Порядок для обучения задаётся при экспорте.
        </p>

        {canEdit && (
          <button
            className="mag-dashed"
            type="button"
            onClick={() => setEditing({ kind: "new-superclass" })}
          >
            + Добавить суперкласс
          </button>
        )}

        {info.superclasses.map((sc) => (
          <Group
            key={sc.id}
            sc={sc}
            items={info.classes.filter((c) => c.superclass_id === sc.id)}
            canEdit={canEdit}
            onEditGroup={() => setEditing({ kind: "superclass", sc })}
            onAddClass={() => setEditing({ kind: "new-class", superclassId: sc.id })}
            onEditClass={(cls) => setEditing({ kind: "class", cls })}
          />
        ))}

        <Group
          sc={null}
          items={ungrouped}
          canEdit={canEdit}
          onAddClass={() => setEditing({ kind: "new-class", superclassId: null })}
          onEditClass={(cls) => setEditing({ kind: "class", cls })}
        />
      </div>

      {(editing?.kind === "class" || editing?.kind === "new-class") && (
        <ClassModal
          cls={editing.kind === "class" ? editing.cls : null}
          superclasses={info.superclasses}
          initialSuperclassId={
            editing.kind === "new-class" ? editing.superclassId : null
          }
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const ok =
              editing.kind === "class"
                ? await act(() => updateClass(code, editing.cls.id, patch))
                : await act(() => createClass(code, patch));
            if (ok) setEditing(null);
          }}
          onDelete={
            editing.kind === "class"
              ? async () => {
                  if (await act(() => deleteClass(code, editing.cls.id, true))) {
                    setEditing(null);
                  }
                }
              : undefined
          }
        />
      )}

      {(editing?.kind === "superclass" || editing?.kind === "new-superclass") && (
        <SuperclassModal
          sc={editing.kind === "superclass" ? editing.sc : null}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const ok =
              editing.kind === "superclass"
                ? await act(() => updateSuperclass(code, editing.sc.id, patch))
                : await act(() => createSuperclass(code, patch));
            if (ok) setEditing(null);
          }}
          onDelete={
            editing.kind === "superclass"
              ? async () => {
                  const n = editing.sc.classes;
                  const warn = n
                    ? `Удалить суперкласс «${editing.sc.name}»? ${n} ${plural(n, "класс останется", "класса останутся", "классов останутся")} без группы — разметка не пострадает.`
                    : `Удалить суперкласс «${editing.sc.name}»?`;
                  if (!window.confirm(warn)) return;
                  if (await act(() => deleteSuperclass(code, editing.sc.id))) {
                    setEditing(null);
                  }
                }
              : undefined
          }
        />
      )}
    </>
  );
}

// --- группа классов ---

function Group({
  sc,
  items,
  canEdit,
  onEditGroup,
  onAddClass,
  onEditClass,
}: {
  sc: SuperclassItem | null;
  items: LabelClass[];
  canEdit: boolean;
  onEditGroup?: () => void;
  onAddClass: () => void;
  onEditClass: (cls: LabelClass) => void;
}) {
  const total = items.reduce((s, c) => s + c.annotations, 0);
  return (
    <div className="mag-group">
      <div className="mag-group-h">
        <span
          className="mag-swatch sm"
          style={{ background: sc ? sc.color : "#9aa4ad" }}
        />
        {sc ? sc.name : "Без группы"}
        <span className="mag-group-n">
          {items.length} {plural(items.length, "класс", "класса", "классов")} ·{" "}
          {total.toLocaleString("ru-RU")} разметок
        </span>
        {canEdit && sc && (
          <button className="mag-ghost mag-ghost-inline" type="button" onClick={onEditGroup}>
            Изменить
          </button>
        )}
      </div>

      {items.length > 0 && (
        <table className="mag-table mag-classes-table">
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="mag-cls-id">{c.class_index}</td>
                <td className="swatch">
                  <span className="mag-swatch" style={{ background: c.color }} />
                </td>
                <td><b>{c.name}</b></td>
                <td className="num">
                  {c.annotations === 0 ? (
                    <span className="mag-zero">не встречен</span>
                  ) : (
                    c.annotations.toLocaleString("ru-RU")
                  )}
                </td>
                <td className="actions">
                  {canEdit && (
                    <button
                      className="mag-ghost mag-ghost-inline"
                      type="button"
                      onClick={() => onEditClass(c)}
                    >
                      Изменить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit ? (
        <button className="mag-dashed inner" type="button" onClick={onAddClass}>
          + Добавить класс
        </button>
      ) : (
        items.length === 0 && (
          <div className="mag-group-empty">В этой группе пока нет классов.</div>
        )
      )}
    </div>
  );
}

// --- модалки ---

function ClassModal({
  cls,
  superclasses,
  initialSuperclassId,
  onClose,
  onSave,
  onDelete,
}: {
  cls: LabelClass | null;
  superclasses: SuperclassItem[];
  initialSuperclassId: string | null;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    color: string;
    superclass_id: string | null;
  }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(cls?.name ?? "");
  const [color, setColor] = useState(cls?.color ?? PALETTE[0]);
  const [superclassId, setSuperclassId] = useState(
    cls ? cls.superclass_id ?? "" : initialSuperclassId ?? ""
  );
  useEscape(onClose);

  return (
    <div className="mag-backdrop">
      <div className="mag-modal" onClick={(e) => e.stopPropagation()}>
        <h1>{cls ? `Класс ${cls.class_index}` : "Новый класс"}</h1>
        <p className="mag-sub">
          {!cls
            ? "Идентификатор присвоится сам — следующий свободный в проекте."
            : cls.annotations === 0
            ? "В проекте нет разметки этим классом."
            : `${cls.annotations.toLocaleString("ru-RU")} ${plural(cls.annotations, "разметка", "разметки", "разметок")} в проекте.`}
        </p>

        <div className="mag-field">
          <label htmlFor="cm-name">Название</label>
          <input
            id="cm-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mag-field">
          <label htmlFor="cm-sc">Суперкласс</label>
          <select
            id="cm-sc"
            value={superclassId}
            onChange={(e) => setSuperclassId(e.target.value)}
          >
            <option value="">Без группы</option>
            {superclasses.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <div className="mag-field">
          <label>Цвет</label>
          <ColorPicker value={color} onChange={setColor} />
        </div>

        <div className="mag-modal-foot">
          {onDelete && cls && (
            <button
              className="mag-ghost mag-danger"
              type="button"
              onClick={() => {
                const warn =
                  cls.annotations === 0
                    ? `Удалить класс «${cls.name}»?`
                    : `Удалить класс «${cls.name}»? Вместе с ним исчезнут ` +
                      `${cls.annotations.toLocaleString("ru-RU")} ${plural(cls.annotations, "разметка", "разметки", "разметок")}. Действие необратимо.`;
                if (window.confirm(warn)) onDelete();
              }}
            >
              Удалить
            </button>
          )}
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="mag-btn"
            type="button"
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                name: name.trim(),
                color,
                superclass_id: superclassId || null,
              })
            }
          >
            {cls ? "Сохранить" : "Создать класс"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SuperclassModal({
  sc,
  onClose,
  onSave,
  onDelete,
}: {
  sc: SuperclassItem | null;
  onClose: () => void;
  onSave: (patch: { name: string; color: string }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(sc?.name ?? "");
  const [color, setColor] = useState(sc?.color ?? PALETTE[3]);
  useEscape(onClose);

  return (
    <div className="mag-backdrop">
      <div className="mag-modal" onClick={(e) => e.stopPropagation()}>
        <h1>{sc ? "Суперкласс" : "Новый суперкласс"}</h1>
        <p className="mag-sub">
          {sc
            ? `${sc.classes} ${plural(sc.classes, "класс", "класса", "классов")} в группе.`
            : "Группа классов для статистики и экспорта — классы можно добавить сразу после."}
        </p>

        <div className="mag-field">
          <label htmlFor="sm-name">Название</label>
          <input
            id="sm-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mag-field">
          <label>Цвет</label>
          <ColorPicker value={color} onChange={setColor} />
        </div>

        <div className="mag-modal-foot">
          {onDelete && (
            <button className="mag-ghost mag-danger" type="button" onClick={onDelete}>
              Удалить
            </button>
          )}
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="mag-btn"
            type="button"
            disabled={!name.trim()}
            onClick={() => onSave({ name: name.trim(), color })}
          >
            {sc ? "Сохранить" : "Создать суперкласс"}
          </button>
        </div>
      </div>
    </div>
  );
}
