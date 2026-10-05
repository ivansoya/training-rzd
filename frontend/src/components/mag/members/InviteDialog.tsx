import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getFriends, inviteToProject } from "../../../auth/api";
import type { FriendEntry } from "../../../auth/api";
import { Button, Dialog, Field, Input, Notice, Select } from "../../../ui";
import { FriendPicker, ROLES, useFriendPick } from "../FriendPicker";
import type { Role } from "../FriendPicker";

/** Приглашение по логину или почте и друзей флажками — одной кнопкой. */
export function InviteDialog({ code, taken, onClose, onSent }: {
  code: string;
  /** Уже в проекте или приглашены — среди друзей их не показываем. */
  taken: Set<string>;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const [identity, setIdentity] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [friends, setFriends] = useState<FriendEntry[] | null>(null);
  const pick = useFriendPick();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    getFriends().then((f) => setFriends(f.friends)).catch(() => setFriends([]));
  }, []);

  const free = friends?.filter((f) => !taken.has(f.user.id)) ?? null;
  const chosen = (free ?? []).filter((f) => pick.picked.has(f.user.id));
  const total = chosen.length + (identity.trim() ? 1 : 0);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy || total === 0) return;
    setBusy(true);
    setFailed([]);
    const errors: string[] = [];
    const who = identity.trim();
    if (who) {
      try {
        await inviteToProject(code, who, role);
        setIdentity("");
      } catch (err) {
        errors.push(`${who}: ${(err as Error).message}`);
      }
    }
    for (const f of chosen) {
      try {
        await inviteToProject(code, f.user.login, pick.roleOf(f.user.id));
        pick.toggle(f.user.id, false);
      } catch (err) {
        errors.push(`${f.user.display_name}: ${(err as Error).message}`);
      }
    }
    await onSent().catch(() => undefined);
    setBusy(false);
    // Ушедшие приглашения уже на странице; окно остаётся только ради неудавшихся
    if (errors.length) setFailed(errors);
    else onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={560} modalLock={total > 0}
      title="Пригласить в проект"
      desc="Приглашение появится у человека на странице «Проекты» — он решит сам."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="invite" disabled={busy || total === 0} onClick={() => submit()}>
          {busy ? "Отправляем…" : total > 1 ? `Пригласить (${total})` : "Пригласить"}
        </Button>
      </>}>
      <form className="stack-v np-form" onSubmit={submit}>
        {failed.length > 0 && (
          <Notice tone="error" onClose={() => setFailed([])}>
            Не отправлено:
            <ul className="mem-fail">{failed.map((f) => <li key={f}>{f}</li>)}</ul>
          </Notice>
        )}
        <Field label="Логин или почта" hint="Для тех, кого нет в друзьях.">
          {(id) => (
            <div className="mem-who">
              <Input id={id} value={identity} maxLength={255} placeholder="ivan или ivan@mail.ru" data-autofocus
                autoComplete="off" onChange={(e) => setIdentity(e.target.value)} />
              <Select label="Роль" value={role} options={ROLES} onChange={setRole} />
            </div>
          )}
        </Field>
        {/* Enter в поле отправляет приглашения */}
        <button type="submit" hidden />
      </form>

      <FriendPicker friends={free} pick={pick} title="Друзья" hint="Те, кого ещё нет в проекте."
        empty={friends?.length
          ? "Все друзья уже в проекте или приглашены."
          : "Друзей пока нет — добавьте их в личном кабинете, и звать в проекты можно будет одним щелчком."} />
    </Dialog>
  );
}
