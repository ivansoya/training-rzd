// Окно сборки набора образцов «Сети по тексту» из ручной разметки проекта.
//
// Набор неизменяем (training_svc/examples.py): убрать, переставить и добрать создают новый набор,
// и строка черновика переходит на него. Иначе правка черновика меняла бы сохранённые версии агента.
// Вырезка всегда «авто», и SAM 3 берёт все образцы набора — лишние идут следующими проходами.

import { useEffect, useState } from "react";
import * as api from "../../api/agents";
import { Button, Check, Dialog, Field, Input, Notice, Select } from "../../ui";
import { NumInput } from "../NumInput";
import { count, plural, ru } from "../ru";
import type { TextModel } from "./agentDoc";

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

export function ExamplesDialog({ model, preset, agentName, onDone, onClose }: {
  model: TextModel;
  /** Проект (код) и класс проекта, выбранные заранее: карточка класса-ссылки. */
  preset?: { project?: string; classId?: string };
  /** Класс агента уже известен (окно открыто из карточки) — поля имени нет. */
  agentName?: string;
  onDone: (set: api.ExampleSet, agent: string) => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<{ code: string; name: string }[] | null>(null);
  const [project, setProject] = useState("");
  const [src, setSrc] = useState<api.ExampleSources | null>(null);
  const [classId, setClassId] = useState("");
  const [off, setOff] = useState<Set<string>>(new Set());
  // SAM 3 берёт все образцы: 6 — один ряд за проход. YOLOE сводит набор в средний вектор — ему больше лучше.
  const [n, setN] = useState(model === "sam3" ? 6 : 32);
  const [agent, setAgent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.previewProjects().then((r) => {
      setProjects(r.projects);
      const want = preset?.project && r.projects.some((p) => p.code === preset.project) ? preset.project : r.projects[0]?.code;
      if (want) setProject(want);
    }).catch((e) => setError(e.message));
    // Заготовка читается один раз, при открытии окна.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!project) return;
    setSrc(null);
    setOff(new Set());
    api.exampleSources(project).then((r) => {
      setSrc(r);
      const best = [...r.classes].sort((a, b) => usable(b, new Set()).usable - usable(a, new Set()).usable)[0];
      setClassId(r.classes.some((c) => c.id === preset?.classId) ? preset!.classId! : best?.id ?? "");
    }).catch((e) => setError(e.message));
  }, [project, preset?.classId]);

  const cls = src?.classes.find((c) => c.id === classId);
  const got = cls ? usable(cls, off) : { usable: 0, frames: 0 };
  const name = agentName ?? agent ?? cls?.name ?? "";

  const build = async () => {
    if (!cls || !src) return;
    setBusy(true);
    setError(null);
    try {
      const ids = src.datasets.map((d) => d.id).filter((id) => !off.has(id));
      const r = await api.createExamples({ project, class_id: cls.id, n, datasets: off.size ? ids : null });
      onDone(r.set, name.trim() || cls.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    // Пока собирается, окно не закрывается ничем: сборка уже идёт на сервере.
    <Dialog open onOpenChange={(v) => !v && onClose()} closable={!busy} width={640} title="Образцы из разметки"
      desc={agentName ? `Ручные рамки класса проекта — образцами для класса «${agentName}»` : "Ручные рамки класса проекта — вырезками для YOLOE и коллажем для SAM 3"}
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
        <div className="ae-ex-2">
          <Field label="Образцов" hint={model === "sam3" ? "SAM 3 берёт все: 6 — ряд, каждые следующие 12 (на тайлах 6) — ещё проход" : "YOLOE сводит набор в один средний вектор"}>
            {(id) => <NumInput id={id} className="ui-input ui-ctl ui-mono" value={n} disabled={busy} min={1} max={256} integer
              onValue={(v) => v !== undefined && setN(v)} />}
          </Field>
          {agentName === undefined && (
            <Field label="Класс агента" hint="Под этим именем находки уйдут дальше по графу">
              {(id) => <Input id={id} value={name} disabled={busy} onChange={(e) => setAgent(e.target.value)} />}
            </Field>
          )}
        </div>
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
