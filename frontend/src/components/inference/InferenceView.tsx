import { useEffect, useMemo, useState } from "react";
import ProgressBar from "../common/ProgressBar";
import CollapsibleSection from "../common/CollapsibleSection";
import VideoUploadModal from "./VideoUploadModal";
import {
  deleteInference,
  deleteVideo,
  getInference,
  inferenceVideoUrl,
  listInferenceModels,
  listInferences,
  listVideos,
  startInference,
  uploadVideo,
  videoFileUrl,
} from "../../api";
import type {
  InferenceRun,
  InferenceSummary,
  Progress,
  TrainedModel,
  VideoItem,
} from "../../types";

interface Props {
  available: boolean;
}

const PROCESSING = "processing";

export default function InferenceView({ available }: Props) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [models, setModels] = useState<TrainedModel[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reloadVideos() {
    try {
      setVideos(await listVideos());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    listInferenceModels()
      .then((r) => setModels(r.models))
      .catch(() => {});
    reloadVideos();
  }, []);

  const selectedVideo = useMemo(
    () => videos.find((v) => v.id === selectedVideoId) || null,
    [videos, selectedVideoId]
  );

  const byCatalog = useMemo(() => {
    const m: Record<string, VideoItem[]> = {};
    for (const v of videos) (m[v.catalog] ||= []).push(v);
    return m;
  }, [videos]);

  const catalogNames = useMemo(
    () => Object.keys(byCatalog).sort((a, b) => a.localeCompare(b, "ru")),
    [byCatalog]
  );

  async function handleUpload(
    file: File,
    catalog: string,
    onProgress: (p: Progress) => void
  ) {
    try {
      const v = await uploadVideo(file, catalog, (pct) =>
        onProgress(
          pct >= 0.999
            ? { label: "Передача видео на сервер…", pct: null }
            : { label: "Загрузка видео", pct }
        )
      );
      setShowAdd(false);
      await reloadVideos();
      setSelectedVideoId(v.id);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }

  async function handleDeleteVideo(id: string) {
    if (
      !window.confirm(
        "Удалить это видео? Все его проверки моделями тоже будут удалены."
      )
    )
      return;
    try {
      await deleteVideo(id);
      if (selectedVideoId === id) setSelectedVideoId(null);
      await reloadVideos();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="augment-view">
      {!available && (
        <div className="warn-banner">
          ultralytics недоступна на сервере — обработка моделью отключена, но
          видео можно загружать и просматривать.
        </div>
      )}
      {error && <div className="error-banner inline">{error}</div>}

      {selectedVideo ? (
        <section className="content">
          <button
            className="back-btn"
            onClick={() => setSelectedVideoId(null)}
            title="К списку видео"
          >
            <span className="back-ico">←</span> Назад
          </button>
          <VideoDetail
            key={selectedVideo.id}
            video={selectedVideo}
            models={models}
            available={available}
            onDeleteVideo={() => handleDeleteVideo(selectedVideo.id)}
            onError={setError}
          />
        </section>
      ) : (
        <section className="content">
          <div className="tile-grid">
            <button className="tile tile-add" onClick={() => setShowAdd(true)}>
              <span className="tile-add-plus">+</span>
              <span>Добавить видео</span>
            </button>
          </div>

          {videos.length === 0 && (
            <div className="tile-empty">видео пока нет</div>
          )}
          {catalogNames.map((cat) => (
            <CollapsibleSection
              key={cat}
              title={cat}
              count={byCatalog[cat].length}
            >
              {byCatalog[cat].map((v) => (
                <VideoTile
                  key={v.id}
                  video={v}
                  onSelect={() => setSelectedVideoId(v.id)}
                  onDelete={() => handleDeleteVideo(v.id)}
                />
              ))}
            </CollapsibleSection>
          ))}
        </section>
      )}

      {showAdd && (
        <VideoUploadModal
          catalogs={catalogNames}
          onUpload={handleUpload}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

function VideoTile({
  video,
  onSelect,
  onDelete,
}: {
  video: VideoItem;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="tile video-tile" onClick={onSelect}>
      <button
        className="tile-del"
        title="Удалить видео"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ✕
      </button>
      <video
        className="video-thumb"
        src={`${videoFileUrl(video.id)}#t=0.1`}
        muted
        preload="metadata"
        playsInline
      />
      <div className="tile-meta">
        {new Date(video.created_at * 1000).toLocaleString("ru-RU")}
      </div>
    </div>
  );
}

function VideoDetail({
  video,
  models,
  available,
  onDeleteVideo,
  onError,
}: {
  video: VideoItem;
  models: TrainedModel[];
  available: boolean;
  onDeleteVideo: () => void;
  onError: (m: string) => void;
}) {
  const [runs, setRuns] = useState<InferenceSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<InferenceRun | null>(null);
  const [modelRunId, setModelRunId] = useState("");
  const [busy, setBusy] = useState(false);

  async function reloadRuns() {
    try {
      const list = await listInferences(video.id);
      setRuns(list);
      return list;
    } catch (e) {
      onError((e as Error).message);
      return [];
    }
  }

  useEffect(() => {
    if (models[0]) setModelRunId(models[0].run_id);
    reloadRuns();
  }, [video.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the run list while anything is processing.
  useEffect(() => {
    if (!runs.some((r) => r.status === PROCESSING)) return;
    const h = setInterval(reloadRuns, 2500);
    return () => clearInterval(h);
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the selected run while it is processing.
  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }
    let active = true;
    const tick = async () => {
      try {
        const r = await getInference(selectedRunId);
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
  }, [selectedRunId]);

  async function handleRun() {
    if (!modelRunId) return;
    setBusy(true);
    onError("");
    try {
      const { id } = await startInference({
        video_id: video.id,
        model_run_id: modelRunId,
      });
      await reloadRuns();
      setSelectedRunId(id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRun(id: string) {
    if (!window.confirm("Удалить эту проверку?")) return;
    try {
      await deleteInference(id);
      if (selectedRunId === id) setSelectedRunId(null);
      await reloadRuns();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="aug-col">
      <div className="stats-head">
        <div>
          <h3 className="section-title" style={{ marginTop: 0 }}>
            {video.name}
          </h3>
          <p className="subtle">
            каталог «{video.catalog}» · {fmtSize(video.size)}
          </p>
        </div>
        <div className="row-actions">
          <a className="btn" href={videoFileUrl(video.id)} download={video.name}>
            Скачать
          </a>
          <button className="btn btn-danger" onClick={onDeleteVideo}>
            Удалить видео
          </button>
        </div>
      </div>

      <video
        className="result-video"
        src={videoFileUrl(video.id)}
        controls
        playsInline
      />

      <h3 className="section-title">Проверить моделью</h3>
      {models.length === 0 ? (
        <p className="subtle">
          Нет обученных моделей с весами. Обучите модель в разделе «Обучение
          моделей», чтобы прогнать это видео через неё.
        </p>
      ) : (
        <div className="inline-form">
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
          <button
            className="btn btn-primary"
            onClick={handleRun}
            disabled={!available || !modelRunId || busy}
          >
            Запустить инференс
          </button>
        </div>
      )}

      {runs.length > 0 && (
        <>
          <h3 className="section-title">Результаты проверки</h3>
          <ul className="dataset-list">
            {runs.map((r) => (
              <li
                key={r.id}
                className={
                  r.id === selectedRunId ? "dataset-item active" : "dataset-item"
                }
                onClick={() => setSelectedRunId(r.id)}
              >
                <div className="dataset-info">
                  <span className="dataset-name">
                    <StatusDot status={r.status} /> {r.model_name}
                  </span>
                  <span className="dataset-meta">
                    {r.status === "done"
                      ? `${r.total_detections ?? 0} детекций · ${new Date(
                          r.created_at * 1000
                        ).toLocaleString("ru-RU")}`
                      : statusLabel(r.status)}
                  </span>
                </div>
                <button
                  className="del-btn"
                  title="Удалить проверку"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteRun(r.id);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {run && <RunResult run={run} />}
    </div>
  );
}

function RunResult({ run }: { run: InferenceRun }) {
  const processing = run.status === PROCESSING;
  const pct = run.total_frames ? run.processed_frames / run.total_frames : null;
  const s = run.stats;

  return (
    <div className="run-result">
      <p className="subtle">
        Обработано моделью «{run.model_name}»
        {run.dataset_name ? ` · ${run.dataset_name}` : ""} ·{" "}
        {statusLabel(run.status)}
      </p>

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
        <>
          <video
            className="result-video"
            src={inferenceVideoUrl(run.id)}
            controls
            playsInline
          />
          <div className="row-actions">
            <a className="btn" href={inferenceVideoUrl(run.id)} download>
              Скачать результат
            </a>
          </div>
        </>
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
  return { processing: "обработка", done: "готово", error: "ошибка" }[s] || s;
}

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`;
  return `${mb.toFixed(1)} МБ`;
}
