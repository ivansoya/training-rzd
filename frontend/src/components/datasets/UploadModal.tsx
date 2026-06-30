import { useRef, useState } from "react";

interface Props {
  // Fire-and-forget: the parent closes the modal immediately and tracks
  // progress in the header, so uploading does not block the UI.
  onUpload: (file: File, name: string) => void;
  onClose: () => void;
}

export default function UploadModal({ onUpload, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      if (!name) setName(f.name.replace(/\.zip$/i, ""));
    }
  }

  function confirm() {
    if (!file || !name.trim()) return;
    onUpload(file, name.trim()); // parent closes the modal + shows progress in header
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Загрузка датасета</h3>
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          hidden
          onChange={onFileChosen}
        />
        <button className="btn block" onClick={() => inputRef.current?.click()}>
          {file ? `Файл: ${file.name}` : "Выбрать .zip архив"}
        </button>
        <label className="modal-label">
          Название датасета
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Мой датасет"
          />
        </label>

        <p className="subtle">
          Загрузка идёт в фоне — окно закроется, а прогресс будет виден в шапке.
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-primary"
            onClick={confirm}
            disabled={!file || !name.trim()}
          >
            Загрузить
          </button>
        </div>
      </div>
    </div>
  );
}
