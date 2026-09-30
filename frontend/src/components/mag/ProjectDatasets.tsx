import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useProject } from "./ProjectShell";
import { useEscape } from "./useEscape";
import { useDialog } from "../useDialog";
import { count, ru } from "../ru";
import { datasetUsage, deleteDataset, renameDataset } from "../../api/datasets";
import type { DatasetUsage } from "../../api/datasets";

// Вкладка «Датасеты». Таблица получила собственный класс: правила кабинета
// (.mag-cab table) сюда никогда не доставали, поэтому она была без стилей.
//
// Переименование — у редактора (имя — подпись для людей), удаление — у
// владельца проекта: оно уносит кадры с разметкой и необратимо.
export default function ProjectDatasets() {
  const { detail, refresh } = useProject();
  const { project, datasets, my_role, classes } = detail;
  const canEdit = my_role === "admin" || my_role === "editor";
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  if (datasets.length === 0) {
    // Импорт второго архива сервер отклоняет, пока в проекте есть классы
    // (`_import_blocked`), — говорим это до выбора файла, а не после.
    const blocked = classes.length > 0;
    return (
      <div className="mag-card mag-empty-big">
        <h3>Датасетов пока нет</h3>
        <p>
          {blocked
            ? "В проекте уже есть классы — импорт архива в такой проект пока не поддержан."
            : "Импортируйте YOLO-архив — он станет первым датасетом проекта."}
        </p>
        {my_role === "admin" && !blocked && (
          <Link className="mag-btn mag-btn-inline" to={`/projects/${project.code}/import`}>
            Импортировать датасет
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="mag-card">
      <div className="mag-card-h">
        <h4>Датасеты проекта</h4>
      </div>
      <div className="mag-table-scroll">
        <table className="mag-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Идентификатор</th>
              <th className="num">Изображений</th>
              <th>Создан</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link
                    className="mag-link"
                    to={`/projects/${project.code}/datasets/${d.id}`}
                  >
                    {d.name}
                  </Link>
                </td>
                <td><span className="mag-code">{d.identifier}</span></td>
                <td className="num">{ru(d.images_count)}</td>
                <td>{new Date(d.created_at).toLocaleDateString("ru-RU")}</td>
                {canEdit && (
                  <td className="actions">
                    <button
                      className="mag-ghost mag-ghost-inline"
                      type="button"
                      onClick={() => setEditing({ id: d.id, name: d.name })}
                    >
                      Изменить
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <DatasetModal
          code={project.code}
          dataset={editing}
          canDelete={my_role === "admin"}
          onClose={() => setEditing(null)}
          onDone={async () => {
            await refresh();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** Одно окно на имя и на удаление, как у класса: удаление — редкое и
 *  опасное действие, отдельной кнопки в строке таблицы оно не заслуживает.
 *  Нажав «Удалить», окно спрашивает цену у сервера и показывает её числами;
 *  держащие таски называет по имени и удалить не даёт. */
function DatasetModal({
  code,
  dataset,
  canDelete,
  onClose,
  onDone,
}: {
  code: string;
  dataset: { id: string; name: string };
  canDelete: boolean;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(dataset.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [usage, setUsage] = useState<DatasetUsage | null>(null);
  const ref = useDialog();
  useEscape(onClose);

  useEffect(() => {
    if (!deleting) return;
    // Кнопка «Удалить…», на которой стоял фокус, исчезла вместе с полем:
    // возвращаем фокус окну, иначе он падает на страницу под подложкой.
    ref.current?.focus();
    let alive = true;
    datasetUsage(code, dataset.id)
      .then((u) => alive && setUsage(u))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [code, dataset.id, deleting, ref]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const held = usage !== null && usage.tasks.length > 0;

  return (
    <div className="mag-backdrop">
      <div
        className="mag-modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ds-modal-h"
        tabIndex={-1}
      >
        <h1 id="ds-modal-h">
          {deleting ? `Удалить датасет «${dataset.name}»` : "Датасет"}
        </h1>

        {!deleting ? (
          <div className="mag-field">
            <label htmlFor="ds-rename">Название</label>
            <input
              id="ds-rename"
              type="text"
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && name.trim() !== dataset.name)
                  act(() => renameDataset(code, dataset.id, name.trim()));
              }}
              autoFocus
            />
          </div>
        ) : usage === null ? (
          <p className="mag-sub">{error ?? "Считаем, что уйдёт вместе с датасетом…"}</p>
        ) : (
          <>
            <table className="mag-table mag-fate-table">
              <tbody>
                <tr>
                  <td>Кадров</td>
                  <td className="num">{ru(usage.images)}</td>
                </tr>
                <tr>
                  <td>Разметок на них</td>
                  <td className="num">{ru(usage.annotations)}</td>
                </tr>
              </tbody>
            </table>
            {held && (
              <p className="mag-hint mag-warn">
                Датасет держат незакрытые таски:{" "}
                {usage.tasks.map((t) => t.name).join(", ")}. Закройте их, чтобы удалить.
              </p>
            )}
            {usage.unbuilt_sets.length > 0 && (
              <p className="mag-hint mag-warn">
                Его выбрали несобранные наборы: {usage.unbuilt_sets.join(", ")}.
              </p>
            )}
          </>
        )}

        {error && (usage !== null || !deleting) && <div className="mag-error">{error}</div>}

        <div className="mag-modal-foot">
          {canDelete && !deleting && (
            <div className="mag-foot-left">
              <button
                className="mag-ghost mag-danger"
                type="button"
                onClick={() => {
                  setError(null);
                  setDeleting(true);
                }}
              >
                Удалить…
              </button>
            </div>
          )}
          <button className="mag-ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          {deleting ? (
            <button
              className="mag-btn mag-danger"
              type="button"
              disabled={busy || usage === null || held}
              onClick={() => act(() => deleteDataset(code, dataset.id))}
            >
              {usage
                ? `Удалить ${count(usage.images, "кадр", "кадра", "кадров")}`
                : "Удалить"}
            </button>
          ) : (
            <button
              className="mag-btn"
              type="button"
              disabled={busy || !name.trim() || name.trim() === dataset.name}
              onClick={() => act(() => renameDataset(code, dataset.id, name.trim()))}
            >
              Сохранить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
