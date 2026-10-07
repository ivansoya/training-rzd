// Таблицы в параметрах узла: классы «Сети» и классы «Фильтра» (строки «Сети по тексту» — карточками, ClassCards).
// Классов у сети бывает несколько десятков — поэтому поиск и фильтр, а не список галочек.

import { useEffect, useState } from "react";
import { Button, Input, Seg, cx } from "../../ui";
import { NumInput } from "../NumInput";
import { CLASS_NAME_MAX, foldName, offLimits, type AgentClass, type FilterRow, type NetRow, type PromptRow } from "./agentDoc";

type Shown = "all" | "on" | "off";
/** Класс агента по имени: найденный или заведённый редактором; пустое имя — null. */
type Ensure = (name: string) => string | null;

const SHOWN = [{ value: "all" as const, label: "Все" }, { value: "on" as const, label: "Включены" }, { value: "off" as const, label: "Выключены" }];

function Head({ title, total, on, query, onQuery, placeholder, shown, onShown, onAll, readOnly }: {
  title: string; total: number; on?: number; query?: string; onQuery?: (v: string) => void; placeholder?: string;
  shown?: Shown; onShown?: (v: Shown) => void; onAll?: (on: boolean) => void; readOnly: boolean;
}) {
  return (
    <div className="ae-ct-h">
      <div className="ae-ct-t">
        <b>{title}</b>
        <span className="ui-mono">{total}{on !== undefined && <> · в агент {on}</>}</span>
      </div>
      {onQuery && (
        <div className="ae-ct-tools">
          <Input icon="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
          {onShown && <Seg size="sm" label="Какие строки" value={shown!} onChange={onShown} options={SHOWN} />}
          {onAll && !readOnly && (
            <>
              <Button size="sm" variant="ghost" icon="plus" title="Включить все" onClick={() => onAll(true)}>все</Button>
              <Button size="sm" variant="ghost" icon="minus" title="Выключить все" onClick={() => onAll(false)}>все</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Tick({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <input type="checkbox" className="ui-check ui-ctl" checked={checked} disabled={disabled} aria-label={label}
    onChange={(e) => onChange(e.target.checked)} />;
}

/** Класс агента в строке: поле с подсказками из списка агента. Имя из списка
 *  выбирает класс, новое — заводит его; переименовывают класс в окне «Классы
 *  агента», а не здесь. Пустое на уходе из поля возвращает прежний класс. */
function ClassPick({ cls, hint, classes, readOnly, label, onPick }: {
  cls?: string; hint: string; classes: AgentClass[]; readOnly: boolean; label: string; onPick: (name: string) => void;
}) {
  const c = classes.find((k) => k.id === cls);
  const shown = c?.name ?? hint;
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const clean = text.trim();
    if (!clean || (c && foldName(clean) === foldName(c.name))) {
      setText(shown);
      return;
    }
    onPick(clean);
  };
  const merged = c?.sources.length ?? 0;
  return (
    <span className="ae-an">
      <i className={c?.ref ? "ref" : undefined} style={{ background: c?.color ?? "var(--input)" }}
        title={c?.ref ? `Класс проекта «${c.ref.project_name ?? "проект"}»` : undefined} />
      <input className={cx("ui-input ui-ctl ae-in", !c && "t-faint")} value={text} disabled={readOnly} aria-label={label} title={shown}
        list="ae-agent-classes" maxLength={CLASS_NAME_MAX} onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(shown);
        }} />
      {merged > 1 ? <b className="ae-merge" title="В этот класс агента сходятся несколько источников">×{merged}</b> : null}
    </span>
  );
}

/** Подсказки полей класса — одни на шторку. */
export function ClassList({ classes }: { classes: AgentClass[] }) {
  return <datalist id="ae-agent-classes">{classes.map((c) => <option key={c.id} value={c.name} />)}</datalist>;
}

const filterBy = <T extends { on: boolean }>(rows: T[], shown: Shown) => rows.filter((r) => shown === "all" || (shown === "on" ? r.on : !r.on));

/** Строке, что включают, нужен класс: свой или по подсказке, иначе по имени из весов. */
const bound = <R extends NetRow | PromptRow>(r: R, classes: AgentClass[], ensure: Ensure, fallback: string): R => {
  if (r.cls && classes.some((c) => c.id === r.cls)) return { ...r, on: true };
  const cls = ensure(r.agent || fallback);
  const { agent: _hint, ...rest } = r;
  return cls ? ({ ...rest, cls, on: true } as R) : { ...r, on: true };
};

export function NetClasses({ names, rows, readOnly, classes, ensure, onRows }: {
  names: string[]; rows: NetRow[]; readOnly: boolean; classes: AgentClass[]; ensure: Ensure; onRows: (rows: NetRow[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Shown>("all");
  const table: NetRow[] = names.map((n, i) => rows[i] ?? { agent: n, on: false });
  const set = (i: number, patch: Partial<NetRow>) => onRows(table.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const nameOf = (r: NetRow) => classes.find((c) => c.id === r.cls)?.name ?? r.agent ?? "";
  const q = query.trim().toLowerCase();
  const visible = filterBy(table.map((r, i) => ({ ...r, i, name: names[i] })), shown)
    .filter((r) => !q || `${r.name} ${nameOf(r)}`.toLowerCase().includes(q));
  return (
    <div className="ae-ct">
      <Head title="Классы сети" total={names.length} on={table.filter((r) => r.on).length} query={query} onQuery={setQuery}
        placeholder="Найти класс" shown={shown} onShown={setShown} readOnly={readOnly}
        onAll={(on) => onRows(table.map((r, i) => (on ? bound(r, classes, ensure, names[i]) : { ...r, on })))} />
      <div className="ae-ct-row net head"><span /><span>№</span><span>в весах</span><span>класс агента</span></div>
      {visible.length === 0 && <p className="t-xs t-faint ae-ct-none">Ничего не найдено</p>}
      {visible.map((r) => (
        <div key={r.i} className={cx("ae-ct-row net", !r.on && "off")}>
          <Tick checked={r.on} disabled={readOnly} label={r.name}
            onChange={(on) => set(r.i, on ? bound(table[r.i], classes, ensure, r.name) : { on })} />
          <span className="ui-mono t-faint">{r.i}</span>
          <span className="ui-mono t-ell" title={r.name}>{r.name}</span>
          <ClassPick cls={r.cls} hint={r.agent ?? r.name} classes={classes} readOnly={readOnly}
            label={`Класс агента для ${r.name}`} onPick={(name) => set(r.i, { cls: ensure(name) ?? undefined, agent: undefined })} />
        </div>
      ))}
    </div>
  );
}

/** Классы «Фильтра»: те, что приходят на вход, с галочкой и порогом. Класса нет в таблице — пропускается
 *  с порогом 0, так же считает и сервер. Строки ушедших классов не выбрасываем: вернётся класс — вернётся правило. */
export function FilterClasses({ ids, rows, readOnly, classes, onRows }: {
  ids: string[]; rows: FilterRow[]; readOnly: boolean; classes: AgentClass[]; onRows: (rows: FilterRow[]) => void;
}) {
  const byId = new Map(rows.map((r) => [r.cls, r]));
  const table = ids.map((cls) => byId.get(cls) ?? { cls, on: true, conf: 0 });
  const set = (cls: string, patch: Partial<FilterRow>) =>
    onRows([...rows.filter((r) => !ids.includes(r.cls)), ...table.map((r) => (r.cls === cls ? { ...r, ...patch } : r))]);
  const def = (cls: string) => classes.find((c) => c.id === cls);
  return (
    <div className="ae-ct">
      <Head title="Классы на входе" total={ids.length} readOnly={readOnly} />
      <div className="ae-ct-row flt head"><span /><span>класс агента</span><span className="r">уверенность от</span></div>
      {ids.length === 0 && <p className="t-xs t-faint ae-ct-none">Выше нет сетей с классами</p>}
      {table.map((r) => (
        <div key={r.cls} className={cx("ae-ct-row flt", !r.on && "off")}>
          <Tick checked={r.on} disabled={readOnly} label={def(r.cls)?.name ?? r.cls} onChange={(on) => set(r.cls, { on })} />
          <span className="ae-an">
            <i style={{ background: def(r.cls)?.color ?? "var(--input)" }} />
            <span className="t-ell" title={def(r.cls)?.name}>{def(r.cls)?.name ?? r.cls}</span>
          </span>
          <NumInput className="ui-input ui-ctl ae-in ui-mono r" min={0} max={1} step={0.05} value={r.conf} disabled={readOnly || !r.on}
            aria-label={`Порог для ${def(r.cls)?.name ?? r.cls}`} aria-invalid={offLimits({ lo: 0, hi: 1 }, r.conf) || undefined}
            onValue={(v) => set(r.cls, { conf: v ?? 0 })} />
        </div>
      ))}
    </div>
  );
}

