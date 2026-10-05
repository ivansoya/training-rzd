// Мастер набора: данные → деление → аугментации → имя. Справа итог тем же кодом, которым соберётся набор.
// Деление идёт раньше аугментаций и в исполнителе: иначе копии одного кадра разъедутся по половинам,
// и проверка будет мерить запоминание.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { backgroundWords, getProject } from "../../../auth/api";
import type { LabelClass, ProjectDetail } from "../../../auth/api";
import { classesIn } from "../../../api/datasets";
import * as aug from "../../../api/aug";
import { listTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import * as setsApi from "../../../api/trainsets";
import type { AnnKind, DatasetPart, FeedRow, Preview, SplitMode } from "../../../api/trainsets";
import {
  Button, Card, Check, Field, Icon, Input, Legend, LinkButton, Notice, PageHeader, Pill, Progress, Radio, Range, Seg, Select,
  StackBar, Swatch, Table, cx,
} from "../../../ui";
import { count, ru } from "../../ru";
import { FeedRows } from "./FeedRows";
import { SPLIT_MODE, TRAIN, VAL, bytes, seedFromSet, similarName } from "./sets";

const STEPS = ["Данные", "Деление", "Аугментации", "Имя и сборка"];

const MODES: { key: SplitMode; title: string; hint: string }[] = [
  { key: "manual", title: "Как размечено", hint: "Половину задаёт сам кадр. Кадры без половины уйдут в train." },
  { key: "random", title: "Случайно", hint: "Жребий по кадрам. Быстро, но редкий класс может целиком уехать в одну половину." },
  { key: "balanced", title: "С учётом классов", hint: "Каждый класс делится в заданной доле. Выбор по умолчанию." },
  { key: "smart", title: "Умное", hint: "Похожие кадры (соседние в ролике) не разъезжаются по половинам. Нужны признаки кадров." },
];

const START_FEEDS: FeedRow[] = [
  { part: "train", position: 0, graph_version_id: null, bindings: [{ source_node: "", feed: "train", tag_ids: [] }] },
  { part: "val", position: 0, graph_version_id: null, bindings: [{ source_node: "", feed: "val", tag_ids: [] }] },
];

const newSeed = () => Math.floor(Math.random() * 2 ** 31);

export default function SetWizard() {
  const { code = "" } = useParams<{ code: string }>();
  const [search] = useSearchParams();
  const from = search.get("from");
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [graphs, setGraphs] = useState<aug.GraphSummary[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [perSample, setPerSample] = useState(0);
  const [source, setSource] = useState<{ name: string; lost: { datasets: number; classes: number } } | null>(null);

  const [datasets, setDatasets] = useState<string[]>([]);
  // Датасет, закреплённый за половиной целиком; без записи — общий и делится наравне со всеми
  const [parts, setParts] = useState<Record<string, DatasetPart>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [kind, setKind] = useState<AnnKind>("bbox");
  const [mode, setMode] = useState<SplitMode>("balanced");
  const [ratio, setRatio] = useState(0.2);
  // Зерно одно на предпросмотр и сборку — иначе таблица разошлась бы с собранным
  const [seed, setSeed] = useState(newSeed);
  const [feeds, setFeeds] = useState<FeedRow[]>(START_FEEDS);
  const [name, setName] = useState("");

  const [preview, setPreview] = useState<Preview | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (!code || loaded.current) return;
    loaded.current = true;
    void (async () => {
      try {
        const [got, cls, g, t, list] = await Promise.all([
          getProject(code),
          classesIn(code, "any"),
          aug.projectGraphs(code),
          listTags(code).catch(() => ({ tags: [] as Tag[] })),
          setsApi.listSets(code).catch(() => ({ sets: [] as setsApi.TrainSet[], role: "" })),
        ]);
        setDetail(got);
        setClasses(cls.classes);
        setGraphs([...g.graphs, ...g.mine]);
        setTags(t.tags);
        const taken = list.sets.map((s) => s.name);
        setNames(taken);
        // Вес образца по собранным наборам: исходник ×1,15 завышал оценку вдвое
        const done = list.sets.filter((s) => s.status === "ready" && (s.counts?.written ?? 0) > 0);
        const n = done.reduce((a, s) => a + (s.counts?.written ?? 0), 0);
        setPerSample(n ? done.reduce((a, s) => a + s.size_bytes, 0) / n : 0);

        const base = from ? await setsApi.getSet(code, from).catch(() => null) : null;
        if (base) {
          const { spec, lost } = seedFromSet(base, { datasets: got.datasets.map((d) => d.id), classes: cls.classes.map((c) => c.id) });
          setDatasets(spec.datasets);
          setParts(spec.dataset_parts ?? {});
          setPicked(spec.classes);
          setKind(spec.ann_type);
          setMode(spec.split_mode);
          setRatio(spec.split_mode === "manual" ? 0.2 : spec.val_ratio);
          setSeed(spec.seed);
          if (spec.feeds?.length) setFeeds(spec.feeds);
          setName(similarName(base.name, taken));
          setSource({ name: base.name, lost });
        } else {
          setDatasets(got.datasets.map((d) => d.id));
          setPicked(cls.classes.filter((c) => c.annotations > 0).map((c) => c.id));
          const plain = `${got.project.name} — набор`;
          setName(taken.includes(plain) ? similarName(plain, taken) : plain);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [code, from]);

  const spec = useMemo(() => ({
    datasets, dataset_parts: parts, classes: picked, ann_type: kind, split_mode: mode, val_ratio: ratio, seed, feeds,
  }), [datasets, parts, picked, kind, mode, ratio, seed, feeds]);

  // Предпросмотр на каждое изменение — тем же кодом, которым потом соберётся набор
  useEffect(() => {
    if (!code || !datasets.length || !picked.length) {
      setPreview(null);
      setComputing(false);
      return;
    }
    let alive = true;
    // «Считаю» сразу, до паузы: иначе сдвинутый ползунок триста миллисекунд показывал старое деление
    setComputing(true);
    const timer = window.setTimeout(() => {
      setsApi.preview(code, spec)
        .then((got) => alive && setPreview(got))
        .catch((e) => alive && setError((e as Error).message))
        .finally(() => alive && setComputing(false));
    }, 300);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [code, spec, datasets.length, picked.length]);

  // Пока признаки считаются, предпросмотр перечитывается сам
  const embedJob = preview?.embeddings?.job?.id ?? null;
  useEffect(() => {
    if (!code || !embedJob) return;
    const t = window.setInterval(() => { setsApi.preview(code, spec).then(setPreview).catch(() => undefined); }, 2000);
    return () => window.clearInterval(t);
  }, [code, spec, embedJob]);

  const embed = async () => {
    setError(null);
    try {
      // force: человек нажал сам, причину прошлого отказа он видел
      await setsApi.startEmbed(code, { ...spec, force: true });
      setPreview(await setsApi.preview(code, spec));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      await setsApi.createSet(code, { ...spec, name: name.trim() });
      navigate(`/projects/${code}/training`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // `??` — на сервер, который строк ещё не знает: «0 образцов» читалось бы как поломка
  const samplesOut = preview ? preview.samples ?? preview.train + preview.val : 0;
  const perImage = detail && detail.stats.images ? detail.stats.size_bytes / detail.stats.images : 0;
  // Строки без графа ложатся жёсткой ссылкой и места не занимают
  const linked = (preview?.feeds || []).filter((f) => f.source_node === null).reduce((a, f) => a + f.samples, 0);
  const estimate = Math.round((samplesOut - linked) * (perSample || perImage * 1.15));
  const needsEmbeddings = mode === "smart" && (preview?.embeddings?.missing ?? 0) > 0;
  const tagless = feeds.some((r) => r.bindings.some((b) => b.feed === "tags" && b.tag_ids.length === 0));
  const taken = names.includes(name.trim());

  // Почему нельзя дальше — словами под кнопкой: подсказку при наведении не найдут
  const why = (at: number): string | null =>
    at === 0 && !datasets.length ? "Выберите хотя бы один датасет."
      : at === 0 && !picked.length ? "Выберите хотя бы один класс."
        : at === 1 && needsEmbeddings ? "Сперва посчитаем признаки кадров — без них группы не построить."
          : at === 2 && tagless ? "В строке «кадры с тагами» не выбран ни один таг — выберите или уберите строку."
            : at === 3 && !name.trim() ? "У набора должно быть имя."
              : at === 3 && taken ? "Набор с таким именем уже есть."
                : at === 3 && !preview?.train ? "В train не попадает ни одного кадра."
                  : null;
  const blocked = why(step);
  const reachable = (to: number) => Array.from({ length: to }, (_, i) => i).every((i) => !why(i));

  const dsById = new Map((detail?.datasets ?? []).map((d) => [d.id, d]));
  const pickedCls = classes.filter((c) => picked.includes(c.id));
  const stepNote = [
    datasets.length ? `${count(datasets.length, "датасет", "датасета", "датасетов")} · ${count(picked.length, "класс", "класса", "классов")}` : "",
    `${SPLIT_MODE[mode]}${mode !== "manual" ? `, ${Math.round(ratio * 100)} %` : ""}`,
    (() => { const n = new Set(feeds.map((f) => f.graph_version_id).filter(Boolean)).size; return n ? count(n, "граф", "графа", "графов") : "без графов"; })(),
    "",
  ];

  return (
    <div className="page tw">
      <PageHeader title={source ? `Похожий на «${source.name}»` : "Новый набор"}
        desc="всё, что справа, считается тем же кодом, которым соберётся набор"
        actions={<LinkButton variant="ghost" to={`/projects/${code}/training`}>Отмена</LinkButton>} />
      {source && (source.lost.datasets > 0 || source.lost.classes > 0) && (
        <Notice tone="warn">
          Из настроек «{source.name}» выпали {[source.lost.datasets ? count(source.lost.datasets, "датасет", "датасета", "датасетов") : "",
            source.lost.classes ? count(source.lost.classes, "класс", "класса", "классов") : ""].filter(Boolean).join(" и ")} — их больше нет в проекте.
        </Notice>
      )}
      {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}

      <nav className="tw-steps" aria-label="Шаги мастера">
        {STEPS.map((t, i) => (
          <button key={t} type="button" className={cx("tw-step", i < step && "done", i === step && "cur")}
            aria-current={i === step ? "step" : undefined} disabled={i > step && !reachable(i)} onClick={() => setStep(i)}>
            <b>{i < step ? <Icon name="tick" size={13} /> : i + 1}</b>{t}
            {i < step && stepNote[i] && <small>{stepNote[i]}</small>}
          </button>
        ))}
      </nav>

      <div className="tw-grid">
        <div className="tw-main">
          {step === 0 && (<>
            <Card title="Датасеты" desc="кадры из открытых тасок в набор не идут" flush className="tw-ds">
              {detail && detail.datasets.length === 0 && <p className="tw-note">В проекте нет ни одного датасета — собирать не из чего.</p>}
              {detail?.datasets.map((d) => {
                const on = datasets.includes(d.id);
                return (
                  <div key={d.id} className={cx("tw-dsr", !on && "off")}>
                    <Check checked={on} onChange={(v) => {
                      setDatasets((old) => (v ? [...old, d.id] : old.filter((x) => x !== d.id)));
                      // Выключенный датасет теряет и закрепление — иначе оно молча решило бы судьбу кадров при включении
                      if (!v) setParts(({ [d.id]: _off, ...rest }) => rest);
                    }}>{d.name}</Check>
                    <span className="ui-mono t-xs t-faint">{ru(d.images_count)}</span>
                    {on && mode !== "manual" ? (
                      <Select size="sm" label={`Где используется ${d.name}`} value={parts[d.id] ?? "both"}
                        onChange={(v) => setParts((old) => {
                          const next = { ...old };
                          if (v === "both") delete next[d.id];
                          else next[d.id] = v;
                          return next;
                        })}
                        options={[{ value: "both", label: "делить на обе" }, { value: "train", label: "только train" }, { value: "val", label: "только val" }]} />
                    ) : <span />}
                  </div>
                );
              })}
            </Card>
            <Card title="Классы" desc={`${picked.length} из ${classes.length} · объектов в выбранных датасетах`} actions={<>
              <Button variant="ghost" size="sm" onClick={() => setPicked(classes.map((c) => c.id))}>Все</Button>
              <Button variant="ghost" size="sm" onClick={() => setPicked([])}>Ничего</Button>
            </>}>
              {classes.length === 0 ? <p className="tw-note">В проекте нет классов — размечать и учить нечему.</p> : (
                <div className="tw-cls">
                  {classes.map((c) => {
                    const on = picked.includes(c.id);
                    return (
                      <button key={c.id} type="button" className={cx("tw-ctog", on && "on")} aria-pressed={on}
                        style={{ "--cc": c.color } as CSSProperties}
                        onClick={() => setPicked((old) => (on ? old.filter((x) => x !== c.id) : [...old, c.id]))}>
                        <span className="tw-sw" /><span className="t-ell">{c.name}</span><b className="ui-mono">{ru(c.annotations)}</b>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
            <Card>
              <div className="row" style={{ gap: 14 }}>
                <span className="t-sm t-muted tw-lbl">Вид разметки</span>
                <Seg label="Вид разметки" value={kind} onChange={setKind} options={[
                  { value: "bbox", label: "Рамки" }, { value: "polygon", label: "Сегментация" },
                ]} />
                <span className="t-xs t-faint">{kind === "bbox" ? "контуры в рамочный набор идут описанным прямоугольником" : "в набор идут только контуры"}</span>
              </div>
            </Card>
          </>)}

          {step === 1 && (<>
            <Card title={`Как делить ${preview ? count(preview.images, "кадр", "кадра", "кадров") : "кадры"}`}>
              <div className="tw-radios">
                {MODES.map((m) => (
                  <Radio key={m.key} name="split" checked={mode === m.key} onChange={() => setMode(m.key)} title={m.title} hint={m.hint}>
                    {m.key === "smart" && preview?.embeddings && (preview.embeddings.missing > 0 || preview.embeddings.job || preview.embeddings.failure) && (
                      <div className="tw-embed">
                        <Progress value={preview.embeddings.ready} max={Math.max(1, preview.embeddings.total)} label="Признаки кадров" color="var(--st-done)" />
                        <span className="t-xs t-muted">признаки посчитаны у {ru(preview.embeddings.ready)} из {ru(preview.embeddings.total)}
                          {preview.embeddings.job?.stage_text ? ` · ${preview.embeddings.job.stage_text}` : ""}</span>
                        {!preview.embeddings.job && preview.embeddings.failure && <Pill tone="bad">Не посчитались: {preview.embeddings.failure.error}</Pill>}
                        {needsEmbeddings && (
                          <Button size="sm" icon="cpu" onClick={embed} disabled={Boolean(preview.embeddings.job)}>
                            {preview.embeddings.job ? "Считаю…" : `${preview.embeddings.failure ? "Повторить счёт" : "Посчитать признаки"} (${ru(preview.embeddings.missing)})`}
                          </Button>
                        )}
                      </div>
                    )}
                  </Radio>
                ))}
              </div>
              {mode !== "manual" && (
                <div className="tw-knobs">
                  <Field label="Доля val" aside={<b className="ui-mono">{Math.round(ratio * 100)} %</b>}>
                    {(id) => <Range id={id} min={0.05} max={0.5} step={0.01} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} />}
                  </Field>
                  <div className="row tw-seed">
                    <span className="t-sm t-muted tw-lbl">Перемешивание</span>
                    <span className="ui-mono t-sm">№ {ru(seed)}</span>
                    <Button variant="ghost" size="sm" icon="shuffle" onClick={() => setSeed(newSeed())}>Перемешать по-другому</Button>
                    <span className="t-xs t-faint">тот же номер даёт то же деление</span>
                  </div>
                </div>
              )}
            </Card>
            {preview && preview.classes.length > 0 && (
              <Card title="Что получится по классам" desc="кадров с классом" flush>
                <Table className="tw-ctbl">
                  <thead><tr><th>Класс</th><th className="r">train</th><th className="r">val</th><th /></tr></thead>
                  <tbody>
                    {preview.classes.map((c) => {
                      const color = pickedCls.find((x) => x.name === c.name)?.color;
                      const thin = c.val > 0 && c.val <= 2;
                      return (
                        <tr key={c.export_id}>
                          <td><span className="row" style={{ gap: 8 }}><Swatch color={color} />{c.name}</span></td>
                          <td className="r ui-mono">{ru(c.train)}</td>
                          <td className={cx("r ui-mono", (thin || (!c.val && c.train > 0)) && "tw-warn")}>{ru(c.val)}</td>
                          <td className="tw-bar"><StackBar parts={[{ value: c.train, color: TRAIN, label: "train" }, { value: c.val, color: VAL, label: "val" }]} /></td>
                        </tr>
                      );
                    })}
                    {preview.background > 0 && (
                      <tr>
                        <td className="t-muted">фон · {backgroundWords(preview.background_parts) || "кадры без разметки"}</td>
                        <td className="r ui-mono">{ru(preview.background_split?.train ?? 0)}</td>
                        <td className="r ui-mono">{ru(preview.background_split?.val ?? 0)}</td>
                        <td />
                      </tr>
                    )}
                  </tbody>
                </Table>
              </Card>
            )}
          </>)}

          {step === 2 && (<>
            <FeedRows part="train" rows={feeds} graphs={graphs} tags={tags} preview={preview?.feeds ?? []}
              frames={preview?.train ?? null} onChange={setFeeds} />
            <FeedRows part="val" rows={feeds} graphs={graphs} tags={tags} preview={preview?.feeds ?? []}
              frames={preview?.val ?? null} onChange={setFeeds} />
            {feeds.some((r) => r.part === "val" && r.graph_version_id) ? (
              <Notice tone="warn">val пойдёт через аугментации: метрика измерит качество на выдуманных кадрах, а не на настоящих. Делайте так, только если точно знаете зачем.</Notice>
            ) : (
              <Notice>Если у набора есть граф, встроенные аугментации YOLO при обучении выключаются целиком — чтобы не крутить кадр дважды.</Notice>
            )}
          </>)}

          {step === 3 && (<>
            <Card>
              <Field label="Имя набора" error={taken ? "Набор с таким именем уже есть." : undefined}
                hint="По имени набор ищут в окне запуска обучения — назовите по тому, чем он отличается.">
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus invalid={taken} />}
              </Field>
            </Card>
            <Card title="Проверьте перед сборкой">
              <dl className="tw-kv">
                <dt>Данные</dt><dd>{datasets.map((id) => dsById.get(id)?.name).filter(Boolean).join(", ") || "—"} · {count(picked.length, "класс", "класса", "классов")} · {kind === "bbox" ? "рамки" : "контуры"}</dd>
                <dt>Деление</dt><dd>{SPLIT_MODE[mode]}{mode !== "manual" ? `, val ${Math.round(ratio * 100)} % · № ${ru(seed)}` : ""}</dd>
                {(["train", "val"] as const).map((p) => (
                  <FeedsLine key={p} part={p} rows={feeds} graphs={graphs} preview={preview} />
                ))}
              </dl>
            </Card>
          </>)}
        </div>

        <aside className="ui-card tw-side" aria-label="Итог">
          <section>
            <h5>Разделится так{computing && <span className="tw-busy"> · считаю{mode === "smart" ? " умное деление" : ""}{preview?.split_ms ? ` (≈ ${Math.max(1, Math.round(preview.split_ms / 1000))} с)` : "…"}</span>}</h5>
            {preview ? (
              <div className={cx("tw-sum", computing && "tw-stale")}>
                <StackBar height={12} parts={[{ value: preview.train, color: TRAIN, label: "train" }, { value: preview.val, color: VAL, label: "val" }]} />
                <Legend items={[
                  { label: <><b className="ui-mono">{ru(preview.train)}</b> train</>, color: TRAIN },
                  { label: <><b className="ui-mono">{ru(preview.val)}</b> val</>, color: VAL },
                ]} />
              </div>
            ) : <p className="t-sm t-faint">Выберите датасеты и классы — посчитаю, что получится.</p>}
          </section>
          {preview && (
            <section className={cx(computing && "tw-stale")}>
              <dl className="tw-nums">
                {step >= 2 ? <>
                  <dt>образцов</dt><dd>{ru(samplesOut)}</dd>
                  <dt>во сколько раз</dt><dd>×{(samplesOut / Math.max(1, preview.train + preview.val)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}</dd>
                  <dt>ссылками, без места</dt><dd>{ru(linked)}</dd>
                  <dt>займёт на диске</dt><dd>{perSample ? "≈" : "до"} {bytes(Math.max(0, estimate))}</dd>
                </> : <>
                  <dt>кадров</dt><dd>{ru(preview.images)}</dd>
                  {preview.groups !== null && <><dt>групп похожих кадров</dt><dd>{ru(preview.groups)}</dd></>}
                  {preview.background > 0 && <><dt>фон, пустой файл</dt><dd>{ru(preview.background)}</dd></>}
                  {preview.dropped > 0 && <><dt>разметка не того рода</dt><dd>{ru(preview.dropped)}</dd></>}
                </>}
              </dl>
            </section>
          )}
          {preview && preview.warnings.length > 0 && (
            <section className="tw-warns">{preview.warnings.map((w) => <Pill key={w} tone="warn">{w}</Pill>)}</section>
          )}
          <section>
            <div className="row" style={{ gap: 8 }}>
              {step > 0 && <Button variant="ghost" icon="back" onClick={() => setStep(step - 1)}>Назад</Button>}
              <span className="grow" />
              {step < 3
                ? <Button variant="primary" iconEnd="forward" disabled={Boolean(blocked)} onClick={() => setStep(step + 1)}>Дальше — {STEPS[step + 1].toLowerCase()}</Button>
                : <Button variant="primary" icon="layers" disabled={busy || Boolean(blocked)} onClick={build}>{busy ? "Ставлю в очередь…" : "Собрать набор"}</Button>}
            </div>
            {blocked ? <span className="tw-why">{blocked}</span>
              : step === 3 && <span className="tw-why">Сборка встанет в очередь; файлы проекта не копируются, а ссылаются.</span>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function FeedsLine({ part, rows, graphs, preview }: {
  part: "train" | "val"; rows: FeedRow[]; graphs: aug.GraphSummary[]; preview: Preview | null;
}) {
  const mine = rows.filter((r) => r.part === part);
  const name = (v: string | null) => {
    const g = v ? graphs.find((x) => x.version_id === v) : null;
    return g ? `${g.name} v${g.version}` : "как есть";
  };
  const out = (preview?.feeds ?? []).filter((f) => f.part === part).reduce((a, f) => a + f.samples, 0);
  return (<>
    <dt>{part}</dt>
    <dd>{mine.length ? mine.map((r) => `${r.bindings.map((b) => (b.feed === "tags" ? "по тагам" : `${b.feed} целиком`)).join(" + ")} → ${name(r.graph_version_id)}`).join("; ") : "ничего"}
      {preview && <> → <b className="ui-mono">{ru(out)}</b></>}</dd>
  </>);
}
