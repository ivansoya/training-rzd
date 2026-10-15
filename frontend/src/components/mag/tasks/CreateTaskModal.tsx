// Окно «Новая таска»: название, исполнители, датасет для готовых кадров.
// Из датасета (решения 14.10.2026) — то же окно с плашкой: какие кадры уйдут копиями и сколько пропустим.

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { createTask } from "../../../auth/api";
import { takePreview } from "../../../api/gallery";
import type { TakePreview } from "../../../api/gallery";
import { useAuth } from "../../auth/AuthGate";
import { useProject } from "../ProjectShell";
import { count, ru } from "../../ru";
import { Badge, Button, Dialog, Field, Icon, Input, Notice, Select } from "../../../ui";
import { TeamPicker } from "./Team";

export function CreateTaskModal({
  isAdmin,
  onClose,
  onCreated,
  fromDataset,
}: {
  isAdmin: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Кадры датасета, которые уйдут в таску копиями. */
  fromDataset?: string[];
}) {
  const { detail } = useProject();
  const { me } = useAuth();
  const [name, setName] = useState("");
  // По умолчанию — автор; никого не выбрать — таска ничья, с очереди её возьмёт любой редактор
  const [team, setTeam] = useState<string[]>([me.user.id]);
  // Radix не принимает пустое значение: «new» — новый датасет
  const [dataset, setDataset] = useState("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TakePreview | null>(null);

  useEffect(() => {
    if (!fromDataset) return;
    let alive = true;
    takePreview(detail.project.code, fromDataset)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [detail.project.code, fromDataset]);

  // Из датасета брать нечего — все выбранные кадры уже в других тасках
  const nothing = !!fromDataset && preview !== null && preview.take === 0;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !name.trim() || nothing || (fromDataset && !preview)) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(detail.project.code, {
        name: name.trim(),
        assignees: team,
        target_dataset_id: dataset === "new" ? null : dataset,
        ...(fromDataset ? { image_ids: fromDataset } : {}),
      });
      onCreated(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Других назначает админ; редактор — только себя или никого
  const people = detail.members.filter((m) => m.role !== "viewer" && (isAdmin || m.id === me.user.id));
  const skipped = preview?.busy.reduce((a, b) => a + b.n, 0) ?? 0;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={540}
      title="Новая таска"
      desc={fromDataset ? "Правки лягут в датасет, когда таску переведут в «Готово»."
        : "Кадры попадут в проект, когда вы переведёте таску в «Готово»."}
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy || !name.trim() || nothing || (!!fromDataset && !preview)}
            onClick={() => submit()}>
            {fromDataset ? "Создать таску" : "Создать и загрузить кадры"}
          </Button>
        </>
      }>
      <form className="stack-v" style={{ gap: 14 }} onSubmit={submit}>
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        {fromDataset && (
          <section className="ct-from" aria-label="Кадры из датасета">
            <div className="ct-from-h">
              <Icon name="database" size={15} />
              <b>{preview ? `Из датасета: ${count(preview.take, "кадр", "кадра", "кадров")}` : "Считаю кадры…"}</b>
              <span className="grow" />
              <span className="t-xs t-faint">копиями</span>
            </div>
            {preview && preview.by_dataset.length > 0 && (
              <div className="row wrap">
                {preview.by_dataset.map((d) => <Badge key={d.id}>{d.name} · {ru(d.n)}</Badge>)}
              </div>
            )}
            {skipped > 0 && (
              <Notice tone="warn">
                {nothing ? "Все выбранные кадры уже в тасках" : `Пропущено ${ru(skipped)} — уже в тасках`}:{" "}
                {preview!.busy.map((b, i) => (
                  <span key={b.task_id}>{i > 0 && ", "}
                    <Link className="fe-link" to={`/projects/${detail.project.code}/tasks/${b.task_id}`}>{b.name}</Link> · {ru(b.n)}
                  </span>
                ))}
              </Notice>
            )}
          </section>
        )}
        <Field label="Название">
          {(id) => <Input id={id} value={name} placeholder="Съёмка 12 августа" maxLength={255} data-autofocus
            onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Исполнители" aside={team.length ? undefined : "ничья"}>
          {() => <TeamPicker people={people} value={team} onChange={setTeam} />}
        </Field>
        <Field label={fromDataset ? "Новые кадры пойдут в датасет" : "Готовые кадры пойдут в датасет"}
          hint="Спрашиваем один раз: на «Готово» вопросов больше не будет.">
          {(id) => <Select id={id} full value={dataset} onChange={setDataset} label="Датасет для готовых кадров"
            options={[{ value: "new", label: "Новый, с именем таски", hint: name.trim() ? `«${name.trim()}»` : "имя появится вместе с названием таски" },
              ...detail.datasets.map((d) => ({ value: d.id, label: d.name, hint: count(d.images_count, "кадр", "кадра", "кадров") }))]} />}
        </Field>
        {/* Enter в названии создаёт таску */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
