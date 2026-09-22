// Мастер сборки обучающего набора: четыре шага.
//
// Деление идёт раньше аугментаций, и это не порядок экранов, а порядок в
// исполнителе. Иначе копии одного кадра разъедутся по обеим половинам, проверка
// начнёт мерить запоминание вместо обобщения, и заметить это по метрикам будет
// нельзя — они просто окажутся неправдоподобно хорошими.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getClasses, getProject } from "../../auth/api";
import type { LabelClass, ProjectDetail } from "../../auth/api";
import * as aug from "../../api/aug";
import * as sets from "../../api/trainsets";
import type {
  AnnKind, DatasetPart, FeedRow, Preview, SplitMode,
} from "../../api/trainsets";
import { listTags } from "../../api/tags";
import type { Tag } from "../../api/tags";
import FeedRows from "./FeedRows";
import Sep from "../Sep";
import Banner from "../Banner";

const STEPS = ["Данные", "Деление", "Аугментации", "Сборка"];

const MODES: { key: SplitMode; title: string }[] = [
  { key: "manual", title: "Вручную" },
  { key: "random", title: "Случайно" },
  { key: "balanced", title: "Случайно, с оглядкой на классы" },
  { key: "smart", title: "Умное" },
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
  // Закрепление датасета за половиной. Датасета здесь нет — он общий, и его
  // кадры делятся наравне со всеми. Ради этого и заводилось: набор, где
  // синтетика учит, а снятое камерой проверяет.
  const [parts, setParts] = useState<Record<string, DatasetPart>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState<AnnKind>("bbox");
  const [mode, setMode] = useState<SplitMode>("balanced");
  const [ratio, setRatio] = useState(0.2);
  const [tags, setTags] = useState<Tag[]>([]);
  // Строки сборки. Стартовое состояние — «всё как есть»: по строке на
  // половину, кадры своей половины, без графа. Ровно то, что набор делал до
  // появления строк, и потому объяснять его человеку не нужно.
  const [feeds, setFeeds] = useState<FeedRow[]>(() => [
    { part: "train", position: 0, graph_version_id: null,
      bindings: [{ source_node: "", feed: "train", tag_ids: [] }] },
    { part: "val", position: 0, graph_version_id: null,
      bindings: [{ source_node: "", feed: "val", tag_ids: [] }] },
  ]);
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
    listTags(code).then((got) => setTags(got.tags)).catch(() => setTags([]));
  }, [code]);

  const spec = useMemo(
    () => ({
      datasets,
      dataset_parts: parts,
      classes: picked,
      ann_type: kind,
      split_mode: mode,
      val_ratio: ratio,
      feeds,
    }),
    [datasets, parts, picked, kind, mode, ratio, feeds]
  );

  // Предпросмотр считается на каждое изменение — по тому же коду, которым
  // потом соберётся набор. Разойтись они не могут по построению.
  useEffect(() => {
    if (!code || !datasets.length || !picked.length) {
      setPreview(null);
      return;
    }
    let alive = true;
    // Отметку «считаю» ставим сразу, до паузы дребезга. Иначе движение
    // ползунка триста миллисекунд выглядело как «ничего не произошло», а
    // числа в карточке всё это время показывали старое деление.
    setComputing(true);
    const timer = window.setTimeout(() => {
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

  // Итог в образцах считает сервер — по строкам, тем же кодом, которым потом
  // соберёт. Клиент его только показывает: складывать множители строк на
  // глаз значило бы обещать одно, а собрать другое.
  //
  // `??` — на сервер, который строк ещё не знает (стенд между выкатками):
  // без него мастер показывал бы «0 образцов» при живом отборе, и это
  // читалось бы как поломка, а не как рассинхрон версий.
  const samplesOut = preview ? preview.samples ?? preview.train + preview.val : 0;

  const perImage = detail && detail.stats.images
    ? detail.stats.size_bytes / detail.stats.images
    : 0;
  // Неизменённые кадры кладутся жёсткой ссылкой и места не занимают — их из
  // оценки надо вычесть, иначе «займёт 40 ГБ» пугает впустую.
  // Ссылками ложатся строки без графа: их образцы это те же файлы проекта.
  const linked = (preview?.feeds || [])
    .filter((f) => f.source_node === null)
    .reduce((sum, f) => sum + f.samples, 0);
  const estimate = Math.round((samplesOut - linked) * perImage * 1.15);

  const build = async () => {
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      const got = await sets.createSet(code, { ...spec, name: name.trim() });
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

      {error && <Banner className="mag-error" onClose={() => setError(null)}>{error}</Banner>}

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
                {detail?.datasets.map((d) => {
                  const on = datasets.includes(d.id);
                  return (
                    <span key={d.id} className={`t-ds${on ? " on" : ""}`}>
                      <button
                        type="button"
                        className="t-ds-name"
                        onClick={() => {
                          setDatasets((old) =>
                            on ? old.filter((x) => x !== d.id) : [...old, d.id]
                          );
                          // Датасет выключили — снимаем и закрепление. Иначе
                          // оно доживёт до следующего включения и решит судьбу
                          // кадров молча.
                          if (on) {
                            setParts(({ [d.id]: _off, ...rest }) => rest);
                          }
                        }}
                      >
                        {d.name}
                        <span>{ru(d.images_count)}</span>
                      </button>
                      {on && mode !== "manual" && (
                        <select
                          className="t-ds-part"
                          value={parts[d.id] ?? ""}
                          aria-label={`где используется ${d.name}`}
                          onChange={(e) =>
                            setParts((old) => {
                              const next = { ...old };
                              const part = e.target.value as DatasetPart | "";
                              if (part) next[d.id] = part;
                              else delete next[d.id];
                              return next;
                            })
                          }
                        >
                          <option value="">обе</option>
                          <option value="train">обучение</option>
                          <option value="val">проверка</option>
                        </select>
                      )}
                    </span>
                  );
                })}
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
                    <span className="t">
                      {k === "bbox" ? "Рамки" : "Сегментация"}
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
                    <span className="t">{m.title}</span>
                  </button>
                ))}
              </div>

              {mode !== "manual" && (
                <div className="t-kv" style={{ marginBottom: 12 }}>
                  <span>Доля проверки</span>
                  <input
                    type="range"
                    className="t-slider"
                    min={0.05}
                    max={0.5}
                    step={0.01}
                    value={ratio}
                    onChange={(e) => setRatio(Number(e.target.value))}
                    aria-label="Доля проверки"
                  />
                  <b>{Math.round(ratio * 100)} %</b>
                </div>
              )}

              {/* Полоса признаков — только пока их считают или не хватает.
                  Досчитанная до конца, она висела зелёной навсегда и не
                  сообщала ничего: «11 885 из 11 885» — это не состояние, а
                  сообщение о том, что состояния больше нет. Число групп
                  живёт в карточке справа, вместе с остальным итогом. */}
              {mode === "smart" && preview?.embeddings &&
                (preview.embeddings.missing > 0 ||
                  preview.embeddings.job ||
                  preview.embeddings.failure) && (
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
                Обучающая часть
              </div>
              <FeedRows
                part="train"
                rows={feeds}
                graphs={graphs}
                tags={tags}
                preview={preview?.feeds || []}
                onChange={setFeeds}
              />

              <div className="g-label" style={{ margin: "20px 0 10px" }}>
                Проверочная часть
              </div>
              <FeedRows
                part="val"
                rows={feeds}
                graphs={graphs}
                tags={tags}
                preview={preview?.feeds || []}
                onChange={setFeeds}
              />

              {feeds.some((r) => r.part === "val" && r.graph_version_id) && (
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
                className="mag-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: "100%" }}
                aria-label="Имя набора"
              />
            </>
          )}
        </div>

        <div>
          {/* Пока идёт пересчёт, карточка честно гаснет: числа в ней —
              прошлое деление, и показывать их в полную силу рядом с только
              что сдвинутым ползунком значит врать. Полоса под подписью
              бегущая, без процентов: сколько осталось, никто не знает. */}
          <div className={computing ? "t-side t-side-busy" : "t-side"}>
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
            {computing && <div className="t-busy-line" aria-hidden="true" />}
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

          <div className="t-nav">
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
                disabled={Boolean(blocked)}
                onClick={() => setStep((s) => s + 1)}
              >
                Дальше — {STEPS[step + 1]?.toLowerCase()}
              </button>
            ) : (
              <button
                type="button"
                className="mag-btn"
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
