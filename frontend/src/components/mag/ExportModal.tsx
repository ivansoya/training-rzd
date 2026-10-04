import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { pollJob } from "../../api/jobs";
import { classesIn } from "../../api/datasets";
import {
  exportDownloadUrl,
  backgroundWords,
  previewExport,
  startExport,
} from "../../auth/api";
import type {
  ExportOptions,
  ExportSplit,
  ExportPreview,
  ExportResult,
  LabelClass,
  ProjectDetail,
} from "../../auth/api";
import { listTags } from "../../api/tags";
import { startEmbed } from "../../api/trainsets";
import type { SetSpec } from "../../api/trainsets";
import type { Tag } from "../../api/tags";
import {
  AnchorButton, Button, Check, ChipToggle, Dialog, Legend, Notice, Pill, Range, Ring, Seg, StackBar,
} from "../../ui";
import { formatBytes } from "./ProjectShell";
import { count, plural, ru } from "../ru";

interface Props {
  detail: ProjectDetail;
  onClose: () => void;
}

// «error» отдельной ступенью не нужен: сорвавшаяся сборка возвращает окно в
// setup с текстом ошибки, чтобы можно было поправить выбор и повторить.
type Phase = "setup" | "packing" | "ready";

const SOON = "Появится позже — такой разметки в проекте пока нет";

