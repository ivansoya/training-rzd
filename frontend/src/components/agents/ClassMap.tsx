// Классы агента → классы проекта: общая таблица окна запуска и окна «Агент таски».
//
// Одинаковые имена подставляются сами, а класс агента, взятый из этого проекта,
// сопоставлен намертво — его строка с замком. Помнит сопоставление сервер, на пару
// «агент + проект» по id класса агента.

import { useMemo } from "react";
import type * as api from "../../api/agents";
import { Badge, Icon, Select, Table } from "../../ui";

const NONE = "none";

/** Запомненное по id класса агента; у сопоставлений до списка классов ключ — имя. */
export const remembered = (c: api.VersionClass, saved: Record<string, string | null> | undefined) =>
  saved?.[c.id] ?? saved?.[c.name];

/** Стартовое сопоставление: ссылка, иначе запомненное, иначе класс с тем же именем. */
export const guess = (list: api.VersionClass[], classes: api.RunContext["classes"],
  saved: Record<string, string | null> | undefined) => {
  const byName = new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const ids = new Set(classes.map((c) => c.id));
  const out: Record<string, string | null> = {};
  for (const c of list) {
    const kept = remembered(c, saved);
    out[c.id] = c.lock ?? (kept !== undefined && (kept === null || ids.has(kept)) ? kept : byName.get(c.name.trim().toLowerCase()) ?? null);
  }
  return out;
};

/** Классы, подставленные по имени, а не запомненные и не по ссылке. */
export function useAutoMapped(list: api.VersionClass[], saved: Record<string, string | null> | undefined,
  mapping: Record<string, string | null>) {
  return useMemo(
    () => new Set(list.filter((c) => !c.lock && remembered(c, saved) === undefined && mapping[c.id]).map((c) => c.id)),
    [list, saved, mapping]
  );
}

export default function ClassMap({ list, classes, mapping, auto, onMapping }: {
  list: api.VersionClass[];
  classes: api.RunContext["classes"];
  mapping: Record<string, string | null>;
  auto: Set<string>;
  onMapping: (next: Record<string, string | null>) => void;
}) {
  const locked = list.filter((c) => c.lock);
  if (list.length > 0 && locked.length === list.length) {
    return <p className="ar-lock"><Icon name="link" size={14} />Все классы агента взяты из этого проекта — сопоставлять нечего.</p>;
  }
  return (
    <div className="ar-map">
      <div className="ar-map-h">
        <b>Классы агента → классы проекта</b>
        {auto.size > 0 && <span className="t-xs t-muted">{auto.size} подставлено по имени</span>}
      </div>
      <Table>
        <tbody>
          {list.map((c) => {
            const target = classes.find((k) => k.id === mapping[c.id]);
            return (
              <tr key={c.id}>
                <td className="t-ell">{c.name}</td>
                <td>
                  {c.lock ? (
                    <span className="ar-locked" title="Класс агента взят из этого проекта — сопоставлен сам">
                      <Icon name="lock" size={13} />{target ? `${target.class_index} — ${target.name}` : "класс проекта"}
                    </span>
                  ) : (
                    <Select full size="sm" label={`Класс проекта для «${c.name}»`} value={mapping[c.id] ?? NONE}
                      onChange={(v) => onMapping({ ...mapping, [c.id]: v === NONE ? null : v })}
                      options={[{ value: NONE, label: "Не размечать" },
                        ...classes.map((k) => ({ value: k.id, label: `${k.class_index} — ${k.name}` }))]} />
                  )}
                </td>
                <td className="r">
                  {c.lock ? <Badge variant="secondary">по ссылке</Badge> : auto.has(c.id) && <Badge variant="secondary">по имени</Badge>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
