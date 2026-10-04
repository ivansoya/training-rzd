// Классы: таблица и панель правки справа. Группы (суперклассы) — в фильтре «Все группы»,
// правятся в той же панели.

import { useCallback, useEffect, useState } from "react";
import { getClasses } from "../../../auth/api";
import type { ClassesInfo, LabelClass, SuperclassItem } from "../../../auth/api";
import { useLive } from "../../../live/LiveProvider";
import {
  Button, Card, Empty, Input, MenuItem, Notice, Popover, Progress, Swatch, Table, cx,
} from "../../../ui";
import { count, pct, ru } from "../../ru";
import { useProject } from "../ProjectShell";
import { ClassPanel } from "./ClassPanel";
import { ClassesHead } from "./ClassesHead";
import { GroupPanel } from "./GroupPanel";
import { VAL_LOW, indexLabel, matchClasses, valShare } from "./classes";
import type { GroupFilter } from "./classes";

type Panel =
  | { kind: "class"; id: string }
  | { kind: "new-class" }
  | { kind: "group"; id: string }
  | { kind: "new-group" }
  | null;

export default function ProjectClasses() {
  const { detail, refresh } = useProject();
  const code = detail.project.code;
  const [info, setInfo] = useState<ClassesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupFilter>("all");
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
  }, [info, panel, group]);

  if (!info) {
    return (
      <div className="page">
        <ClassesHead code={code} />
        {error ? <Notice tone="error">{error}</Notice> : <p className="t-muted">Загружаем классы…</p>}
      </div>
    );
  }

  const { classes, superclasses, can_edit: canEdit, can_manage: canManage } = info;
  const shown = matchClasses(classes, query, group);
  const boxes = classes.reduce((s, c) => s + c.annotations, 0);
  const filtered = query.trim() !== "" || group !== "all";
  const selected = panel?.kind === "class" ? classes.find((c) => c.id === panel.id) ?? null : null;
  const selectedGroup = panel?.kind === "group" ? superclasses.find((s) => s.id === panel.id) ?? null : null;

  const desc = classes.length
    ? `${count(classes.length, "класс", "класса", "классов")} · ${count(boxes, "бокс", "бокса", "боксов")}`
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
              action={<Button size="sm" onClick={() => { setQuery(""); setGroup("all"); }}>Сбросить</Button>}>
              Измените запрос или группу.
            </Empty>
          ) : (
            <Table className="cls-tbl">
              <thead>
                <tr>
                  <th>Класс</th><th>Группа</th><th className="r">Индекс</th><th className="r">Боксов</th>
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
              superclasses={superclasses} canEdit={canEdit} canManage={canManage}
              initialGroup={group !== "all" && group !== "none" ? group : null}
              onClose={() => setPanel(null)}
              onSaved={async (saved) => { await changed(); setPanel({ kind: "class", id: saved.id }); }}
              onDeleted={async (kept) => { await changed(); if (!kept) setPanel(null); }} />
          ) : (panel?.kind === "group" && selectedGroup) || panel?.kind === "new-group" ? (
            <GroupPanel key={selectedGroup?.id ?? "new"} code={code} sc={selectedGroup}
              onClose={() => setPanel(null)}
              onSaved={async (saved) => { await changed(); setPanel({ kind: "group", id: saved.id }); }}
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
  return (
    <tr className={cx("cls-row", on && "on")} tabIndex={0} aria-selected={on} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      <td><span className="row"><Swatch color={cls.color} /><b className="cls-n t-ell">{cls.name}</b></span></td>
      <td className={cx("t-sm", cls.superclass_name ? "t-muted" : "t-faint")}>{cls.superclass_name ?? "Без группы"}</td>
      <td className="r ui-mono t-xs t-faint">{indexLabel(cls.class_index)}</td>
      <td className="r ui-mono">{cls.annotations ? ru(cls.annotations) : <span className="t-faint" title="Не встречен">—</span>}</td>
      <td className="r ui-mono">{cls.images ? ru(cls.images) : <span className="t-faint">—</span>}</td>
      <td title={sp ? `train ${ru(sp.train)} · val ${ru(sp.val)}${sp.other ? ` · без сплита ${ru(sp.other)}` : ""}` : undefined}>
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
