import type { Progress } from "../types";

export default function ProgressBar({ label, pct, spinner }: Progress) {
  // Spinner variant: a plain status line with no progress track (used for
  // single-pass steps like computing statistics).
  if (spinner) {
    return (
      <div className="progress">
        <div className="progress-status">
          <span className="spinner" />
          <span>{label}</span>
        </div>
      </div>
    );
  }

  const indeterminate = pct === null;
  return (
    <div className="progress">
      <div className="progress-label">
        <span>{label}</span>
        {!indeterminate && <span>{Math.round((pct as number) * 100)}%</span>}
      </div>
      <div className="progress-track">
        <div
          className={indeterminate ? "progress-fill indeterminate" : "progress-fill"}
          style={indeterminate ? undefined : { width: `${(pct as number) * 100}%` }}
        />
      </div>
    </div>
  );
}
