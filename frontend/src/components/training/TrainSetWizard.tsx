// Мастер сборки обучающего набора: четыре шага.
//
// Деление идёт раньше аугментаций, и это не порядок экранов, а порядок в
// исполнителе. Иначе копии одного кадра разъедутся по обеим половинам, проверка
// начнёт мерить запоминание вместо обобщения, и заметить это по метрикам будет
// нельзя — они просто окажутся неправдоподобно хорошими.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getClasses, getProject } from "../../auth/api";
import type { LabelClass, ProjectDetail } from "../../auth/api";
import * as aug from "../../api/aug";
import * as sets from "../../api/trainsets";
import type { AnnKind, Preview, SplitMode } from "../../api/trainsets";
import Sep from "../Sep";

const STEPS = ["Данные", "Деление", "Аугментации", "Сборка"];

const MODES: { key: SplitMode; title: string; why: string }[] = [
  {
    key: "manual",
    title: "Вручную",
    why: "Берём то, что уже проставлено у кадров. Кадры без назначения уйдут "
      + "в обучение — в проверку кадр попадает только тогда, когда его туда отправили.",
  },
  {
    key: "random",
    title: "Случайно",
    why: "Доля проверки от общего числа. Одинаково при каждом пересчёте: "
      + "порядок берётся из отпечатка кадра, а не из случайности.",
  },
  {
    key: "balanced",
    title: "Случайно, с оглядкой на классы",
    why: "Редкий класс попадёт в проверку хотя бы одним кадром. Пропорцию это "
      + "слегка искажает — и ради этого затевалось.",
  },
  {
    key: "smart",
    title: "Умное",
    why: "Похожие кадры собираются в группы и уезжают в одну сторону целиком. "
      + "Соседние кадры одного перегона не окажутся по разные стороны, и "
      + "проверка перестанет мерить запоминание.",
  },
];

const bytes = (n: number) => {
  if (n < 1024) return `${n} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${units[i]}`;
};

const ru = (n: number) => Math.round(n).toLocaleString("ru-RU");

