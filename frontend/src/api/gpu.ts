// Железо: карты, очередь к ним и ручные потолки.

import { get, patch, post } from "./http";

export interface Holder {
  id: string;
  kind: string;
  title: string | null;
  granted_mb: number;
  peak_mb: number | null;
  user_id: string | null;
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
  holders: Holder[];
}

export interface QueueRow {
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

export interface GpuState {
  staff: boolean;
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

export const setLimits = (
  id: string,
  data: { reserved_mb?: number; max_heavy?: number; enabled?: boolean }
) => patch<Device[]>(`gpu/devices/${id}`, data);

// Снимает не сервер, а воркер: флаг ставится в базе, а процесс убивает тот,
// кто держит его pid. Стрелять по чужому pid из чужого контейнера нельзя.
export const killLease = (id: string) =>
  post<{ ok: true }>(`gpu/leases/${id}/kill`);
