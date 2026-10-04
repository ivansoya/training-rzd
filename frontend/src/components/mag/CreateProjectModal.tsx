import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createProject, getFriends } from "../../auth/api";
import type { FriendEntry } from "../../auth/api";
import { Avatar, Button, Check, Dialog, Field, Input, Notice, Select, Textarea } from "../../ui";

type Role = "editor" | "admin" | "viewer";

const ROLES: { value: Role; label: string }[] = [
  { value: "editor", label: "Редактор" },
  { value: "admin", label: "Администратор" },
  { value: "viewer", label: "Просмотр" },
];

/** Друзей больше — появляется поиск по ним. */
const SEARCH_FROM = 6;

const norm = (s: string) => s.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();

/** Новый проект: название, описание и сразу — кого из друзей позвать и с какой ролью. */
export default function CreateProjectModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (code: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [friends, setFriends] = useState<FriendEntry[] | null>(null);
  // Отмеченные друзья и их роли; роль помнится и после снятия отметки
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, Role>>({});
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    getFriends().then((f) => setFriends(f.friends)).catch(() => setFriends([]));
  }, []);

  const shown = useMemo(() => {
    const q = norm(query);
    return (friends ?? []).filter((f) => !q || norm(`${f.user.display_name} ${f.user.login}`).includes(q));
  }, [friends, query]);

  const toggle = (id: string, on: boolean) => setPicked((prev) => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

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
      const invites = [...picked].map((user_id) => ({ user_id, role: roles[user_id] ?? "editor" }));
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

      <section className="np-team">
        <div className="np-team-h">
          <div>
            <b>Пригласить участников</b>
            <p className="t-xs t-muted">Друзей — отсюда, остальных — по логину со страницы проекта.</p>
          </div>
          {(friends?.length ?? 0) > SEARCH_FROM && (
            <Input icon="search" className="np-search" type="search" placeholder="Найти друга" aria-label="Найти друга"
              value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
        </div>
        {friends === null ? (
          <p className="t-sm t-muted">Загружаем друзей…</p>
        ) : friends.length === 0 ? (
          <p className="np-none">Друзей пока нет — добавьте их в личном кабинете, и звать в проекты можно будет одним щелчком.</p>
        ) : shown.length === 0 ? (
          <p className="np-none">Никого не нашлось.</p>
        ) : (
          <ul className="np-friends">
            {shown.map((f) => {
              const on = picked.has(f.user.id);
              return (
                <li key={f.user.id} className={on ? "on" : undefined}>
                  <Check checked={on} onChange={(v) => toggle(f.user.id, v)}>
                    <Avatar name={f.user.display_name} size={28} />
                    <span className="np-who">
                      <b className="t-ell">{f.user.display_name}</b>
                      <span className="t-ell">{f.user.login}</span>
                    </span>
                  </Check>
                  <Select size="sm" label={`Роль: ${f.user.display_name}`} disabled={!on}
                    value={roles[f.user.id] ?? "editor"} options={ROLES}
                    onChange={(v) => setRoles((r) => ({ ...r, [f.user.id]: v }))} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Dialog>
  );
}
