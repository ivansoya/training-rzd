import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { FriendEntry } from "../../auth/api";
import { Avatar, Check, Input, Select } from "../../ui";
import type { SelectOption } from "../../ui";

export type Role = "editor" | "admin" | "viewer";

export const ROLES: SelectOption<Role>[] = [
  { value: "editor", label: "Редактор", hint: "Размечает кадры, ведёт таски, правит классы" },
  { value: "admin", label: "Администратор", hint: "Плюс импорт, обучение и состав проекта" },
  { value: "viewer", label: "Просмотр", hint: "Смотрит данные и результаты, ничего не меняет" },
];

/** Друзей больше — появляется поиск по ним. */
const SEARCH_FROM = 6;

const norm = (s: string) => s.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();

/** Отмеченные друзья и их роли; роль помнится и после снятия отметки. */
export function useFriendPick() {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, Role>>({});
  return {
    picked,
    roleOf: (id: string) => roles[id] ?? "editor",
    toggle: (id: string, on: boolean) => setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    }),
    setRole: (id: string, role: Role) => setRoles((r) => ({ ...r, [id]: role })),
  };
}

export type FriendPick = ReturnType<typeof useFriendPick>;

/** Список друзей флажками с ролью у каждого. */
export function FriendPicker({ friends, pick, title, hint, empty }: {
  friends: FriendEntry[] | null;
  pick: FriendPick;
  title: ReactNode;
  hint: ReactNode;
  /** Текст, когда звать некого. */
  empty: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = norm(query);
    return (friends ?? []).filter((f) => !q || norm(`${f.user.display_name} ${f.user.login}`).includes(q));
  }, [friends, query]);

  return (
    <section className="np-team">
      <div className="np-team-h">
        <div>
          <b>{title}</b>
          <p className="t-xs t-muted">{hint}</p>
        </div>
        {(friends?.length ?? 0) > SEARCH_FROM && (
          <Input icon="search" className="np-search" type="search" placeholder="Найти друга" aria-label="Найти друга"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
      </div>
      {friends === null ? (
        <p className="t-sm t-muted">Загружаем друзей…</p>
      ) : friends.length === 0 ? (
        <p className="np-none">{empty}</p>
      ) : shown.length === 0 ? (
        <p className="np-none">Никого не нашлось.</p>
      ) : (
        <ul className="np-friends">
          {shown.map((f) => {
            const on = pick.picked.has(f.user.id);
            return (
              <li key={f.user.id} className={on ? "on" : undefined}>
                <Check checked={on} onChange={(v) => pick.toggle(f.user.id, v)}>
                  <Avatar name={f.user.display_name} size={28} />
                  <span className="np-who">
                    <b className="t-ell">{f.user.display_name}</b>
                    <span className="t-ell">{f.user.login}</span>
                  </span>
                </Check>
                <Select size="sm" label={`Роль: ${f.user.display_name}`} disabled={!on}
                  value={pick.roleOf(f.user.id)} options={ROLES}
                  onChange={(v) => pick.setRole(f.user.id, v)} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
