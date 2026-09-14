import { useCallback, useEffect, useState } from "react";
import { deleteTag, listTags, renameTag } from "../../api/tags";
import type { Tag } from "../../api/tags";
import { ApiError } from "../../api/http";
import { useProject } from "./ProjectShell";
import { plural } from "./ProjectsPage";
import Sep from "../Sep";
import Banner from "../Banner";

/** Справочник тагов проекта.
 *
 * Заводят таги обычно не здесь, а по ходу дела — в карточке ролика, в
 * карточке загрузки, в редакторе. Этот экран нужен для другого: переименовать
 * опечатку и убрать то, чем перестали пользоваться. Без него опечатка «нось»
 * оставалась бы в справочнике навсегда и тихо делила ночные кадры надвое.
 */
export default function ProjectTags() {
  const { detail } = useProject();
  const code = detail.project.code;

  const [tags, setTags] = useState<Tag[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const got = await listTags(code);
      setTags(got.tags);
      setCanEdit(got.can_edit);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(id: string) {
    const name = draft.trim();
    if (!name) return;
    try {
      await renameTag(code, id, name);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(tag: Tag) {
    setError(null);
    try {
      await deleteTag(code, tag.id);
      await load();
    } catch (e) {
      // 409 — это не отказ, а цена: сервер сосчитал, с чего таг снимется, и
      // ждёт подтверждения. Пересказываем цену словами и спрашиваем.
      if (e instanceof ApiError && e.code === "confirm_required") {
        if (!window.confirm(`${e.message}\n\nУдалить таг «${tag.name}»?`)) return;
        try {
          await deleteTag(code, tag.id, true);
          await load();
        } catch (again) {
          setError((again as Error).message);
        }
        return;
      }
      setError((e as Error).message);
    }
  }

  return (
    <>
      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

      <div className="mag-card">
        <div className="mag-card-h">
          <h4>Таги проекта <Sep /> {tags.length}</h4>
        </div>
        {!tags.length && (
          <p className="mag-empty">
            Тагов пока нет. Их заводят в карточке ролика, в окне загрузки
            кадров или в редакторе разметки.
          </p>
        )}

        {tags.map((tag) => (
          <div key={tag.id} className="mag-tagrow">
            {editing === tag.id ? (
              // Форма, а не строка с кнопкой: Enter в поле сохраняет сам, и
              // ради этого не нужен обработчик клавиш.
              <form
                className="mag-tagrow-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(tag.id);
                }}
              >
                <input
                  className="mag-input"
                  value={draft}
                  autoFocus
                  aria-label={`Новое имя тага «${tag.name}»`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <button className="mag-btn mag-btn-inline" type="submit"
                  disabled={!draft.trim()}>
                  Сохранить
                </button>
                <button className="mag-ghost mag-ghost-inline" type="button"
                  onClick={() => setEditing(null)}>
                  Отмена
                </button>
              </form>
            ) : (
              <>
                {/* Имя и его вес стоят вместе: «103 кадра» — это про таг, а
                    прижатое к кнопкам число читалось как их подпись. */}
                <span className="mag-tagrow-name">
                  <b title={tag.name}>{tag.name}</b>
                  <small>
                    {(tag.images ?? 0).toLocaleString("ru-RU")}{" "}
                    {plural(tag.images ?? 0, "кадр", "кадра", "кадров")}
                  </small>
                </span>
                {canEdit && (
                  <span className="mag-tagrow-acts">
                    <button
                      className="mag-rowbtn"
                      type="button"
                      onClick={() => {
                        setEditing(tag.id);
                        setDraft(tag.name);
                      }}
                    >
                      Переименовать
                    </button>
                    <button
                      className="mag-rowbtn danger"
                      type="button"
                      onClick={() => void remove(tag)}
                    >
                      Удалить
                    </button>
                  </span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
