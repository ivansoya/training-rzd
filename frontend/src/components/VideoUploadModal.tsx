import { useRef, useState } from "react";
import ProgressBar from "./ProgressBar";
import type { Progress } from "../types";

interface Props {
  catalogs: string[];
  onUpload: (
    file: File,
    catalog: string,
    onProgress: (p: Progress) => void
  ) => Promise<void>;
  onClose: () => void;
}

const NEW = "__new__";

export default function VideoUploadModal({ catalogs, onUpload, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [choice, setChoice] = useState(catalogs[0] ?? NEW);
  const [newCatalog, setNewCatalog] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);

  const busy = progress !== null;
  const isNew = choice === NEW || catalogs.length === 0;
  const catalog = (isNew ? newCatalog.trim() : choice) || "Общий";

  async function confirm() {
    if (!file) return;
    setProgress({ label: "Подготовка…", pct: null });
    try {
      await onUpload(file, catalog, setProgress);
      // success: parent closes the modal
    } catch {
      setProgress(null); // error shown by parent banner
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Добавить видео</h3>

        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setFile(f);
          }}
        />
        <button
          className="file-pick"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <span className="file-pick-icon">⭳</span>
          <span>{file ? file.name : "Выбрать видеофайл"}</span>
        </button>

        {catalogs.length > 0 && (
          <label className="modal-label">
            Каталог (проект)
            <select
              className="text-input"
              value={choice}
              disabled={busy}
              onChange={(e) => setChoice(e.target.value)}
            >
              {catalogs.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={NEW}>+ Новый каталог…</option>
            </select>
          </label>
        )}

        {isNew && (
          <label className="modal-label">
            {catalogs.length > 0 ? "Название нового каталога" : "Каталог (проект)"}
            <input
              className="text-input"
              value={newCatalog}
              disabled={busy}
              onChange={(e) => setNewCatalog(e.target.value)}
              placeholder="Общий"
            />
          </label>
        )}

        {progress && <ProgressBar label={progress.label} pct={progress.pct} />}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            onClick={confirm}
            disabled={busy || !file}
          >
            {busy ? "Загрузка…" : "Добавить"}
          </button>
        </div>
      </div>
    </div>
  );
}
