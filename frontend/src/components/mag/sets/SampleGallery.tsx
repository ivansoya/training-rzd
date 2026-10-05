// Образцы набора: группы train и val, отбор по классам, оригиналам и копиям графа, просмотр поверх.

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as aug from "../../../api/aug";
import * as setsApi from "../../../api/trainsets";
import type { Sample, SamplesTally, SetClass } from "../../../api/trainsets";
import { Button, Check, Chip, ChipToggle, Icon, Popover, Seg, Swatch, cx } from "../../../ui";
import { count, ru } from "../../ru";
import ShapeMini from "../ShapeMini";
import { useGroupFrames } from "../frames/useGroupFrames";
import { SampleLightbox, pathText } from "./SampleLightbox";
import { TRAIN, VAL } from "./sets";

type Part = "train" | "val";
type Kind = "all" | "orig" | "copy";

interface Look { part: "all" | Part; kind: Kind; classes: number[]; empty: boolean }
const NONE: Look = { part: "all", kind: "all", classes: [], empty: false };

export function SampleGallery({ code, setId, classes, tally }: {
  code: string;
  setId: string;
  classes: SetClass[];
  tally: SamplesTally | null;
}) {
  const [f, setF] = useState<Look>(NONE);
  const set = (patch: Partial<Look>) => setF((old) => ({ ...old, ...patch }));
  const [matched, setMatched] = useState<Record<Part, number | null>>({ train: null, val: null });
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    aug.catalogue()
      .then((c) => setNames(new Map([["Mosaic", "Слияние сеткой"], ...c.nodes.map((n) => [n.op, n.name] as [string, string])])))
      .catch(() => undefined);
  }, []);

  const byId = new Map(classes.map((c) => [c.export_id, c]));
  const toggle = (i: number) => set({ classes: f.classes.includes(i) ? f.classes.filter((x) => x !== i) : [...f.classes, i], empty: false });
  const parts: Part[] = f.part === "all" ? ["train", "val"] : [f.part];
  const shown = parts.reduce((a, p) => a + (matched[p] ?? 0), 0);
  const known = parts.every((p) => matched[p] !== null);
  const total = tally ? tally.train + tally.val : null;
  const dirty = f.part !== "all" || f.kind !== "all" || f.classes.length > 0 || f.empty;
  const onMatched = useCallback((p: Part, n: number | null) => setMatched((old) => (old[p] === n ? old : { ...old, [p]: n })), []);

  return (
    <section className="ui-card ts-gal">
      <div className="fr-frow">
        <Seg label="Половина" value={f.part} onChange={(v) => set({ part: v })} options={[
          { value: "all", label: "Все" },
          { value: "train", label: <>train {tally && <span className="ui-count">{ru(tally.train)}</span>}</> },
          { value: "val", label: <>val {tally && <span className="ui-count">{ru(tally.val)}</span>}</> },
        ]} />
        {tally && tally.copy > 0 && (
          <Seg label="Оригиналы и копии" value={f.kind} onChange={(v) => set({ kind: v })} options={[
            { value: "all", label: "Все образцы" },
            { value: "orig", label: <>Оригиналы <span className="ui-count">{ru(tally.orig)}</span></>, title: "Кадры, легшие в набор как есть" },
            { value: "copy", label: <>Копии графа <span className="ui-count">{ru(tally.copy)}</span></>, title: "Образцы, к которым граф что-то применил" },
          ]} />
        )}
        <Popover width={290} trigger={
          <Button className="fr-fbtn" icon="tag" iconEnd="chevD" disabled={!classes.length}>
            Классы{f.classes.length > 0 && <span className="fr-fcount">{f.classes.length}</span>}
          </Button>
        }>
          <div className="ui-pop-h">
            <span>Классы набора</span>
            <Button variant="ghost" size="sm" onClick={() => set({ classes: f.classes.length ? [] : classes.map((c) => c.export_id), empty: false })}>
              {f.classes.length ? "Снять все" : "Выбрать все"}
            </Button>
          </div>
          <div className="fr-opts">
            {classes.map((c) => (
              <Check key={c.export_id} checked={f.classes.includes(c.export_id)} onChange={() => toggle(c.export_id)}>
                <Swatch color={c.color} />
                <span className="t-ell grow">{c.name}</span>
                <span className="ui-count" title="Объектов в файлах разметки">{ru(c.annotations)}</span>
              </Check>
            ))}
          </div>
        </Popover>
        {(tally?.empty ?? 0) > 0 && (
          <ChipToggle pressed={f.empty} onToggle={() => set({ empty: !f.empty, classes: [] })} count={ru(tally?.empty ?? 0)}
            title="Кадры-фон: пустой файл разметки">Без разметки</ChipToggle>
        )}
      </div>
      <div className="fr-sum">
        <span className="t-sm">
          Показано <b className="ui-mono">{known ? ru(shown) : "…"}</b>{total !== null && <span className="t-muted"> из {ru(total)} образцов</span>}
        </span>
        <span className="grow" />
        {f.classes.map((i) => (
          <Chip key={i} onRemove={() => toggle(i)} removeLabel={`Убрать класс ${byId.get(i)?.name ?? i}`}>
            <Swatch color={byId.get(i)?.color} />{byId.get(i)?.name ?? `класс ${i}`}
          </Chip>
        ))}
        {f.empty && <Chip onRemove={() => set({ empty: false })} removeLabel="Убрать условие">без разметки</Chip>}
        {dirty && <Button variant="ghost" size="sm" onClick={() => setF(NONE)}>Сбросить</Button>}
      </div>
      <div className="ts-groups">
        {parts.map((p) => <SampleGroup key={p} part={p} code={code} setId={setId} look={f} names={names} onMatched={onMatched} />)}
      </div>
    </section>
  );
}

