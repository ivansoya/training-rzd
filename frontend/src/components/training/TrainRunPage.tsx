// Экран одного обучения: что идёт прямо сейчас и что вышло в конце.

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import * as runsApi from "../../api/runs";
import type { EpochRow, Run } from "../../api/runs";
import { useLive } from "../../live/LiveProvider";
import { ClassMetrics, ConfusionMatrix, CurveChart, LossChart, MetricChart } from "./Charts";

const ru = (n: number) => Math.round(n).toLocaleString("ru-RU");

// Подписи параметров — словами, а не ключами ultralytics. Аугментации
// показываются только когда они включены: ряд нулей ничего не говорит.
const PARAM_LABEL: Record<string, string> = {
  epochs: "эпох",
  imgsz: "размер входа",
  batch: "батч",
  pretrained: "предобученные веса",
  weights: "файл весов",
  patience: "стоп без улучшения, эпох",
  optimizer: "оптимизатор",
  lr0: "скорость обучения",
  lrf: "конечная доля скорости",
  momentum: "момент",
  weight_decay: "затухание весов",
  warmup_epochs: "разогрев, эпох",
  cos_lr: "косинусный график",
  freeze: "заморожено слоёв",
  dropout: "dropout",
  label_smoothing: "сглаживание меток",
  seed: "зерно",
  workers: "загрузчиков",
  augment_mode: "аугментации",
  hsv_h: "тон (hsv_h)",
  hsv_s: "насыщенность (hsv_s)",
  hsv_v: "яркость (hsv_v)",
  degrees: "поворот, °",
  translate: "сдвиг",
  scale: "масштаб",
  shear: "скос, °",
  perspective: "перспектива",
  flipud: "отражение по вертикали",
  fliplr: "отражение по горизонтали",
  bgr: "перестановка каналов",
  mosaic: "мозаика",
  mixup: "mixup",
  copy_paste: "copy-paste",
  close_mosaic: "мозаика выкл. за N эпох до конца",
};
const AUG_KEYS = new Set([
  "hsv_h", "hsv_s", "hsv_v", "degrees", "translate", "scale", "shear",
  "perspective", "flipud", "fliplr", "bgr", "mosaic", "mixup", "copy_paste",
  "close_mosaic",
]);
const AUG_MODE: Record<string, string> = {
  yolo: "встроенные YOLO",
  off: "выключены",
  graph: "из графа набора",
};

function paramText(key: string, value: unknown): string {
  if (key === "augment_mode") return AUG_MODE[String(value)] ?? String(value);
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (key === "patience" && value === 0) return "не останавливать";
  return String(value);
}

const LOOK: Record<string, [string, string]> = {
  queued: ["wait", "в очереди"],
  waiting_gpu: ["wait", "ждёт видеокарту"],
  preparing: ["run", "готовится"],
  running: ["run", "идёт"],
  stopping: ["wait", "останавливается"],
  done: ["ok", "готово"],
  stopped: ["idle", "остановлено"],
  error: ["bad", "ошибка"],
};

