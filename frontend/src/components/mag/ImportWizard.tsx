import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { pollJob } from "../../api";
import {
  cancelImport,
  commitImport,
  getImport,
  uploadArchive,
} from "../../auth/api";
import type { ImportState, ScannedClass } from "../../auth/api";
import { formatBytes } from "./ProjectShell";
import { plural } from "./ProjectsPage";

// Colours offered to classes that arrive without one — the same list the
// server falls back to, so a class looks the same before and after the write.
const PALETTE = [
  "#e21a1a", "#1f6feb", "#e8590c", "#1a7f4b", "#8957e5", "#0b7285",
  "#c2255c", "#5c7cfa", "#f08c00", "#2b8a3e", "#862e9c", "#0c8599",
];

const SPLIT_LABELS: Record<string, string> = {
  train: "train",
  val: "val",
  test: "test",
  other: "вне сплитов",
};

interface ClassDraft {
  name: string;
  color: string;
  superclass: string | null;
}

function seconds(value: number): string {
  if (value < 60) return `${Math.round(value)} с`;
  const m = Math.floor(value / 60);
  return `${m} мин ${Math.round(value - m * 60)} с`;
}

function splitLine(splits: Record<string, number>): string {
  const parts = ["train", "val", "test", "other"].filter((s) => splits[s]);
  if (parts.length === 0) return "—";
  return parts.map((s) => `${splits[s].toLocaleString("ru-RU")} ${SPLIT_LABELS[s]}`).join(" · ");
}

