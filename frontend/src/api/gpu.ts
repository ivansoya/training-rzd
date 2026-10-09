// Железо: карты, очередь к ним и ручные потолки.

import { get, patch, post, put } from "./http";

/** Подписи брони от сервера: что за работа, чья, в каком проекте. */
export interface Described {
  what: string | null;
  detail: string | null;
  user: string | null;
  project: string | null;
}

export interface Holder extends Described {
  id: string;
  kind: string;
  title: string | null;
  granted_mb: number;
  peak_mb: number | null;
  user_id: string | null;
  granted_at: string | null;
}

export interface Device {
  id: string;
  host: string;
  index: number;
  name: string;
  total_mb: number;
  reserved_mb: number;
  sam2_reserve_mb: number;
  max_heavy: number;
  held_mb: number;
  free_mb: number;
  heavy: number;
  seen_at: string | null;
  enabled: boolean;
  /** На связи: воркер перечислял карту недавно. */
  fresh: boolean;
  /** Потолок под задачи: всего без запаса и резерва под разметку. */
  cap_mb: number;
  /** Пусто без права на оборудование — тогда занятое видно только суммой `held_mb`. */
  holders: Holder[];
}

export interface QueueRow extends Described {
  id: string;
  position: number;
  kind: string;
  title: string | null;
  want_mb: number;
  waiting_seconds: number;
  reason: string | null;
  mine: boolean;
  user_id: string | null;
}

/** Карта без держателей — видит каждый: на ней объясняется вердикт агента. */
export interface GpuCard {
  id: string;
  index: number;
  name: string;
  cap_mb: number;
  free_mb: number;
}

export interface GpuState {
  /** «Просмотр оборудования» и выше: держатели карт и чужая очередь. */
  staff: boolean;
  /** «Управление»: настройка карт, снятие задач, выдача прав. */
  manage: boolean;
  level: "view" | "manage" | null;
  cards: GpuCard[];
  devices: Device[];
  queue: {
    mine: QueueRow[];
    ahead: number;
    total: number;
    queue: QueueRow[];
  };
  live: { used: number; soft: number; hard: number; peak: number };
}

export const gpuState = () => get<GpuState>("gpu");

export type HardwareLevel = "view" | "manage";
export interface AccessRow { id: string; login: string; email: string; name: string; level: HardwareLevel | null }
export const grantedAccess = () => get<{ granted: AccessRow[] }>("gpu/access");
export const findPeople = (q: string) => get<{ found: AccessRow[] }>(`gpu/access?q=${encodeURIComponent(q)}`);
export const setAccess = (userId: string, level: HardwareLevel | null) => put<AccessRow>(`gpu/access/${userId}`, { level });

export const setLimits = (
  id: string,
  data: { reserved_mb?: number; max_heavy?: number; enabled?: boolean }
) => patch<Device[]>(`gpu/devices/${id}`, data);

// Свою задачу отменяет владелец, чужую — «Управление». Снимает не сервер, а воркер: флаг ставится в базе, а процесс убивает тот,
// кто держит его pid. Стрелять по чужому pid из чужого контейнера нельзя.
export const killLease = (id: string) =>
  post<{ ok: true }>(`gpu/leases/${id}/kill`);