function left(run: Run, epochs: EpochRow[]) {
  const timed = epochs.filter((e) => e.seconds);
  if (!timed.length || run.current_epoch >= run.epochs) return null;
  // Считаем по последним пяти: первая эпоха всегда медленнее остальных, и
  // среднее по всем врёт в начале сильнее всего.
  const recent = timed.slice(-5);
  const per = recent.reduce((a, e) => a + (e.seconds ?? 0), 0) / recent.length;
  const secs = per * (run.epochs - run.current_epoch);
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

export default function TrainRunPage() {
  const { code, runId } = useParams<{ code: string; runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [epochs, setEpochs] = useState<EpochRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!code || !runId) return;
    try {
      const got = await runsApi.getRun(code, runId);
      setRun(got);
      const rows = await runsApi.runEpochs(code, runId);
      setEpochs(rows.epochs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code, runId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useLive("run", (event) => {
    if (event.id === runId || event.k === "*") refresh();
  });

  useEffect(() => {
    if (!run || ["done", "error", "stopped"].includes(run.status)) return;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [run, refresh]);

  if (error) return <div className="mag-error">{error}</div>;
  if (!run) return <div className="mag-empty">Загружаем обучение…</div>;

  const [look, label] = LOOK[run.status] ?? ["idle", run.status];
  const busy = ["running", "preparing", "stopping"].includes(run.status);
  const eta = left(run, epochs);

  return (
    <div className="t-run">
      <div>
        <div className="t-run-head">
          <Link to={`/projects/${code}/training?tab=runs`} className="g-ctx-back">
            ←
          </Link>
          <h2>{run.name}</h2>
          <span className={`t-pill ${look}`}>
            <i />
            {label}
            {busy && ` · эпоха ${run.current_epoch} из ${run.epochs}`}
          </span>
        </div>

        <div className="t-run-sub">
          {run.base_model} · набор <b>{run.set?.name ?? "удалён"}</b> ·{" "}
          {run.device === "cpu" ? "процессор" : `карта ${run.device}`}
          {run.author ? ` · запустил ${run.author}` : ""}
          {eta && <> · осталось примерно <b>{eta}</b></>}
        </div>

        {run.status === "waiting_gpu" && run.queue_reason && (
          <div className="t-warn">{run.queue_reason}</div>
        )}
        {run.error && <div className="mag-error">{run.error}</div>}

        {!busy && run.summary?.stopped_early ? (
          <div className="t-warn">
            Остановлено раньше срока: прошло {ru(run.summary.epochs_done ?? 0)}{" "}
            из {ru(run.epochs)} эпох, дальше качество не улучшалось
            {typeof run.params?.patience === "number"
              ? ` ${ru(run.params.patience)} эпох подряд`
              : ""}
            . Лучшие веса сохранены.
          </div>
        ) : null}

        {busy && (
          <div className="t-bars">
            {run.phase === "weights" ? (
              <div className="t-barrow">
                <span className="k">Качаю веса</span>
                <div className="bar">
                  <i
                    style={{
                      width: `${
                        ((run.val_batch ?? 0) / Math.max(1, run.val_total ?? 1)) *
                        100
                      }%`,
                    }}
                  />
                </div>
                <span className="v">
                  {ru(run.val_batch)} / {run.val_total ? ru(run.val_total) : "?"} МБ
                </span>
              </div>
            ) : run.phase === "val" ? (
              <div className="t-barrow">
                <span className="k">Проверка эпохи</span>
                <div className="bar">
                  <i
                    style={{
                      width: `${
                        ((run.val_batch ?? 0) / Math.max(1, run.val_total ?? 1)) *
                        100
                      }%`,
                    }}
                  />
                </div>
                <span className="v">
                  {ru(run.val_batch)} / {ru(run.val_total ?? 0)}
                </span>
              </div>
            ) : (
              <div className="t-barrow">
                <span className="k">Эпоха {run.current_epoch}</span>
                <div className="bar">
                  <i
                    style={{
                      width: `${
                        ((run.current_batch ?? 0) /
                          Math.max(1, run.total_batches ?? 1)) *
                        100
                      }%`,
                    }}
                  />
                </div>
                <span className="v">
                  {ru(run.current_batch)} / {ru(run.total_batches ?? 0)} батчей
                </span>
              </div>
            )}
            <div className="t-barrow">
              <span className="k">Обучение целиком</span>
              <div className="bar">
                <i
                  className="e"
                  style={{
                    width: `${(run.current_epoch / Math.max(1, run.epochs)) * 100}%`,
                  }}
                />
              </div>
              <span className="v">
                {run.current_epoch} / {run.epochs} эпох
              </span>
            </div>
          </div>
        )}

        {epochs.length > 0 ? (
          <>
            <MetricChart epochs={epochs} total={run.epochs} />
            <LossChart epochs={epochs} total={run.epochs} />
          </>
        ) : (
          <div className="t-card">
            <span className="g-label">Качество по эпохам</span>
            <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 8 }}>
              Первая эпоха ещё не закончилась. График появится, когда будет что
              на нём рисовать.
            </p>
          </div>
        )}

        {run.per_class && <ClassMetrics data={run.per_class} />}

        {run.curves && run.curves.length > 0 && <CurveChart curves={run.curves} />}

        {run.confusion ? (
          <ConfusionMatrix data={run.confusion} />
        ) : (
          run.status === "done" && (
            <div className="t-card">
              <span className="g-label">Матрица ошибок</span>
              <p style={{ color: "var(--faint)", fontSize: 12.5, marginTop: 8 }}>
                Не посчиталась. Обучение это не портит — веса на месте.
              </p>
            </div>
          )
        )}
      </div>

      <aside>
        <div className="t-side">
          <div className="g-label">Чем учили</div>
          <div className="t-kv">
            <span>набор</span>
            <b>{run.set?.name ?? "—"}</b>
          </div>
          {run.set?.counts && (
            <>
              <div className="t-kv">
                <span>образцов</span>
                <b>{ru(run.set.counts.samples ?? 0)}</b>
              </div>
              <div className="t-kv">
                <span>обучение / проверка</span>
                <b>
                  {ru(run.set.counts.train ?? 0)} / {ru(run.set.counts.val ?? 0)}
                </b>
              </div>
            </>
          )}
          <div className="t-kv">
            <span>разметка</span>
            <b>{run.set?.kind === "polygon" ? "контуры" : "рамки"}</b>
          </div>
        </div>

        <div className="t-side">
          <div className="g-label">Настройки</div>
          {Object.entries(run.params ?? {})
            .filter(([k]) => !AUG_KEYS.has(k) || run.params?.augment_mode === "yolo")
            .map(([k, v]) => (
              <div className="t-kv" key={k}>
                <span>{PARAM_LABEL[k] ?? k}</span>
                <b>{paramText(k, v)}</b>
              </div>
            ))}
        </div>

        {run.peak_vram_mb !== null && (
          <div className="t-side">
            <div className="g-label">Видеопамять</div>
            <div className="t-kv">
              <span>взял на пике</span>
              <b>{(run.peak_vram_mb / 1024).toFixed(1).replace(".", ",")} ГБ</b>
            </div>
            <p style={{ color: "var(--faint)", fontSize: 11.5, marginTop: 6 }}>
              Замер запоминается: следующее такое же обучение попросит по
              факту, а не по прикидке.
            </p>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {busy || run.status === "queued" || run.status === "waiting_gpu" ? (
            <button
              type="button"
              className="mag-ghost"
              style={{ flex: 1 }}
              onClick={() =>
                code && runId && runsApi.stopRun(code, runId).then(refresh)
              }
            >
              Остановить
            </button>
          ) : null}
          {run.has_weights && code && runId && (
            <a
              className="mag-btn"
              style={{ flex: 1, textAlign: "center" }}
              href={runsApi.weightsUrl(code, runId)}
            >
              Скачать веса
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}
