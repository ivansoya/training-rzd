// Таблицы в параметрах узла: классы «Сети», строки «Сети по тексту», классы «Фильтра».
// Классов у сети бывает несколько десятков — поэтому поиск и фильтр, а не список галочек.

import { useState } from "react";
import * as api from "../../api/agents";
import { Button, Input, Seg, cx } from "../../ui";
import { NumInput } from "../NumInput";
import {
  CYRILLIC, exampleConfDefault, isExamples, offLimits, withConf, type FilterRow, type NetRow, type PromptRow, type TextModel,
} from "./agentDoc";
import { ExampleStrip, ExamplesDialog } from "./ExamplesDialog";

type Shown = "all" | "on" | "off";
type ColorOf = Map<string, { color: string; sources: unknown[] }>;

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

/** Имя класса агента в строке; пустое на уходе из поля возвращается к исходному. */
function AgentName({ value, fallback, color, merged, readOnly, label, onChange }: {
  value: string; fallback: string; color?: string; merged?: number; readOnly: boolean; label: string; onChange: (v: string) => void;
}) {
  return (
    <span className="ae-an">
      <i style={{ background: color ?? "var(--input)" }} />
      <input className="ui-input ui-ctl ae-in" value={value} disabled={readOnly} aria-label={label} title={value}
        onChange={(e) => onChange(e.target.value)} onBlur={(e) => !e.target.value.trim() && onChange(fallback)} />
      {merged && merged > 1 ? <b className="ae-merge" title="В этот класс агента сходятся несколько источников">×{merged}</b> : null}
    </span>
  );
}

const filterBy = <T extends { on: boolean }>(rows: T[], shown: Shown) => rows.filter((r) => shown === "all" || (shown === "on" ? r.on : !r.on));

