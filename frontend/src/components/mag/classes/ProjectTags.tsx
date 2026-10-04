// Справочник тагов. Заводят их по ходу дела (ролик, загрузка, редактор),
// здесь — переименовать опечатку и убрать то, чем перестали пользоваться.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../../api/http";
import { deleteTag, listTags, renameTag } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import { Button, Card, Empty, Input, Notice, Table } from "../../../ui";
import { count, ru } from "../../ru";
import { useProject } from "../ProjectShell";
import { ClassesHead } from "./ClassesHead";

/** Строка в работе: переименование или удаление, которое ждёт подтверждения цены. */
type Edit = { id: string; kind: "rename"; draft: string } | { id: string; kind: "confirm"; message: string };

export default function ProjectTags() {
  const { detail } = useProject();
  const code = detail.project.code;
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [query, setQuery] = useState("");

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

  useEffect(() => { void load(); }, [load]);

  const rename = async (id: string, name: string) => {
    if (!name.trim()) return;
    try {
      await renameTag(code, id, name.trim());
      setEdit(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (tag: Tag, confirmed = false) => {
    setError(null);
    try {
      await deleteTag(code, tag.id, confirmed);
      setEdit(null);
      await load();
    } catch (e) {
      // 409 — не отказ, а цена: сервер сосчитал, с чего таг снимется, и ждёт подтверждения
      if (!confirmed && e instanceof ApiError && e.code === "confirm_required") {
        setEdit({ id: tag.id, kind: "confirm", message: e.message });
        return;
      }
      setError((e as Error).message);
    }
  };

  const q = query.trim().toLocaleLowerCase("ru");
  const shown = (tags ?? []).filter((t) => !q || t.name.toLocaleLowerCase("ru").includes(q));

  return (
    <div className="page">
      <ClassesHead code={code} desc={tags ? (tags.length ? count(tags.length, "таг", "тага", "тагов") : "Тагов пока нет") : undefined} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      {tags === null ? (
        !error && <p className="t-muted">Загружаем таги…</p>
      ) : tags.length === 0 ? (
        <Empty icon="tags" title="Тагов пока нет">
          Их заводят в карточке ролика, в окне загрузки кадров или в редакторе разметки.
        </Empty>
      ) : (
        <Card className="cls-card">
          <div className="cls-bar">
            <Input icon="search" type="search" className="cls-q" placeholder="Найти таг" aria-label="Найти таг"
              value={query} onChange={(e) => setQuery(e.target.value)} />
            {q && <span className="t-xs t-faint" role="status">{shown.length} из {tags.length}</span>}
            <span className="grow" />
            <span className="t-xs t-muted">Таг — условия съёмки: ночь, дождь, тоннель. По ним собирают наборы</span>
          </div>
          {shown.length === 0 ? (
            <Empty compact icon="search" title="Ни один таг не подошёл"
              action={<Button size="sm" onClick={() => setQuery("")}>Сбросить</Button>} />
          ) : (
            <Table className="tag-tbl">
              <thead><tr><th>Таг</th><th className="r">Кадров</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {shown.map((tag) => {
                  const mine = edit?.id === tag.id ? edit : null;
                  return (
                    <tr key={tag.id}>
                      <td>
                        {mine?.kind === "rename" ? (
                          // Форма — Enter сохраняет сам, Esc отменяет
                          <form className="row" onSubmit={(e) => { e.preventDefault(); void rename(tag.id, mine.draft); }}>
                            <Input value={mine.draft} maxLength={64} autoFocus className="tag-in"
                              aria-label={`Новое имя тага «${tag.name}»`}
                              onChange={(e) => setEdit({ ...mine, draft: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEdit(null); } }} />
                            <Button size="sm" variant="primary" type="submit" disabled={!mine.draft.trim()}>Сохранить</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Отмена</Button>
                          </form>
                        ) : mine?.kind === "confirm" ? (
                          <div className="tag-confirm">
                            <span className="ui-hint warn">{mine.message}</span>
                          </div>
                        ) : (
                          <b className="tag-n">{tag.name}</b>
                        )}
                      </td>
                      <td className="r ui-mono">{ru(tag.images ?? 0)}</td>
                      {canEdit && (
                        <td className="r tag-acts">
                          {mine?.kind === "confirm" ? (
                            <span className="row">
                              <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Не удалять</Button>
                              <Button size="sm" variant="danger" onClick={() => void remove(tag, true)}>Удалить «{tag.name}»</Button>
                            </span>
                          ) : mine ? null : (
                            <span className="row">
                              <Button size="sm" variant="ghost" icon="edit"
                                onClick={() => setEdit({ id: tag.id, kind: "rename", draft: tag.name })}>Переименовать</Button>
                              <Button size="sm" variant="ghost" icon="trash" aria-label={`Удалить таг «${tag.name}»`}
                                onClick={() => void remove(tag)} />
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
