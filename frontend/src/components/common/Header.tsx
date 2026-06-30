import { useState } from "react";
import type { TrainingSummary } from "../../types";

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
  trainings: TrainingSummary[]; // only the active ones
  onOpenTraining: (id: string) => void;
  onCancelAugment: (id: string) => void;
}

interface Item {
  key: string;
  title: string;
  detail: string;
  pct: number | null;
  onClick?: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}

// Live activity indicator in the header. Renders nothing when idle; a single
// pill when one task runs; a count pill that expands to a list when several do.
export default function Header({
  uploads,
  augments,
  trainings,
  onOpenTraining,
  onCancelAugment,
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
    ...trainings.map((t) => ({
      key: "t:" + t.id,
      title: `Обучение · ${t.model_name}`,
      detail: `${t.dataset_label || t.dataset_name} · эпоха ${t.current_epoch}/${t.epochs}`,
      pct: t.epochs ? Math.min(1, t.current_epoch / t.epochs) : null,
      onClick: () => onOpenTraining(t.id),
    })),
  ];

  if (items.length === 0) return null;

  if (items.length === 1) {
    const it = items[0];
    return (
      <div className="hdr-status-wrap">
        <button
          className="hdr-status"
          onClick={it.onClick}
          disabled={!it.onClick}
          title={it.onClick ? "Открыть" : undefined}
        >
          <span className="hdr-spinner" />
          <span className="hdr-status-text">{it.title}</span>
          <span className="hdr-status-detail">{it.detail}</span>
          {it.pct != null && (
            <span className="hdr-pct">{Math.round(it.pct * 100)}%</span>
          )}
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
    );
  }

  return (
    <div className="hdr-status-wrap">
      <button className="hdr-status" onClick={() => setOpen((o) => !o)}>
        <span className="hdr-spinner" />
        <span className="hdr-status-text">Активных задач: {items.length}</span>
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