/** Экспорт проекта: слева что выгружать, справа как и что получится. */
export default function ExportModal({ detail, onClose }: Props) {
  const code = detail.project.code;
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [pickedDs, setPickedDs] = useState<Set<string>>(() => new Set(detail.datasets.map((d) => d.id)));
  const [pickedCls, setPickedCls] = useState<Set<string>>(new Set());
  const [showUnused, setShowUnused] = useState(false);
  // Таги СУЖАЮТ отбор и работают «любым из»: ничего не отмечено — берём всё.
  const [tags, setTags] = useState<Tag[]>([]);
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  // «keep» — как в проекте; иначе один из способов мастера набора
  const [split, setSplit] = useState<ExportSplit>("keep");
  const [divideBy, setDivideBy] = useState<Exclude<ExportSplit, "keep">>("balanced");
  const [embedBusy, setEmbedBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [annType, setAnnType] = useState<"bbox" | "polygon">("bbox");
  const [valRatio, setValRatio] = useState(0.2);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  // Для какого выбора посчитан предпросмотр: после ошибки на экране старые числа.
  const [previewKey, setPreviewKey] = useState("");
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ответы предпросмотра приходят вразнобой — устаревший не затирает свежий.
  const seq = useRef(0);

  useEffect(() => {
    // Счёт по датасетам: разметка в тасках не выгружается, а класс по ней выбирался.
    classesIn(code, "any")
      .then(({ classes: rows }) => {
        setClasses(rows);
        // По умолчанию — то, что реально размечено: иначе классы без единого примера.
        setPickedCls(new Set(rows.filter((c) => c.annotations > 0).map((c) => c.id)));
      })
      .catch((e) => setError((e as Error).message));
    listTags(code).then(({ tags: rows }) => setTags(rows)).catch(() => setTags([]));
  }, [code]);

  const options: ExportOptions = useMemo(() => ({
    datasets: [...pickedDs],
    classes: [...pickedCls],
    tags: pickedTags,
    split_mode: split,
    val_ratio: valRatio,
    ann_type: annType,
  }), [pickedDs, pickedCls, pickedTags, split, valRatio, annType]);

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
          setPreviewKey(JSON.stringify(options));
          setError(null);
        })
        .catch((e) => { if (seq.current === mine) setError((e as Error).message); })
        .finally(() => { if (seq.current === mine) setPending(false); });
    }, 250);
    return () => window.clearTimeout(h);
  }, [code, options, phase, tick]);

  // Пока считаются признаки для умного деления — пересчитывать предпросмотр
  const embedJob = preview?.embeddings?.job ?? null;
  useEffect(() => {
    if (!embedJob || phase !== "setup") return;
    const h = window.setTimeout(() => setTick((n) => n + 1), 2000);
    return () => window.clearTimeout(h);
  }, [embedJob, preview, phase]);

  async function embed() {
    setEmbedBusy(true);
    try {
      await startEmbed(code, { ...options, force: true } as unknown as Partial<SetSpec> & { force?: boolean });
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEmbedBusy(false);
    }
  }

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  async function run() {
    setError(null);
    setPhase("packing");
    setProgress(0);
    try {
      // Смещение часового пояса — ради даты в имени архива: сервер живёт по UTC.
      const body = { ...options, tz_offset: -new Date().getTimezoneOffset() };
      const { job_id } = await startExport(code, body);
      const res = await pollJob<ExportResult>(job_id, (job) =>
        setProgress(job.total ? job.processed / job.total : 0));
      setResult(res);
      setPhase("ready");
    } catch (e) {
      setError((e as Error).message);
      setPhase("setup");
    }
  }

  const locked = phase !== "setup";
  const byIndex = new Map((preview?.classes ?? []).map((r) => [r.class_index, r]));
  const maxTotal = Math.max(1, ...(preview?.classes ?? []).map((r) => r.train + r.val + r.test));
  const canRun = previewKey === JSON.stringify(options) && options.datasets.length > 0
    && options.classes.length > 0 && (preview?.images ?? 0) > 0;
  const used = classes.filter((c) => c.annotations > 0 || pickedCls.has(c.id));
  const unused = classes.length - used.length;
  const visible = showUnused ? classes : used;

  const summary = preview && options.datasets.length && options.classes.length ? (
    <div className="exp-sum">
      <div className="exp-nums">
        <div><b>{ru(preview.images)}</b><span>{plural(preview.images, "кадр", "кадра", "кадров")}</span></div>
        <div><b>{ru(preview.annotations)}</b><span>{plural(preview.annotations, "разметка", "разметки", "разметок")}</span></div>
      </div>
      <StackBar height={8} label="Деление на обучение и проверку" parts={[
        { label: "train", value: preview.splits.train ?? 0, color: "var(--c1)" },
        { label: "val", value: preview.splits.val ?? 0, color: "var(--c2)" },
        // Сплит «test» встречается редко, но если он есть — кадры уедут в свою папку
        ...(preview.splits.test ? [{ label: "test", value: preview.splits.test, color: "var(--c3)" }] : []),
      ]} />
      <Legend items={[
        { label: <>train <b className="ui-mono">{ru(preview.splits.train ?? 0)}</b></>, color: "var(--c1)" },
        { label: <>val <b className="ui-mono">{ru(preview.splits.val ?? 0)}</b></>, color: "var(--c2)" },
        ...(preview.splits.test ? [{ label: <>test <b className="ui-mono">{ru(preview.splits.test)}</b></>, color: "var(--c3)" }] : []),
      ]} />
      {/* Пропуск по роду разметки — словами и с единицами: «пропущено 412» читается как поломка */}
      {preview.wrong_kind > 0 && (
        <p className="ui-hint">
          Не идут {preview.ann_type === "polygon"
            ? `${count(preview.wrong_kind, "бокс", "бокса", "боксов")} — в сегментацию идут только контуры`
            : count(preview.wrong_kind, "объект неподходящего вида", "объекта неподходящего вида", "объектов неподходящего вида")}
          {preview.dropped > 0 && `; ${count(preview.dropped, "кадр", "кадра", "кадров")}, где больше ничего нет, ${plural(preview.dropped, "не идёт", "не идут", "не идут")} целиком`}.
        </p>
      )}
      {preview.empty > 0 && (
        <p className="ui-hint">
          {phase === "ready"
            ? count(preview.empty, "кадр ушёл", "кадра ушли", "кадров ушли")
            : count(preview.empty, "кадр уйдёт", "кадра уйдут", "кадров уйдут")} фоном, с пустым файлом разметки
          {backgroundWords(preview.background_parts) && ` — ${backgroundWords(preview.background_parts)}`}.
        </p>
      )}
      {pickedTags.length > 0 && preview.no_tag > 0 && (
        <p className="ui-hint">Только кадры с отмеченными тагами — {count(preview.no_tag, "кадр отсеян", "кадра отсеяно", "кадров отсеяно")}.</p>
      )}
      {preview.warnings.length > 0 && (
        <div className="ui-pills">{preview.warnings.map((w) => <Pill key={w} tone="warn">{w}</Pill>)}</div>
      )}
    </div>
  ) : (
    <Notice tone="warn">Отметьте хотя бы один датасет и класс — иначе выгружать нечего.</Notice>
  );

  const right = phase === "packing" ? (
    <>
      {summary}
      <div className="exp-stage">
        <Ring value={progress} label="Сборка архива" />
        <b>Собираю архив…</b>
      </div>
    </>
  ) : phase === "ready" && result ? (
    <>
      {summary}
      <div className="exp-stage">
        <Ring tone="done" label="Архив готов" />
        <b>Архив готов</b>
        <span>{result.file_name} · {formatBytes(result.size_bytes)}</span>
      </div>
    </>
  ) : (
    <>
      <div className="exp-field">
        <span>Формат</span>
        <Seg label="Формат" value="yolo" onChange={() => undefined} options={[
          { value: "yolo", label: "YOLO" },
          { value: "coco", label: "COCO", disabled: true, title: SOON },
          { value: "voc", label: "VOC", disabled: true, title: SOON },
        ]} />
      </div>
      <div className="exp-field">
        <span>Тип разметки</span>
        <Seg label="Тип разметки" value={annType} onChange={(v) => setAnnType(v as "bbox" | "polygon")} options={[
          { value: "bbox", label: "Боксы", title: "Рамка на объект. Контур сводится к охватывающей рамке" },
          { value: "polygon", label: "Сегментация", title: "Контур на объект. Боксы в такую выгрузку не идут" },
          { value: "mask", label: "Маски", disabled: true, title: SOON },
        ]} />
      </div>
      <div className="exp-field">
        <span>Обучение и проверка</span>
        <Seg label="Обучение и проверка" value={split === "keep" ? "0" : "1"}
          onChange={(v) => setSplit(v === "1" ? divideBy : "keep")} options={[
            { value: "0", label: "Как в проекте" },
            { value: "1", label: "Поделить заново" },
          ]} />
        {split === "keep" ? <p className="ui-hint">Сплит кадра берётся из проекта; кадры без сплита делятся в той же пропорции.</p> : (
          <>
            <Seg label="Способ деления" value={split} onChange={(v) => { setSplit(v); setDivideBy(v as Exclude<ExportSplit, "keep">); }} options={[
              { value: "random", label: "Случайно", title: "Кадры раскладываются случайно — без оглядки на классы" },
              { value: "balanced", label: "С учётом классов", title: "Случайно, но редкие классы попадают и в проверку" },
              { value: "smart", label: "Умное", title: "Похожие кадры едут в одну сторону целиком — проверка не меряет запоминание" },
            ]} />
            <div className="row between t-sm"><span className="t-muted">На проверку</span><span className="ui-mono">{Math.round(valRatio * 100)} %</span></div>
            <Range min={5} max={50} step={1} value={Math.round(valRatio * 100)} aria-label="Доля на проверку"
              onChange={(e) => setValRatio(Number(e.target.value) / 100)} />
            {split === "smart" && preview?.embeddings && <Embeddings state={preview.embeddings} busy={embedBusy} onStart={embed} />}
          </>
        )}
      </div>
      <hr className="ov-sep" />
      {summary}
    </>
  );

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={940} height={760} className="exp"
      title="Экспорт проекта" desc={`${detail.project.name} · архив с изображениями и разметкой`} bare
      footer={
        <>
          <span className="grow t-sm t-muted">{phase === "setup" ? (pending ? "Считаю предпросмотр…" : preview ? "Предпросмотр пересчитан" : "") : ""}</span>
          <Button variant="ghost" onClick={onClose}>{phase === "ready" ? "Закрыть" : "Отмена"}</Button>
          {phase === "ready" && result ? (
            <AnchorButton variant="primary" icon="download" href={exportDownloadUrl(code, result.job_id)} download={result.file_name}>
              Скачать архив
            </AnchorButton>
          ) : (
            <Button variant="primary" icon="download" disabled={!canRun || phase === "packing" || pending} onClick={run}>
              {phase === "packing" ? "Собираю…" : "Экспортировать"}
            </Button>
          )}
        </>
      }>
      <div className={locked ? "exp-l locked" : "exp-l"} aria-disabled={locked || undefined}>
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        <section>
          <div className="exp-h">
            <span>Датасеты</span>
            <button type="button" disabled={locked} onClick={() => setPickedDs(new Set(detail.datasets.map((d) => d.id)))}>все</button>
          </div>
          {detail.datasets.length === 0 ? <p className="ui-hint">В проекте пока нет датасетов.</p> : (
            <div className="exp-list">
              {detail.datasets.map((d) => (
                <div key={d.id} className="exp-ds">
                  <Check checked={pickedDs.has(d.id)} disabled={locked}
                    onChange={() => setPickedDs((s) => toggle(s, d.id))}>{d.name}</Check>
                  <span className="ui-mono t-xs t-muted">{ru(d.images_count)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {tags.length > 0 && (
          <section>
            <div className="exp-h">
              <span>Таги</span>
              {pickedTags.length > 0 && <button type="button" disabled={locked} onClick={() => setPickedTags([])}>снять</button>}
            </div>
            <div className="ui-pills">
              {tags.map((t) => (
                <ChipToggle key={t.id} pressed={pickedTags.includes(t.id)} count={t.images ?? 0} disabled={locked}
                  onToggle={() => setPickedTags((prev) => prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id])}>
                  {t.name}
                </ChipToggle>
              ))}
            </div>
            <p className="ui-hint">{pickedTags.length
              ? "Только кадры хотя бы с одним из отмеченных тагов."
              : "Ничего не отмечено — берутся кадры со всеми тагами и без них."}</p>
          </section>
        )}

        <section>
          <div className="exp-h">
            <span>Классы <span className="t-faint">· щелчок по строке — в выгрузку или из неё · train / val</span></span>
            <span className="exp-acts">
              <button type="button" disabled={locked} onClick={() => setPickedCls(new Set(classes.map((c) => c.id)))}>все</button>
              <button type="button" disabled={locked} onClick={() => setPickedCls(new Set(classes.filter((c) => c.annotations > 0).map((c) => c.id)))}>с разметкой</button>
              <button type="button" disabled={locked} onClick={() => setPickedCls(new Set())}>снять</button>
            </span>
          </div>
          <div className="exp-list">
            {visible.map((c) => {
              const on = pickedCls.has(c.id);
              const row = on ? byIndex.get(c.class_index) : undefined;
              const total = row ? row.train + row.val + row.test : 0;
              return (
                <button key={c.id} type="button" className={`exp-cls${on ? " on" : ""}`} disabled={locked}
                  style={{ "--cc": c.color } as CSSProperties} aria-pressed={on}
                  title={on ? "Убрать из выгрузки" : "Добавить в выгрузку"}
                  onClick={() => setPickedCls((s) => toggle(s, c.id))}>
                  <span className="exp-pick" aria-hidden="true" />
                  <span className="exp-n"><span className="t-ell">{c.name}</span><small>{c.superclass_name ?? "без группы"}</small></span>
                  {row ? (
                    <span className="exp-tv" style={{ width: `${Math.max(6, (total / maxTotal) * 100)}%` }} title={`train ${row.train} · val ${row.val}`}>
                      <i style={{ flex: row.train || 0.001, background: "var(--c1)" }} />
                      <i style={{ flex: row.val || 0.001, background: "var(--c2)" }} />
                    </span>
                  ) : <span />}
                  <span className="exp-num">
                    {row ? <><b>{ru(row.train)}</b> / <span className={row.val ? undefined : "zero"}
                      title={row.val ? undefined : "В проверку не попало ни одного объекта — метрика по классу не посчитается"}>{ru(row.val)}</span></>
                      : c.annotations ? ru(c.annotations) : "нет разметки"}
                  </span>
                </button>
              );
            })}
            {!showUnused && unused > 0 && (
              <button type="button" className="exp-more" onClick={() => setShowUnused(true)}>
                Показать ещё {count(unused, "класс", "класса", "классов")} без разметки
              </button>
            )}
          </div>
        </section>
      </div>
      <div className="exp-r">{right}</div>
    </Dialog>
  );
}

/** Признаки кадров для умного деления: сколько посчитано, идёт ли счёт, что делать. */
function Embeddings({ state, busy, onStart }: {
  state: NonNullable<ExportPreview["embeddings"]>;
  busy: boolean;
  onStart: () => void;
}) {
  if (!state.missing) return <div className="ui-pills"><Pill tone="ok">Признаки есть у всех кадров</Pill></div>;
  return (
    <div className="exp-embed">
      <div className="ui-pills">
        {state.job ? (
          <Pill icon="refresh">{state.job.stage === "embed"
            ? `Считаю признаки: ${ru(state.job.processed)} из ${ru(state.job.total)}`
            : state.job.stage_text || "Признаки в очереди"}</Pill>
        ) : state.failure ? (
          <Pill tone="bad">Признаки не посчитались: {state.failure.error}</Pill>
        ) : (
          <Pill tone="warn">Признаки есть у {ru(state.ready)} из {ru(state.total)} кадров — без них деление идёт с учётом классов</Pill>
        )}
      </div>
      {!state.job && (
        <Button size="sm" icon="sparkle" disabled={busy} onClick={onStart}>
          {state.failure ? "Повторить счёт признаков" : "Посчитать признаки"} ({ru(state.missing)})
        </Button>
      )}
    </div>
  );
}
