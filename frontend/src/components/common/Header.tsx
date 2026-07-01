import { useState } from "react";
import type { InferenceSummary, TrainingSummary } from "../../types";

export interface UploadActivity {
  id: string;
  label: string; // dataset name
  pct: number | null; // null = indeterminate (server-side phase)
}

export interface AugActivity {
  id: string;
  label: string;
  pct: number | null;
  cancelling?: boolean;
}

interface Props {
  uploads: UploadActivity[];
  augments: AugActivity[];
  trainings: TrainingSummary[]; // active + queued
  inferences: InferenceSummary[]; // processing
  onOpenTraining: (id: string) => void;
  onOpenInference: (videoId: string) => void;
  onCancelAugment: (id: string) => void;
  onCancelTraining: (id: string) => void;
}

interface Item {
  key: string;
  title: string;
  detail: string;
  pct: number | null;
  queued?: boolean;
  onClick?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}

// Live activity indicator in the header. Renders nothing when idle; otherwise a
// single pill showing the number of active tasks and their average progress,
// which expands to a dropdown listing every process regardless of type.
export default function Header({
  uploads,
  augments,
  trainings,
  inferences,
  onOpenTraining,
  onOpenInference,
  onCancelAugment,
  onCancelTraining,
}: Props) {
  const [open, setOpen] = useState(false);

  const items: Item[] = [
    ...uploads.map((u) => ({
      key: "u:" + u.id,
      title: "Загрузка датасета",
      detail: u.label,
      pct: u.pct,
    })),
    ...augments.map((a) => ({
      key: "a:" + a.id,
      title: "Генерация аугментаций",
      detail: a.cancelling ? `${a.label} · отмена…` : a.label,
      pct: a.pct,
      onCancel: a.cancelling ? undefined : () => onCancelAugment(a.id),
      cancelLabel: "Отменить генерацию",
    })),
    ...trainings.map((t) => {
      const name = t.display_name || t.model_name;
      const dataset = t.dataset_label || t.dataset_name;
      if (t.status === "queued") {
        return {
          key: "t:" + t.id,
          title: `Обучение · в очереди`,
          detail: `${name} · ${dataset}`,
          pct: null,
          queued: true,
          onClick: () => onOpenTraining(t.id),
          onCancel: () => onCancelTraining(t.id),
          cancelLabel: "Убрать из очереди",
        };
      }
      return {
        key: "t:" + t.id,
        title: `Обучение · ${name}`,
        detail: `${dataset} · эпоха ${t.current_epoch}/${t.epochs}`,
        pct: t.epochs ? Math.min(1, t.current_epoch / t.epochs) : null,
        onClick: () => onOpenTraining(t.id),
      };
    }),
    ...inferences.map((r) => ({
      key: "i:" + r.id,
      title: `Проверка · ${r.model_display || r.model_run_id}`,
      detail: r.total_frames
        ? `${r.input_name} · кадр ${r.processed_frames ?? 0}/${r.total_frames}`
        : r.input_name,
      pct: r.total_frames ? (r.processed_frames ?? 0) / r.total_frames : null,
      onClick: r.video_id ? () => onOpenInference(r.video_id as string) : undefined,
    })),
  ];

  if (items.length === 0) return null;

  // Average across tasks that report a numeric progress (queued/indeterminate
  // ones are excluded so they don't drag the figure to zero).
  const measured = items.filter((it) => it.pct != null);
  const avg =
    measured.length > 0
      ? measured.reduce((s, it) => s + (it.pct as number), 0) / measured.length
      : null;

  return (
    <div className="hdr-status-wrap">
      <button className="hdr-status" onClick={() => setOpen((o) => !o)}>
        <span className="hdr-spinner" />
        <span className="hdr-status-text">Активных задач: {items.length}</span>
        {avg != null && <span className="hdr-pct">{Math.round(avg * 100)}%</span>}
        <span className="caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="hdr-dropdown">
          {items.map((it) => (
            <div key={it.key} className="hdr-drop-row">
              <button
                className="hdr-drop-item"
                onClick={() => {
                  it.onClick?.();
                  setOpen(false);
                }}
                disabled={!it.onClick}
              >
                <span className="hdr-drop-title">{it.title}</span>
                <span className="hdr-drop-detail">
                  {it.detail}
                  {it.pct != null ? ` · ${Math.round(it.pct * 100)}%` : ""}
                </span>
              </button>
              {it.onCancel && (
                <button
                  className="hdr-cancel"
                  onClick={it.onCancel}
                  title={it.cancelLabel}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
