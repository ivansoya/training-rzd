// Окно запуска обучения: набор, модель, параметры. Умолчания и пределы — с сервера, своих чисел нет.

import { useEffect, useMemo, useRef, useState } from "react";
import * as runsApi from "../../../api/runs";
import type { ModelRow, ParamSpec, ParamValue, Run } from "../../../api/runs";
import * as setsApi from "../../../api/trainsets";
import type { TrainSet } from "../../../api/trainsets";
import { Button, Check, Dialog, Field, Icon, Input, Notice, Seg, Select, Switch } from "../../../ui";
import { count, ru } from "../../ru";
import { gb, useGpuState } from "../../shell/useGpuState";
import { AUG_KEYS } from "./runs";

const TASK_OF: Record<string, "detect" | "segment"> = { bbox: "detect", polygon: "segment" };

const LABEL: Record<string, string> = {
  epochs: "Эпох", imgsz: "Размер входа", batch: "Батч", patience: "Стоп без улучшения, эпох",
  optimizer: "Оптимизатор", lr0: "Скорость обучения (lr0)", lrf: "Конечная доля скорости (lrf)",
  momentum: "Момент", weight_decay: "Затухание весов", warmup_epochs: "Разогрев, эпох",
  cos_lr: "Косинусный график скорости", freeze: "Заморозить первых слоёв", dropout: "Dropout",
  label_smoothing: "Сглаживание меток", seed: "Зерно", workers: "Загрузчиков данных",
  hsv_h: "Тон (hsv_h)", hsv_s: "Насыщенность (hsv_s)", hsv_v: "Яркость (hsv_v)", degrees: "Поворот, °",
  translate: "Сдвиг, доля", scale: "Масштаб, ±доля", shear: "Скос, °", perspective: "Перспектива",
  flipud: "Отражение ↕, p", fliplr: "Отражение ↔, p", bgr: "Перестановка каналов, p", mosaic: "Мозаика, p",
  mixup: "Mixup, p", copy_paste: "Copy-paste, p", close_mosaic: "Без мозаики последние N эпох",
};
const MAIN = ["epochs", "imgsz", "batch", "patience"];
const FINE = ["optimizer", "lr0", "lrf", "momentum", "weight_decay", "warmup_epochs", "freeze", "dropout",
  "label_smoothing", "seed", "workers", "cos_lr"];

/** Что повторить: набор, модель и параметры прогона. */
export interface RunSeed { setId?: string; model?: string; params?: Record<string, unknown>; name?: string }

export function seedOf(run: Run): RunSeed {
  return { setId: run.set?.id, model: run.base_model, params: run.params, name: `${run.name} · повтор` };
}

