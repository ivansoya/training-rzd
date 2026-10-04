// Подписи страницы «Проекты»: что сказать о списке и о последнем обучении проекта.

import type { ProjectSummary } from "../../auth/api";
import { ago, count } from "../ru";

export type RunTone = "live" | "done" | "warn" | "bad" | "idle";

const ACTIVE = new Set(["preparing", "running"]);
const WAITING = new Set(["queued", "waiting_gpu"]);

/** Строка подвала карточки: что с обучением и насколько это свежо. */
export function runLine(run: ProjectSummary["last_run"], now = Date.now()): { text: string; tone: RunTone } {
  if (!run) return { text: "Обучения не было", tone: "idle" };
  const n = `«${run.name}»`;
  if (ACTIVE.has(run.status)) return { text: `${n}: эпоха ${run.epoch} из ${run.epochs}`, tone: "live" };
  if (WAITING.has(run.status)) return { text: `${n} в очереди`, tone: "idle" };
  if (run.status === "stopping") return { text: `${n} останавливается`, tone: "warn" };
  const when = ago(run.at, now);
  if (run.status === "done") return { text: `${n} готово ${when}`, tone: "done" };
  if (run.status === "stopped") return { text: `${n} остановлено ${when}`, tone: "warn" };
  if (run.status === "error") return { text: `${n}: ошибка ${when}`, tone: "bad" };
  return { text: n, tone: "idle" };
}

/** Подзаголовок: сколько проектов, приглашений и где сейчас идёт обучение. */
export function projectsLine(projects: ProjectSummary[], invitations: number): string {
  const parts = [count(projects.length, "проект", "проекта", "проектов")];
  if (invitations) parts.push(count(invitations, "приглашение", "приглашения", "приглашений"));
  const live = projects.filter((p) => p.last_run && ACTIVE.has(p.last_run.status)).length;
  const waiting = projects.filter((p) => p.last_run && WAITING.has(p.last_run.status)).length;
  if (live) parts.push(`обучение идёт в ${count(live, "проекте", "проектах", "проектах")}`);
  if (waiting) parts.push(`в очереди — ${count(waiting, "проект", "проекта", "проектов")}`);
  return parts.join(" · ");
}

/** Доля размеченного; пустой проект — ноль, а не NaN. */
export function doneShare(p: Pick<ProjectSummary, "done_count" | "images_count">): number {
  return p.images_count > 0 ? Math.min(1, p.done_count / p.images_count) : 0;
}