export default function ImportWizard() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [state, setState] = useState<ImportState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [jobPct, setJobPct] = useState<number | null>(null);
  const [jobLabel, setJobLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);

  const [datasetName, setDatasetName] = useState("");
  const [drafts, setDrafts] = useState<Record<number, ClassDraft>>({});
  const [superclasses, setSuperclasses] = useState<{ name: string; color: string }[]>([]);
  const [newSuperclass, setNewSuperclass] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!code) return null;
    const next = await getImport(code);
    setState(next);
    return next;
  }, [code]);

  // Follows a background job to its end, then re-reads the wizard state.
  const follow = useCallback(
    async (jobId: string, label: string) => {
      setJobLabel(label);
      try {
        await pollJob(jobId, (job) => {
          setJobPct(job.total ? job.processed / job.total : null);
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setJobPct(null);
        setJobLabel("");
        await refresh();
      }
    },
    [refresh]
  );

  // On open (or after a reload) pick up whatever the server is doing.
  useEffect(() => {
    (async () => {
      const next = await refresh().catch((e) => {
        setError((e as Error).message);
        return null;
      });
      if (!next) return;
      if (next.status === "scanning" && next.job_id) {
        follow(next.job_id, "Читаю разметку");
      } else if (next.status === "writing" && next.job_id) {
        follow(next.job_id, "Записываю в проект");
      }
    })();
  }, [refresh, follow]);

  // The class step starts from what the archive said; the person edits it.
  useEffect(() => {
    if (state?.status !== "classes" || !state.report) return;
    setDatasetName((prev) => prev || state.archive?.name.replace(/\.zip$/i, "") || "");
    setDrafts((prev) => {
      if (Object.keys(prev).length) return prev;
      const next: Record<number, ClassDraft> = {};
      state.report!.classes.forEach((c, i) => {
        next[c.class_index] = {
          name: c.yaml_name || "",
          color: PALETTE[i % PALETTE.length],
          superclass: null,
        };
      });
      return next;
    });
  }, [state]);

  async function handleFile(file: File) {
    if (!code) return;
    setError(null);
    setUploadPct(0);
    try {
      const { job_id } = await uploadArchive(code, file, setUploadPct);
      setUploadPct(null);
      await refresh();
      await follow(job_id, "Читаю разметку");
    } catch (e) {
      setUploadPct(null);
      setError((e as Error).message);
      await refresh();
    }
  }

  async function handleCommit() {
    if (!code || !state?.report) return;
    setBusy(true);
    setError(null);
    try {
      const { job_id } = await commitImport(code, {
        dataset_name: datasetName.trim(),
        superclasses,
        classes: state.report.classes.map((c) => ({
          class_index: c.class_index,
          name: (drafts[c.class_index]?.name || "").trim(),
          color: drafts[c.class_index]?.color || PALETTE[0],
          superclass: drafts[c.class_index]?.superclass || null,
        })),
      });
      await refresh();
      await follow(job_id, "Записываю в проект");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!code) return;
    if (!window.confirm("Отменить импорт? Загруженный архив будет удалён.")) return;
    await cancelImport(code).catch(() => {});
    navigate(`/projects/${code}`);
  }

  function setDraft(index: number, patch: Partial<ClassDraft>) {
    setDrafts((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));
  }

  function addSuperclass() {
    const name = newSuperclass.trim();
    if (!name || superclasses.some((s) => s.name === name)) return;
    setSuperclasses((prev) => [
      ...prev,
      { name, color: PALETTE[(prev.length + 3) % PALETTE.length] },
    ]);
    setNewSuperclass("");
  }

  if (error && !state) {
    return (
      <div className="mag-content">
        <div className="mag-error">{error}</div>
        <Link to="/" className="mag-link">← К списку проектов</Link>
      </div>
    );
  }
  if (!state) return <div className="mag-content mag-empty">Загружаем…</div>;

  const report = state.report;
  const unnamed = report
    ? report.classes.filter((c) => !(drafts[c.class_index]?.name || "").trim()).length
    : 0;
  const maxCount = report
    ? Math.max(1, ...report.classes.map((c) => c.annotations))
    : 1;

  return (
    <div className="mag-content">
      <div className="mag-crumbs">
        <Link to="/">Проекты</Link> / <Link to={`/projects/${code}`}>{code}</Link> /{" "}
        <b>Импорт датасета</b>
      </div>

      {error && <div className="mag-error">{error}</div>}

      {/* ---- 1. Архив ---- */}
      {state.archive ? (
        <StepDone
          title="Архив загружен"
          sub={state.archive.name}
          facts={[
            { value: formatBytes(state.archive.size_bytes), label: "размер" },
            ...(report
              ? [
                  { value: report.archive_members.toLocaleString("ru-RU"), label: "файлов в архиве" },
                  { value: report.images.toLocaleString("ru-RU"), label: "изображений" },
                  { value: splitLine(report.splits), label: "" },
                ]
              : [{ value: seconds(state.archive.upload_seconds), label: "заняла загрузка" }]),
          ]}
        />
      ) : (
        <div className="mag-step now">
          <span className="mag-step-num">1</span>
          <div className="mag-step-main">
            <div className="mag-step-h">
              <b>Выберите архив</b>
              <span className="sub">Zip с YOLO-разметкой: data.yaml, images/, labels/</span>
            </div>
            {uploadPct === null ? (
              <div className="mag-drop">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".zip"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
                <button className="mag-btn" onClick={() => fileInput.current?.click()}>
                  Выбрать архив
                </button>
                <p>Пока только детекция — пять значений в строке разметки.</p>
              </div>
            ) : (
              <Progress
                pct={uploadPct >= 0.999 ? null : uploadPct}
                label={uploadPct >= 0.999 ? "Архив передаётся на сервер…" : "Передаю архив"}
              />
            )}
          </div>
        </div>
      )}

      {/* ---- 2. Разбор ---- */}
      {state.status === "scanning" ? (
        <div className="mag-step now">
          <span className="mag-step-num">2</span>
          <div className="mag-step-main">
            <div className="mag-step-h">
              <b>Разбираю разметку</b>
              <span className="sub">Читаю классы и размеры изображений</span>
              <button className="mag-ghost mag-sm" onClick={handleCancel}>
                Отменить импорт
              </button>
            </div>
            <Progress pct={jobPct} label={jobLabel || "Читаю разметку"} />
          </div>
        </div>
      ) : report ? (
        <StepDone
          title="Разметка разобрана"
          sub={`${report.classes.length} ${plural(report.classes.length, "идентификатор", "идентификатора", "идентификаторов")} классов`}
          action={
            report.skipped > 0 ? (
              <button className="mag-more" onClick={() => setShowSkipped((v) => !v)}>
                {showSkipped ? "Скрыть пропущенное" : "Показать, что пропущено"}
              </button>
            ) : undefined
          }
          facts={[
            { value: report.annotations.toLocaleString("ru-RU"), label: "разметок" },
            {
              value: report.images_without_labels.toLocaleString("ru-RU"),
              label: "изображений без разметки",
            },
            { value: report.clipped.toLocaleString("ru-RU"), label: "координат подрезано", tone: "warn" },
            { value: report.skipped.toLocaleString("ru-RU"), label: "изображений пропущено", tone: "bad" },
          ]}
          extra={
            showSkipped && report.skipped_examples.length > 0 ? (
              <ul className="mag-skipped">
                {report.skipped_examples.map((s) => (
                  <li key={s.file}>
                    <code>{s.file}</code> — {s.reason}
                  </li>
                ))}
                {report.skipped > report.skipped_examples.length && (
                  <li className="rest">
                    …и ещё {report.skipped - report.skipped_examples.length}
                  </li>
                )}
              </ul>
            ) : undefined
          }
        />
      ) : null}

      {/* ---- 3. Классы ---- */}
      {report && state.status === "classes" && (
        <div className="mag-step now">
          <span className="mag-step-num">3</span>
          <div className="mag-step-main">
            <div className="mag-step-h">
              <b>Классы и суперклассы</b>
              <span className="sub">
                {unnamed > 0
                  ? `${unnamed} ${plural(unnamed, "класс", "класса", "классов")} без названия`
                  : "Все классы названы"}
              </span>
            </div>

            <div className="mag-field mag-ds-name">
              <label htmlFor="ds-name">Название датасета</label>
              <input
                id="ds-name"
                type="text"
                value={datasetName}
                onChange={(e) => setDatasetName(e.target.value)}
                placeholder="Как называть эту партию изображений"
              />
            </div>

            <div className="mag-table-scroll">
              <table className="mag-classes">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Название класса</th>
                    <th />
                    <th>Суперкласс</th>
                    <th>Разметок</th>
                  </tr>
                </thead>
                <tbody>
                  {report.classes.map((c) => (
                    <ClassRow
                      key={c.class_index}
                      cls={c}
                      draft={drafts[c.class_index]}
                      superclasses={superclasses}
                      maxCount={maxCount}
                      onChange={(patch) => setDraft(c.class_index, patch)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mag-sc-add">
              <input
                type="text"
                value={newSuperclass}
                placeholder="Новый суперкласс"
                onChange={(e) => setNewSuperclass(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSuperclass();
                  }
                }}
              />
              <button className="mag-ghost" onClick={addSuperclass} disabled={!newSuperclass.trim()}>
                Добавить суперкласс
              </button>
              {superclasses.length > 0 && (
                <span className="mag-sc-list">
                  {superclasses.map((s) => (
                    <span key={s.name} className="mag-sc-chip">
                      <i style={{ background: s.color }} />
                      {s.name}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- 4. Запись ---- */}
      {state.status === "writing" ? (
        <div className="mag-step now">
          <span className="mag-step-num">4</span>
          <div className="mag-step-main">
            <div className="mag-step-h">
              <b>Записываю в проект</b>
              <span className="sub">Создаю превью и сохраняю разметку</span>
            </div>
            <Progress pct={jobPct} label={jobLabel || "Записываю в проект"} />
          </div>
        </div>
      ) : state.status === "done" && state.result ? (
        <StepDone
          title="Импорт завершён"
          sub={datasetName || "Датасет создан"}
          action={
            <Link className="mag-btn mag-btn-inline" to={`/projects/${code}`}>
              К проекту
            </Link>
          }
          facts={[
            { value: state.result.images.toLocaleString("ru-RU"), label: "изображений записано" },
            ...(state.result.unreadable
              ? [{ value: String(state.result.unreadable), label: "не открылись при записи", tone: "bad" as const }]
              : []),
            ...(state.result.orphan_boxes
              ? [{ value: String(state.result.orphan_boxes), label: "разметок без класса", tone: "warn" as const }]
              : []),
          ]}
        />
      ) : report && state.status === "classes" ? (
        <div className="mag-step todo">
          <span className="mag-step-num">4</span>
          <div className="mag-step-main">
            <div className="mag-step-h">
              <b>Запись в проект</b>
              <span className="sub">Останется в базе после импорта</span>
              <button
                className="mag-btn"
                onClick={handleCommit}
                disabled={busy || unnamed > 0 || !datasetName.trim()}
              >
                Импортировать
              </button>
            </div>
            <Facts
              facts={[
                { value: report.images.toLocaleString("ru-RU"), label: "изображений" },
                { value: report.annotations.toLocaleString("ru-RU"), label: "разметок" },
                {
                  value: `${report.classes.length} в ${superclasses.length}`,
                  label: `${plural(report.classes.length, "класс", "класса", "классов")} / ${plural(superclasses.length, "суперклассе", "суперклассах", "суперклассах")}`,
                },
              ]}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- мелкие части ---

interface Fact {
  value: string;
  label: string;
  tone?: "warn" | "bad";
}

function Facts({ facts }: { facts: Fact[] }) {
  return (
    <div className="mag-facts">
      {facts.map((f, i) => (
        <div key={i} className={f.tone ? `mag-fact ${f.tone}` : "mag-fact"}>
          <b>{f.value}</b>
          {f.label}
        </div>
      ))}
    </div>
  );
}

function StepDone({
  title,
  sub,
  facts,
  action,
  extra,
}: {
  title: string;
  sub?: string;
  facts: Fact[];
  action?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="mag-step done">
      <span className="mag-step-num">✓</span>
      <div className="mag-step-main">
        <div className="mag-step-h">
          <b>{title}</b>
          {sub && <span className="sub">{sub}</span>}
          {action}
        </div>
        <Facts facts={facts} />
        {extra}
      </div>
    </div>
  );
}

function Progress({ pct, label }: { pct: number | null; label: string }) {
  return (
    <div className="mag-progress">
      <div className="mag-progress-track">
        <i
          className={pct === null ? "indeterminate" : ""}
          style={pct === null ? undefined : { width: `${Math.round(pct * 100)}%` }}
        />
      </div>
      <div className="mag-progress-lbl">
        <span>{label}</span>
        <span>{pct === null ? "" : `${Math.round(pct * 100)} %`}</span>
      </div>
    </div>
  );
}

function ClassRow({
  cls,
  draft,
  superclasses,
  maxCount,
  onChange,
}: {
  cls: ScannedClass;
  draft?: ClassDraft;
  superclasses: { name: string; color: string }[];
  maxCount: number;
  onChange: (patch: Partial<ClassDraft>) => void;
}) {
  const name = draft?.name ?? "";
  const unused = cls.annotations === 0;
  return (
    <tr>
      <td className="mag-cls-id">{cls.class_index}</td>
      <td>
        <input
          className={name.trim() ? "" : "blank"}
          type="text"
          value={name}
          placeholder={
            cls.yaml_name === null
              ? "Нет в data.yaml — найден в разметке"
              : "Имя не указано в data.yaml"
          }
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </td>
      <td>
        <input
          type="color"
          aria-label={`Цвет класса ${cls.class_index}`}
          value={draft?.color ?? "#e21a1a"}
          onChange={(e) => onChange({ color: e.target.value })}
        />
      </td>
      <td>
        <select
          value={draft?.superclass ?? ""}
          aria-label={`Суперкласс класса ${cls.class_index}`}
          onChange={(e) => onChange({ superclass: e.target.value || null })}
        >
          <option value="">Без группы</option>
          {superclasses.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </td>
      <td className="mag-cls-count">
        <div className="mag-cls-bar">
          <i
            className={unused ? "zero" : ""}
            style={{ width: `${Math.round((cls.annotations / maxCount) * 100)}%` }}
          />
        </div>
        {unused ? (
          <span className="zero">не встречен</span>
        ) : (
          cls.annotations.toLocaleString("ru-RU")
        )}
      </td>
    </tr>
  );
}
