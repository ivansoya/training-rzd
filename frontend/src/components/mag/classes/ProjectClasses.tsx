// Классы: таблица и панель правки справа. Группы (суперклассы) — в фильтре «Все группы»,
// таги классов — в фильтре «Все таги»; правятся в той же панели.

import { useCallback, useEffect, useState } from "react";
import { getClasses } from "../../../auth/api";
import type { ClassTagItem, ClassesInfo, LabelClass, SuperclassItem } from "../../../auth/api";
import { useLive } from "../../../live/LiveProvider";
import {
  Button, Card, Empty, Input, MenuItem, Notice, Popover, Progress, Swatch, Table, cx,
} from "../../../ui";
import { count, pct, ru } from "../../ru";
import { withSep } from "../../Sep";
import { useProject } from "../ProjectShell";
import { ClassPanel } from "./ClassPanel";
import { ClassTagPanel } from "./ClassTagPanel";
import { ClassesHead } from "./ClassesHead";
import { GroupPanel } from "./GroupPanel";
import { VAL_LOW, indexLabel, matchClasses, valShare } from "./classes";
import type { GroupFilter, TagFilter } from "./classes";

type Panel =
  | { kind: "class"; id: string }
  | { kind: "new-class" }
  | { kind: "group"; id: string }
  | { kind: "new-group" }
  | { kind: "tag"; id: string }
  | null;

const NO_TAGS: ClassTagItem[] = [];
// Тагов в строке таблицы — сколько влезает без переноса; остальные — числом
const ROW_TAGS = 3;