function SampleGroup({ part, code, setId, look, names, onMatched }: {
  part: Part; code: string; setId: string; look: Look; names: Map<string, string>;
  onMatched: (p: Part, n: number | null) => void;
}) {
  const [shut, setShut] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const load = useCallback(async (offset: number, limit: number) => {
    const got = await setsApi.samples(code, setId, {
      split: part, classes: look.classes, empty: look.empty, kind: look.kind === "all" ? undefined : look.kind, offset, limit,
    });
    return { items: got.samples, matched: got.matched };
  }, [code, setId, part, look]);
  const key = `${part}|${look.kind}|${look.classes.join(",")}|${look.empty}`;
  const g = useGroupFrames<Sample>(load, key);
  useEffect(() => { onMatched(part, g.matched); }, [part, g.matched, onMatched]);
  const total = g.matched ?? 0;
  const rest = total - g.items.length;
  const src = useMemo(() => (s: Sample) => setsApi.sampleUrl(code, setId, s.file), [code, setId]);
  const copies = g.items.filter((s) => s.ops.length).length;

  return (
    <section className={cx("fr-g", shut && "col")}>
      <header className="fr-gh">
        <button type="button" className="fr-gt" aria-expanded={!shut} onClick={() => setShut(!shut)}>
          <Icon name="chevD" className="fr-chev" />
          <i className="ts-dot" style={{ background: part === "train" ? TRAIN : VAL }} />
          <b>{part}</b>
          <span className="ui-mono t-xs t-muted">{g.matched === null ? "…" : count(total, "образец", "образца", "образцов")}</span>
        </button>
        {g.loading && <span className="t-xs t-faint">загружаю…</span>}
        {!g.loading && copies > 0 && look.kind === "all" && <span className="t-xs t-faint">среди показанных копий графа — {ru(copies)}</span>}
      </header>
      <div className="fr-body">
        <div className="fr-in">
          {g.error ? <p className="fr-note err">{g.error}</p>
            : g.matched === 0 ? <p className="fr-note">Под отбор не подошёл ни один образец.</p> : (
              <div className="ts-grid">
                {g.items.map((s, i) => <SampleTile key={s.file} s={s} src={src(s)} onOpen={() => setViewer(i)} />)}
                {rest > 0 && (
                  <button type="button" className="fr-tile fr-more" disabled={g.loading} onClick={() => g.more()}
                    title={`Показать ещё ${ru(Math.min(200, rest))} из ${ru(rest)}`}>
                    {g.items.length > 0 && <img src={src(g.items[g.items.length - 1])} alt="" loading="lazy" />}
                    <span className="fr-more-in"><b className="ui-mono">+{ru(rest)}</b><span>{g.loading ? "загружаю…" : "показать ещё"}</span></span>
                  </button>
                )}
              </div>
            )}
        </div>
      </div>
      {viewer !== null && g.items[viewer] && createPortal(
        <SampleLightbox items={g.items} index={viewer} total={total} src={src} code={code} names={names}
          onIndex={setViewer} onClose={() => setViewer(null)} onNeedMore={() => g.more()} />,
        document.body,
      )}
    </section>
  );
}

const SampleTile = memo(function SampleTile({ s, src, onOpen }: { s: Sample; src: string; onOpen: () => void }) {
  const copy = s.ops.length > 0;
  return (
    <button type="button" className="fr-tile" onClick={onOpen}
      title={`${s.source_name ?? s.name} — ${count(s.objects, "объект", "объекта", "объектов")}${copy && s.sid ? ` · ${pathText(s.sid)}` : ""}`}>
      <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      <ShapeMini boxes={s.boxes} width={s.width} height={s.height} />
      <span className={cx("fr-split", copy && "ts-copy")}>{copy ? "копия" : "оригинал"}</span>
      <span className="fr-name">{(s.source_name ?? s.name).replace(/\.[^.]+$/, "")}</span>
    </button>
  );
});
