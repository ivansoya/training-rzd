import { useState } from "react";
import ProgressBar from "./ProgressBar";
import type { AugConfig, AugScope, Progress } from "../types";

interface Props {
  source: string;
  configs: AugConfig[];
  onCreate: (
    configIds: string[],
    displayName: string,
    scope: AugScope,
    onProgress: (p: Progress) => void
  ) => Promise<void>;
  onClose: () => void;
}

export default function CreateAugmentedModal({
  source,
  configs,
  onCreate,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [scope, setScope] = useState<AugScope>("all");
  const [progress, setProgress] = useState<Progress | null>(null);

  const busy = progress !== null;

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  async function confirm() {
    if (selected.length === 0) return;
    setProgress({ label: "Подготовка…", pct: null });
    try {
      await onCreate(selected, displayName.trim(), scope, setProgress);
    } catch {
      setProgress(null);
    }
  }

  const chosen = configs.filter((c) => selected.includes(c.id));
  const totalPasses = selected.length;

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Создать аугментацию</h3>
        <p className="modal-file">Источник: «{source}»</p>

        <div className="modal-label">
          Какие изображения аугментировать
          <div className="radio-row">
            <label className="param param-bool">
              <input
                type="radio"
                name="scope"
                checked={scope === "all"}
                disabled={busy}
                onChange={() => setScope("all")}
              />
              <span>Все изображения</span>
            </label>
            <label className="param param-bool">
              <input
                type="radio"
                name="scope"
                checked={scope === "train"}
                disabled={busy}
                onChange={() => setScope("train")}
              />
              <span>Только train</span>
            </label>
          </div>
        </div>

        <div className="modal-label">
          Конфигурации (каждая — отдельный проход по изображениям)
          <ul className="config-pick">
            {configs.map((c) => (
              <li key={c.id}>
                <label className="param param-bool">
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    disabled={busy}
                    onChange={() => toggle(c.id)}
                  />
                  <span>
                    {c.name}{" "}
                    <span className="subtle">({c.transforms.length} аугм.)</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        {totalPasses > 0 && (
          <p className="subtle">
            Будет {totalPasses}{" "}
            {plural(totalPasses, "проход", "прохода", "проходов")} по{" "}
            {scope === "train" ? "train-изображениям" : "всем изображениям"}:{" "}
            {chosen.map((c) => c.name).join(", ")}.
          </p>
        )}

        <label className="modal-label">
          Отображаемое имя (необязательно)
          <input
            className="text-input"
            value={displayName}
            disabled={busy}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={
              chosen.length
                ? `${source} · ${chosen.map((c) => c.name).join(", ")}`
                : ""
            }
          />
        </label>

        {progress && <ProgressBar label={progress.label} pct={progress.pct} />}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            onClick={confirm}
            disabled={busy || selected.length === 0}
          >
            {busy ? "Создание…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
