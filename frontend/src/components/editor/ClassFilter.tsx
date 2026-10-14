// Список «какие классы показывать» — у дорожек видео и над лентой «Фокуса» (решения 14.10.2026).

import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Button, Check, Icon, Popover, Swatch } from "../../ui";
import { ru } from "../ru";

export interface FilterEntry {
  key: string;
  name: string;
  color: string;
  n: number;
}

function read(key: string): Set<string> {
  try { return new Set(JSON.parse(window.localStorage.getItem(key) || "[]") as string[]); } catch { return new Set(); }
}

/** Снятые классы — в этом браузере, на таску; у «Фокуса» и видео ключи свои. */
export function useClassFilter(storeKey: string) {
  const [off, setOff] = useState(() => read(storeKey));
  useEffect(() => { setOff(read(storeKey)); }, [storeKey]);
  const set = useCallback((next: Set<string>) => {
    setOff(next);
    try { window.localStorage.setItem(storeKey, JSON.stringify([...next])); } catch { /* не запомнится — фильтру не мешает */ }
  }, [storeKey]);
  return [off, set] as const;
}

/** Сколько строк списка отмечено и сколько всего — для подписи кнопки. */
export const shownOf = (entries: FilterEntry[], off: Set<string>) =>
  ({ shown: entries.filter((e) => !off.has(e.key)).length, total: entries.length });

export function ClassFilter({ trigger, title, classes, agent = [], unit, agentUnit, off, onChange, side }: {
  trigger: ReactElement;
  title: string;
  classes: FilterEntry[];
  /** Классы разведки без класса проекта — ниже чертой. */
  agent?: FilterEntry[];
  /** Что считает число в строке — подсказкой к нему. */
  unit: string;
  agentUnit?: string;
  off: Set<string>;
  onChange: (next: Set<string>) => void;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const all = [...classes, ...agent];
  const toggle = (key: string, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(key); else next.add(key);
    onChange(next);
  };
  // «только» — соседней кнопкой, а не внутри подписи: кнопка в label переключала бы и галочку
  const row = (e: FilterEntry, hint: string) => (
    <div key={e.key} className="flt-row">
      <Check checked={!off.has(e.key)} onChange={(v) => toggle(e.key, v)}>
        <Swatch color={e.color} />
        <span className="t-ell grow">{e.name}</span>
        <span className="ui-count" title={hint}>{ru(e.n)}</span>
      </Check>
      <Button variant="ghost" size="sm" className="flt-only" title={`Показать только «${e.name}»`}
        onClick={() => onChange(new Set(all.map((x) => x.key).filter((k) => k !== e.key)))}>только</Button>
    </div>
  );
  return (
    <Popover width={290} side={side} className="flt-pop" trigger={trigger}>
      <div className="ui-pop-h">
        <span>{title}</span>
        <Button variant="ghost" size="sm" disabled={all.every((e) => !off.has(e.key))} onClick={() => onChange(new Set())}>Все</Button>
      </div>
      <div className="flt-opts">{classes.map((e) => row(e, unit))}</div>
      {agent.length > 0 && (
        <>
          <div className="ui-pop-sep" />
          <div className="ui-pop-h"><span className="row"><Icon name="scan" size={13} />Агент, без класса</span></div>
          <div className="flt-opts flt-ag">{agent.map((e) => row(e, agentUnit ?? unit))}</div>
        </>
      )}
    </Popover>
  );
}
