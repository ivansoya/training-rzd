import { useEffect, useRef, useState } from "react";
import ProgressBar from "./ProgressBar";
import {
  deleteInference,
  getInference,
  inferenceInputUrl,
  inferenceVideoUrl,
  listInferenceModels,
  listInferences,
  startInference,
} from "../api";
import type {
  InferenceRun,
  InferenceSummary,
  Progress,
  TrainedModel,
} from "../types";

interface Props {
  available: boolean;
  onBack: () => void;
}

const PROCESSING = "processing";

export default function InferenceView({ available, onBack }: Props) {
  const [models, setModels] = useState<TrainedModel[]>([]);
  const [runs, setRuns] = useState<InferenceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<InferenceRun | null>(null);
  const [modelRunId, setModelRunId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  async function reloadRuns() {
    try {
      setRuns(await listInferences());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    listInferenceModels()
      .then((r) => {
        setModels(r.models);
        if (r.models[0]) setModelRunId(r.models[0].run_id);
      })
      .catch(() => {});
    reloadRuns();
  }, []);

  // Poll history while anything is processing.
  useEffect(() => {
    if (!runs.some((r) => r.status === PROCESSING)) return;
    const h = setInterval(reloadRuns, 2500);
    return () => clearInterval(h);
  }, [runs]);

  // Poll the selected run while it is processing.
  useEffect(() => {
    if (!selectedId) {
      setRun(null);
      return;
    }
    let active = true;
    const tick = async () => {
      try {
        const r = await getInference(selectedId);
        if (!active) return;
        setRun(r);
        if (r.status !== PROCESSING) clearInterval(h);
      } catch {
        /* ignore */
      }
    };
    tick();
    const h = setInterval(tick, 1500);
    return () => {
      active = false;
      clearInterval(h);
    };
  }, [selectedId]);

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  }

  async function handleStart() {
    if (!file || !modelRunId) return;
    setError(null);
    setProgress({ label: "Загрузка видео", pct: 0 });
    try {
      const { id } = await startInference(file, modelRunId, (pct) =>
        setProgress(
          pct >= 0.999
            ? { label: "Передача видео на сервер…", pct: null }
            : { label: "Загрузка видео", pct }
        )
      );
      setProgress(null);
      setFile(null);
      await reloadRuns();
      setSelectedId(id);
    } catch (e) {
      setError((e as Error).message);
      setProgress(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Удалить эту проверку и её видео?")) return;
    try {
      await deleteInference(id);
      if (selectedId === id) setSelectedId(null);
      await reloadRuns();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // group history by model
  const grouped: Record<string, InferenceSummary[]> = {};
  for (const r of runs) {
    (grouped[r.model_name] ||= []).push(r);
  }

  return (
    <div className="augment-view">
      <div className="aug-bar">
        <button className="btn" onClick={onBack}>
          Назад к датасетам
        </button>
        <h2>Проверка моделей</h2>
      </div>

      {!available && (
        <div className="warn-banner">
          ultralytics недоступна на сервере — инференс отключён.
        </div>
      )}
      {error && <div className="error-banner inline">{error}</div>}

      <div className="train-layout">
        <div className="aug-col train-history">
          <button className="btn btn-primary block" onClick={() => setSelectedId(null)}>
            Новая проверка
          </button>
          {Object.keys(grouped).length === 0 && (
            <div className="empty">история пуста</div>
          )}
          {Object.entries(grouped).map(([model, list]) => (
            <div className="group" key={model}>
              <div className="group-header">{model}</div>
              <ul className="dataset-list">
                {list.map((r) => (
                  <li
                    key={r.id}
                    className={r.id === selectedId ? "dataset-item active" : "dataset-item"}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <div className="dataset-info">
                      <span className="dataset-name">
                        <StatusDot status={r.status} /> {r.input_name}
                      </span>
                      <span className="dataset-meta">
                        {r.status === "done"
                          ? `${r.total_detections ?? 0} детекций`
                          : statusLabel(r.status)}
                      </span>
                    </div>
                    <button
                      className="del-btn"
                      title="Удалить проверку"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(r.id);
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="train-main">
          {selectedId && run ? (
            <RunDetail run={run} onDelete={() => handleDelete(run.id)} />
          ) : (
            <div className="aug-col">
              <h3 className="section-title" style={{ marginTop: 0 }}>
                Новая проверка модели
              </h3>
              {models.length === 0 ? (
                <p className="subtle">
                  Нет обученных моделей с весами. Сначала обучите модель в разделе
                  «Обучение моделей».
                </p>
              ) : (
                <>
                  <label className="modal-label">
                    Модель
                    <select
                      className="text-input"
                      value={modelRunId}
                      onChange={(e) => setModelRunId(e.target.value)}
                    >
                      {models.map((m) => (
                        <option key={m.run_id} value={m.run_id}>
                          {m.model_name} · {m.dataset_name} ·{" "}
                          {new Date(m.created_at * 1000).toLocaleDateString("ru-RU")}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="modal-label">
                    Видео
                    <input
                      ref={fileRef}
                      type="file"
                      accept="video/*"
                      hidden
                      onChange={pickFile}
                    />
                    <button
                      className="btn block"
                      onClick={() => fileRef.current?.click()}
                      disabled={progress !== null}
                    >
                      {file ? file.name : "Выбрать видеофайл"}
                    </button>
                  </label>

                  {progress && <ProgressBar {...progress} />}

                  <button
                    className="btn btn-primary"
                    onClick={handleStart}
                    disabled={!available || !file || !modelRunId || progress !== null}
                  >
                    Запустить инференс
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunDetail({
  run,
  onDelete,
}: {
  run: InferenceRun;
  onDelete: () => void;
}) {
  const processing = run.status === PROCESSING;
  const pct = run.total_frames ? run.processed_frames / run.total_frames : null;
  const s = run.stats;

  return (
    <div className="aug-col">
      <div className="stats-head">
        <div>
          <h3 className="section-title" style={{ marginTop: 0 }}>
            <StatusDot status={run.status} /> {run.input_name}
          </h3>
          <p className="subtle">
            модель «{run.model_name}»
            {run.dataset_name ? ` · ${run.dataset_name}` : ""} ·{" "}
            {statusLabel(run.status)}
          </p>
        </div>
        <div className="row-actions">
          {run.has_output && (
            <a className="btn" href={inferenceVideoUrl(run.id)} download>
              Скачать результат
            </a>
          )}
          <a className="btn" href={inferenceInputUrl(run.id)} download>
            Исходное видео
          </a>
          <button className="btn btn-danger" onClick={onDelete}>
            Удалить
          </button>
        </div>
      </div>

      {run.error && <div className="error-banner inline">{run.error}</div>}

      {processing && (
        <ProgressBar
          label={
            run.total_frames
              ? `Обработка кадров ${run.processed_frames}/${run.total_frames}`
              : "Обработка видео…"
          }
          pct={pct}
          spinner={!run.total_frames}
        />
      )}

      {run.has_output && (
        <video
          className="result-video"
          src={inferenceVideoUrl(run.id)}
          controls
          playsInline
        />
      )}

      {s && (
        <>
          <div className="cards">
            <Card label="Кадров" value={s.total_frames} />
            <Card label="Детекций" value={s.total_detections} />
            <Card label="Кадров с детекцией" value={s.frames_with_detections} />
            <Card label="Детекций/кадр" value={s.avg_detections_per_frame} />
          </div>

          <p className="subtle">
            {s.width}×{s.height} · {s.fps} fps · {s.duration} c · инференс на{" "}
            {s.device.toUpperCase()}
          </p>

          <h3 className="section-title">Детекции по классам</h3>
          <table className="stats-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Класс</th>
                <th>Детекций</th>
                <th>Ср. уверенность</th>
              </tr>
            </thead>
            <tbody>
              {s.per_class.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.id}</td>
                  <td>{c.name}</td>
                  <td>{c.count}</td>
                  <td>{c.avg_conf.toFixed(3)}</td>
                </tr>
              ))}
              {s.per_class.length === 0 && (
                <tr>
                  <td colSpan={4} className="subtle">
                    объектов не обнаружено
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="card-value">{value.toLocaleString("ru-RU")}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${status}`} />;
}

function statusLabel(s: string): string {
  return (
    { processing: "обработка", done: "готово", error: "ошибка" }[s] || s
  );
}
