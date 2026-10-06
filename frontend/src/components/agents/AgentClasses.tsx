// Окно «Классы агента»: список, на который ссылаются строки узлов.
//
// Класс свой или ссылка на класс проекта. Ссылка берёт имя и цвет из проекта вживую,
// а в том проекте при запуске сопоставляется сама. Имена в списке уникальны без учёта
// регистра: класс из проекта с занятым именем не дублирует свой, а связывает его.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import * as api from "../../api/agents";
import { Badge, Button, ColorPicker, Dialog, Empty, Icon, Input, Popover, Select, cx } from "../../ui";
import { count } from "../ru";
import { CLASS_NAME_MAX, findOrCreate, foldName, type AgentClass, type ClassDef } from "./agentDoc";

type Project = api.ClassSource;

/** Где класс используется: «Сеть — вагоны: №0 wagon, №3 car». */
function usage(c: AgentClass, titleOf: (node: string) => string) {
  const by = new Map<string, string[]>();
  for (const s of c.sources) by.set(s.node, [...(by.get(s.node) ?? []), s.label]);
  return [...by].map(([node, labels]) => ({ node, text: `${titleOf(node)}: ${labels.join(", ")}` }));
}

function NameCell({ c, taken, readOnly, onName }: {
  c: AgentClass; taken: (name: string, self: string) => boolean; readOnly: boolean; onName: (name: string) => void;
}) {
  const [text, setText] = useState(c.name);
  useEffect(() => setText(c.name), [c.name]);
  const clean = text.trim();
  const bad = !clean ? "Имя пустое" : taken(clean, c.id) ? "Такой класс уже есть" : null;
  if (c.ref || readOnly) return <b className="t-ell" title={c.name}>{c.name}</b>;
  return (
    <div className="acl-name">
      <Input value={text} maxLength={CLASS_NAME_MAX} aria-label={`Имя класса ${c.name}`} aria-invalid={Boolean(bad) || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => (bad ? setText(c.name) : clean !== c.name && onName(clean))}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(c.name);
        }} />
      {bad && text !== c.name && <small className="acl-err">{bad}</small>}
    </div>
  );
}

