import { useRef, useState } from "react";
import ProgressBar from "../common/ProgressBar";
import type { Progress } from "../../types";

interface Props {
  onUpload: (
    file: File,
    name: string,
    onProgress: (p: Progress) => void
  ) => Promise<void>;
  onClose: () => void;
}

export default function UploadModal({ onUpload, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);

  const busy = progress !== null;

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      if (!name) setName(f.name.replace(/\.zip$/i, ""));
    }
  }

  async function confirm() {
    if (!file) return;
    setProgress({ label: "Подготовка…", pct: null });
    try {
      await onUpload(file, name.trim(), setProgress);
      // success: parent closes the modal
    } catch {
      setProgress(null); // error shown by parent banner
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Загрузка датасета</h3>
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          hidden
          onChange={onFileChosen}
        />
        <button
          className="btn block"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {file ? `Файл: ${file.name}` : "Выбрать .zip архив"}
        </button>
        <label className="modal-label">
          Название датасета
          <input
            className="text-input"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-dataset"
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
            disabled={busy || !file || !name.trim()}
          >
            {busy ? "Загрузка…" : "Загрузить"}
          </button>
        </div>
      </div>
    </div>
  );
}
