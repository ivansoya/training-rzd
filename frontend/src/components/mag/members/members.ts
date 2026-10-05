import type { Person } from "../../../auth/api";
import { ago } from "../../ru";
import type { Role } from "../FriendPicker";

export type RoleFilter = "all" | Role;

const norm = (s: string) => s.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();

/** Отбор по имени или логину и по роли. */
export function matchPeople<T extends { user: Person; role: string }>(rows: T[], query: string, role: RoleFilter): T[] {
  const q = norm(query);
  return rows.filter((r) => (role === "all" || r.role === role)
    && (!q || norm(`${r.user.display_name} ${r.user.login}`).includes(q)));
}

/** «в сети», «заходил(а) 2 часа назад», «не заходил(а)». */
export function presence(p: Pick<Person, "online" | "last_seen_at">, now = Date.now()): string {
  if (p.online) return "в сети";
  return p.last_seen_at ? `заходил(а) ${ago(p.last_seen_at, now)}` : "не заходил(а)";
}

/** «12 авг 2025» — дата без времени. */
export function day(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })
    .replace(".", "").replace(" г.", "");
}
