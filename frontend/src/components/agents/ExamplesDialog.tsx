// Наборы образцов «Сети по тексту»: окно сборки из разметки проекта и полоса
// миниатюр под строкой.
//
// Набор неизменяем (training_svc/examples.py): убрать, переставить и добрать
// создают новый набор, и строка черновика переходит на него. Иначе правка
// черновика незаметно меняла бы уже сохранённые версии агента.

import { useEffect, useMemo, useState, type DragEvent } from "react";
import * as api from "../../api/agents";
import Sep from "../Sep";
import { useBackdrop } from "../useBackdrop";

const COLLAGE_MAX = 8;

export function ExamplesDialog({
  onDone,
  onClose,
}: {
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
      const r = await api.createExamples({
        project, class_id: cls.id, n, collage, ctx,
        datasets: off.size ? ids : null,
      });
      onDone(r.set, name.trim() || cls.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mag-backdrop" {...useBackdrop(busy ? () => undefined : onClose)}>
      <div className="mag-modal ag-exdlg" onClick={(e) => e.stopPropagation()}>
        <h1>Образцы из разметки</h1>
        {error && <div className="mag-error">{error}</div>}
        <div className="ag-two">
          <div className="mag-field">
            <label htmlFor="ex-project">Проект</label>
            <select id="ex-project" value={project} disabled={busy || !projects}
              onChange={(e) => { setProject(e.target.value); setAgent(null); }}>
              {projects?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </div>
          <div className="mag-field">
            <label htmlFor="ex-class">Класс проекта</label>
            <select id="ex-class" value={classId} disabled={busy || !src}
              onChange={(e) => { setClassId(e.target.value); setAgent(null); }}>
              {src?.classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name} — {usable(c, off).usable} рамок</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mag-field">
          <label>Датасеты</label>
          <div className="ag-exds">
            {src?.datasets.map((d) => (
              <label key={d.id}>
                <input type="checkbox" checked={!off.has(d.id)} disabled={busy}
                  onChange={(e) => setOff((old) => {
                    const next = new Set(old);
                    if (e.target.checked) next.delete(d.id); else next.add(d.id);
                    return next;
                  })} />
                {d.name}
                <span className="mono">{d.frames} кадров</span>
              </label>
            ))}
          </div>
        </div>
        <div className="ag-three">
          <div className="mag-field ag-num">
            <label htmlFor="ex-n">Образцов</label>
            <input id="ex-n" type="number" min={1} max={256} value={n} disabled={busy}
              onChange={(e) => setN(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <div className="mag-field ag-num">
            <label htmlFor="ex-collage">В коллаже SAM 3</label>
            <input id="ex-collage" type="number" min={1} max={COLLAGE_MAX} value={collage} disabled={busy}
              onChange={(e) => setCollage(Math.min(COLLAGE_MAX, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
          <div className="mag-field ag-num">
            <label htmlFor="ex-ctx">Вырезка, ×</label>
            <input id="ex-ctx" type="number" min={1} max={16} step={0.5} value={ctx} disabled={busy}
              onChange={(e) => setCtx(Math.min(16, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
        </div>
        <div className="mag-field">
          <label htmlFor="ex-agent">Класс агента</label>
          <input id="ex-agent" value={name} disabled={busy} onChange={(e) => setAgent(e.target.value)} />
        </div>
        {cls && (
          <p className="ag-exnote">
            Годится <b className="mono">{got.usable}</b> ручных рамок на <b className="mono">{got.frames}</b> кадрах
            {got.usable === 0 ? null : n > got.usable
              ? <span className="ag-warn-text"> — возьмём все {got.usable}</span>
              : n > got.frames ? ` — ${n - got.frames} придётся брать вторыми с тех же кадров`
                : ` — по одной с ${n} разных кадров`}
          </p>
        )}
        <div className="ag-foot">
          {busy && <span className="ag-muted">Собираю: рамки, вырезки, векторы YOLOE четырёх размеров…</span>}
          <span className="ag-grow" />
          <button type="button" className="mag-ghost" disabled={busy} onClick={onClose}>Отмена</button>
          <button type="button" className="mag-btn" disabled={busy || !cls || got.usable === 0} onClick={build}>
            {busy ? "Собираю…" : "Собрать"}
          </button>
        </div>
      </div>
    </div>
  );
}

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

/** Полоса миниатюр набора. Первые `collage` идут в коллаж SAM 3 — они
 *  обведены; порядок меняется перетаскиванием. */
export function ExampleStrip({
  set,
  readOnly,
  onSet,
}: {
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
    <div className="ag-strip">
      <div className="ag-thumbs">
        {set.items.map((it, k) => (
          <div
            key={it.uid}
            className={`ag-th${k < collage ? " col" : ""}${drag === k ? " drag" : ""}${over === k ? " over" : ""}`}
            draggable={!readOnly && !busy}
            title={`${it.file_name} · ${it.side} px`}
            onDragStart={() => setDrag(k)}
            onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(k); } }}
            onDragLeave={() => setOver((o) => (o === k ? null : o))}
            onDrop={drop(k)}
            onDragEnd={() => { setDrag(null); setOver(null); }}
          >
            <img src={api.exampleCrop(set.id, it.uid)} alt={`образец ${k + 1}`} loading="lazy" />
            <span className="n">{k + 1}</span>
            {!readOnly && set.items.length > 1 && (
              <button type="button" className="rm" disabled={busy} aria-label={`Убрать образец ${k + 1}`}
                onClick={() => derive({ order: uids.filter((u) => u !== it.uid) })}>×</button>
            )}
          </div>
        ))}
      </div>
      {error && <div className="mag-error">{error}</div>}
      <div className="ag-strip-foot">
        <span className="ag-strip-src">
          {set.project} <Sep /> {set.items.length} рамок с {set.frames} кадров <Sep /> ×{String(set.params.ctx).replace(".", ",")}
        </span>
        <span className="ag-lg"><i />в коллаже SAM 3: {collage} из {set.items.length}</span>
        <span className="ag-grow" />
        {!readOnly && (
          <button type="button" className="mag-ghost ag-sm" disabled={busy} onClick={() => derive({ add: 4 })}>
            {busy ? "…" : "Добрать 4"}
          </button>
        )}
      </div>
    </div>
  );
}
