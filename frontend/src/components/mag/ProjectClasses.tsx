import { useCallback, useEffect, useRef, useState } from "react";
import {
  createClass,
  createSuperclass,
  deleteClass,
  deleteSuperclass,
  getClassUsage,
  getClasses,
  moveClass,
  updateClass,
  updateSuperclass,
} from "../../auth/api";
import type {
  ClassUsage,
  ClassesInfo,
  LabelClass,
  SuperclassItem,
} from "../../auth/api";
import ColorPicker, { PALETTE } from "./ColorPicker";
import { useLive } from "../../live/LiveProvider";
import { useProject } from "./ProjectShell";
import { count, plural, ru } from "../ru";
import { useEscape } from "./useEscape";
import Sep from "../Sep";
import Banner from "../Banner";

// Что сейчас редактируется. null — ничего.
//
// «fate» — судьба разметки класса: удалить её, отдать другому классу или
// отдать и класс при этом оставить. Все три — одна операция на сервере,
// поэтому и окно одно.
type Editing =
  | { kind: "class"; cls: LabelClass }
  | { kind: "new-class"; superclassId: string | null }
  | { kind: "fate"; cls: LabelClass; move: boolean }
  | { kind: "superclass"; sc: SuperclassItem }
  | { kind: "new-superclass" }
  | null;

type Fate = "delete" | "move-delete" | "move-keep";