export default function ProjectClasses() {
  const { detail, refresh } = useProject();
  const code = detail.project.code;
  const [info, setInfo] = useState<ClassesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupFilter>("all");
  const [tag, setTag] = useState<TagFilter>("all");
  const [panel, setPanel] = useState<Panel>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await getClasses(code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => { void load(); }, [load]);
  // Классы мог поменять другой человек, а редакторы адресуют боксы номером класса
  useLive("classes", load);

  const changed = useCallback(async () => {
    await load();
    await refresh();
  }, [load, refresh]);

  // Запись исчезла (удалили в другой вкладке) — панель и отбор не держат пустоту
  useEffect(() => {
    if (!info) return;
    if (panel?.kind === "class" && !info.classes.some((c) => c.id === panel.id)) setPanel(null);
    if (panel?.kind === "group" && !info.superclasses.some((s) => s.id === panel.id)) setPanel(null);
    if (group !== "all" && group !== "none" && !info.superclasses.some((s) => s.id === group)) setGroup("all");
    const known = info.class_tags ?? NO_TAGS;
    if (panel?.kind === "tag" && !known.some((t) => t.id === panel.id)) setPanel(null);
    if (tag !== "all" && tag !== "none" && !known.some((t) => t.id === tag)) setTag("all");
  }, [info, panel, group, tag]);

  if (!info) {
    return (
      <div className="page">
        <ClassesHead code={code} />
        {error ? <Notice tone="error">{error}</Notice> : <p className="t-muted">Загружаем классы…</p>}
      </div>
    );
  }

  const { classes, superclasses, can_edit: canEdit, can_manage: canManage } = info;
  const classTags = info.class_tags ?? NO_TAGS;
  const shown = matchClasses(classes, query, group, tag);
  const boxes = classes.reduce((s, c) => s + c.annotations, 0);
  const filtered = query.trim() !== "" || group !== "all" || tag !== "all";
  const selected = panel?.kind === "class" ? classes.find((c) => c.id === panel.id) ?? null : null;
  const selectedGroup = panel?.kind === "group" ? superclasses.find((s) => s.id === panel.id) ?? null : null;
  const selectedTag = panel?.kind === "tag" ? classTags.find((t) => t.id === panel.id) ?? null : null;

  const desc = classes.length
    ? withSep([count(classes.length, "класс", "класса", "классов"), count(boxes, "бокс", "бокса", "боксов")])
    : "Классов пока нет";

  return (
    <div className="page">
      <ClassesHead code={code} desc={desc} actions={canEdit && (
        <Button variant="primary" icon="plus" onClick={() => setPanel({ kind: "new-class" })}>Новый класс</Button>
      )} />
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      <div className="cls-split">
        <Card className="cls-card">
          <div className="cls-bar">
            <Input icon="search" type="search" className="cls-q" placeholder="Найти класс" aria-label="Найти класс"
              value={query} onChange={(e) => setQuery(e.target.value)} />
            <GroupMenu value={group} onChange={setGroup} classes={classes} superclasses={superclasses} canEdit={canEdit}
              onEdit={(id) => setPanel({ kind: "group", id })} onNew={() => setPanel({ kind: "new-group" })} />
            <TagMenu value={tag} onChange={setTag} classes={classes} tags={classTags} canEdit={canEdit}
              onEdit={(id) => setPanel({ kind: "tag", id })} />
            {filtered && <span className="t-xs t-faint" role="status">{shown.length} из {classes.length}</span>}
            <span className="grow" />
            <span className="t-xs t-muted">Индекс класса не меняется: на нём держатся выгрузки</span>
          </div>
          {classes.length === 0 ? (
            <Empty icon="tag" title="Классов пока нет"
              action={canEdit && <Button icon="plus" onClick={() => setPanel({ kind: "new-class" })}>Новый класс</Button>}>
              Классы приходят с импортом архива или заводятся здесь.
            </Empty>
          ) : shown.length === 0 ? (
            <Empty compact icon="search" title="Ни один класс не подошёл"
              action={<Button size="sm" onClick={() => { setQuery(""); setGroup("all"); setTag("all"); }}>Сбросить</Button>}>
              Измените запрос, группу или таг.
            </Empty>
          ) : (
            <Table className="cls-tbl">
              <thead>
                <tr>
                  <th>Класс</th><th>Группа</th><th>Таги</th><th className="r">Индекс</th><th className="r">Боксов</th>
                  <th className="r">Кадров</th><th>Доля в val</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <Row key={c.id} cls={c} on={c.id === selected?.id} onOpen={() => setPanel({ kind: "class", id: c.id })} />
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <aside className="cls-side" aria-label="Панель правки">
          {(panel?.kind === "class" && selected) || panel?.kind === "new-class" ? (
            <ClassPanel key={selected?.id ?? "new"} code={code} cls={selected} classes={classes}
              superclasses={superclasses} classTags={classTags} canEdit={canEdit} canManage={canManage}
              initialGroup={group !== "all" && group !== "none" ? group : null}
              initialTag={tag !== "all" && tag !== "none" ? tag : null}
              onClose={() => setPanel(null)}
              onSaved={async (saved) => { await changed(); setPanel({ kind: "class", id: saved.id }); }}
              onDeleted={async (kept) => { await changed(); if (!kept) setPanel(null); }} />
          ) : (panel?.kind === "group" && selectedGroup) || panel?.kind === "new-group" ? (
            <GroupPanel key={selectedGroup?.id ?? "new"} code={code} sc={selectedGroup}
              onClose={() => setPanel(null)}
              onSaved={async (saved) => { await changed(); setPanel({ kind: "group", id: saved.id }); }}
              onDeleted={async () => { await changed(); setPanel(null); }} />
          ) : panel?.kind === "tag" && selectedTag ? (
            <ClassTagPanel key={selectedTag.id} code={code} tag={selectedTag}
              taken={classTags.filter((t) => t.id !== selectedTag.id).map((t) => t.name)}
              onClose={() => setPanel(null)}
              onSaved={changed}
              onDeleted={async () => { await changed(); setPanel(null); }} />
          ) : (
            <Card className="cls-panel">
              <Empty compact icon="pointer" title={canEdit ? "Выберите класс" : "Выберите класс, чтобы посмотреть"}
                action={canEdit && <Button size="sm" icon="plus" onClick={() => setPanel({ kind: "new-class" })}>Новый класс</Button>}>
                {canEdit ? "Щёлкните строку таблицы — правка откроется здесь." : "Менять классы может редактор проекта."}
              </Empty>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ cls, on, onOpen }: { cls: LabelClass; on: boolean; onOpen: () => void }) {
  const share = valShare(cls);
  const sp = cls.split;
  const tags = cls.tags ?? [];
  return (
    <tr className={cx("cls-row", on && "on")} tabIndex={0} aria-selected={on} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <td><span className="row"><Swatch color={cls.color} /><b className="cls-n t-ell">{cls.name}</b></span></td>
      <td className={cx("t-sm", cls.superclass_name ? "t-muted" : "t-faint")}>{cls.superclass_name ?? "Без группы"}</td>
      <td>{tags.length ? (
        <span className="tagp-row tagp-compact cls-tags" title={tags.map((t) => t.name).join(", ")}>
          {tags.slice(0, ROW_TAGS).map((t) => <span key={t.id} className="tagp-chip on">{t.name}</span>)}
          {tags.length > ROW_TAGS && <span className="t-xs t-faint">+{tags.length - ROW_TAGS}</span>}
        </span>
      ) : <span className="t-faint" title="Без тагов">—</span>}</td>
      <td className="r ui-mono t-xs t-faint">{indexLabel(cls.class_index)}</td>
      <td className="r ui-mono">{cls.annotations ? ru(cls.annotations) : <span className="t-faint" title="Не встречен">—</span>}</td>
      <td className="r ui-mono">{cls.images ? ru(cls.images) : <span className="t-faint">—</span>}</td>
      <td title={sp ? `train ${ru(sp.train)}, val ${ru(sp.val)}${sp.other ? `, без сплита ${ru(sp.other)}` : ""}` : undefined}>
        {share === null ? <span className="t-faint">—</span> : (
          <span className="row">
            <Progress value={share} max={0.3} color={share < VAL_LOW ? "var(--st-skip)" : "var(--c2)"}
              label={`Доля в val ${pct(share)}`} />
            <span className="ui-mono t-xs">{pct(share)}</span>
          </span>
        )}
      </td>
    </tr>
  );
}

/** Отбор по группе и вход в правку групп. */
function GroupMenu({ value, onChange, classes, superclasses, canEdit, onEdit, onNew }: {
  value: GroupFilter;
  onChange: (g: GroupFilter) => void;
  classes: LabelClass[];
  superclasses: SuperclassItem[];
  canEdit: boolean;
  onEdit: (id: string) => void;
  onNew: () => void;
}) {
  const label = value === "all" ? "Все группы" : value === "none" ? "Без группы"
    : superclasses.find((s) => s.id === value)?.name ?? "Все группы";
  const ungrouped = classes.filter((c) => !c.superclass_id).length;
  return (
    <Popover width={290} yieldFocus trigger={<Button className="fr-fbtn cls-gbtn" icon="layers" iconEnd="chevD">{label}</Button>}>
      {(close) => (
        <div className="cls-gpop">
          <MenuItem selected={value === "all"} onSelect={() => { onChange("all"); close(); }}>
            <span className="cls-gname">Все группы<span className="ui-count">{classes.length}</span></span>
          </MenuItem>
          {superclasses.map((s) => (
            <div key={s.id} className="cls-gopt">
              <MenuItem selected={value === s.id} onSelect={() => { onChange(s.id); close(); }}>
                <span className="cls-gname"><Swatch color={s.color} /><span className="t-ell">{s.name}</span>
                  <span className="ui-count">{s.classes}</span></span>
              </MenuItem>
              {canEdit && (
                <Button variant="ghost" size="sm" icon="edit" aria-label={`Изменить группу «${s.name}»`}
                  onClick={() => { onEdit(s.id); close(); }} />
              )}
            </div>
          ))}
          <MenuItem selected={value === "none"} onSelect={() => { onChange("none"); close(); }}>
            <span className="cls-gname"><Swatch /><span>Без группы</span><span className="ui-count">{ungrouped}</span></span>
          </MenuItem>
          {canEdit && (
            <>
              <div className="ui-pop-sep" />
              <MenuItem icon="plus" onSelect={() => { onNew(); close(); }}>Новая группа</MenuItem>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}

/** Отбор по тагу классов и вход в его правку. Заводят таги в карточке класса. */
function TagMenu({ value, onChange, classes, tags, canEdit, onEdit }: {
  value: TagFilter;
  onChange: (t: TagFilter) => void;
  classes: LabelClass[];
  tags: ClassTagItem[];
  canEdit: boolean;
  onEdit: (id: string) => void;
}) {
  const label = value === "all" ? "Все таги" : value === "none" ? "Без тагов"
    : tags.find((t) => t.id === value)?.name ?? "Все таги";
  const untagged = classes.filter((c) => !c.tags?.length).length;
  return (
    <Popover width={290} yieldFocus trigger={<Button className="fr-fbtn cls-gbtn" icon="tags" iconEnd="chevD">{label}</Button>}>
      {(close) => (
        <div className="cls-gpop">
          <MenuItem selected={value === "all"} onSelect={() => { onChange("all"); close(); }}>
            <span className="cls-gname">Все таги<span className="ui-count">{classes.length}</span></span>
          </MenuItem>
          {tags.map((t) => (
            <div key={t.id} className="cls-gopt">
              <MenuItem selected={value === t.id} onSelect={() => { onChange(t.id); close(); }}>
                <span className="cls-gname"><span className="t-ell">{t.name}</span>
                  <span className="ui-count">{t.classes}</span></span>
              </MenuItem>
              {canEdit && (
                <Button variant="ghost" size="sm" icon="edit" aria-label={`Изменить таг «${t.name}»`}
                  onClick={() => { onEdit(t.id); close(); }} />
              )}
            </div>
          ))}
          <MenuItem selected={value === "none"} onSelect={() => { onChange("none"); close(); }}>
            <span className="cls-gname"><span>Без тагов</span><span className="ui-count">{untagged}</span></span>
          </MenuItem>
          {!tags.length && (
            <p className="ui-hint cls-thint">Таг заводят в карточке класса: поле «Таги».</p>
          )}
        </div>
      )}
    </Popover>
  );
}
