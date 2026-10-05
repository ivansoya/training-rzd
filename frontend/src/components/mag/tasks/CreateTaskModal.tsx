// Окно «Новая таска»: название, исполнитель, датасет для готовых кадров.

import { useState } from "react";
import type { FormEvent } from "react";
import { createTask } from "../../../auth/api";
import { useProject } from "../ProjectShell";
import { count } from "../../ru";
import { Button, Dialog, Field, Input, Notice, Select } from "../../../ui";

export function CreateTaskModal({
  isAdmin,
  onClose,
  onCreated,
}: {
  isAdmin: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { detail } = useProject();
  const [name, setName] = useState("");
  // Radix не принимает пустое значение: «me» и «new» — «я сам» и «новый датасет»
  const [assignee, setAssignee] = useState("me");
  const [dataset, setDataset] = useState("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(detail.project.code, {
        name: name.trim(),
        assignee_id: assignee === "me" ? null : assignee,
        target_dataset_id: dataset === "new" ? null : dataset,
      });
      onCreated(task.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const people = isAdmin ? detail.members.filter((m) => m.role !== "viewer") : [];
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={520}
      title="Новая таска" desc="Кадры попадут в проект, когда вы переведёте таску в «Готово»."
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => submit()}>Создать и загрузить кадры</Button>
        </>
      }>
      <form className="stack-v" style={{ gap: 14 }} onSubmit={submit}>
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        <Field label="Название">
          {(id) => <Input id={id} value={name} placeholder="Съёмка 12 августа" maxLength={255} data-autofocus
            onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Исполнитель" hint={isAdmin ? undefined : "Назначать других может администратор."}>
          {(id) => <Select id={id} full value={assignee} onChange={setAssignee} disabled={!isAdmin} label="Исполнитель"
            options={[{ value: "me", label: "Я сам" },
              ...people.map((m) => ({ value: m.id, label: m.display_name, hint: m.role_label }))]} />}
        </Field>
        <Field label="Готовые кадры пойдут в датасет" hint="Спрашиваем один раз: на «Готово» вопросов больше не будет.">
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
