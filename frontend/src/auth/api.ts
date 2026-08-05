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
  status: ProjectStatus;
  role: string;
  role_label: string;
  members_count: number;
  members: { display_name: string; online: boolean }[];
  datasets_count: number;
  images_count: number;
  annotations_count: number;
  classes_count: number;
  created_at: string;
}

export interface ProjectMemberInfo extends Person {
  role: string;
  role_label: string;
}

export type ProjectStatus = "importing" | "ready";

export interface ProjectDetail {
  project: {
    id: string;
    name: string;
    code: string;
    description: string | null;
    status: ProjectStatus;
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
  classes: {
    class_index: number;
    name: string;
    color: string;
    superclass: string | null;
    annotations: number;
  }[];
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

// Код проекта присваивает сервер, клиент его не предлагает.
export async function createProject(fields: {
  name: string;
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

// --- import of a YOLO archive into a project ---

export type ImportStatus =
  | "none"
  | "scanning"
  | "classes"
  | "writing"
  | "done"
  | "error";

export interface ScannedClass {
  class_index: number;
  yaml_name: string | null;
  annotations: number;
}

export interface ImportReport {
  archive_members: number;
  images: number;
  annotations: number;
  images_without_labels: number;
  splits: Record<string, number>;
  clipped: number;
  skipped: number;
  skipped_examples: { file: string; reason: string }[];
  classes: ScannedClass[];
}

export interface ImportState {
  status: ImportStatus;
  job_id?: string;
  error?: string;
  archive?: { name: string; size_bytes: number; upload_seconds: number };
  report?: ImportReport;
  result?: {
    dataset_id: string;
    images: number;
    unreadable: number;
    orphan_boxes: number;
  };
}

export interface ImportPlan {
  dataset_name: string;
  superclasses: { name: string; color: string }[];
  classes: {
    class_index: number;
    name: string;
    color: string;
    superclass: string | null;
  }[];
}

export async function getImport(code: string): Promise<ImportState> {
  return asJson(await fetch(`/api/projects/${encodeURIComponent(code)}/import`));
}

// Streams the archive with an upload-progress callback; the scan that follows
// is a background job polled through /api/jobs.
export function uploadArchive(
  code: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<{ job_id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${encodeURIComponent(code)}/import`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { job_id?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.job_id) {
        resolve({ job_id: data.job_id });
      } else {
        reject(new ApiError(data.error || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError("Не удалось передать архив."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export async function commitImport(
  code: string,
  plan: ImportPlan
): Promise<{ job_id: string }> {
  return asJson(await post(`projects/${encodeURIComponent(code)}/import/commit`, plan));
}

export async function cancelImport(code: string): Promise<void> {
  await asJson(
    await fetch(`/api/projects/${encodeURIComponent(code)}/import`, {
      method: "DELETE",
    })
  );
}

// --- project datasets ---

// Геометрия в пикселях исходного кадра — на превью пересчитывается в проценты.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  class_index: number;
  name: string;
  color: string;
}

export interface DatasetImage {
  id: string;
  file_name: string;
  split: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  annotations: number;
  boxes: Box[];
}

export interface DatasetStats {
  images: number;
  annotations: number;
  splits: Record<string, number>;
  without_annotations: number;
  per_image: number;
  resolutions: { width: number | null; height: number | null; count: number }[];
}

export interface DatasetDetail {
  dataset: { id: string; name: string; identifier: string; created_at: string };
  stats: DatasetStats;
  matched: number;
  my_role: string;
  images: DatasetImage[];
}

export interface DatasetQuery {
  split?: string;
  class_index?: number | null;
  empty?: boolean;
  sort?: "name" | "objects";
  limit?: number;
  offset?: number;
}

export async function getDataset(
  code: string,
  datasetId: string,
  params: DatasetQuery = {}
): Promise<DatasetDetail> {
  const q = new URLSearchParams();
  if (params.split) q.set("split", params.split);
  if (params.class_index !== null && params.class_index !== undefined) {
    q.set("class_index", String(params.class_index));
  }
  if (params.empty) q.set("empty", "1");
  if (params.sort) q.set("sort", params.sort);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.offset) q.set("offset", String(params.offset));
  const suffix = q.toString() ? `?${q}` : "";
  return asJson(
    await fetch(
      `/api/projects/${encodeURIComponent(code)}/datasets/${datasetId}${suffix}`
    )
  );
}

// --- классы и суперклассы проекта ---

export interface LabelClass {
  id: string;
  class_index: number;
  name: string;
  color: string;
  superclass_id: string | null;
  superclass_name: string | null;
  annotations: number;
}

export interface SuperclassItem {
  id: string;
  name: string;
  color: string;
  classes: number;
}

export interface ClassesInfo {
  classes: LabelClass[];
  superclasses: SuperclassItem[];
  can_edit: boolean;
}

export async function getClasses(code: string): Promise<ClassesInfo> {
  return asJson(await fetch(`/api/projects/${encodeURIComponent(code)}/classes`));
}

export async function createClass(
  code: string,
  body: { name: string; color?: string; superclass_id?: string | null }
): Promise<LabelClass> {
  return asJson(await post(`projects/${encodeURIComponent(code)}/classes`, body));
}

export async function updateClass(
  code: string,
  id: string,
  patch: { name?: string; color?: string; superclass_id?: string | null }
): Promise<LabelClass> {
  return asJson(
    await fetch(`/api/projects/${encodeURIComponent(code)}/classes/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

// Без confirm сервер отвечает 409 и числом разметок под удаление — цену
// называем до того, как что-то исчезнет.
export async function deleteClass(
  code: string,
  id: string,
  confirm = false
): Promise<{ deleted_annotations: number }> {
  const q = confirm ? "?confirm=1" : "";
  return asJson(
    await fetch(`/api/projects/${encodeURIComponent(code)}/classes/${id}${q}`, {
      method: "DELETE",
    })
  );
}

export async function createSuperclass(
  code: string,
  body: { name: string; color?: string }
): Promise<SuperclassItem> {
  return asJson(await post(`projects/${encodeURIComponent(code)}/superclasses`, body));
}

export async function updateSuperclass(
  code: string,
  id: string,
  patch: { name?: string; color?: string }
): Promise<SuperclassItem> {
  return asJson(
    await fetch(`/api/projects/${encodeURIComponent(code)}/superclasses/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
}

export async function deleteSuperclass(
  code: string,
  id: string
): Promise<{ classes_ungrouped: number }> {
  return asJson(
    await fetch(`/api/projects/${encodeURIComponent(code)}/superclasses/${id}`, {
      method: "DELETE",
    })
  );
}

// --- таски и разметка ---

export type TaskStatus = "queued" | "in_progress" | "done" | "updating" | "closed";

export interface TaskCounts {
  total: number;
  new: number;
  skipped: number;
  annotated: number;
  empty: number;
  deleted: number;
  accepted: number;
}

export interface TaskSummary {
  id: string;
  name: string;
  status: TaskStatus;
  status_label: string;
  assignee: { id: string; display_name: string } | null;
  target_dataset: { id: string | null; name: string } | null;
  created_at: string;
  counts: TaskCounts;
}

// План нарезки ролика, а не история: кадры таски приводятся к нему.
export interface CutSegment {
  start_ms: number;
  end_ms: number;
  step_ms: number;
}

export interface TaskVideoItem {
  id: string;
  file_name: string;
  duration_ms: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  segments: CutSegment[];
  frames: number;
}

export interface TaskDetail extends TaskSummary {
  project: { code: string; name: string };
  can_work: boolean;
  is_admin: boolean;
  videos: TaskVideoItem[];
  from_files: number;
  classes: { class_index: number; name: string; color: string; annotations: number }[];
}

export function videoStripUrl(taskId: string, videoId: string): string {
  return `/api/tasks/${taskId}/videos/${videoId}/strip`;
}

export function videoFileUrl(taskId: string, videoId: string): string {
  return `/api/tasks/${taskId}/videos/${videoId}/file`;
}

// «empty» — фоновый кадр, объектов нет осознанно; «deleted» — забракован, но
// виден в таске до её закрытия.
export type ImageTaskStatus =
  | "new"
  | "skipped"
  | "annotated"
  | "empty"
  | "deleted";

export interface TaskImage {
  id: string;
  file_name: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  task_status: ImageTaskStatus;
  accepted: boolean;
  source_video_id: string | null;
  source_time_ms: number | null;
  annotations: number;
  boxes: (Box & { id: string; source: string })[];
}

export interface Segment {
  start_ms: number;
  end_ms: number;
  step_ms: number;
}

export async function listTasks(
  code: string
): Promise<{ tasks: TaskSummary[]; can_create: boolean; is_admin: boolean }> {
  return asJson(await fetch(`/api/projects/${encodeURIComponent(code)}/tasks`));
}

export async function createTask(
  code: string,
  body: {
    name: string;
    assignee_id?: string | null;
    target_dataset_id?: string | null;
    target_dataset_name?: string | null;
  }
): Promise<TaskSummary> {
  return asJson(await post(`projects/${encodeURIComponent(code)}/tasks`, body));
}

export async function getTask(id: string): Promise<TaskDetail> {
  return asJson(await fetch(`/api/tasks/${id}`));
}

export async function setTaskStatus(
  id: string,
  status: TaskStatus
): Promise<TaskDetail & { accepted?: number; dataset?: string; removed_images?: number }> {
  return asJson(await post(`tasks/${id}/status`, { status }));
}

export async function assignTask(id: string, assignee_id: string | null): Promise<TaskSummary> {
  return asJson(
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_id }),
    })
  );
}

export async function getTaskImages(
  id: string,
  params: { status?: string; limit?: number; offset?: number } = {}
): Promise<{ matched: number; counts: TaskCounts; images: TaskImage[] }> {
  const q = new URLSearchParams();
  if (params.status) q.set("status", params.status);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.offset) q.set("offset", String(params.offset));
  const suffix = q.toString() ? `?${q}` : "";
  return asJson(await fetch(`/api/tasks/${id}/images${suffix}`));
}

export function uploadTaskImages(
  id: string,
  files: File[],
  onProgress: (pct: number) => void
): Promise<{ added: number; skipped: number; counts: TaskCounts }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/tasks/${id}/images`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as never);
      } else {
        reject(new ApiError((data.error as string) || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError("Не удалось передать файлы."));
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    xhr.send(form);
  });
}

export function uploadTaskVideo(
  id: string,
  file: File,
  onProgress: (pct: number) => void
): Promise<TaskVideoItem> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/tasks/${id}/videos`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else reject(new ApiError((data.error as string) || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError("Не удалось передать видео."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export interface CutEstimate {
  frames?: number;
  size_bytes?: number;
  error?: string;
  // Разница плана и таски: что добавится, что исчезнет и что защищено.
  add?: number;
  remove?: number;
  remove_annotated?: { ms: number; boxes: number }[];
  kept_accepted?: number;
  existing?: number[];
  doomed?: number[];
}

export async function estimateCut(
  taskId: string,
  videoId: string,
  segments: Segment[]
): Promise<CutEstimate> {
  return asJson(await post(`tasks/${taskId}/videos/${videoId}/estimate`, { segments }));
}

export async function cutVideo(
  taskId: string,
  videoId: string,
  segments: Segment[]
): Promise<{ job_id: string }> {
  return asJson(await post(`tasks/${taskId}/videos/${videoId}/cut`, { segments }));
}

export async function saveAnnotations(
  imageId: string,
  boxes: { class_index: number; x: number; y: number; w: number; h: number }[]
): Promise<{ saved: number; clamped: number; task_status: string }> {
  return asJson(
    await fetch(`/api/images/${imageId}/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxes }),
    })
  );
}

export async function setImageTaskStatus(
  imageId: string,
  status: ImageTaskStatus
): Promise<{ task_status: ImageTaskStatus; counts: TaskCounts }> {
  return asJson(
    await fetch(`/api/images/${imageId}/task-status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    })
  );
}

// В живой таске удаление мягкое: ответ говорит, кадр помечен или стёрт совсем.
export async function deleteImage(
  imageId: string
): Promise<{ ok: boolean; soft: boolean; counts?: TaskCounts }> {
  return asJson(await fetch(`/api/images/${imageId}`, { method: "DELETE" }));
}

export interface TaskEventItem {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  user: string | null;
}

export async function getTaskEvents(id: string): Promise<TaskEventItem[]> {
  const { events } = await asJson<{ events: TaskEventItem[] }>(
    await fetch(`/api/tasks/${id}/events`)
  );
  return events;
}

export function imageThumbUrl(id: string): string {
  return `/api/images/${id}/thumb`;
}

// Промежуточный размер для просмотра: ~150 КБ против 670 КБ оригинала.
export function imagePreviewUrl(id: string): string {
  return `/api/images/${id}/preview`;
}

export function imageFileUrl(id: string): string {
  return `/api/images/${id}/file`;
}