export default function ProjectClasses() {
  const { detail, refresh: refreshProject } = useProject();
  const code = detail.project.code;

  const [info, setInfo] = useState<ClassesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [query, setQuery] = useState("");

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

  // Классы мог изменить кто-то другой — и это не косметика: боксы в открытом
  // редакторе адресуются номером класса.
  useLive("classes", load);

  // Бросает ошибку дальше: окно показывает её у себя. Баннер страницы
  // стоял под затемнением, и отказ сервера выглядел как зависшая кнопка.
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      await fn();
      await load();
      await refreshProject();
    },
    [load, refreshProject]
  );
  // Перетаскивание класса между группами идёт без окна — его ошибка в баннер.
  const move = (fn: () => Promise<unknown>) =>
    void act(fn).catch((e) => setError((e as Error).message));

  if (error && !info) return <div className="mag-error">{error}</div>;
  if (!info) return <div className="mag-empty">Загружаем классы…</div>;

  const canEdit = info.can_edit;
  const matching = info.classes.filter((c) => [c.name, c.class_index,
    info.superclasses.find((sc) => sc.id === c.superclass_id)?.name ?? "Без группы"
  ].join(" ").toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  const ungrouped = matching.filter((c) => !c.superclass_id);

  return (
    <>
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      <div className="mag-card">
        <div className="mag-card-h">
          <h4>Классы проекта <Sep /> {info.classes.length}</h4>
        </div>
        <div className="workspace-project-search">
          <input type="search" aria-label="Найти класс" placeholder="Название, номер или группа…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span role="status">{matching.length} из {info.classes.length}</span>
        </div>
        {query.trim() && matching.length === 0 && <p className="mag-empty">Классы не найдены. Измените поисковый запрос.</p>}

        {canEdit && (
          <button
            className="mag-dashed"
            type="button"
            onClick={() => setEditing({ kind: "new-superclass" })}
          >
            + Добавить суперкласс
          </button>
        )}

        {info.superclasses.filter((sc) => !query.trim() || matching.some((c) => c.superclass_id === sc.id)).map((sc) => (
          <Group
            key={sc.id}
            sc={sc}
            items={matching.filter((c) => c.superclass_id === sc.id)}
            canEdit={canEdit}
            onEditGroup={() => setEditing({ kind: "superclass", sc })}
            onAddClass={() => setEditing({ kind: "new-class", superclassId: sc.id })}
            onEditClass={(cls) => setEditing({ kind: "class", cls })}
            onMoveClass={(id) => move(() => updateClass(code, id, { superclass_id: sc.id }))}
          />
        ))}

        <Group
          sc={null}
          items={ungrouped}
          canEdit={canEdit}
          onAddClass={() => setEditing({ kind: "new-class", superclassId: null })}
          onEditClass={(cls) => setEditing({ kind: "class", cls })}
          onMoveClass={(id) => move(() => updateClass(code, id, { superclass_id: null }))}
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
            await act(() =>
              editing.kind === "class"
                ? updateClass(code, editing.cls.id, patch)
                : createClass(code, patch)
            );
            setEditing(null);
          }}
          onFate={
            editing.kind === "class" && info.can_manage
              ? (move) => setEditing({ kind: "fate", cls: editing.cls, move })
              : undefined
          }
        />
      )}

      {editing?.kind === "fate" && (
        <ClassFateModal
          code={code}
          cls={editing.cls}
          others={info.classes.filter((c) => c.id !== editing.cls.id)}
          initialMove={editing.move}
          onClose={() => setEditing(null)}
          onDone={async (fn) => {
            await act(fn);
            setEditing(null);
          }}
        />
      )}

      {(editing?.kind === "superclass" || editing?.kind === "new-superclass") && (
        <SuperclassModal
          sc={editing.kind === "superclass" ? editing.sc : null}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await act(() =>
              editing.kind === "superclass"
                ? updateSuperclass(code, editing.sc.id, patch)
                : createSuperclass(code, patch)
            );
            setEditing(null);
          }}
          onDelete={
            editing.kind === "superclass"
              ? async () => {
                  const n = editing.sc.classes;
                  const warn = n
                    ? `Удалить суперкласс «${editing.sc.name}»? ${n} ${plural(n, "класс останется", "класса останутся", "классов останутся")} без группы — разметка не пострадает.`
                    : `Удалить суперкласс «${editing.sc.name}»?`;
                  if (!window.confirm(warn)) return;
                  await act(() => deleteSuperclass(code, editing.sc.id));
                  setEditing(null);
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
  onMoveClass,
}: {
  sc: SuperclassItem | null;
  items: LabelClass[];
  canEdit: boolean;
  onEditGroup?: () => void;
  onAddClass: () => void;
  onEditClass: (cls: LabelClass) => void;
  /** Класс перетащили сюда из другой группы. */
  onMoveClass: (classId: string) => void;
}) {
  const total = items.reduce((s, c) => s + c.annotations, 0);
  // Подсветка цели: без неё непонятно, куда именно упадёт класс — групп на
  // экране обычно больше трёх, и промах виден только по итогу.
  const [over, setOver] = useState(false);

  return (
    <div
      className={`mag-group${over ? " drop" : ""}`}
      onDragOver={(e) => {
        if (!canEdit) return;
        // Без preventDefault браузер не считает область приёмником и не даёт
        // уронить: молчаливый отказ, который читается как «драг не работает».
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!canEdit) return;
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        // Свой же класс — не перенос: молча ничего не делаем, чтобы промах по
        // родной группе не дёргал сервер.
        if (!id || items.some((c) => c.id === id)) return;
        onMoveClass(id);
      }}
    >
      <div className="mag-group-h">
        <span
          className="mag-swatch sm"
          style={{ background: sc ? sc.color : "#9aa4ad" }}
        />
        {sc ? sc.name : "Без группы"}
        <span className="mag-group-n">
          {count(items.length, "класс", "класса", "классов")} <Sep />{" "}
          {count(total, "разметка", "разметки", "разметок")}
        </span>
        {canEdit && sc && (
          <button className="mag-ghost mag-ghost-inline" type="button" onClick={onEditGroup}>
            Изменить
          </button>
        )}
      </div>

      {/* Своя прокрутка у таблицы: группа режет всё, что за её краем
          (`overflow: hidden` ради скруглённых углов), и на 430 px число
          разметок и «Изменить» уходили за край без возможности до них дойти. */}
      {items.length > 0 && (
        <div className="mag-table-scroll">
        <table className="mag-table mag-classes-table">
          <tbody>
            {items.map((c) => (
              <tr
                key={c.id}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", c.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
              >
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
        </div>
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


/** Действие окна: одно за раз и с ошибкой внутри окна.
 *
 *  Двойной щелчок по «Создать класс» заводил два класса: кнопка оставалась
 *  живой, пока шёл запрос. Замок — ref, а не только состояние: второй щелчок
 *  может прийти раньше, чем React перерисует кнопку неактивной. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

/** Судьба разметки класса.
 *
 * Одно окно на три исхода, потому что на сервере это одна операция и один
 * `UPDATE`. Числа берём с сервера отдельным запросом, а не из списка классов:
 * тот загружен вместе со страницей и считает только разметку кадров — треки
 * и ключевые кадры несданных роликов в нём не видны, а гибнут они так же.
 */
function ClassFateModal({
  code,
  cls,
  others,
  initialMove,
  onClose,
  onDone,
}: {
  code: string;
  cls: LabelClass;
  others: LabelClass[];
  initialMove: boolean;
  onClose: () => void;
  onDone: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [fate, setFate] = useState<Fate>(
    initialMove ? "move-delete" : "delete"
  );
  const [target, setTarget] = useState(others[0]?.id ?? "");
  const [usage, setUsage] = useState<ClassUsage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { busy, error, run: act } = useAction();
  useEscape(onClose);

  const moving = fate !== "delete";

  // Цель могли удалить в другой вкладке: живой список классов обновился, а в
  // выборе остался id исчезнувшего — select показывал чужое имя, а кнопка
  // гасла без причины. Сбрасываем выбор и просим выбрать заново.
  useEffect(() => {
    if (target && !others.some((c) => c.id === target)) setTarget("");
  }, [others, target]);

  useEffect(() => {
    let alive = true;
    setUsage(null);
    getClassUsage(code, cls.id, moving && target ? target : undefined)
      .then((u) => alive && setUsage(u))
      .catch((e) => alive && setFailed((e as Error).message));
    return () => {
      alive = false;
    };
  }, [code, cls.id, moving, target]);

  const total =
    usage &&
    usage.annotations + usage.video_tracks + usage.video_keys +
      usage.video_singles;
  const to = others.find((c) => c.id === target);
  const ready = usage !== null && !busy && (!moving || Boolean(to));

  const run = () => {
    if (!ready) return;
    void act(() =>
      onDone(() =>
        fate === "delete"
          ? deleteClass(code, cls.id, true)
          : moveClass(code, cls.id, target, fate === "move-delete")
      )
    );
  };

  return (
    <div className="mag-backdrop">
      <div className="mag-modal" onClick={(e) => e.stopPropagation()}>
        <h1>Класс «{cls.name}»</h1>
        <p className="mag-sub">
          {usage === null
            ? failed ?? "Считаем, чем занят класс…"
            : total === 0
              ? "На классе нет ни одной разметки."
              : "Что сделать с его разметкой. Действие необратимо."}
        </p>

        {usage !== null && total !== 0 && (
          <table className="mag-table mag-fate-table">
            <tbody>
              <tr>
                <td>Разметок на кадрах</td>
                <td className="num">{ru(usage.annotations)}</td>
              </tr>
              <tr>
                <td>Треков в несданных роликах</td>
                <td className="num">{ru(usage.video_tracks)}</td>
              </tr>
              <tr>
                <td>Ключевых кадров этих треков</td>
                <td className="num">{ru(usage.video_keys)}</td>
              </tr>
              <tr>
                <td>Одиночных боксов в роликах</td>
                <td className="num">{ru(usage.video_singles)}</td>
              </tr>
            </tbody>
          </table>
        )}

        {/* В ленте затронутых тасок появится запись о смене класса — это
            делает сервер, а на экране достаточно их имён. */}
        {usage !== null && usage.tasks.length > 0 && (
          <p className="mag-hint">
            Затронуты таски: {usage.tasks.map((t) => t.name).join(", ")}.
          </p>
        )}

        {usage !== null && usage.unbuilt_sets.length > 0 && fate !== "move-keep" && (
          <p className="mag-hint">
            Класс входит в отбор {usage.train_sets}{" "}
            {plural(usage.train_sets, "набора", "наборов", "наборов")}, из них
            ещё не {plural(usage.unbuilt_sets.length, "собран", "собраны", "собраны")}:{" "}
            {usage.unbuilt_sets.join(", ")}.
            {/* Не соберётся потому, что номера классов в наборе разошлись бы
                с тем, что показывал мастер (builder.py сверяет их числом). */}
            {fate === "delete" && " После удаления они не соберутся."}
          </p>
        )}

        <div className="mag-field">
          <label>Что сделать</label>
          <div className="mag-fate-choice">
            {(
              [
                ["delete", "Удалить класс вместе с разметкой"],
                ["move-delete", "Перенести разметку в другой класс, класс удалить"],
                ["move-keep", "Перенести разметку, класс оставить пустым"],
              ] as [Fate, string][]
            ).map(([value, label]) => (
              <label key={value} className="mag-fate-opt">
                <input
                  type="radio"
                  name="fate"
                  checked={fate === value}
                  disabled={value !== "delete" && others.length === 0}
                  onChange={() => setFate(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>

        {moving && (
          <div className="mag-field">
            <label htmlFor="fate-target">Куда перенести</label>
            <select
              id="fate-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {!to && (
                <option value="" disabled>
                  Выберите класс
                </option>
              )}
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.class_index} — {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {moving && usage?.overlap_images ? (
          <p className="mag-hint mag-warn">
            На {ru(usage.overlap_images)}{" "}
            {plural(usage.overlap_images, "кадре", "кадрах", "кадрах")} разметка
            обоих классов уже есть — там появятся дубли.
            {/* Дубли не схлопываем: это было бы удалением чужой разметки
                внутри операции, затеянной ради её сохранения. */}
          </p>
        ) : null}

        {moving && !to && others.length > 0 && (
          <p className="mag-hint mag-warn">Выберите класс, куда перенести разметку.</p>
        )}
        {error && <div className="mag-error">{error}</div>}

        <div className="mag-modal-foot">
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className={fate === "delete" ? "mag-btn mag-danger" : "mag-btn"}
            type="button"
            disabled={!ready}
            onClick={run}
          >
            {fate === "delete"
              ? "Удалить"
              : fate === "move-delete"
                ? `Перенести в «${to?.name ?? "…"}» и удалить`
                : `Перенести в «${to?.name ?? "…"}»`}
          </button>
        </div>
      </div>
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
  onFate,
}: {
  cls: LabelClass | null;
  superclasses: SuperclassItem[];
  initialSuperclassId: string | null;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    color: string;
    superclass_id: string | null;
  }) => Promise<void>;
  onFate?: (move: boolean) => void;
}) {
  const { busy, error, run } = useAction();
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
        {/* Номер новому классу выдаёт сервер — следующий после всех когда-либо
            выданных, освободившиеся не переиспользуются (create_class). */}
        {cls && (
          <p className="mag-sub">
            {cls.annotations === 0
              ? "В проекте нет разметки этим классом."
              : `${count(cls.annotations, "разметка", "разметки", "разметок")} в проекте.`}
          </p>
        )}

        <div className="mag-field">
          <label htmlFor="cm-name">Название</label>
          <input
            id="cm-name"
            type="text"
            value={name}
            maxLength={128}
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

        {error && <div className="mag-error">{error}</div>}

        <div className="mag-modal-foot">
          {onFate && cls && (
            <div className="mag-foot-left">
              {/* Два входа в одно окно: «удалить» и «перенести». Числа туда
                  приедут с сервера — снимок страницы для такого решения
                  слишком стар, и разметку роликов он не считает вовсе. */}
              <button
                className="mag-ghost mag-danger"
                type="button"
                onClick={() => onFate(false)}
              >
                Удалить
              </button>
              <button
                className="mag-ghost"
                type="button"
                onClick={() => onFate(true)}
              >
                Перенести разметку…
              </button>
            </div>
          )}
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="mag-btn"
            type="button"
            disabled={!name.trim() || busy}
            onClick={() =>
              run(() =>
                onSave({
                  name: name.trim(),
                  color,
                  superclass_id: superclassId || null,
                })
              )
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
  onSave: (patch: { name: string; color: string }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState(sc?.name ?? "");
  const [color, setColor] = useState(sc?.color ?? PALETTE[3]);
  useEscape(onClose);

  return (
    <div className="mag-backdrop">
      <div className="mag-modal" onClick={(e) => e.stopPropagation()}>
        <h1>{sc ? "Суперкласс" : "Новый суперкласс"}</h1>
        {sc && <p className="mag-sub">{count(sc.classes, "класс", "класса", "классов")} в группе.</p>}

        <div className="mag-field">
          <label htmlFor="sm-name">Название</label>
          <input
            id="sm-name"
            type="text"
            value={name}
            maxLength={128}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="mag-field">
          <label>Цвет</label>
          <ColorPicker value={color} onChange={setColor} />
        </div>

        {error && <div className="mag-error">{error}</div>}

        <div className="mag-modal-foot">
          {onDelete && (
            <button className="mag-ghost mag-danger" type="button" disabled={busy}
              onClick={() => run(onDelete)}>
              Удалить
            </button>
          )}
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="mag-btn"
            type="button"
            disabled={!name.trim() || busy}
            onClick={() => run(() => onSave({ name: name.trim(), color }))}
          >
            {sc ? "Сохранить" : "Создать суперкласс"}
          </button>
        </div>
      </div>
    </div>
  );
}
