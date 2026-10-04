import type { LabelClass } from "../../../auth/api";
import type { ImagesSummary } from "../../../api/gallery";
import type { Tag } from "../../../api/tags";
import { Button, Check, Chip, ChipToggle, Icon, Input, Popover, Seg, Swatch, TriCheck } from "../../../ui";
import type { Tri } from "../../../ui";
import { ru } from "../../ru";

export interface Filters {
  classes: number[];
  split: string;
  tags: Record<string, "in" | "ex">;
  q: string;
  empty: boolean;
}

export const NO_FILTERS: Filters = { classes: [], split: "", tags: {}, q: "", empty: false };

export const SPLIT_LABEL: Record<string, string> = { train: "train", val: "val", test: "test", other: "без сплита" };

export const hasFilters = (f: Filters) =>
  f.classes.length > 0 || f.split !== "" || Object.keys(f.tags).length > 0 || f.q.trim() !== "" || f.empty;

/** Фильтры галереи: классы, сплит, таги, имя файла — и под ними итог отбора. */
export function FrameFilters({ f, set, classes, tags, splits, matched, total, summary }: {
  f: Filters;
  set: (patch: Partial<Filters>) => void;
  classes: LabelClass[];
  tags: Tag[];
  /** Кадров по сплитам во всём проекте — какие варианты вообще показывать. */
  splits: Record<string, number>;
  matched: number | null;
  total: number;
  summary: ImagesSummary | null;
}) {
  const byIndex = new Map(classes.map((c) => [c.class_index, c]));
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const tagsOn = Object.entries(f.tags);

  // Полоска классов в показанном: выбранные, а без выбора — все, что встретились
  const boxes = summary?.boxes_by_class ?? {};
  const strip = (f.classes.length ? f.classes : classes.map((c) => c.class_index))
    .map((i) => ({ c: byIndex.get(i), n: boxes[String(i)] ?? 0 }))
    .filter((x): x is { c: LabelClass; n: number } => Boolean(x.c) && x.n > 0)
    .sort((a, b) => b.n - a.n);
  const sum = strip.reduce((a, x) => a + x.n, 0);

  const toggleClass = (i: number) =>
    set({ classes: f.classes.includes(i) ? f.classes.filter((x) => x !== i) : [...f.classes, i], empty: false });
  const setTag = (id: string, v: Tri) => {
    const next = { ...f.tags };
    if (v) next[id] = v;
    else delete next[id];
    set({ tags: next });
  };

  const splitKeys = ["train", "val", "test", "other"].filter((k) => (splits[k] ?? 0) > 0 || f.split === k);

  return (
    <section className="ui-card fr-filters">
      <div className="fr-frow">
        <Popover width={290} trigger={
          <Button className="fr-fbtn" icon="tag" iconEnd="chevD">
            Классы{f.classes.length > 0 && <span className="fr-fcount">{f.classes.length}</span>}
          </Button>
        }>
          <div className="ui-pop-h">
            <span>Классы</span>
            <Button variant="ghost" size="sm" disabled={!classes.length}
              onClick={() => set({ classes: f.classes.length ? [] : classes.map((c) => c.class_index), empty: false })}>
              {f.classes.length ? "Снять все" : "Выбрать все"}
            </Button>
          </div>
          {classes.length === 0 && <p className="search-none">В проекте нет классов.</p>}
          <div className="fr-opts">
            {classes.map((c) => (
              <Check key={c.id} checked={f.classes.includes(c.class_index)} onChange={() => toggleClass(c.class_index)}>
                <Swatch color={c.color} />
                <span className="t-ell grow">{c.name}</span>
                <span className="ui-count" title="Рамок класса">{ru(c.annotations)}</span>
              </Check>
            ))}
          </div>
        </Popover>

        {splitKeys.length > 0 && (
          <Seg label="Сплит" value={f.split || "all"} onChange={(v) => set({ split: v === "all" ? "" : v })}
            options={[{ value: "all", label: "Все" },
              ...splitKeys.map((k) => ({ value: k, label: SPLIT_LABEL[k] }))]} />
        )}

        <Popover width={290} trigger={
          <Button className="fr-fbtn" icon="tags" iconEnd="chevD" disabled={!tags.length}
            title={tags.length ? undefined : "В проекте нет тагов"}>
            Таги{tagsOn.length > 0 && <span className="fr-fcount">{tagsOn.length}</span>}
          </Button>
        }>
          <div className="ui-pop-h"><span>Таги</span><span>нужен → исключить → неважно</span></div>
          {tags.map((t) => (
            <TriCheck key={t.id} value={f.tags[t.id] ?? null} onChange={(v) => setTag(t.id, v)} showState>
              {t.name}
            </TriCheck>
          ))}
        </Popover>

        <ChipToggle pressed={f.empty} onToggle={() => set({ empty: !f.empty, classes: [] })}
          title="Кадры без единой рамки">
          Без разметки
        </ChipToggle>

        <Input icon="search" className="fr-q" placeholder="Имя файла" aria-label="Имя файла" type="search"
          value={f.q} onChange={(e) => set({ q: e.target.value })} />
      </div>

      <div className="fr-sum">
        <span className="t-sm">
          Показано <b className="ui-mono">{matched === null ? "…" : ru(matched)}</b>{" "}
          <span className="t-muted">из {ru(total)} кадров</span>
        </span>
        {sum > 0 && (
          <>
            <span className="fr-strip" role="img"
              aria-label={strip.map((x) => `${x.c.name} ${Math.round((x.n / sum) * 100)} %`).join(", ")}>
              {strip.map((x) => <i key={x.c.id} style={{ flex: x.n, background: x.c.color }} title={x.c.name} />)}
            </span>
            <span className="t-xs t-muted">
              {strip.slice(0, 3).map((x) => `${x.c.name} ${Math.round((x.n / sum) * 100)} %`).join(" · ")}
            </span>
          </>
        )}
        <span className="grow" />
        {f.classes.map((i) => (
          <Chip key={`c${i}`} onRemove={() => toggleClass(i)} removeLabel={`Убрать класс ${byIndex.get(i)?.name ?? i}`}>
            <Swatch color={byIndex.get(i)?.color} />{byIndex.get(i)?.name ?? `класс ${i}`}
          </Chip>
        ))}
        {f.split && <Chip onRemove={() => set({ split: "" })} removeLabel="Убрать сплит">{SPLIT_LABEL[f.split] ?? f.split}</Chip>}
        {tagsOn.map(([id, v]) => (
          <Chip key={id} tone={v === "ex" ? "neg" : undefined} onRemove={() => setTag(id, null)}
            removeLabel={`Убрать таг ${tagName.get(id) ?? ""}`}>
            {v === "ex" ? "без тага" : "таг"} «{tagName.get(id) ?? "?"}»
          </Chip>
        ))}
        {f.empty && <Chip onRemove={() => set({ empty: false })} removeLabel="Убрать условие">без разметки</Chip>}
        {f.q.trim() && <Chip onRemove={() => set({ q: "" })} removeLabel="Убрать поиск"><Icon name="search" size={12} />{f.q.trim()}</Chip>}
        {hasFilters(f) && <Button variant="ghost" size="sm" onClick={() => set(NO_FILTERS)}>Сбросить</Button>}
      </div>
    </section>
  );
}
