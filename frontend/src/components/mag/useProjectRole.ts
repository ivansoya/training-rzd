import { useAuth } from "../auth/AuthGate";

export type Role = "viewer" | "editor" | "admin";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** Роль в проекте из `me.projects`. Страницам вне ProjectShell (мастера, таска,
 *  обучение) её больше неоткуда взять. null — не участник или кода нет. */
export function useProjectRole(code: string | undefined): Role | null {
  const { me } = useAuth();
  if (!code) return null;
  return me.projects.find((p) => p.code === code.trim().toUpperCase())?.role ?? null;
}

export function roleAtLeast(role: Role | null, need: Role): boolean {
  return role !== null && RANK[role] >= RANK[need];
}