/** Выбор классов проекта пачкой. Имя уже есть у своего класса — тот станет ссылкой. */
function FromProject({ projects, defs, onAdd, onCancel }: {
  projects: Project[]; defs: ClassDef[]; onAdd: (project: Project, picked: api.ClassSource["classes"]) => void; onCancel: () => void;
}) {
  const [pid, setPid] = useState(projects.find((p) => p.classes.length)?.id ?? projects[0]?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const project = projects.find((p) => p.id === pid);
  const state = (c: api.ClassSource["classes"][number]) => {
    if (defs.some((d) => d.ref?.cls === c.id)) return { off: true, note: "уже в агенте" };
    const same = defs.find((d) => foldName(d.name) === foldName(c.name));
    if (same?.ref) return { off: true, note: `имя занято классом из «${same.ref.project_name ?? "проекта"}»` };
    if (same) return { off: false, note: `свяжет свой «${same.name}»` };
    return { off: false, note: null };
  };
  const free = (project?.classes ?? []).filter((c) => !state(c).off);
  return (
    <div className="acl-pick">
      <div className="acl-pick-h">
        <Select size="sm" label="Проект" value={pid} onChange={(v) => { setPid(v); setPicked(new Set()); }}
          options={projects.map((p) => ({ value: p.id, label: p.name, hint: count(p.classes.length, "класс", "класса", "классов") }))} />
        <span className="grow" />
        <Button size="sm" variant="ghost" disabled={!free.length}
          onClick={() => setPicked(picked.size === free.length ? new Set() : new Set(free.map((c) => c.id)))}>
          {picked.size === free.length && free.length ? "Снять все" : "Выбрать все"}
        </Button>
      </div>
      <div className="acl-pick-l">
        {!project?.classes.length && <p className="t-xs t-faint">В проекте нет классов</p>}
        {project?.classes.map((c) => {
          const st = state(c);
          return (
            <label key={c.id} className={cx("acl-pick-r", st.off && "off")}>
              <input type="checkbox" className="ui-check ui-ctl" disabled={st.off} checked={picked.has(c.id)}
                onChange={(e) => setPicked((old) => {
                  const next = new Set(old);
                  if (e.target.checked) next.add(c.id); else next.delete(c.id);
                  return next;
                })} />
              <i style={{ background: c.color }} />
              <span className="t-ell">{c.name}</span>
              {st.note && <small>{st.note}</small>}
            </label>
          );
        })}
      </div>
      <div className="acl-pick-f">
        <Button size="sm" variant="ghost" onClick={onCancel}>Отмена</Button>
        <Button size="sm" variant="primary" icon="plus" disabled={!picked.size || !project}
          onClick={() => project && onAdd(project, project.classes.filter((c) => picked.has(c.id)))}>
          {picked.size ? `Добавить ${picked.size}` : "Добавить"}
        </Button>
      </div>
    </div>
  );
}

export default function AgentClasses({ open, onClose, classes, readOnly, projects, titleOf, onChange, onRemove, onShowNode }: {
  open: boolean;
  onClose: () => void;
  classes: AgentClass[];
  readOnly: boolean;
  /** Проекты человека с классами; null — ещё грузятся. */
  projects: Project[] | null;
  titleOf: (node: string) => string;
  onChange: (defs: ClassDef[]) => void;
  /** Убрать классы: строки узлов с ними выключаются, но не пропадают. */
  onRemove: (ids: string[]) => void;
  onShowNode: (node: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const defs: ClassDef[] = useMemo(() => classes.map(({ sources: _s, ...c }) => c), [classes]);
  const unused = classes.filter((c) => !c.sources.length);
  const byProject = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  const taken = (name: string, self: string) => defs.some((d) => d.id !== self && foldName(d.name) === foldName(name));
  const patch = (id: string, change: Partial<ClassDef>) => onChange(defs.map((d) => (d.id === id ? { ...d, ...change } : d)));

  const addOwn = () => {
    let n = defs.length + 1;
    while (taken(`класс ${n}`, "")) n += 1;
    onChange(findOrCreate(defs, `класс ${n}`)[0]);
  };
  const addFrom = (project: Project, picked: Project["classes"]) => {
    let next = defs;
    for (const c of picked) {
      const ref = { project: project.id, cls: c.id, project_name: project.name };
      const same = next.find((d) => foldName(d.name) === foldName(c.name));
      next = same
        ? next.map((d) => (d.id === same.id ? { ...d, name: c.name, color: c.color, ref } : d))
        : findOrCreate(next, c.name, { color: c.color, ref })[0];
    }
    onChange(next);
    setPicking(false);
  };
  const origin = (c: AgentClass) => {
    if (!c.ref) return <span className="t-faint">своё</span>;
    const project = byProject.get(c.ref.project);
    const live = project?.classes.find((k) => k.id === c.ref!.cls);
    return (
      <span className="acl-ref" title={projects && !project ? "Нет доступа к проекту — показан последний известный класс" : undefined}>
        <Icon name="link" size={12} />
        <span className="t-ell">{c.ref.project_name ?? project?.name ?? "проект"} · {live?.name ?? c.name}</span>
        {projects && !project && <Badge variant="secondary">нет доступа</Badge>}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} width={820} title="Классы агента"
      desc="Строки узлов выбирают класс из этого списка. Класс из проекта в том проекте сопоставляется сам"
      footer={<>
        {!readOnly && unused.length > 0 && (
          <Button variant="ghost" icon="trash" onClick={() => onChange(defs.filter((d) => !unused.some((u) => u.id === d.id)))}>
            Убрать неиспользуемые ({unused.length})
          </Button>
        )}
        <span className="grow" />
        <Button onClick={onClose}>Готово</Button>
      </>}>
      <div className="acl">
        {classes.length === 0 ? (
          <Empty compact icon="tags" title="Классов пока нет">
            Включите класс в таблице «Сети» — он появится здесь сам, или добавьте класс из проекта.
          </Empty>
        ) : (
          <div className="acl-t" role="table" aria-label="Классы агента">
            <div className="acl-r head" role="row"><span /><span>класс</span><span>откуда</span><span>где используется</span><span /></div>
            {classes.map((c) => {
              const used = usage(c, titleOf);
              return (
                <div key={c.id} className={cx("acl-r", !used.length && "idle")} role="row">
                  {c.ref || readOnly ? <i className="acl-sw" style={{ "--cc": c.color } as CSSProperties} /> : (
                    <Popover width={300} trigger={
                      <button type="button" className="acl-sw" style={{ "--cc": c.color } as CSSProperties} aria-label={`Цвет класса ${c.name}`} />
                    }>
                      <ColorPicker value={c.color} onChange={(color) => patch(c.id, { color })} />
                    </Popover>
                  )}
                  <NameCell c={c} taken={taken} readOnly={readOnly} onName={(name) => patch(c.id, { name })} />
                  {origin(c)}
                  <span className="acl-use">
                    {used.length ? used.map((u) => (
                      <button key={u.node} type="button" className="acl-node t-ell" title={u.text} onClick={() => onShowNode(u.node)}>{u.text}</button>
                    )) : <span className="t-faint">не используется</span>}
                  </span>
                  {readOnly ? <span /> : asking === c.id ? (
                    <span className="acl-ask">
                      <Button size="sm" variant="danger" onClick={() => { onRemove([c.id]); setAsking(null); }}>Убрать</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>Нет</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" icon={c.ref ? "x" : "trash"}
                      aria-label={`Убрать класс ${c.name}`}
                      title={used.length ? `Строки узлов с этим классом выключатся (${c.sources.length})` : "Убрать класс"}
                      onClick={() => (used.length ? setAsking(c.id) : onRemove([c.id]))} />
                  )}
                  {asking === c.id && (
                    <small className="acl-warn">
                      {count(c.sources.length, "строка", "строки", "строк")} в узлах выключится — сами строки останутся
                    </small>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!readOnly && (picking && projects ? (
          <FromProject projects={projects} defs={defs} onAdd={addFrom} onCancel={() => setPicking(false)} />
        ) : (
          <div className="acl-add">
            <Button size="sm" icon="plus" onClick={addOwn}>Класс</Button>
            <Button size="sm" icon="link" disabled={!projects?.length} onClick={() => setPicking(true)}>Из проекта…</Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
