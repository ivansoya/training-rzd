import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pollJob } from "../../api";
import {
  exportDownloadUrl,
  getClasses,
  previewExport,
  startExport,
} from "../../auth/api";
import type {
  ExportOptions,
  ExportPreview,
  ExportResult,
  LabelClass,
  ProjectDetail,
} from "../../auth/api";
import { formatBytes } from "./ProjectShell";
import { useEscape } from "./useEscape";

interface Props {
  detail: ProjectDetail;
  onClose: () => void;
}

// «error» отдельной ступенью не нужен: сорвавшаяся сборка возвращает окно в
// setup с текстом ошибки, чтобы можно было поправить выбор и повторить.
type Phase = "setup" | "packing" | "ready";

const FORMATS = [
  { id: "yolo", label: "YOLO", ok: true },
  { id: "coco", label: "COCO", ok: false },
  { id: "voc", label: "VOC", ok: false },
];
const TYPES = [
  { id: "bbox", label: "Боксы", ok: true },
  { id: "polygon", label: "Сегменты", ok: false },
  { id: "mask", label: "Маски", ok: false },
];
const SOON = "Появится позже — такой разметки в проекте пока нет";

export default function ExportModal({ detail, onClose }: Props) {
  const code = detail.project.code;
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [pickedDs, setPickedDs] = useState<Set<string>>(
    () => new Set(detail.datasets.map((d) => d.id))
  );
  const [pickedCls, setPickedCls] = useState<Set<string>>(new Set());
  const [resplit, setResplit] = useState(false);
  const [valRatio, setValRatio] = useState(0.2);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState(false);
  // Порядковый номер запроса: ответы предпросмотра приходят вразнобой, и
  // устаревший не должен затереть свежий.
  const seq = useRef(0);

  useEscape(onClose);

  useEffect(() => {
    getClasses(code)
      .then(({ classes: rows }) => {
        setClasses(rows);
        // По умолчанию — то, что реально размечено: остальное дало бы классы
        // без единого примера.
        setPickedCls(new Set(rows.filter((c) => c.annotations > 0).map((c) => c.id)));
      })
      .catch((e) => setError((e as Error).message));
  }, [code]);

  const options: ExportOptions = useMemo(
    () => ({
      datasets: [...pickedDs],
      classes: [...pickedCls],
      split_mode: resplit ? "resplit" : "keep",
      val_ratio: valRatio,
    }),
    [pickedDs, pickedCls, resplit, valRatio]
  );

  useEffect(() => {
    if (phase !== "setup") return;
    if (!options.datasets.length || !options.classes.length) {
      setPreview(null);
      setPending(false);
      return;
    }
    const mine = ++seq.current;
    setPending(true);
    const h = window.setTimeout(() => {
      previewExport(code, options)
        .then((p) => {
          if (seq.current !== mine) return;
          setPreview(p);
          setError(null);
        })
        .catch((e) => {
          if (seq.current === mine) setError((e as Error).message);
        })
        .finally(() => {
          if (seq.current === mine) setPending(false);
        });
    }, 250);
    return () => window.clearTimeout(h);
  }, [code, options, phase]);

  const toggle = useCallback((set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }, []);

  function handleBackdrop() {
    setNudge(true);
    window.setTimeout(() => setNudge(false), 400);
  }

  async function run() {
    setError(null);
    setPhase("packing");
    setProgress(0);
    try {
      const { job_id } = await startExport(code, options);
      const res = await pollJob<ExportResult>(job_id, (job) =>
        setProgress(job.total ? job.processed / job.total : 0)
      );
      setResult(res);
      setPhase("ready");
    } catch (e) {
      setError((e as Error).message);
      setPhase("setup");
    }
  }

  const rows = preview?.classes ?? [];
  const byId = new Map(rows.map((r) => [r.class_index, r]));
  const canRun =
    options.datasets.length > 0 &&
    options.classes.length > 0 &&
    (preview?.images ?? 0) > 0;

  return (
    <div className="mag-backdrop" onClick={handleBackdrop}>
      <div
        className={nudge ? "mag-modal mag-exp mag-modal-nudge" : "mag-modal mag-exp"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mag-exp-pick">
          <h1>Экспорт проекта</h1>
          <p className="mag-sub">
            В архив попадут кадры выбранных датасетов, у которых осталась
            разметка выбранных классов. Кадры «пусто» выгружаются всегда.
          </p>

          <h3 className="mag-exp-h">Датасеты</h3>
          <div className="mag-exp-list">
            {detail.datasets.map((d) => (
              <label key={d.id} className="mag-exp-row">
                <input
                  type="checkbox"
                  checked={pickedDs.has(d.id)}
                  disabled={phase !== "setup"}
                  onChange={() => setPickedDs((s) => toggle(s, d.id))}
                />
                <span className="mag-exp-name">{d.name}</span>
                <span className="mag-exp-num">{d.images_count}</span>
              </label>
            ))}
            {detail.datasets.length === 0 && (
              <div className="mag-empty">В проекте пока нет датасетов.</div>
            )}
          </div>

          <h3 className="mag-exp-h">
            Классы
            <span className="mag-exp-acts">
              <button
                type="button"
                onClick={() => setPickedCls(new Set(classes.map((c) => c.id)))}
              >
                все
              </button>
              <button
                type="button"
                onClick={() =>
                  setPickedCls(
                    new Set(classes.filter((c) => c.annotations > 0).map((c) => c.id))
                  )
                }
              >
                с разметкой
              </button>
              <button type="button" onClick={() => setPickedCls(new Set())}>
                снять
              </button>
            </span>
          </h3>
          <div className="mag-exp-list mag-exp-classes">
            {classes.map((c) => {
              const row = pickedCls.has(c.id) ? byId.get(c.class_index) : undefined;
              return (
                <label key={c.id} className="mag-exp-row">
                  <input
                    type="checkbox"
                    checked={pickedCls.has(c.id)}
                    disabled={phase !== "setup"}
                    onChange={() => setPickedCls((s) => toggle(s, c.id))}
                  />
                  <i className="mag-exp-dot" style={{ background: c.color }} />
                  <span className="mag-exp-name">{c.name}</span>
                  {row ? (
                    <span className="mag-exp-split">
                      <b>{row.train}</b>/<b>{row.val}</b>
                    </span>
                  ) : (
                    <span className="mag-exp-num">{c.annotations}</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        <div className="mag-exp-side">
          <h3 className="mag-exp-h">Формат</h3>
          <div className="mag-exp-seg">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={f.id === "yolo" ? "on" : ""}
                disabled={!f.ok}
                title={f.ok ? undefined : SOON}
              >
                {f.label}
              </button>
            ))}
          </div>

          <h3 className="mag-exp-h">Тип разметки</h3>
          <div className="mag-exp-seg">
            {TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={t.id === "bbox" ? "on" : ""}
                disabled={!t.ok}
                title={t.ok ? undefined : SOON}
              >
                {t.label}
              </button>
            ))}
          </div>

          <h3 className="mag-exp-h">Обучение и проверка</h3>
          <div className="mag-exp-seg">
            <button
              type="button"
              className={resplit ? "" : "on"}
              disabled={phase !== "setup"}
              onClick={() => setResplit(false)}
            >
              Как в проекте
            </button>
            <button
              type="button"
              className={resplit ? "on" : ""}
              disabled={phase !== "setup"}
              onClick={() => setResplit(true)}
            >
              Поделить заново
            </button>
          </div>
          <p className="mag-exp-hint">
            {resplit
              ? "Прежние сплиты игнорируются: делится всё выбранное."
              : "Берётся сплит кадра; кадры вне сплита делятся в той же пропорции."}
          </p>
          {resplit && (
            <div className="mag-exp-slider">
              <input
                type="range"
                min={5}
                max={50}
                step={1}
                value={Math.round(valRatio * 100)}
                disabled={phase !== "setup"}
                onChange={(e) => setValRatio(Number(e.target.value) / 100)}
              />
              <span>на проверку {Math.round(valRatio * 100)}%</span>
            </div>
          )}

          <div className="mag-exp-sum">
            <div>
              <b>{preview ? preview.images.toLocaleString("ru-RU") : "—"}</b>
              <span>изображений</span>
            </div>
            <div>
              <b>{preview ? preview.annotations.toLocaleString("ru-RU") : "—"}</b>
              <span>разметок</span>
            </div>
            <div>
              <b>{preview?.splits.train ?? 0}</b>
              <span>train</span>
            </div>
            <div>
              <b>{preview?.splits.val ?? 0}</b>
              <span>val</span>
            </div>
            {/* Сплит «test» в проекте пока не встречается, но если он есть —
                кадры уедут в свою папку, и молчать об этом нельзя. */}
            {!!preview?.splits.test && (
              <div>
                <b>{preview.splits.test}</b>
                <span>test</span>
              </div>
            )}
          </div>
          {preview &&
            (preview.dropped > 0 || preview.unlabelled > 0 || preview.empty > 0) && (
              <p className="mag-exp-hint">
                {preview.dropped > 0 && `Отсеяно фильтром классов: ${preview.dropped}. `}
                {preview.unlabelled > 0 && `Без разметки: ${preview.unlabelled}. `}
                {preview.empty > 0 && `Фоновых кадров «пусто»: ${preview.empty}.`}
              </p>
            )}

          {preview?.warnings.map((w) => (
            <div key={w} className="mag-exp-warn">
              {w}
            </div>
          ))}
          {error && <div className="mag-error">{error}</div>}

          {phase === "packing" && (
            <div className="mag-exp-progress">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
              <span>Собираю архив… {Math.round(progress * 100)}%</span>
            </div>
          )}
          {phase === "ready" && result && (
            <div className="mag-exp-done">
              <b>Готово</b>
              <span>
                {result.images.toLocaleString("ru-RU")} изображений ·{" "}
                {formatBytes(result.size_bytes)}
              </span>
            </div>
          )}
        </div>

        <div className="mag-modal-foot">
          <button className="mag-ghost mag-ghost-inline" type="button" onClick={onClose}>
            {phase === "ready" ? "Закрыть" : "Отмена"}
          </button>
          {phase === "ready" && result ? (
            <a
              className="mag-btn mag-btn-inline"
              href={exportDownloadUrl(code, result.job_id)}
              download={result.file_name}
            >
              Скачать архив
            </a>
          ) : (
            <button
              className="mag-btn mag-btn-inline"
              type="button"
              disabled={!canRun || phase === "packing" || pending}
              onClick={run}
            >
              {phase === "packing" ? "Собираю…" : "Экспортировать"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
