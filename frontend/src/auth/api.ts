// API client for auth, friends, projects and invitations. Sessions live in an
// httpOnly cookie, so every call is a plain same-origin fetch.

export interface AuthUser {
  id: string;
  email: string;
  login: string;
  display_name: string;
  created_at: string;
}

export interface ProjectMembership {
  id: string;
  name: string;
  code: string;
  role: "admin" | "editor" | "viewer";
  role_label: string;
}

export interface Me {
  user: AuthUser;
  projects: ProjectMembership[];
}

export interface Person {
  id: string;
  login: string;
  display_name: string;
  online?: boolean;
  last_seen_at?: string | null;
}

export interface FriendEntry {
  friendship_id: string;
  user: Person;
}

export interface FriendsInfo {
  friends: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  code: string;
  description: string | null;
  role: string;
  role_label: string;
  members_count: number;
  datasets_count: number;
  created_at: string;
}

export interface ProjectMemberInfo extends Person {
  role: string;
  role_label: string;
}

export interface ProjectDetail {
  project: {
    id: string;
    name: string;
    code: string;
    description: string | null;
    created_at: string;
    created_by: string | null;
  };
  my_role: string;
  members: ProjectMemberInfo[];
  stats: {
    images: number;
    annotations: number;
    size_bytes: number;
    datasets: number;
    classes: number;
  };
  datasets: {
    id: string;
    name: string;
    identifier: string;
    images_count: number;
    created_at: string;
  }[];
  classes: { name: string; color: string; annotations: number }[];
  pending_invitations?: { id: string; user: Person; role_label: string }[];
}

export interface InvitationItem {
  id: string;
  project: { name: string; code: string };
  role: string;
  role_label: string;
  invited_by: string | null;
}

// Thrown for any non-ok response; `code` carries machine-readable reasons
// (e.g. "email_unconfirmed"), `fields` — per-field validation messages.
export class ApiError extends Error {
  code?: string;
  email?: string;
  fields?: Record<string, string>;
  constructor(message: string, code?: string, fields?: Record<string, string>, email?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields;
    this.email = email;
  }
}

async function asJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data as {
      error?: string;
      code?: string;
      email?: string;
      errors?: Record<string, string>;
    };
    const message =
      err.error || (err.errors && Object.values(err.errors)[0]) || `HTTP ${res.status}`;
    throw new ApiError(message, err.code, err.errors, err.email);
  }
  return data as T;
}

function post(path: string, body: unknown = {}): Promise<Response> {
  return fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- auth ---

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  return asJson<Me>(res);
}

export async function login(identity: string, password: string): Promise<AuthUser> {
  const { user } = await asJson<{ user: AuthUser }>(
    await post("auth/login", { identity, password })
  );
  return user;
}

export async function register(fields: {
  email: string;
  login: string;
  display_name: string;
  password: string;
}): Promise<{ email: string }> {
  return asJson(await post("auth/register", fields));
}

export async function confirmEmail(token: string): Promise<AuthUser> {
  const { user } = await asJson<{ user: AuthUser }>(await post("auth/confirm", { token }));
  return user;
}

export async function resendConfirmation(email: string): Promise<void> {
  await asJson(await post("auth/resend", { email }));
}

export async function logout(): Promise<void> {
  await asJson(await post("auth/logout"));
}

export async function changePassword(current: string, next: string): Promise<void> {
  await asJson(await post("auth/password", { current, new: next }));
}

// --- friends ---

export async function getFriends(): Promise<FriendsInfo> {
  return asJson(await fetch("/api/friends"));
}

export async function addFriend(identity: string): Promise<void> {
  await asJson(await post("friends", { identity }));
}

export async function acceptFriend(friendshipId: string): Promise<void> {
  await asJson(await post(`friends/${friendshipId}/accept`));
}

export async function removeFriend(friendshipId: string): Promise<void> {
  await asJson(await fetch(`/api/friends/${friendshipId}`, { method: "DELETE" }));
}

// --- projects ---

export async function listProjects(): Promise<ProjectSummary[]> {
  const { projects } = await asJson<{ projects: ProjectSummary[] }>(
    await fetch("/api/projects")
  );
  return projects;
}

export async function createProject(fields: {
  name: string;
  code: string;
  description: string;
  invites: { user_id: string; role: string }[];
}): Promise<{ code: string }> {
  return asJson(await post("projects", fields));
}

export async function getProject(code: string): Promise<ProjectDetail> {
  return asJson(await fetch(`/api/projects/${encodeURIComponent(code)}`));
}

export async function inviteToProject(
  code: string,
  identity: string,
  role: string
): Promise<void> {
  await asJson(await post(`projects/${encodeURIComponent(code)}/invite`, { identity, role }));
}

// --- invitations ---

export async function listInvitations(): Promise<InvitationItem[]> {
  const { invitations } = await asJson<{ invitations: InvitationItem[] }>(
    await fetch("/api/invitations")
  );
  return invitations;
}

export async function acceptInvitation(id: string): Promise<{ code: string }> {
  return asJson(await post(`invitations/${id}/accept`));
}

export async function declineInvitation(id: string): Promise<void> {
  await asJson(await post(`invitations/${id}/decline`));
}
