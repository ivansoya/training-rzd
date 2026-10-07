// Строки «Сети по тексту» карточками классов: у класса описания со своими порогами и
// образцы по проходам. Хранение прежнее — строки узла, карточка их только группирует.
// Шапка карточки чуть тронута цветом класса, под курсором — заметнее; щелчок по ней раскрывает.

import { useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import * as api from "../../api/agents";
import { Button, Icon, Input, MenuItem, Notice, Popover, Swatch, Switch, cx } from "../../ui";
import { NumInput } from "../NumInput";
import { count, plural, ru } from "../ru";
import {
  CYRILLIC, EX_ROW, collagePasses, exampleConfDefault, isExamples, offLimits, promptMax, withConf,
  type AgentClass, type PromptRow, type TextModel,
} from "./agentDoc";
import { ExamplesDialog } from "./ExamplesDialog";

/** Класс агента по имени: найденный или заведённый редактором; пустое имя — null. */
type Ensure = (name: string) => string | null;
type Row = { r: PromptRow; i: number };
interface Card { key: string; def?: AgentClass; name: string; rows: Row[] }

const HINT: Record<"sam3" | "yoloe", string> = {
  sam3: "SAM 3 понимает короткие фразы: предмет и 1–3 признака — «rusty hex nut», «orange safety vest». "
    + "Длиннее 32 токенов он молча обрезает, поэтому больше 100 знаков не сохранить.",
  yoloe: "YOLOE читает до 77 токенов. Длинное описание помогает не всегда — сравнивайте по счёту на кадре и на 6 кадрах.",
};
const ADD = 6;

const dec = (v: number) => String(v).replace(".", ",");
const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`);

/** Карточки по классу строк, в порядке первого появления; строки без класса — по подсказке имени. */
function cardsOf(rows: PromptRow[], classes: AgentClass[]): Card[] {
  const out = new Map<string, Card>();
  rows.forEach((r, i) => {
    const def = r.cls ? classes.find((c) => c.id === r.cls) : undefined;
    const key = def ? def.id : `hint:${(r.agent ?? "").trim().toLowerCase()}`;
    if (!out.has(key)) out.set(key, { key, def, name: def?.name ?? r.agent ?? "", rows: [] });
    out.get(key)!.rows.push({ r, i });
  });
  return [...out.values()];
}

/** «N на кадре» — рамки строки или класса на кадре превью. */
function Hits({ n, title }: { n: number; title: string }) {
  return <span className={cx("ae-hit", n === 0 && "zero")} title={title}><b className="ui-mono">{n}</b> на кадре</span>;
}

export default function ClassCards({ rows, readOnly, classes, ensure, ensureRef, projects, nodeConf, model, sets, gone, onSet, onRows,
  hits, view, views, msPerCall, onClasses }: {
  rows: PromptRow[];
  readOnly: boolean;
  classes: AgentClass[];
  ensure: Ensure;
  /** Класс-ссылка на класс проекта: найденный по имени становится ссылкой. */
  ensureRef: (project: api.ClassSource, cls: api.ClassSource["classes"][number]) => string | null;
  projects: api.ClassSource[] | null;
  nodeConf: number;
  model: TextModel;
  sets: Map<string, api.ExampleSet>;
  /** Наборы, которых больше нет на сервере. */
  gone: Set<string>;
  onSet: (set: api.ExampleSet) => void;
  onRows: (rows: PromptRow[]) => void;
  /** Своих рамок узла на кадре превью по номеру строки; null — превью нет. */
  hits: Map<number, number> | null;
  /** Вид, на котором идут образцы (кадр или тайл): по нему ряды и проходы. */
  view: [number, number] | null;
  /** Видов на кадр: целый и тайлы. */
  views: number;
  msPerCall?: number;
  /** Окно «Классы агента»: переименовать, сменить цвет. */
  onClasses: () => void;
}) {
  const [query, setQuery] = useState("");
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [focusNew, setFocusNew] = useState<number | null>(null);
  // `row` — строка, чей набор собирается заново; без неё новый набор встаёт новой строкой.
  const [dialog, setDialog] = useState<{ card?: Card; row?: number } | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const cards = useMemo(() => cardsOf(rows, classes), [rows, classes]);
  const sam3 = model === "sam3";
  const limit = promptMax(model);
  const q = query.trim().toLowerCase();
  const shown = cards.filter((c) => !q || c.name.toLowerCase().includes(q)
    || c.rows.some(({ r }) => !isExamples(r) && (r.prompt ?? "").toLowerCase().includes(q)));
  // По умолчанию раскрыты первые три карточки; поиск раскрывает найденное.
  const open = (c: Card) => (q ? true : (cards.indexOf(c) < 3) !== flipped.has(c.key));
  const toggle = (c: Card) => setFlipped((old) => {
    const next = new Set(old);
    if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
    return next;
  });

  const set = (i: number, patch: Partial<PromptRow>) => onRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const drop = (ids: number[]) => onRows(rows.filter((_, k) => !ids.includes(k)));
  const addText = (cls: string | null | undefined) => {
    if (!cls) return;
    setFocusNew(rows.length);
    onRows([...rows, { kind: "text", prompt: "", cls, on: true }]);
  };
  const sizeOf = (r: PromptRow) => sets.get(r.set ?? "")?.items.length ?? 0;
  const passesOf = (n: number) => (sam3 && view ? collagePasses(Math.max(1, n), view[0], view[1]).length : 1);
  const total = {
    texts: rows.filter((r) => !isExamples(r)).length,
    examples: rows.filter(isExamples).reduce((s, r) => s + sizeOf(r), 0),
  };

  // Включить класс — все его строки; строке без класса — класс карточки или по имени.
  const switchCard = (c: Card, on: boolean) => {
    const cls = c.def?.id ?? (on ? ensure(c.name) : null);
    const ids = new Set(c.rows.map((x) => x.i));
    onRows(rows.map((r, k) => {
      if (!ids.has(k)) return r;
      if (!on) return { ...r, on: false };
      const { agent: _hint, ...rest } = r;
      return cls ? { ...rest, cls, on: true } : { ...r, on: true };
    }));
  };

  const summary = (c: Card, opened: boolean) => {
    const texts = c.rows.filter(({ r }) => !isExamples(r));
    const exs = c.rows.filter(({ r }) => isExamples(r));
    const parts: string[] = [];
    if (!opened && texts.length === 1) parts.push(`«${texts[0].r.prompt || "…"}» ${dec(texts[0].r.conf ?? nodeConf)}`);
    else if (texts.length) parts.push(count(texts.length, "описание", "описания", "описаний"));
    const live = exs.filter(({ r }) => !gone.has(r.set ?? ""));
    if (exs.length && !live.length) parts.push("набор образцов удалён");
    else if (live.length) {
      const n = live.reduce((s, { r }) => s + sizeOf(r), 0);
      const p = live.reduce((s, { r }) => s + passesOf(sizeOf(r)), 0);
      parts.push(count(n, "образец", "образца", "образцов") + (sam3 ? ` · ${count(p, "проход", "прохода", "проходов")}` : "")
        + (!opened ? ` ${dec(live[0].r.conf ?? nodeConf)}` : ""));
    }
    return parts.join(" · ") || "пусто — добавьте описание или образцы";
  };

  return (
    <div className="ae-block">
      <div className="ae-block-h">
        <b>Классы</b>
        <span className="ae-block-d">{cards.length} · {count(total.texts, "описание", "описания", "описаний")} · {count(total.examples, "образец", "образца", "образцов")}</span>
        <span className="grow" />
        {cards.length > 2 && (
          <Input icon="search" className="ae-find" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти класс или описание"
            aria-label="Найти класс или описание" />
        )}
      </div>
      {rows.length === 0 && <p className="ae-none">Классов нет — добавьте класс агента или класс из проекта ниже.</p>}
      {rows.length > 0 && shown.length === 0 && <p className="ae-none">Ничего не найдено</p>}

      <div className="ae-cards">
        {shown.map((c) => {
          const opened = open(c);
          const on = c.rows.filter(({ r }) => r.on).length;
          const texts = c.rows.filter(({ r }) => !isExamples(r));
          const exs = c.rows.filter(({ r }) => isExamples(r));
          const got = hits && on ? c.rows.reduce((s, { i }) => s + (hits.get(i) ?? 0), 0) : null;
          return (
            <div key={c.key} className={cx("ae-card", on === 0 && "off", opened && "open")}
              style={{ "--cc": c.def?.color ?? "var(--muted-fg)" } as CSSProperties}>
              {/* Щелчок по шапке раскрывает; кнопки, переключатель и меню (оно в портале) — своё. */}
              <div className="ae-card-h" onClick={(e) => {
                if (!e.currentTarget.contains(e.target as Node) || (e.target as Element).closest("button, input, a")) return;
                toggle(c);
              }}>
                <div className="ae-card-t">
                  <span className="ae-card-n">
                    <span className="ae-sw" title={c.def?.ref ? "Класс проекта: имя и цвет живут там" : undefined}>
                      <Swatch color={c.def?.color} />
                    </span>
                    <b className={cx("t-ell", !c.def && "t-faint")} title={c.name}>{c.name || "без класса"}</b>
                    {c.def?.ref?.project_name && <span className="ui-mono">{c.def.ref.project_name}</span>}
                  </span>
                  <span className="ae-card-sum t-ell">{summary(c, opened)}</span>
                </div>
                {got !== null && <Hits n={got} title="Рамок класса на кадре превью" />}
                <Button size="sm" variant="ghost" icon={opened ? "chevU" : "chevD"} aria-expanded={opened}
                  aria-label={opened ? "Свернуть класс" : "Раскрыть класс"} onClick={() => toggle(c)} />
                {!readOnly && (
                  <Popover align="end" width={240} trigger={<Button size="sm" variant="ghost" icon="more" aria-label={`Ещё: ${c.name}`} />}>
                    {(close) => (
                      <>
                        <MenuItem icon="plus" disabled={!c.def} onSelect={() => { close(); addText(c.def?.id); }}>Описание</MenuItem>
                        <MenuItem icon="images" onSelect={() => { close(); setDialog({ card: c }); }}>Образцы из разметки…</MenuItem>
                        <MenuItem icon="tags" onSelect={() => { close(); onClasses(); }}>Переименовать, цвет…</MenuItem>
                        <div className="ui-pop-sep" />
                        <MenuItem icon="trash" danger onSelect={() => { close(); drop(c.rows.map((x) => x.i)); }}>Убрать класс из узла</MenuItem>
                      </>
                    )}
                  </Popover>
                )}
                <Switch checked={on > 0} disabled={readOnly} onChange={(v) => switchCard(c, v)}
                  label={on ? `Выключить класс ${c.name} в узле` : `Включить класс ${c.name} в узле`} />
              </div>

              {opened && (
                <div className="ae-card-b">
                  <div className="ae-sub">
                    <div className="ae-sub-h">
                      <b>Описания</b>
                      <span>{texts.length ? "по-английски, у каждого свой порог"
                        : exs.length ? "нет — класс ищется только по образцам" : "нет"}</span>
                      <span className="grow" />
                      {!readOnly && c.def && (
                        <Button size="sm" variant="ghost" icon="plus" onClick={() => addText(c.def!.id)}>Описание</Button>
                      )}
                    </div>
                    {texts.map(({ r, i }) => {
                      const text = r.prompt ?? "";
                      const long = text.length > limit;
                      const cyr = CYRILLIC.test(text);
                      return (
                        <div key={i} className={cx("ae-pl", !r.on && "off")}>
                          <input type="checkbox" className="ui-check ui-ctl" checked={r.on} disabled={readOnly} aria-label={`Описание ${text || "пустое"}`}
                            onChange={(e) => set(i, e.target.checked ? { on: true, cls: r.cls ?? ensure(c.name) ?? undefined } : { on: false })} />
                          <input className={cx("ui-input ui-ctl ae-in ui-mono", cyr && "warn")} value={text} disabled={readOnly}
                            maxLength={Math.max(limit, text.length)} aria-label="Описание" aria-invalid={long || undefined}
                            placeholder="описание по-английски" autoFocus={focusNew === i}
                            onFocus={() => { setEditing(i); setFocusNew(null); }} onBlur={() => setEditing((e) => (e === i ? null : e))}
                            onChange={(e) => set(i, { prompt: e.target.value })} />
                          {hits ? <Hits n={hits.get(i) ?? 0} title="Рамок этого описания на кадре превью" /> : <span />}
                          <NumInput className="ui-input ui-ctl ae-in ui-mono r" min={0} max={1} step={0.05} allowEmpty disabled={readOnly}
                            placeholder={dec(nodeConf)} value={typeof r.conf === "number" ? r.conf : undefined}
                            aria-label="Порог описания" aria-invalid={offLimits({ lo: 0, hi: 1 }, r.conf) || undefined}
                            onValue={(v) => set(i, { conf: v ?? null })} />
                          {!readOnly ? <Button size="sm" variant="ghost" icon="x" aria-label={`Удалить описание ${text}`} onClick={() => drop([i])} /> : <span />}
                          {(editing === i || long) && (
                            <div className={cx("ae-under", long && "bad")}>
                              <span className="ui-mono">{text.length} / {limit}</span>
                              <span>{long ? `Длиннее ${limit} знаков версию не сохранить — сократите.` : HINT[sam3 ? "sam3" : "yoloe"]}</span>
                            </div>
                          )}
                          {cyr && !long && <div className="ae-under warn"><span>По-русски модель понимает плохо — пишите по-английски.</span></div>}
                        </div>
                      );
                    })}
                  </div>

                  <div className="ae-sub">
                    {exs.length ? exs.map(({ r, i }) => (
                      <ExampleBlock key={i} row={r} set={sets.get(r.set ?? "")} gone={gone.has(r.set ?? "")} sam3={sam3} view={view}
                        views={views} msPerCall={msPerCall} readOnly={readOnly} nodeConf={nodeConf}
                        hits={hits ? <Hits n={hits.get(i) ?? 0} title="Рамок по образцам на кадре превью" /> : null} onSet={onSet}
                        onRow={(patch) => set(i, patch)} onRemove={() => drop([i])} onRebuild={() => setDialog({ card: c, row: i })} />
                    )) : (
                      <div className="ae-sub-h">
                        <b>Образцы</b>
                        <span>{sam3 ? "нет" : "у YOLOE набор сводится в один средний вектор"}</span>
                        <span className="grow" />
                        {!readOnly && <Button size="sm" variant="ghost" icon="plus" onClick={() => setDialog({ card: c })}>Образцы…</Button>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div className="ae-cards-add">
          {naming === null ? (
            <button type="button" className="ae-addl" onClick={() => setNaming("")}><Icon name="plus" size={14} />Класс агента</button>
          ) : (
            <form className="ae-cards-new" onSubmit={(e) => {
              e.preventDefault();
              const cls = ensure(naming);
              if (cls) addText(cls);
              setNaming(null);
            }}>
              <Input autoFocus value={naming} placeholder="имя класса" list="ae-agent-classes" aria-label="Имя нового класса"
                onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(null)} />
              <Button type="submit" size="sm" disabled={!naming.trim()}>Добавить</Button>
              <Button size="sm" variant="ghost" onClick={() => setNaming(null)}>Отмена</Button>
            </form>
          )}
          <ProjectClassPick projects={projects} onPick={(p, k) => addText(ensureRef(p, k))} />
        </div>
      )}

      {dialog && (
        <ExamplesDialog model={model} onClose={() => setDialog(null)}
          preset={dialog.card?.def?.ref ? { project: projects?.find((p) => p.id === dialog.card!.def!.ref!.project)?.code,
            classId: dialog.card.def.ref.cls } : undefined}
          agentName={dialog.card?.def?.name}
          onDone={(made, agentName) => {
            onSet(made);
            if (dialog.row !== undefined) set(dialog.row, { set: made.id });
            else {
              const cls = dialog.card?.def?.id ?? ensure(agentName) ?? undefined;
              onRows([...rows, withConf({ kind: "examples", set: made.id, cls, on: true }, exampleConfDefault(model))]);
            }
            setDialog(null);
          }} />
      )}
    </div>
  );
}

/** Образцы одной строки: миниатюры по проходам и рядам коллажа SAM 3. Набор неизменяем —
 *  убрать и переставить рождают новый набор, строка переходит на него. */
function ExampleBlock({ row, set, gone, sam3, view, views, msPerCall, readOnly, nodeConf, hits, onSet, onRow, onRemove, onRebuild }: {
  row: PromptRow; set?: api.ExampleSet; gone: boolean; sam3: boolean; view: [number, number] | null; views: number; msPerCall?: number;
  readOnly: boolean; nodeConf: number; hits: ReactNode; onSet: (set: api.ExampleSet) => void;
  onRow: (patch: Partial<PromptRow>) => void; onRemove: () => void; onRebuild: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  if (!set) {
    return (
      <div className="ae-sub-h">
        <b>Образцы</b>
        <span className={gone ? "ge-warn" : undefined}>{gone ? "набора больше нет на сервере — соберите заново или уберите строку" : "загружаю набор…"}</span>
        <span className="grow" />
        {gone && !readOnly && (
          <>
            <Button size="sm" variant="ghost" icon="images" onClick={onRebuild}>Собрать заново…</Button>
            <Button size="sm" variant="ghost" icon="trash" aria-label="Убрать строку образцов" onClick={onRemove} />
          </>
        )}
      </div>
    );
  }
  const uids = set.items.map((it) => it.uid);
  const n = set.items.length;
  const plan = sam3 && view ? collagePasses(n, view[0], view[1]) : [set.items.map((_, k) => k)];
  const rowsIn = (pass: number[]) => Array.from({ length: Math.ceil(pass.length / EX_ROW) }, (_, k) => pass.slice(k * EX_ROW, (k + 1) * EX_ROW));
  // Подписи «ряд» и «проход» — только когда их больше одного; YOLOE просто ставит миниатюры подряд.
  const labelled = sam3 && (plan.length > 1 || plan.some((pass) => pass.length > EX_ROW));
  const chip = !sam3 ? null : plan.length > 1 ? count(plan.length, "проход", "прохода", "проходов")
    : `1 проход${rowsIn(plan[0] ?? []).length > 1 ? " · 2 ряда" : ""}`;

  const derive = async (body: { order?: string[]; add?: number }) => {
    setBusy(true);
    setError(null);
    try {
      const next = (await api.deriveExamples(set.id, body)).set;
      onSet(next);
      onRow({ set: next.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dropOn = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = drag;
    setDrag(null);
    setOver(null);
    if (from === null || from === to) return;
    const order = [...uids];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    void derive({ order });
  };
  const thumb = (k: number) => {
    const it = set.items[k];
    return (
      <div key={it.uid} className={cx("ae-th", drag === k && "drag", over === k && "over")} draggable={!readOnly && !busy}
        title={`${it.file_name} — ${it.side} px`}
        onDragStart={() => setDrag(k)}
        onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(k); } }}
        onDragLeave={() => setOver((o) => (o === k ? null : o))}
        onDrop={dropOn(k)}
        onDragEnd={() => { setDrag(null); setOver(null); }}>
        <img src={api.exampleCrop(set.id, it.uid)} alt={`образец ${k + 1}`} loading="lazy" draggable={false} />
        <span className="n">{k + 1}</span>
        {!readOnly && n > 1 && (
          <button type="button" className="rm" disabled={busy} aria-label={`Убрать образец ${k + 1}`}
            onClick={() => derive({ order: uids.filter((u) => u !== it.uid) })}>×</button>
        )}
      </div>
    );
  };
  const extra = sam3 && plan.length > 1 && msPerCall !== undefined ? msPerCall * (plan.length - 1) * views : null;

  return (
    <div className={cx("ae-exb", !row.on && "off")}>
      <div className="ae-sub-h">
        <b>Образцы</b>
        <span className="t-ell">{set.project} · {count(n, "рамка", "рамки", "рамок")} с {ru(set.frames)} {plural(set.frames, "кадра", "кадров", "кадров")} · вырезка «авто»</span>
        <span className="grow" />
        {chip && <span className="ae-chip">{chip}</span>}
      </div>
      {set.status === "error" && <Notice tone="error">{set.error ?? "Набор не собрался"}</Notice>}
      {sam3 ? (
        <div className="ae-rows">
          {plan.map((pass, p) => rowsIn(pass).map((line, k) => (
            <div key={`${p}.${k}`} className="ae-exr">
              {labelled && <span className="ui-mono">{plan.length > 1 ? (k === 0 ? `проход ${p + 1}` : "") : `ряд ${k + 1}`}</span>}
              <div className="ae-thumbs">{line.map(thumb)}</div>
            </div>
          )))}
        </div>
      ) : <div className="ae-thumbs">{set.items.map((_, k) => thumb(k))}</div>}
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      <div className="ae-exf">
        <span>Порог</span>
        <NumInput className="ui-input ui-ctl ae-in ui-mono r" min={0} max={1} step={0.05} allowEmpty disabled={readOnly}
          placeholder={dec(nodeConf)} value={typeof row.conf === "number" ? row.conf : undefined}
          aria-label="Порог образцов" aria-invalid={offLimits({ lo: 0, hi: 1 }, row.conf) || undefined}
          onValue={(v) => onRow({ conf: v ?? null })} />
        {hits}
        {extra !== null && <span className="t-faint">проходы сверх первого ≈ +{took(extra)} на кадр</span>}
        <span className="grow" />
        {!readOnly && (
          <>
            <Button size="sm" variant="ghost" icon="plus" disabled={busy} onClick={() => derive({ add: ADD })}>{busy ? "…" : `Добрать ${ADD}`}</Button>
            <Button size="sm" variant="ghost" icon="trash" disabled={busy} aria-label="Убрать образцы из класса" onClick={onRemove} />
          </>
        )}
      </div>
    </div>
  );
}

/** «Класс из проекта…»: класс-ссылка, имя и цвет живут в проекте. */
function ProjectClassPick({ projects, onPick }: {
  projects: api.ClassSource[] | null;
  onPick: (project: api.ClassSource, cls: api.ClassSource["classes"][number]) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  return (
    <Popover align="start" width={320} trigger={
      <button type="button" className="ae-addl" disabled={!projects?.length}><Icon name="plus" size={14} />Класс из проекта…</button>}>
      {(close) => (
        <div className="ae-pick">
          <Input icon="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти класс" aria-label="Найти класс проекта" />
          <div className="ae-pick-l">
            {(projects ?? []).map((p) => {
              const list = p.classes.filter((k) => !q || k.name.toLowerCase().includes(q));
              return list.length ? (
                <div key={p.id}>
                  <div className="ui-pop-h">{p.name}</div>
                  {list.map((k) => (
                    <MenuItem key={k.id} onSelect={() => { close(); onPick(p, k); }}>
                      <span className="ae-an"><i style={{ background: k.color }} />{k.name}</span>
                    </MenuItem>
                  ))}
                </div>
              ) : null;
            })}
          </div>
        </div>
      )}
    </Popover>
  );
}