export default function TrainSetWizard() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [graphs, setGraphs] = useState<aug.GraphSummary[]>([]);

  const [datasets, setDatasets] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState<AnnKind>("bbox");
  const [mode, setMode] = useState<SplitMode>("balanced");
  const [ratio, setRatio] = useState(0.2);
  const [trainGraph, setTrainGraph] = useState<string>("");
  const [valGraph, setValGraph] = useState<string>("");
  const [name, setName] = useState("");

  const [preview, setPreview] = useState<Preview | null>(null);
  // Предпросмотр в пути. Умное деление считается секунды, и без этого флага
  // они выглядели как «ничего не происходит».
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    getProject(code).then((got) => {
      setDetail(got);
      setDatasets(got.datasets.map((d) => d.id));
      setName(`${got.project.name} — набор`);
    });
    getClasses(code).then((got) => {
      setClasses(got.classes);
      setPicked(got.classes.filter((c) => c.annotations > 0).map((c) => c.id));
    });
    aug.projectGraphs(code).then((got) => setGraphs([...got.graphs, ...got.mine]));
  }, [code]);

  const spec = useMemo(
    () => ({
      datasets,
      classes: picked,
      ann_type: kind,
      split_mode: mode,
      val_ratio: ratio,
    }),
    [datasets, picked, kind, mode, ratio]
  );

  // Предпросмотр считается на каждое изменение — по тому же коду, которым
  // потом соберётся набор. Разойтись они не могут по построению.
  useEffect(() => {
    if (!code || !datasets.length || !picked.length) {
      setPreview(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      setComputing(true);
      sets
        .preview(code, spec)
        .then((got) => alive && setPreview(got))
        .catch((e) => alive && setError((e as Error).message))
        .finally(() => alive && setComputing(false));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [code, spec, datasets.length, picked.length]);

  const graphOf = useCallback(
    (id: string) => graphs.find((g) => g.version_id === id),
    [graphs]
  );

  const samplesOut = preview
    ? Math.round(preview.train * (graphOf(trainGraph)?.stats?.multiplier ?? 1)) +
      Math.round(preview.val * (graphOf(valGraph)?.stats?.multiplier ?? 1))
    : 0;

  const perImage = detail && detail.stats.images
    ? detail.stats.size_bytes / detail.stats.images
    : 0;
  // Неизменённые кадры кладутся жёсткой ссылкой и места не занимают — их из
  // оценки надо вычесть, иначе «займёт 40 ГБ» пугает впустую.
  const linked = preview
    ? (trainGraph ? 0 : preview.train) + (valGraph ? 0 : preview.val)
    : 0;
  const estimate = Math.round((samplesOut - linked) * perImage * 1.15);

  const build = async () => {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const got = await sets.createSet(code, {
        ...spec,
        name: name.trim(),
        graph_version_id: trainGraph || null,
        val_graph_version_id: valGraph || null,
      });
      navigate(`/projects/${code}/training?set=${got.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const embed = async () => {
    if (!code) return;
    setError(null);
    try {
      // force: человек нажал сам, значит, причину прошлого отказа он видел.
      await sets.startEmbed(code, { ...spec, force: true });
      const got = await sets.preview(code, spec);
      setPreview(got);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Пока признаки считаются, предпросмотр перечитывается сам: иначе полоса
  // стояла бы на нуле до следующего движения мышью, а работа — шла.
  const embedJobId = preview?.embeddings?.job?.id ?? null;
  useEffect(() => {
    if (!code || !embedJobId) return;
    const timer = window.setInterval(() => {
      sets
        .preview(code, spec)
        .then(setPreview)
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [code, spec, embedJobId]);

  const needsEmbeddings =
    mode === "smart" && (preview?.embeddings?.missing ?? 0) > 0;

  // Почему нельзя идти дальше — строкой под кнопкой. Подсказку при наведении
  // не найдут, а вопрос возникнет сразу.
  const blocked =
    step === 0 && !datasets.length
      ? "Выберите хотя бы один датасет."
      : step === 0 && !picked.length
      ? "Выберите хотя бы один класс."
      : step === 1 && needsEmbeddings
      ? "Сперва посчитаем признаки кадров — без них группы не построить."
      : step === 3 && !name.trim()
      ? "У набора должно быть имя."
      : step === 3 && !preview?.train
      ? "В обучающую часть не попадает ни одного кадра."
      : null;

  return (
    <div className="mag-content">
      <div className="mag-pass-strip">
        <div className="mag-pass-id">
          <h1 className="mag-h1">Новый обучающий набор</h1>
          <p>
            Кадры проекта превращаются в папку, которую читает YOLO. Деление на
            обучение и проверку считается до первой картинки.
          </p>
        </div>
        <Link
          to={`/projects/${code}/training`}
          className="mag-ghost mag-ghost-inline mag-pass-export"
        >
          Отмена
        </Link>
      </div>

      <div className="t-rail">
        {STEPS.map((title, i) => (
          <div key={title} className={i < step ? "done" : i === step ? "now" : ""}>
            <b>{i < step ? "✓" : i + 1}</b> {title}
          </div>
        ))}
      </div>

      {error && <div className="mag-error">{error}</div>}

      <div className="t-wiz">
        <div>
          {step === 0 && (
            <>
              <div className="g-label" style={{ marginBottom: 10 }}>
                Датасеты
              </div>
              <div className="t-pick">
                {detail && detail.datasets.length === 0 && (
                  <span className="mag-sub">
                    В проекте нет ни одного датасета — собирать не из чего.
                    Загрузите кадры на вкладке «Датасеты».
                  </span>
                )}
                {detail?.datasets.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`t-chip${datasets.includes(d.id) ? " on" : ""}`}
                    onClick={() =>
                      setDatasets((old) =>
                        old.includes(d.id)
                          ? old.filter((x) => x !== d.id)
                          : [...old, d.id]
                      )
                    }
                  >
                    {d.name}
                    <span>{ru(d.images_count)}</span>
                  </button>
                ))}
              </div>

              <div className="g-label" style={{ margin: "16px 0 10px" }}>
                Классы
              </div>
              <div className="t-pick">
                {classes.length === 0 && (
                  <span className="mag-sub">
                    В проекте нет классов. Пока их нет, размечать и учить нечему.
                  </span>
                )}
                {classes.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`t-chip${picked.includes(c.id) ? " on" : ""}`}
                    onClick={() =>
                      setPicked((old) =>
                        old.includes(c.id)
                          ? old.filter((x) => x !== c.id)
                          : [...old, c.id]
                      )
                    }
                  >
                    {c.name}
                    <span>{ru(c.annotations)}</span>
                  </button>
                ))}
              </div>

              <div className="g-label" style={{ margin: "16px 0 10px" }}>
                Вид разметки
              </div>
              <div className="t-choices">
                {(["bbox", "polygon"] as AnnKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`t-choice${kind === k ? " on" : ""}`}
                    onClick={() => setKind(k)}
                  >
                    <span className="dot" />
                    <span>
                      <span className="t">
                        {k === "bbox" ? "Рамки" : "Сегментация"}
                      </span>
                      <span className="d">
                        {k === "bbox"
                          ? "Полигон сводится к охватывающей рамке: объект упрощается, но не пропадает."
                          : "Контур строкой. Рамки сюда не идут: прямоугольник, записанный контуром, учил бы модель, что объекты прямоугольные."}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="g-label" style={{ marginBottom: 10 }}>
                Как делить {preview ? ru(preview.images) : "—"} кадров
              </div>
              <div className="t-choices">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    className={`t-choice${mode === m.key ? " on" : ""}`}
                    onClick={() => setMode(m.key)}
                  >
                    <span className="dot" />
                    <span>
                      <span className="t">{m.title}</span>
                      <span className="d">{m.why}</span>
                    </span>
                  </button>
                ))}
              </div>

              {mode !== "manual" && (
                <div className="t-kv" style={{ marginBottom: 12 }}>
                  <span>Доля проверки</span>
                  <input
                    type="range"
                    min={0.05}
                    max={0.5}
                    step={0.05}
                    value={ratio}
                    onChange={(e) => setRatio(Number(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--red)" }}
                    aria-label="Доля проверки"
                  />
                  <b>{Math.round(ratio * 100)} %</b>
                </div>
              )}

              {mode === "smart" && preview?.embeddings && (
                <div className="t-side" style={{ marginBottom: 14 }}>
                  <div className="g-label">Признаки кадров</div>
                  <div className="t-split">
                    <i
                      style={{
                        width: `${
                          (preview.embeddings.ready /
                            Math.max(1, preview.embeddings.total)) *
                          100
                        }%`,
                        background: "var(--done)",
                      }}
                    />
                  </div>
                  <div className="t-legend">
                    <span>
                      посчитано <b>{ru(preview.embeddings.ready)}</b> из{" "}
                      <b>{ru(preview.embeddings.total)}</b>
                    </span>
                  </div>
                  {preview.embeddings.job?.stage_text && (
                    <div className="hint" style={{ color: "var(--dim)", fontSize: 11, marginTop: 6 }}>
                      {preview.embeddings.job.stage_text}
                    </div>
                  )}
                  {!preview.embeddings.job && preview.embeddings.failure && (
                    <div className="mag-error" style={{ marginTop: 8 }}>
                      Признаки не посчитались: {preview.embeddings.failure.error}
                    </div>
                  )}
                  {needsEmbeddings && (
                    <button
                      type="button"
                      className="mag-btn"
                      style={{ marginTop: 10, width: "100%" }}
                      onClick={embed}
                      disabled={Boolean(preview.embeddings.job)}
                    >
                      {preview.embeddings.job
                        ? preview.embeddings.job.stage === "embed"
                          ? `Считаю: ${ru(preview.embeddings.job.processed)} из ${ru(
                              preview.embeddings.job.total
                            )}`
                          : "Готовлю модель…"
                        : preview.embeddings.failure
                        ? `Повторить счёт признаков (${ru(preview.embeddings.missing)})`
                        : `Посчитать признаки (${ru(preview.embeddings.missing)})`}
                    </button>
                  )}
                </div>
              )}

              {preview && preview.classes.length > 0 && (
                <>
                  <div className="g-label" style={{ margin: "16px 0 4px" }}>
                    Что получится по классам
                  </div>
                  <div className="t-scroll">
                    <table className="t-cls">
                      <thead>
                        <tr>
                          <th>Класс</th>
                          <th>Обучение</th>
                          <th>Проверка</th>
                          <th>Объектов</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.classes.map((c) => (
                          <tr
                            key={c.export_id}
                            className={c.val > 0 && c.val <= 2 ? "thin" : ""}
                          >
                            <td>{c.name}</td>
                            <td>{ru(c.train)}</td>
                            <td>{ru(c.val)}</td>
                            <td>{ru(c.annotations)}</td>
                          </tr>
                        ))}
                        {preview.background > 0 && (
                          <tr className="t-bg-row">
                            <td>фон <Sep /> кадры без разметки</td>
                            <td>{ru(preview.background_split?.train ?? 0)}</td>
                            <td>{ru(preview.background_split?.val ?? 0)}</td>
                            <td className="t-dash">—</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="g-label" style={{ marginBottom: 10 }}>
                Граф для обучающей части
              </div>
              <select
                
                value={trainGraph}
                onChange={(e) => setTrainGraph(e.target.value)}
                style={{ width: "100%", marginBottom: 6 }}
              >
                <option value="">без аугментаций</option>
                {graphs
                  .filter((g) => g.version_id)
                  .map((g) => (
                    <option key={g.id} value={g.version_id as string}>
                      {g.name} <Sep /> версия {g.version} <Sep /> ×{g.stats?.multiplier ?? 1}
                    </option>
                  ))}
              </select>
              <p className="t-choice-hint" style={{ color: "var(--faint)", fontSize: 11.5 }}>
                Набор запомнит и граф, и его версию: правка графа задним числом
                этот набор не изменит.
              </p>

              <div className="g-label" style={{ margin: "18px 0 10px" }}>
                Граф для проверочной части
              </div>
              <select
                
                value={valGraph}
                onChange={(e) => setValGraph(e.target.value)}
                style={{ width: "100%" }}
              >
                <option value="">без аугментаций (обычно так и надо)</option>
                {graphs
                  .filter((g) => g.version_id)
                  .map((g) => (
                    <option key={g.id} value={g.version_id as string}>
                      {g.name} <Sep /> версия {g.version}
                    </option>
                  ))}
              </select>
              {valGraph && (
                <div className="t-warn">
                  Проверочная часть пойдёт через аугментации. Тогда метрика
                  измерит качество на выдуманных кадрах, а не на настоящих —
                  делайте так, только если точно знаете зачем.
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="g-label" style={{ marginBottom: 8 }}>
                Имя набора
              </div>
              <input
                
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: "100%" }}
                aria-label="Имя набора"
              />
              <p style={{ color: "var(--faint)", fontSize: 12, marginTop: 10 }}>
                Собранный набор живёт, пока его не удалят: обучение будет
                ссылаться именно на него, и «повторить ровно на том же» без него
                превратится в слова.
              </p>
            </>
          )}
        </div>

        <div>
          <div className="t-side">
            <div className="g-label">
              Разделится так
              {computing && (
                <span className="t-computing">
                  {" "}
<Sep /> считаю
                  {mode === "smart" ? " умное деление" : ""}
                  {preview?.split_ms
                    ? ` (≈ ${Math.max(1, Math.round(preview.split_ms / 1000))} с)`
                    : "…"}
                </span>
              )}
            </div>
            {preview ? (
              <>
                <div className="t-split">
                  <i
                    style={{
                      width: `${
                        (preview.train /
                          Math.max(1, preview.train + preview.val)) *
                        100
                      }%`,
                      background: "var(--null)",
                    }}
                  />
                  <i
                    style={{
                      width: `${
                        (preview.val /
                          Math.max(1, preview.train + preview.val)) *
                        100
                      }%`,
                      background: "var(--done)",
                    }}
                  />
                </div>
                <div className="t-legend">
                  <span>
                    <u style={{ background: "var(--null)" }} />
                    обучение <b>{ru(preview.train)}</b>
                  </span>
                  <span>
                    <u style={{ background: "var(--done)" }} />
                    проверка <b>{ru(preview.val)}</b>
                  </span>
                </div>
                {preview.groups !== null && (
                  <div className="t-kv" style={{ marginTop: 10 }}>
                    <span>групп похожих кадров</span>
                    <b>{ru(preview.groups)}</b>
                  </div>
                )}
                {preview.background > 0 && (
                  <div className="t-kv">
                    <span>без разметки — идут фоном</span>
                    <b>
                      {ru(preview.background)}
                      {preview.background_split && (
                        <>
                          {" "}
                          ({ru(preview.background_split.train)} /{" "}
                          {ru(preview.background_split.val)})
                        </>
                      )}
                    </b>
                  </div>
                )}
                {preview.dropped > 0 && (
                  <div className="t-kv">
                    <span>разметка не того рода — не идут</span>
                    <b>{ru(preview.dropped)}</b>
                  </div>
                )}
              </>
            ) : (
              <p style={{ color: "var(--faint)", fontSize: 12 }}>
                Выберите датасеты и классы — считаю, что получится.
              </p>
            )}
          </div>

          {step >= 2 && preview && (
            <div className="t-side">
              <div className="g-label">На выходе</div>
              <div className="t-kv">
                <span>образцов</span>
                <b>{ru(samplesOut)}</b>
              </div>
              <div className="t-kv">
                <span>во сколько раз</span>
                <b>
                  ×
                  {(
                    samplesOut / Math.max(1, preview.train + preview.val)
                  ).toFixed(1).replace(".", ",")}
                </b>
              </div>
              <div className="t-kv">
                <span>ссылками, без места</span>
                <b>{ru(linked)}</b>
              </div>
              <div className="t-kv">
                <span>займёт на диске</span>
                <b>≈ {bytes(Math.max(0, estimate))}</b>
              </div>
            </div>
          )}

          {preview?.warnings.map((w) => (
            <div className="t-warn" key={w}>
              {w}
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {step > 0 && (
              <button
                type="button"
                className="mag-ghost"
                onClick={() => setStep((s) => s - 1)}
              >
                Назад
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="mag-btn"
                style={{ flex: 1 }}
                disabled={Boolean(blocked)}
                onClick={() => setStep((s) => s + 1)}
              >
                Дальше — {STEPS[step + 1]?.toLowerCase()}
              </button>
            ) : (
              <button
                type="button"
                className="mag-btn"
                style={{ flex: 1 }}
                disabled={busy || Boolean(blocked)}
                onClick={build}
              >
                {busy ? "Ставлю в очередь…" : "Собрать набор"}
              </button>
            )}
          </div>
          {blocked && <div className="t-why-not">{blocked}</div>}
        </div>
      </div>
    </div>
  );
}
