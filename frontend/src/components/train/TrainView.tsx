import { useEffect, useRef, useState } from "react";
import {
  addModel,
  deleteTraining,
  deleteTrainingWeights,
  getTraining,
  listDevices,
  listModels,
  listTrainings,
  startTraining,
  stopTraining,
  streamTraining,
  weightsUrl,
} from "../../api";
import type {
  DatasetSummary,
  DevicesInfo,
  ModelVersion,
  TrainingRun,
  TrainingSummary,
} from "../../types";

interface Props {
  datasets: DatasetSummary[];
  available: boolean;
  focusRunId?: string;
}

// Hyperparameters exposed in the UI (key, label, default, step, hint).
const NUMERIC_PARAMS: [string, string, number, number, string][] = [
  ["epochs", "Эпохи", 50, 1,
    "Сколько полных проходов по обучающим данным. Больше — дольше обучение и обычно выше качество, но растёт риск переобучения."],
  ["imgsz", "Размер (imgsz)", 640, 32,
    "Сторона входного изображения в пикселях. Больше — лучше видны мелкие объекты, но медленнее и нужно больше памяти."],
  ["batch", "Batch", 16, 1,
    "Сколько изображений обрабатывается за один шаг. Больше — стабильнее и быстрее, но требуется больше памяти. При ошибке «CUDA out of memory» уменьшите значение (8, 4) или поставьте -1 для автоподбора под память GPU."],
  ["workers", "Workers", 4, 1,
    "Число процессов загрузки данных. Больше — быстрее готовятся батчи (особенно если датасет на медленном диске), но на GPU слишком большое значение может вызвать «CUDA out of memory». 0 — загрузка в основном процессе (медленно)."],
  ["lr0", "lr0 (нач. LR)", 0.01, 0.001,
    "Начальная скорость обучения. Слишком большая → расходимость, слишком малая → очень медленная сходимость."],
  ["lrf", "lrf (фин. LR)", 0.01, 0.001,
    "Финальная скорость обучения как доля от lr0 (в конце LR ≈ lr0·lrf). Управляет затуханием скорости обучения."],
  ["momentum", "Momentum", 0.937, 0.001,
    "Инерция оптимизатора (для SGD; beta1 для Adam). Сглаживает обновления весов и ускоряет сходимость."],
  ["weight_decay", "Weight decay", 0.0005, 0.0001,
    "L2-регуляризация весов. Больше — сильнее борьба с переобучением, но слишком большое значение ведёт к недообучению."],
  ["patience", "Patience", 100, 1,
    "Ранняя остановка: число эпох без улучшения метрики, после которого обучение прекращается."],
  ["seed", "Seed", 0, 1,
    "Зерно генератора случайных чисел для воспроизводимости результатов."],
];

const PARAM_HINTS: Record<string, string> = {
  optimizer:
    "Алгоритм оптимизации. auto подбирает сам; SGD — классический, AdamW — часто быстрее сходится.",
  cos_lr:
    "Косинусное расписание скорости обучения вместо линейного затухания.",
  single_cls:
    "Обучать как один класс (все объекты считаются одним классом) — режим «объект/фон».",
  device: "Где выполнять обучение: CPU или конкретный GPU сервера.",
};

const METRIC_COLUMNS: [string, string][] = [
  ["metrics/precision(B)", "P"],
  ["metrics/recall(B)", "R"],
  ["metrics/mAP50(B)", "mAP50"],
  ["metrics/mAP50-95(B)", "mAP50-95"],
  ["train/box_loss", "box_loss"],
  ["train/cls_loss", "cls_loss"],
];

const RUNNING = new Set(["preparing", "running"]);