export default function RunDialog({ code, seed, onClose, onStarted }: {
  code: string;
  seed: RunSeed;
  onClose: () => void;
  onStarted: (run: Run) => void;
}) {
  const [sets, setSets] = useState<TrainSet[] | null>(null);
  const [setId, setSetId] = useState(seed.setId ?? "");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [spec, setSpec] = useState<Record<string, ParamSpec>>({});
  const [augDefaults, setAugDefaults] = useState<Record<string, number>>({});
  const [model, setModel] = useState("");
  const [values, setValues] = useState<Record<string, ParamValue>>({});
  const [name, setName] = useState("");
  const [named, setNamed] = useState(Boolean(seed.name));
  const [fine, setFine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setsApi.listSets(code).then((got) => {
      const ready = got.sets.filter((s) => s.status === "ready");
      setSets(ready);
      setSetId((cur) => (ready.some((s) => s.id === cur) ? cur : ready[0]?.id ?? ""));
    }).catch((e) => setError((e as Error).message));
  }, [code]);

  const set = sets?.find((s) => s.id === setId) ?? null;
  const task = set ? TASK_OF[set.kind] ?? "detect" : null;
  const hasGraph = Boolean(set?.graph);

  // Модели и схема — под задачу набора; значения повтора поверх умолчаний
  useEffect(() => {
    if (!task) return;
    runsApi.listModels(task).then((got) => {
      setModels(got.models);
      setSpec(got.params);
      setAugDefaults(got.aug_defaults);
      setModel((cur) => [cur, seed.model].find((m) => m && got.models.some((x) => x.id === m)) ?? got.models[0]?.id ?? "");
      const init: Record<string, ParamValue> = {};
      for (const [key, s] of Object.entries(got.params)) {
        const given = seed.params?.[key];
        if (["number", "string", "boolean"].includes(typeof given)) init[key] = given as ParamValue;
        else if (s.default !== null && s.default !== undefined) init[key] = s.default;
      }
      setValues(init);
    }).catch((e) => setError((e as Error).message));
  }, [task, seed]);

  useEffect(() => {
    if (named) return;
    if (set && model) setName(`${set.name} · ${model}`);
  }, [set, model, named]);
  useEffect(() => { if (seed.name) setName(seed.name); }, [seed.name]);

  const chosen = useMemo(() => models.find((m) => m.id === model), [models, model]);
  const augOn = values.augment_mode !== "off";
  const setValue = (key: string, value: ParamValue) => setValues((v) => ({ ...v, [key]: value }));
  const augChanged = AUG_KEYS.some((k) => values[k] !== undefined && values[k] !== augDefaults[k]);

  // Несколько карт на одно обучение (решения 10.10.2026): по выбору, по умолчанию одна; батч общий,
  // как в ultralytics, — каждой карте достаётся батч / число карт, ждёт все карты сразу.
  const live = useGpuState()?.cards.length ?? 0;
  const gpus = Math.min(Math.max(1, Number(values.gpus ?? 1)), Math.max(1, live));
  const batch = Number(values.batch ?? 16);
  const imgsz = Number(values.imgsz ?? 640);
  const even = batch % gpus === 0;
  const [vram, setVram] = useState<{ want_mb: number; source: string } | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!model || !task || live < 2) return;
    const n = ++seq.current;
    const t = window.setTimeout(() => {
      runsApi.modelVram({ model, task, imgsz, batch, gpus })
        .then((got) => { if (n === seq.current) setVram(got); })
        .catch(() => { if (n === seq.current) setVram(null); });
    }, 250);
    return () => window.clearTimeout(t);
  }, [model, task, imgsz, batch, gpus, live]);

  const start = async () => {
    if (!set) return;
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, ParamValue> = {};
      for (const [key, value] of Object.entries(values)) {
        if (hasGraph && (AUG_KEYS.includes(key) || key === "augment_mode")) continue;
        if (value === "" || value === null || value === undefined) continue;
        params[key] = value;
      }
      if ("gpus" in params) params.gpus = gpus;
      const run = await runsApi.startRun(code, { set_id: set.id, model, name: name.trim(), params });
      onStarted(run);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const field = (key: string) => {
    const s = spec[key];
    if (!s) return null;
    const label = LABEL[key] ?? key;
    if (s.type === "bool") {
      return <Check key={key} checked={Boolean(values[key])} onChange={(v) => setValue(key, v)}>{label}</Check>;
    }
    if (s.type === "str" && s.choices) {
      return (
        <Field key={key} label={label}>
          {(id) => <Select id={id} full value={String(values[key] ?? s.default ?? "")} onChange={(v) => setValue(key, v)}
            options={s.choices!.map((c) => ({ value: c, label: c }))} />}
        </Field>
      );
    }
    const cur = values[key];
    return (
      <Field key={key} label={<span title={key}>{label}</span>}>
        {(id) => (
          <Input id={id} type="number" min={s.min} max={s.max} step={s.step ?? (s.type === "int" ? 1 : "any")}
            value={cur === undefined || cur === null ? "" : String(cur)}
            placeholder={s.default === null || s.default === undefined ? "авто" : undefined}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") setValues((v) => { const next = { ...v }; delete next[key]; return next; });
              else setValue(key, Number(raw));
            }} />
        )}
      </Field>
    );
  };

  const empty = sets !== null && sets.length === 0;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }} width={720} modalLock
      title={seed.params ? "Повторить обучение" : "Новое обучение"}
      desc="Обучение встанет в очередь и начнётся, когда освободится карта"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="play" disabled={busy || !model || !set || !even} onClick={start}>
          {busy ? "Ставлю в очередь…" : "Запустить"}
        </Button>
      </>}>
      <div className="rn-form">
        {error && <Notice tone="error" onClose={() => setError(null)}>{error}</Notice>}
        {empty ? (
          <Notice tone="warn">Готовых наборов нет — учиться не на чем. Соберите набор в разделе «Наборы».</Notice>
        ) : (
          <>
            <div className="rn-form-2">
              <Field label="Набор" hint={set?.counts ? `${ru(set.counts.samples)} образцов · обучение ${ru(set.counts.train)} · проверка ${ru(set.counts.val)}` : undefined}>
                {(id) => <Select id={id} full value={setId || undefined} onChange={setSetId} placeholder="Загружаю…"
                  options={(sets ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.kind === "polygon" ? "контуры" : "рамки" }))} />}
              </Field>
              <Field label={`Модель · ${task === "segment" ? "сегментация" : "детекция"}`}
                hint={chosen ? (chosen.builtin ? (chosen.cached ? "Предобучена на COCO, веса уже на томе"
                  : "Весов на томе нет — первый запуск начнёт со скачивания") : "Своя модель, учится от принесённых весов") : undefined}>
                {(id) => <Select id={id} full value={model || undefined} onChange={setModel} placeholder="Загружаю…"
                  options={models.map((m) => ({ value: m.id, label: m.name, hint: [m.size, m.note, m.builtin ? "" : "своя"].filter(Boolean).join(" · ") }))} />}
              </Field>
            </div>
            <Field label="Название обучения">
              {(id) => <Input id={id} value={name} onChange={(e) => { setName(e.target.value); setNamed(true); }} />}
            </Field>
            {chosen?.builtin && chosen.scratch && (
              <Check checked={values.pretrained === false} onChange={(v) => setValue("pretrained", !v)}>
                Учить с нуля, без предобученных весов
              </Check>
            )}

            <section className="rn-form-g">
              <h4>Сколько учить</h4>
              <div className="rn-form-4">{MAIN.map(field)}</div>
            </section>

            {live > 1 && (
              <section className="rn-form-g">
                <h4>Видеокарты</h4>
                <div className="rn-gpu">
                  <Seg size="sm" label="Карт на обучение" value={String(gpus)} onChange={(v) => setValue("gpus", Number(v))}
                    options={Array.from({ length: live }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
                  <span className="rn-gpu-l">
                    {gpus === 1 ? "одна карта" : <>батч {batch} — <b>по {even ? batch / gpus : "?"} на карту</b> · ждёт <b>{count(gpus, "карту", "карты", "карт")} сразу</b></>}
                    {vram && <> · <b>≈ {gb(vram.want_mb)} ГБ</b>{gpus > 1 ? " на карту" : ""}</>}
                  </span>
                </div>
                {!even && (
                  <Notice tone="warn">Батч {batch} не делится на число карт ({gpus}) — поставьте {Math.floor(batch / gpus) * gpus || gpus} или {Math.ceil(batch / gpus) * gpus}.</Notice>
                )}
              </section>
            )}

            <section className="rn-form-g">
              <h4>Аугментации</h4>
              {hasGraph ? (
                <Notice tone="info">Набор собран графом «{set?.graph?.name}» v{set?.graph?.version}: искажения уже на диске,
                  встроенные аугментации YOLO к нему не применяются.</Notice>
              ) : (
                <>
                  <label className="row rn-switch">
                    <Switch checked={augOn} onChange={(v) => setValue("augment_mode", v ? "yolo" : "off")}
                      label="Встроенные аугментации YOLO" />
                    <span>Встроенные аугментации YOLO</span>
                    {augOn && augChanged && (
                      <Button size="sm" variant="ghost" icon="undo" className="rn-push"
                        onClick={() => setValues((v) => ({ ...v, ...augDefaults, augment_mode: "yolo" }))}>
                        Вернуть рекомендуемые
                      </Button>
                    )}
                  </label>
                  {augOn && <div className="rn-form-4">{AUG_KEYS.map(field)}</div>}
                </>
              )}
            </section>

            <section className="rn-form-g">
              <button type="button" className="rn-fold" aria-expanded={fine} onClick={() => setFine((v) => !v)}>
                <Icon name="chevD" size={14} />Тонкая настройка: оптимизатор, регуляризация, зерно
              </button>
              {fine && <div className="rn-form-4">{FINE.map(field)}</div>}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
