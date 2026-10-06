// Наборы образцов «Сети по тексту»: окно сборки из разметки проекта и полоса миниатюр под строкой.
//
// Набор неизменяем (training_svc/examples.py): убрать, переставить и добрать создают новый набор,
// и строка черновика переходит на него. Иначе правка черновика меняла бы сохранённые версии агента.

import { useEffect, useMemo, useState, type DragEvent } from "react";
import * as api from "../../api/agents";
import { Button, Check, Dialog, Field, Input, Notice, Select, cx } from "../../ui";
import { NumInput } from "../NumInput";
import { count, plural, ru } from "../ru";

const COLLAGE_MAX = 8;

function usable(cls: api.ExampleSources["classes"][number], off: Set<string>) {
  let u = 0;
  let f = 0;
  for (const [id, s] of Object.entries(cls.datasets)) {
    if (off.has(id)) continue;
    u += s.usable;
    f += s.frames;
  }
  return { usable: u, frames: f };
}

export function ExamplesDialog({ onDone, onClose }: {
  onDone: (set: api.ExampleSet, agent: string) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<{ code: string; name: string }[] | null>(null);
  const [project, setProject] = useState("");
  const [src, setSrc] = useState<api.ExampleSources | null>(null);
  const [classId, setClassId] = useState("");
  const [off, setOff] = useState<Set<string>>(new Set());
  const [n, setN] = useState(32);
  const [collage, setCollage] = useState(6);
  const [ctx, setCtx] = useState(2.5);
  const [agent, setAgent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.previewProjects().then((r) => {
      setProjects(r.projects);
      if (r.projects[0]) setProject(r.projects[0].code);
    }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!project) return;
    setSrc(null);
    setOff(new Set());
    api.exampleSources(project).then((r) => {
      setSrc(r);
      const best = [...r.classes].sort((a, b) => usable(b, new Set()).usable - usable(a, new Set()).usable)[0];
      setClassId(best?.id ?? "");
    }).catch((e) => setError(e.message));
  }, [project]);

  const cls = src?.classes.find((c) => c.id === classId);
  const got = cls ? usable(cls, off) : { usable: 0, frames: 0 };
  const name = agent ?? cls?.name ?? "";

  const build = async () => {
    if (!cls || !src) return;
    setBusy(true);
    setError(null);
    try {
      const ids = src.datasets.map((d) => d.id).filter((id) => !off.has(id));
      const r = await api.createExamples({ project, class_id: cls.id, n, collage, ctx, datasets: off.size ? ids : null });
      onDone(r.set, name.trim() || cls.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const numField = (label: string, value: number, set: (v: number) => void, props: { min: number; max: number; step?: number; integer?: boolean }, hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => <NumInput id={id} className="ui-input ui-ctl ui-mono" value={value} disabled={busy} {...props} onValue={(v) => v !== undefined && set(v)} />}
    </Field>
  );

  return (
    // Пока собирается, окно не закрывается ничем: сборка уже идёт на сервере.
    <Dialog open onOpenChange={(v) => !v && onClose()} closable={!busy} width={640} title="Образцы из разметки"
      desc="Ручные рамки класса проекта — вырезками для YOLOE и коллажем для SAM 3"
      footer={<>
        {busy && <span className="t-xs t-muted">Собираю: рамки, вырезки, векторы YOLOE четырёх размеров…</span>}
        <span className="grow" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="images" disabled={busy || !cls || got.usable === 0} onClick={build}>{busy ? "Собираю…" : "Собрать"}</Button>
      </>}>
      <div className="ae-ex">
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        <div className="ae-ex-2">
          <Field label="Проект">
            {(id) => <Select id={id} full label="Проект" value={project || undefined} disabled={busy || !projects} placeholder="Загружаю…"
              onChange={(v) => { setProject(v); setAgent(null); }} options={(projects ?? []).map((p) => ({ value: p.code, label: p.name }))} />}
          </Field>
          <Field label="Класс проекта">
            {(id) => <Select id={id} full label="Класс проекта" value={classId || undefined} disabled={busy || !src} placeholder="Загружаю…"
              onChange={(v) => { setClassId(v); setAgent(null); }}
              options={(src?.classes ?? []).map((c) => ({ value: c.id, label: c.name, hint: count(usable(c, off).usable, "годная рамка", "годные рамки", "годных рамок") }))} />}
          </Field>
        </div>
        {src && src.datasets.length > 0 && (
          <Field label="Датасеты">
            {() => (
              <div className="ae-ex-ds">
                {src.datasets.map((d) => (
                  <Check key={d.id} checked={!off.has(d.id)} disabled={busy}
                    onChange={(on) => setOff((old) => {
                      const next = new Set(old);
                      if (on) next.delete(d.id); else next.add(d.id);
                      return next;
                    })}>
                    {d.name} <span className="ui-mono t-faint">{count(d.frames, "кадр", "кадра", "кадров")}</span>
                  </Check>
                ))}
              </div>
            )}
          </Field>
        )}
        <div className="ae-ex-3">
          {numField("Образцов", n, setN, { min: 1, max: 256, integer: true })}
          {numField("В коллаже SAM 3", collage, setCollage, { min: 1, max: COLLAGE_MAX, integer: true })}
          {numField("Вырезка, ×", ctx, setCtx, { min: 1, max: 16, step: 0.5 }, "Поле вокруг рамки")}
        </div>
        <Field label="Класс агента" hint="Под этим именем находки уйдут дальше по графу">
          {(id) => <Input id={id} value={name} disabled={busy} onChange={(e) => setAgent(e.target.value)} />}
        </Field>
        {cls && (
          <p className="t-sm t-muted">
            Годится <b className="ui-mono">{ru(got.usable)}</b> {plural(got.usable, "ручная рамка", "ручные рамки", "ручных рамок")} на{" "}
            <b className="ui-mono">{ru(got.frames)}</b> {plural(got.frames, "кадре", "кадрах", "кадрах")}
            {got.usable === 0 ? null : n > got.usable
              ? <span className="ge-warn"> — возьмём все {ru(got.usable)}</span>
              : n > got.frames ? ` — ${ru(n - got.frames)} придётся брать вторыми с тех же кадров`
                : ` — по одной с ${ru(n)} ${plural(n, "кадра", "разных кадров", "разных кадров")}`}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Полоса миниатюр набора. Первые `collage` идут в коллаж SAM 3 — они обведены; порядок меняется перетаскиванием. */
export function ExampleStrip({ set, readOnly, onSet }: {
  set: api.ExampleSet;
  readOnly: boolean;
  onSet: (next: api.ExampleSet) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const collage = Math.min(set.params.collage, set.items.length);
  const uids = useMemo(() => set.items.map((it) => it.uid), [set]);

  const derive = async (body: { order?: string[]; add?: number }) => {
    setBusy(true);
    setError(null);
    try {
      onSet((await api.deriveExamples(set.id, body)).set);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const drop = (to: number) => (e: DragEvent) => {
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

  return (
    <div className="ae-strip">
      <div className="ae-thumbs">
        {set.items.map((it, k) => (
          <div key={it.uid} className={cx("ae-th", k < collage && "col", drag === k && "drag", over === k && "over")}
            draggable={!readOnly && !busy} title={`${it.file_name} — ${it.side} px`}
            onDragStart={() => setDrag(k)}
            onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(k); } }}
            onDragLeave={() => setOver((o) => (o === k ? null : o))}
            onDrop={drop(k)}
            onDragEnd={() => { setDrag(null); setOver(null); }}>
            <img src={api.exampleCrop(set.id, it.uid)} alt={`образец ${k + 1}`} loading="lazy" draggable={false} />
            <span className="n">{k + 1}</span>
            {!readOnly && set.items.length > 1 && (
              <button type="button" className="rm" disabled={busy} aria-label={`Убрать образец ${k + 1}`}
                onClick={() => derive({ order: uids.filter((u) => u !== it.uid) })}>×</button>
            )}
          </div>
        ))}
      </div>
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
      <div className="ae-strip-f">
        <span className="t-ell">
          {set.project} · {count(set.items.length, "рамка", "рамки", "рамок")} с {ru(set.frames)} {plural(set.frames, "кадра", "кадров", "кадров")} · ×{String(set.params.ctx).replace(".", ",")}
        </span>
        <span className="ae-strip-lg"><i />в коллаже SAM 3: {collage} из {set.items.length}</span>
        <span className="grow" />
        {!readOnly && <Button size="sm" variant="ghost" icon="plus" disabled={busy} onClick={() => derive({ add: 4 })}>{busy ? "…" : "Добрать 4"}</Button>}
      </div>
    </div>
  );
}