export default function TrainView({ datasets, available, focusRunId }: Props) {
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [trainings, setTrainings] = useState<TrainingSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [run, setRun] = useState<TrainingRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // new-training form
  const [datasetKey, setDatasetKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [params, setParams] = useState<Record<string, number | boolean>>(() =>
    Object.fromEntries(NUMERIC_PARAMS.map(([k, , d]) => [k, d]))
  );
  const [optimizer, setOptimizer] = useState("auto");
  const [cosLr, setCosLr] = useState(false);
  const [singleCls, setSingleCls] = useState(false);
  const [devices, setDevices] = useState<DevicesInfo | null>(null);
  const [device, setDevice] = useState("cpu");

  const modelFileRef = useRef<HTMLInputElement>(null);

  // open a specific run when requested from the header activity list
  useEffect(() => {
    if (focusRunId) setSelectedId(focusRunId);
  }, [focusRunId]);

  async function reloadTrainings() {
    try {
      setTrainings(await listTrainings());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    listModels()
      .then((r) => {
        setModels(r.models);
        if (r.models[0]) setModelId(r.models[0].id);
      })
      .catch(() => {});
    listDevices()
      .then((d) => {
        setDevices(d);
        if (d.cuda_available && d.gpus[0]) setDevice(String(d.gpus[0].index));
      })
      .catch(() => {});
    reloadTrainings();
  }, []);

  useEffect(() => {
    if (datasets[0] && !datasetKey) {
      setDatasetKey(`${datasets[0].kind}:${datasets[0].name}`);
    }
  }, [datasets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stream live updates for the selected run over SSE — the server pushes each
  // epoch and per-batch step, so there is no polling. When the run ends, refresh
  // the history list to reflect its final status.
  useEffect(() => {
    if (!selectedId) {
      setRun(null);
      return;
    }
    let prevStatus: string | undefined;
    const close = streamTraining(
      selectedId,
      (r) => {
        setRun(r);
        // keep the left-hand list in sync on status transitions without polling
        if (r.status !== prevStatus) {
          prevStatus = r.status;
          reloadTrainings();
        }
      },
      reloadTrainings
    );
    return close;
  }, [selectedId]);

  async function handleStart() {
    const [kind, ...rest] = datasetKey.split(":");
    const name = rest.join(":");
    if (!kind || !name || !modelId) return;
    setBusy(true);
    setError(null);
    try {
      const all: Record<string, number | string | boolean> = { ...params };
      all.optimizer = optimizer;
      all.cos_lr = cosLr;
      all.single_cls = singleCls;
      const { id } = await startTraining({
        dataset_kind: kind as DatasetSummary["kind"],
        dataset_name: name,
        model_id: modelId,
        device,
        params: all,
      });
      await reloadTrainings();
      setSelectedId(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(id: string) {
    try {
      await stopTraining(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDeleteRun(id: string) {
    if (!window.confirm("Удалить это обучение вместе с весами?")) return;
    try {
      await deleteTraining(id);
      if (selectedId === id) setSelectedId(null);
      await reloadTrainings();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDeleteWeights(id: string) {
    if (!window.confirm("Удалить веса этой модели с сервера?")) return;
    try {
      await deleteTrainingWeights(id);
      const r = await getTraining(id);
      setRun(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleAddModel(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await addModel(file, file.name);
      const r = await listModels();
      setModels(r.models);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="augment-view">
      {!available && (
        <div className="warn-banner">
          ⚠ ultralytics недоступна на сервере — обучение отключено.
        </div>
      )}
      {error && <div className="error-banner inline">{error}</div>}

      <div className="train-layout">
        {/* history */}
        <div className="aug-col train-history">
          <button
            className="btn btn-primary block"
            onClick={() => setSelectedId(null)}
          >
            Новое обучение
          </button>
          <div className="group-header">История</div>
          <ul className="dataset-list">
            {trainings.length === 0 && <li className="empty">пока пусто</li>}
            {trainings.map((t) => (
              <li
                key={t.id}
                className={
                  t.id === selectedId ? "dataset-item active" : "dataset-item"
                }
                onClick={() => setSelectedId(t.id)}
              >
                <div className="dataset-info">
                  <span className="dataset-name">
                    <StatusDot status={t.status} /> {t.model_name}
                  </span>
                  <span className="dataset-meta">
                    {t.dataset_name} · {t.current_epoch}/{t.epochs} эп. ·{" "}
                    {deviceLabel(t.device)}
                  </span>
                </div>
                <button
                  className="del-btn"
                  title="Удалить обучение"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteRun(t.id);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* main */}
        <div className="train-main">
          {selectedId && run ? (
            <RunDetail
              run={run}
              onStop={() => handleStop(run.id)}
              onDeleteWeights={() => handleDeleteWeights(run.id)}
              onDelete={() => handleDeleteRun(run.id)}
            />
          ) : (
            <div className="aug-col">
              <h3 className="section-title" style={{ marginTop: 0 }}>
                Новое обучение
              </h3>
              <div className="form-grid">
                <label className="modal-label">
                  Датасет
                  <select
                    className="text-input"
                    value={datasetKey}
                    onChange={(e) => setDatasetKey(e.target.value)}
                  >
                    {datasets.length === 0 && <option value="">нет датасетов</option>}
                    {datasets.map((d) => (
                      <option key={`${d.kind}:${d.name}`} value={`${d.kind}:${d.name}`}>
                        {d.kind === "augmented" ? "[аугм.] " : "[датасет] "}
                        {d.display_name || d.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-label">
                  Версия модели
                  <div className="select-with-add">
                    <select
                      className="text-input"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                    >
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="icon-add"
                      title="Добавить свою модель (.pt или .yaml) на сервер"
                      onClick={() => modelFileRef.current?.click()}
                    >
                      +
                    </button>
                  </div>
                </label>
                <label className="modal-label">
                  Устройство <Hint text={PARAM_HINTS.device} />
                  <select
                    className="text-input"
                    value={device}
                    onChange={(e) => setDevice(e.target.value)}
                  >
                    <option value="cpu">CPU</option>
                    {devices?.gpus.map((g) => (
                      <option key={g.index} value={String(g.index)}>
                        GPU {g.index}: {g.name}
                      </option>
                    ))}
                  </select>
                  {!devices?.cuda_available && (
                    <span className="subtle">
                      GPU не обнаружен — нужен GPU-образ (см. README) и
                      NVIDIA-драйверы.
                    </span>
                  )}
                </label>
              </div>
              <input
                ref={modelFileRef}
                type="file"
                accept=".pt,.yaml,.yml"
                hidden
                onChange={handleAddModel}
              />

              <div className="group-header" style={{ paddingLeft: 0 }}>
                Гиперпараметры
              </div>
              <div className="param-grid">
                {NUMERIC_PARAMS.map(([key, label, , step, hint]) => (
                  <label className="param" key={key}>
                    <span className="param-name">
                      {label} <Hint text={hint} />
                    </span>
                    <input
                      className="text-input sm"
                      type="number"
                      step={step}
                      value={String(params[key])}
                      onChange={(e) =>
                        setParams((p) => ({ ...p, [key]: Number(e.target.value) }))
                      }
                    />
                  </label>
                ))}
                <label className="param">
                  <span className="param-name">
                    Optimizer <Hint text={PARAM_HINTS.optimizer} />
                  </span>
                  <select
                    className="text-input sm"
                    value={optimizer}
                    onChange={(e) => setOptimizer(e.target.value)}
                  >
                    {["auto", "SGD", "Adam", "AdamW", "RMSProp"].map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="param param-bool">
                  <input
                    type="checkbox"
                    checked={cosLr}
                    onChange={(e) => setCosLr(e.target.checked)}
                  />
                  <span className="param-name">
                    cos_lr <Hint text={PARAM_HINTS.cos_lr} />
                  </span>
                </label>
                <label className="param param-bool">
                  <input
                    type="checkbox"
                    checked={singleCls}
                    onChange={(e) => setSingleCls(e.target.checked)}
                  />
                  <span className="param-name">
                    single_cls <Hint text={PARAM_HINTS.single_cls} />
                  </span>
                </label>
              </div>

              <p className="subtle">
                Все аугментации YOLO принудительно отключены при обучении.
              </p>

              <button
                className="btn btn-primary"
                onClick={handleStart}
                disabled={busy || !available || !datasetKey || !modelId}
              >
                {busy ? "Запуск…" : "Запустить обучение"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${status}`} />;
}

function Hint({ text }: { text: string }) {
  return (
    <span className="hint" tabIndex={0}>
      ?<span className="hint-tip">{text}</span>
    </span>
  );
}

function fmt(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "—";
  return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4);
}

function batchPct(run: TrainingRun): number {
  if (!run.total_batches) return 0;
  return Math.min(1, (run.current_batch ?? 0) / run.total_batches);
}

function valPct(run: TrainingRun): number {
  if (!run.val_total) return 0;
  return Math.min(1, (run.val_batch ?? 0) / run.val_total);
}

function RunDetail({
  run,
  onStop,
  onDeleteWeights,
  onDelete,
}: {
  run: TrainingRun;
  onStop: () => void;
  onDeleteWeights: () => void;
  onDelete: () => void;
}) {
  const running = RUNNING.has(run.status);
  const pct = run.epochs ? Math.min(1, run.current_epoch / run.epochs) : 0;
  const maps = run.metrics.map((m) => m["metrics/mAP50(B)"] ?? 0);
  const maxMap = Math.max(0.0001, ...maps);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(
    null
  );

  return (
    <div className="aug-col">
      <div className="stats-head">
        <div>
          <h3 className="section-title" style={{ marginTop: 0 }}>
            <StatusDot status={run.status} /> {run.model_name}
          </h3>
          <p className="subtle">
            {run.dataset_name} · {deviceLabel(run.device)} ·{" "}
            {statusLabel(run.status)}
            {run.message ? ` · ${run.message}` : ""}
          </p>
        </div>
        <div className="row-actions">
          {running && (
            <button className="btn" onClick={onStop}>
              Остановить
            </button>
          )}
          {run.has_weights && (
            <>
              <a className="btn btn-primary" href={weightsUrl(run.id)}>
                Скачать best.pt
              </a>
              <button className="btn btn-danger" onClick={onDeleteWeights}>
                Удалить веса
              </button>
            </>
          )}
          <button className="btn btn-danger" onClick={onDelete}>
            Удалить
          </button>
        </div>
      </div>

      {run.error && <div className="error-banner inline">{run.error}</div>}

      <div className="progress">
        <div className="progress-label">
          <span>
            Эпоха {run.current_epoch} / {run.epochs}
          </span>
          <span>{Math.round(pct * 100)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
        </div>
      </div>

      {/* live per-iteration progress inside the current epoch (like YOLO's bar).
          During the post-epoch validation pass it switches to the val counter so
          the wait is explainable instead of looking like a hang. */}
      {running && run.phase === "val" ? (
        <div className="progress">
          <div className="progress-label">
            <span>
              Валидация {run.val_batch ?? 0}
              {run.val_total ? ` / ${run.val_total}` : ""}
            </span>
            <span>{Math.round(valPct(run) * 100)}%</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill val"
              style={{ width: `${valPct(run) * 100}%` }}
            />
          </div>
        </div>
      ) : running && run.total_batches ? (
        <div className="progress">
          <div className="progress-label">
            <span>
              Итерация {run.current_batch ?? 0} / {run.total_batches}
              {run.batch_rate ? ` · ${run.batch_rate.toFixed(1)} it/s` : ""}
            </span>
            <span>{Math.round(batchPct(run) * 100)}%</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ width: `${batchPct(run) * 100}%` }}
            />
          </div>
          {run.batch_metrics && (
            <p className="subtle" style={{ margin: "4px 0 0" }}>
              box {fmt(run.batch_metrics.box_loss)} · cls{" "}
              {fmt(run.batch_metrics.cls_loss)} · dfl{" "}
              {fmt(run.batch_metrics.dfl_loss)}
            </p>
          )}
        </div>
      ) : null}

      {/* mAP50 per epoch mini chart */}
      {maps.length > 0 && (
        <>
          <div className="group-header" style={{ paddingLeft: 0 }}>
            mAP50 по эпохам
          </div>
          <div className="bars-wrap">
            <div className="bars">
              {run.metrics.map((m) => (
                <div
                  className="bars-col"
                  key={m.epoch}
                  onMouseMove={(e) => {
                    const wrap = e.currentTarget.closest(
                      ".bars-wrap"
                    ) as HTMLElement | null;
                    if (!wrap) return;
                    const r = wrap.getBoundingClientRect();
                    setTip({
                      x: e.clientX - r.left,
                      y: e.clientY - r.top,
                      text: `эпоха ${m.epoch} · mAP50 ${fmt(
                        m["metrics/mAP50(B)"]
                      )}`,
                    });
                  }}
                  onMouseLeave={() => setTip(null)}
                >
                  <div
                    className="bars-bar"
                    style={{
                      height: `${
                        ((m["metrics/mAP50(B)"] ?? 0) / maxMap) * 100
                      }%`,
                    }}
                  />
                </div>
              ))}
            </div>
            {tip && (
              <div
                className="bars-tip"
                style={{ left: tip.x, top: tip.y }}
              >
                {tip.text}
              </div>
            )}
          </div>
        </>
      )}

      <div className="group-header" style={{ paddingLeft: 0 }}>
        Метрики по эпохам
      </div>
      <div className="table-scroll">
        <table className="stats-table">
          <thead>
            <tr>
              <th>Эпоха</th>
              {METRIC_COLUMNS.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...run.metrics].reverse().map((m) => (
              <tr key={m.epoch}>
                <td className="mono">{m.epoch}</td>
                {METRIC_COLUMNS.map(([key]) => (
                  <td key={key}>{fmt(m[key])}</td>
                ))}
              </tr>
            ))}
            {run.metrics.length === 0 && (
              <tr>
                <td colSpan={METRIC_COLUMNS.length + 1} className="subtle">
                  {running ? "ожидание первой эпохи…" : "нет данных"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function deviceLabel(device?: string): string {
  if (!device || device === "cpu") return "CPU";
  return `GPU ${device}`;
}

function statusLabel(s: string): string {
  return (
    {
      preparing: "подготовка",
      running: "обучение",
      done: "завершено",
      stopped: "остановлено",
      error: "ошибка",
    }[s] || s
  );
}
