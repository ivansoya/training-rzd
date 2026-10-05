import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createProject, getFriends } from "../../auth/api";
import type { FriendEntry } from "../../auth/api";
import { Button, Dialog, Field, Input, Notice, Textarea } from "../../ui";
import { FriendPicker, useFriendPick } from "./FriendPicker";

/** Новый проект: название, описание и сразу — кого из друзей позвать и с какой ролью. */
export default function CreateProjectModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [friends, setFriends] = useState<FriendEntry[] | null>(null);
  const pick = useFriendPick();
  const { picked } = pick;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    getFriends().then((f) => setFriends(f.friends)).catch(() => setFriends([]));
  }, []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setFields({ name: "Укажите название проекта." });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const invites = [...picked].map((user_id) => ({ user_id, role: pick.roleOf(user_id) }));
      const { code } = await createProject({ name: name.trim(), description: description.trim(), invites });
      onCreated(code);
    } catch (err) {
      if (err instanceof ApiError && err.fields) setFields(err.fields);
      else setError((err as Error).message);
      setBusy(false);
    }
  }

  // Набранное жалко терять: щелчок мимо окна его не закрывает
  const dirty = Boolean(name.trim() || description.trim() || picked.size);

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={560} modalLock={dirty}
      title="Новый проект"
      desc="Код проекта присвоится сам. Данные добавите на странице проекта — импортом архива или через таски."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={busy} onClick={() => submit()}>
          {busy ? "Создаём…" : picked.size ? `Создать и пригласить (${picked.size})` : "Создать проект"}
        </Button>
      </>}>
      <form className="stack-v np-form" onSubmit={submit}>
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        <Field label="Название" error={fields.name}>
          {(id) => (
            <Input id={id} value={name} maxLength={255} placeholder="Варан КЗТ" data-autofocus invalid={Boolean(fields.name)}
              onChange={(e) => {
                setName(e.target.value);
                if (fields.name) setFields(({ name: _drop, ...rest }) => rest);
              }} />
          )}
        </Field>
        <Field label="Описание" error={fields.description} hint="Необязательно: что размечаем и зачем.">
          {(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        {/* Enter в названии создаёт проект */}
        <button type="submit" hidden />
      </form>

      <FriendPicker friends={friends} pick={pick} title="Пригласить участников"
        hint="Друзей — отсюда, остальных — по логину со страницы проекта."
        empty="Друзей пока нет — добавьте их в личном кабинете, и звать в проекты можно будет одним щелчком." />
    </Dialog>
  );
}