export function NetClasses({ names, rows, readOnly, colorOf, onRows }: {
  names: string[]; rows: NetRow[]; readOnly: boolean; colorOf: ColorOf; onRows: (rows: NetRow[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Shown>("all");
  const table: NetRow[] = names.map((n, i) => rows[i] ?? { agent: n, on: false });
  const set = (i: number, patch: Partial<NetRow>) => onRows(table.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const q = query.trim().toLowerCase();
  const visible = filterBy(table.map((r, i) => ({ ...r, i, name: names[i] })), shown)
    .filter((r) => !q || `${r.name} ${r.agent}`.toLowerCase().includes(q));
  return (
    <div className="ae-ct">
      <Head title="Классы сети" total={names.length} on={table.filter((r) => r.on).length} query={query} onQuery={setQuery}
        placeholder="Найти класс" shown={shown} onShown={setShown} readOnly={readOnly}
        onAll={(on) => onRows(table.map((r) => ({ ...r, on })))} />
      <div className="ae-ct-row net head"><span /><span>№</span><span>в весах</span><span>класс агента</span></div>
      {visible.length === 0 && <p className="t-xs t-faint ae-ct-none">Ничего не найдено</p>}
      {visible.map((r) => {
        const c = r.on ? colorOf.get(r.agent.trim()) : undefined;
        return (
          <div key={r.i} className={cx("ae-ct-row net", !r.on && "off")}>
            <Tick checked={r.on} disabled={readOnly} label={r.name} onChange={(on) => set(r.i, { on })} />
            <span className="ui-mono t-faint">{r.i}</span>
            <span className="ui-mono t-ell" title={r.name}>{r.name}</span>
            <AgentName value={r.agent} fallback={r.name} color={c?.color} merged={c?.sources.length} readOnly={readOnly}
              label={`Класс агента для ${r.name}`} onChange={(agent) => set(r.i, { agent })} />
          </div>
        );
      })}
    </div>
  );
}

/** Строки «Сети по тексту»: слово или набор образцов → класс агента, у каждой свой порог (пусто — порог узла).
 *  Слово по-русски не запрещено — модель его примет, только найдёт хуже или не то. */
export function PromptTable({ rows, readOnly, colorOf, nodeConf, model, sets, onSet, onRows }: {
  rows: PromptRow[]; readOnly: boolean; colorOf: ColorOf; nodeConf: number; model: TextModel;
  sets: Map<string, api.ExampleSet>; onSet: (set: api.ExampleSet) => void; onRows: (rows: PromptRow[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Shown>("all");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  // Раскрытые полосы образцов — по id набора: номер строки съезжал при удалении строки выше.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  const set = (i: number, patch: Partial<PromptRow>) => onRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const q = query.trim().toLowerCase();
  const label = (r: PromptRow) => (isExamples(r) ? sets.get(r.set ?? "")?.class_name ?? "образцы" : r.prompt ?? "");
  const visible = filterBy(rows.map((r, i) => ({ ...r, i })), shown).filter((r) => !q || `${label(r)} ${r.agent}`.toLowerCase().includes(q));
  const add = () => {
    const clean = prompt.trim();
    if (!clean) return;
    onRows([...rows, { kind: "text", prompt: clean, agent: agent.trim() || clean, on: true }]);
    setPrompt("");
    setAgent("");
  };
  const toggle = (id: string) => setOpen((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="ae-ct">
      <Head title="Строки" total={rows.length} on={rows.filter((r) => r.on).length} query={query} onQuery={setQuery}
        placeholder="Найти слово или класс" shown={shown} onShown={setShown} readOnly={readOnly}
        onAll={(on) => onRows(rows.map((r) => ({ ...r, on })))} />
      <div className="ae-ct-row pr head"><span /><span /><span>слово / образцы</span><span>класс агента</span><span className="r">порог</span><span /></div>
      {rows.length === 0 && <p className="t-xs t-faint ae-ct-none">Строк нет — добавьте слово или образцы ниже</p>}
      {rows.length > 0 && visible.length === 0 && <p className="t-xs t-faint ae-ct-none">Ничего не найдено</p>}
      {visible.map((r) => {
        const c = r.on ? colorOf.get(r.agent.trim()) : undefined;
        const ex = isExamples(r);
        const exSet = ex ? sets.get(r.set ?? "") : undefined;
        const cyr = !ex && CYRILLIC.test(r.prompt ?? "");
        const opened = ex && open.has(r.set ?? "");
        return (
          <div key={r.i} className={cx("ae-ct-row pr", !r.on && "off")}>
            <Tick checked={r.on} disabled={readOnly} label={label(r) || "строка"} onChange={(on) => set(r.i, { on })} />
            <span className={cx("ae-kind", ex && "ex")} title={ex ? "образцы" : "слово"}>{ex ? "обр" : "сл"}</span>
            {ex ? (
              <button type="button" className="ae-src" aria-expanded={opened} onClick={() => toggle(r.set ?? "")}>
                <b className="t-ell">{exSet?.class_name ?? "набор"}</b>
                <span className="ui-mono t-faint">{exSet ? `${exSet.items.length} обр.` : "…"}</span>
              </button>
            ) : (
              <input className="ui-input ui-ctl ae-in ui-mono" value={r.prompt ?? ""} disabled={readOnly} aria-label="Слово"
                onChange={(e) => set(r.i, { prompt: e.target.value })} />
            )}
            <AgentName value={r.agent} fallback={label(r)} color={c?.color} merged={c?.sources.length} readOnly={readOnly}
              label={`Класс агента для ${label(r)}`} onChange={(a) => set(r.i, { agent: a })} />
            <NumInput className="ui-input ui-ctl ae-in ui-mono r" min={0} max={1} step={0.05} allowEmpty disabled={readOnly}
              placeholder={String(nodeConf).replace(".", ",")} value={typeof r.conf === "number" ? r.conf : undefined}
              aria-label="Порог строки" aria-invalid={offLimits({ lo: 0, hi: 1 }, r.conf) || undefined}
              onValue={(v) => set(r.i, { conf: v ?? null })} />
            {!readOnly ? (
              <Button size="sm" variant="ghost" icon="x" aria-label={`Удалить строку ${label(r)}`} onClick={() => onRows(rows.filter((_, k) => k !== r.i))} />
            ) : <span />}
            {cyr && <span className="ae-ct-note ge-warn">Слово по-русски — модель понимает английский</span>}
            {opened && exSet && (
              <div className="ae-ct-wide">
                <ExampleStrip set={exSet} readOnly={readOnly} onSet={(next) => {
                  onSet(next);
                  // Набор неизменяем: правка рождает новый id — раскрытой остаётся та же строка.
                  setOpen((old) => new Set([...old].map((id) => (id === exSet.id ? next.id : id))));
                  set(r.i, { set: next.id });
                }} />
              </div>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <form className="ae-ct-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input className="ui-mono" placeholder="слово по-английски" value={prompt} aria-label="Новое слово" onChange={(e) => setPrompt(e.target.value)} />
          <Input placeholder="класс агента" value={agent} list="ae-agent-classes" aria-label="Класс агента для нового слова"
            onChange={(e) => setAgent(e.target.value)} />
          <Button type="submit" size="sm" icon="plus" disabled={!prompt.trim()}>Слово</Button>
          <Button size="sm" icon="images" onClick={() => setDialog(true)}>Образцы из разметки</Button>
          <datalist id="ae-agent-classes">{[...colorOf.keys()].map((name) => <option key={name} value={name} />)}</datalist>
        </form>
      )}
      {dialog && (
        <ExamplesDialog onClose={() => setDialog(false)} onDone={(made, agentName) => {
          onSet(made);
          onRows([...rows, withConf({ kind: "examples", set: made.id, agent: agentName, on: true }, exampleConfDefault(model))]);
          setOpen((old) => new Set(old).add(made.id));
          setDialog(false);
        }} />
      )}
    </div>
  );
}

/** Классы «Фильтра»: те, что приходят на вход, с галочкой и порогом. Класса нет в таблице — пропускается
 *  с порогом 0, так же считает и сервер. Строки ушедших классов не выбрасываем: вернётся класс — вернётся правило. */
export function FilterClasses({ names, rows, readOnly, colorOf, onRows }: {
  names: string[]; rows: FilterRow[]; readOnly: boolean; colorOf: ColorOf; onRows: (rows: FilterRow[]) => void;
}) {
  const byName = new Map(rows.map((r) => [r.cls, r]));
  const table = names.map((cls) => byName.get(cls) ?? { cls, on: true, conf: 0 });
  const set = (cls: string, patch: Partial<FilterRow>) =>
    onRows([...rows.filter((r) => !names.includes(r.cls)), ...table.map((r) => (r.cls === cls ? { ...r, ...patch } : r))]);
  return (
    <div className="ae-ct">
      <Head title="Классы на входе" total={names.length} readOnly={readOnly} />
      <div className="ae-ct-row flt head"><span /><span>класс агента</span><span className="r">уверенность от</span></div>
      {names.length === 0 && <p className="t-xs t-faint ae-ct-none">Выше нет сетей с классами</p>}
      {table.map((r) => (
        <div key={r.cls} className={cx("ae-ct-row flt", !r.on && "off")}>
          <Tick checked={r.on} disabled={readOnly} label={r.cls} onChange={(on) => set(r.cls, { on })} />
          <span className="ae-an">
            <i style={{ background: colorOf.get(r.cls)?.color ?? "var(--input)" }} />
            <span className="t-ell" title={r.cls}>{r.cls}</span>
          </span>
          <NumInput className="ui-input ui-ctl ae-in ui-mono r" min={0} max={1} step={0.05} value={r.conf} disabled={readOnly || !r.on}
            aria-label={`Порог для ${r.cls}`} aria-invalid={offLimits({ lo: 0, hi: 1 }, r.conf) || undefined}
            onValue={(v) => set(r.cls, { conf: v ?? 0 })} />
        </div>
      ))}
    </div>
  );
}

