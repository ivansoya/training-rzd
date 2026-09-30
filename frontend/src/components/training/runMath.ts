// Расчёты экрана обучения: сколько осталось, где на графике эпоха, что писать
// в полосе. Отдельно от разметки, чтобы закрыть их числами.

import type { EpochRow, Run } from "../../api/runs";

const FINISHED = ["done", "error", "stopped"];

/** Идёт ли итоговая проверка лучших весов. Бегун пишет фазу `final`; ран,
 *  запущенный до этого, узнаётся по номеру эпохи за пределом: ultralytics
 *  отмечает свою итоговую проверку как эпоху N+1. */
export function isFinalCheck(run: Pick<Run, "status" | "phase" | "current_epoch" | "epochs">) {
  if (FINISHED.includes(run.status)) return false;
  return run.phase === "final" || run.current_epoch > run.epochs;
}

/** Эпохи, которые стоит рисовать. Строка итоговой проверки (эпоха N+1 у
 *  старых ранов) — не эпоха: её метрики сняты с лучших весов, а не с
 *  (N+1)-го прохода, и на графике она выглядела ещё одной эпохой. */
export function trainedEpochs(run: Pick<Run, "epochs" | "summary">, rows: EpochRow[]) {
  const done = run.summary?.epochs_done;
  const last = typeof done === "number" && done > 0 ? Math.min(done, run.epochs) : run.epochs;
  return rows.filter((r) => r.epoch <= last);
}

/** «Осталось примерно …» — только у идущего обучения. У законченного или
 *  снятого остатка нет, сколько бы эпох ни было недобрано. */
export function left(run: Pick<Run, "status" | "phase" | "current_epoch" | "epochs">, rows: EpochRow[]) {
  if (run.status !== "running" || isFinalCheck(run)) return null;
  const timed = rows.filter((e) => e.seconds);
  if (!timed.length || run.current_epoch >= run.epochs) return null;
  // Считаем по последним пяти: первая эпоха всегда медленнее остальных, и
  // среднее по всем врёт в начале сильнее всего.
  const recent = timed.slice(-5);
  const per = recent.reduce((a, e) => a + (e.seconds ?? 0), 0) / recent.length;
  const secs = per * (run.epochs - run.current_epoch);
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

/** Доля полосы «обучение целиком», 0..1. Во время итоговой проверки — полная:
 *  все эпохи пройдены, а «эпоха 3 из 2» давала полосу в полтора раза шире. */
export function progress(run: Pick<Run, "status" | "phase" | "current_epoch" | "epochs">) {
  if (isFinalCheck(run)) return 1;
  return Math.max(0, Math.min(1, run.current_epoch / Math.max(1, run.epochs)));
}

/** Подпись к статусу идущего обучения. */
export function stageText(run: Pick<Run, "status" | "phase" | "current_epoch" | "epochs">) {
  if (isFinalCheck(run)) return "итоговая проверка";
  return `эпоха ${Math.min(run.current_epoch, run.epochs)} из ${run.epochs}`;
}

/** Положение эпохи на оси: эпоха e стоит над подписью e. Ноль оси — начало
 *  обучения, до первой эпохи; последняя эпоха ложится на правый край.
 *  Раньше эпоха 1 рисовалась над «0», и вся кривая съезжала на шаг влево. */
export function epochX(epoch: number, total: number, x0: number, x1: number) {
  return x0 + (epoch / Math.max(1, total)) * (x1 - x0);
}
